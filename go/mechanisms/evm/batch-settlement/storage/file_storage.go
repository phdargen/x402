package storage

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	batchsettlement "github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement"
)

const (
	fileLockMaxAttempts     = 50
	fileLockRetryIntervalMs = 10
	fileLockStaleMs         = 2_000
)

// FileChannelStorage is a file-backed ChannelStorage. Each record is stored as
// {root}/server/{channelId}.json. UpdateChannel is serialised through an
// exclusive lock file ({channelId}.json.lock) so concurrent writers cannot
// interleave.
type FileChannelStorage[T ChannelRecord[T]] struct {
	root string
}

var (
	_ ChannelStorage[*Channel] = (*FileChannelStorage[*Channel])(nil)
	_ ChannelLockStorage       = (*FileChannelStorage[*Channel])(nil)
)

// NewFileChannelStorage returns a file-backed channel store.
func NewFileChannelStorage[T ChannelRecord[T]](opts batchsettlement.FileChannelStorageOptions) *FileChannelStorage[T] {
	return &FileChannelStorage[T]{root: opts.Directory}
}

func (s *FileChannelStorage[T]) filePath(channelId string) (string, error) {
	id, err := batchsettlement.NormalizeChannelId(channelId)
	if err != nil {
		return "", err
	}
	return batchsettlement.ResolveWithinDir(filepath.Join(s.root, "server"), id+".json")
}

func (s *FileChannelStorage[T]) holdPath(channelId string) (string, error) {
	id, err := batchsettlement.NormalizeChannelId(channelId)
	if err != nil {
		return "", err
	}
	return batchsettlement.ResolveWithinDir(filepath.Join(s.root, "server"), id+".hold")
}

// Get loads a persisted channel record, or the zero T when the file is missing.
func (s *FileChannelStorage[T]) Get(channelId string) (T, error) {
	var zero T
	path, err := s.filePath(channelId)
	if err != nil {
		return zero, err
	}
	var out T
	ok, err := batchsettlement.ReadJSONFile(path, &out)
	if err != nil {
		return zero, err
	}
	if !ok {
		return zero, nil
	}
	return out, nil
}

// Set writes session as JSON under the canonical channel id.
func (s *FileChannelStorage[T]) Set(channelId string, session T) error {
	path, err := s.filePath(channelId)
	if err != nil {
		return err
	}
	return batchsettlement.WriteJSONAtomic(path, session)
}

// Delete removes the channel file and its admission hold sidecar.
func (s *FileChannelStorage[T]) Delete(channelId string) error {
	path, err := s.filePath(channelId)
	if err != nil {
		return err
	}
	if err := os.Remove(path); err != nil && !batchsettlement.IsNotExist(err) {
		return err
	}
	return s.dropHold(channelId)
}

// List returns stored records sorted by channelId.
func (s *FileChannelStorage[T]) List() ([]T, error) {
	dir := filepath.Join(s.root, "server")
	entries, err := os.ReadDir(dir)
	if err != nil {
		if batchsettlement.IsNotExist(err) {
			return []T{}, nil
		}
		return nil, err
	}

	sessions := make([]T, 0, len(entries))
	for _, entry := range entries {
		name := entry.Name()
		if !strings.HasSuffix(name, ".json") || strings.HasSuffix(name, ".lock") {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			if batchsettlement.IsNotExist(err) {
				continue
			}
			return nil, err
		}
		var out T
		if err := json.Unmarshal(raw, &out); err != nil {
			return nil, fmt.Errorf("unmarshal %s: %w", name, err)
		}
		sessions = append(sessions, out)
	}
	sort.Slice(sessions, func(i, j int) bool { return sessions[i].Base().ChannelId < sessions[j].Base().ChannelId })
	return sessions, nil
}

// UpdateChannel atomically reads, mutates, and writes a channel record under an
// exclusive lock file. Returning a different pointer commits the new session;
// returning the zero T deletes the file; returning the same pointer is a no-op.
func (s *FileChannelStorage[T]) UpdateChannel(channelId string, update func(current T) T) (*ChannelUpdateResult[T], error) {
	path, err := s.filePath(channelId)
	if err != nil {
		return nil, err
	}
	lockPath := path + ".lock"

	if err := os.MkdirAll(filepath.Dir(lockPath), 0o755); err != nil {
		return nil, fmt.Errorf("mkdir %s: %w", filepath.Dir(lockPath), err)
	}

	lockFile, err := AcquireExclusiveFile(lockPath, nil)
	if err != nil {
		return nil, err
	}
	defer func() {
		_ = lockFile.Close()
		_ = os.Remove(lockPath)
	}()

	var current T
	ok, err := batchsettlement.ReadJSONFile(path, &current)
	if err != nil {
		return nil, err
	}
	if !ok {
		current = zeroRecord[T]()
	}

	next := update(current)
	if sameRecord(next, current) {
		return &ChannelUpdateResult[T]{Channel: current, Status: ChannelUnchanged}, nil
	}
	if isZeroRecord(next) {
		if !ok {
			return &ChannelUpdateResult[T]{Status: ChannelUnchanged}, nil
		}
		if rmErr := os.Remove(path); rmErr != nil && !batchsettlement.IsNotExist(rmErr) {
			return nil, rmErr
		}
		if dropErr := s.dropHold(channelId); dropErr != nil {
			return nil, dropErr
		}
		return &ChannelUpdateResult[T]{Status: ChannelDeleted}, nil
	}
	if err := batchsettlement.WriteJSONAtomic(path, next); err != nil {
		return nil, err
	}
	return &ChannelUpdateResult[T]{Channel: next, Status: ChannelUpdated}, nil
}

// Acquire takes a per-channel admission lock via a sidecar hold file.
//
// Serialized with Release and IsHeld on {id}.hold.lock so an expired hold
// cannot be unlinked out from under a new holder. Not re-entrant: a live hold,
// including one owned by the same pendingId, is a miss.
func (s *FileChannelStorage[T]) Acquire(channelId string, pendingId string, ttlMs int64) (bool, error) {
	var acquired bool
	err := s.withHoldLock(channelId, func() error {
		path, err := s.holdPath(channelId)
		if err != nil {
			return err
		}
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			return fmt.Errorf("mkdir %s: %w", filepath.Dir(path), err)
		}
		raw, readErr := os.ReadFile(path)
		if readErr != nil && !batchsettlement.IsNotExist(readErr) {
			return readErr
		}
		if readErr == nil {
			var existing admissionLock
			if unmarshalErr := json.Unmarshal(raw, &existing); unmarshalErr != nil {
				return unmarshalErr
			}
			if existing.ExpiresAt > time.Now().UnixMilli() {
				acquired = false
				return nil
			}
		}
		record, err := json.Marshal(admissionLock{PendingId: pendingId, ExpiresAt: time.Now().UnixMilli() + ttlMs})
		if err != nil {
			return err
		}
		if err := os.WriteFile(path, record, 0o644); err != nil {
			return err
		}
		acquired = true
		return nil
	})
	return acquired, err
}

// Release drops the admission lock only when pendingId still holds it.
func (s *FileChannelStorage[T]) Release(channelId string, pendingId string) error {
	return s.withHoldLock(channelId, func() error {
		path, err := s.holdPath(channelId)
		if err != nil {
			return err
		}
		raw, err := os.ReadFile(path)
		if err != nil {
			if batchsettlement.IsNotExist(err) {
				return nil
			}
			return err
		}
		var hold admissionLock
		if err := json.Unmarshal(raw, &hold); err != nil {
			return err
		}
		if hold.PendingId != pendingId {
			return nil
		}
		if rmErr := os.Remove(path); rmErr != nil && !batchsettlement.IsNotExist(rmErr) {
			return rmErr
		}
		return nil
	})
}

// IsHeld reports whether a live admission lock exists, optionally matching pendingId.
func (s *FileChannelStorage[T]) IsHeld(channelId string, pendingId string) (bool, error) {
	var held bool
	err := s.withHoldLock(channelId, func() error {
		path, err := s.holdPath(channelId)
		if err != nil {
			return err
		}
		raw, err := os.ReadFile(path)
		if err != nil {
			if batchsettlement.IsNotExist(err) {
				held = false
				return nil
			}
			return err
		}
		var hold admissionLock
		if err := json.Unmarshal(raw, &hold); err != nil {
			return err
		}
		if hold.ExpiresAt <= time.Now().UnixMilli() {
			held = false
			return nil
		}
		if pendingId == "" {
			held = true
			return nil
		}
		held = hold.PendingId == pendingId
		return nil
	})
	return held, err
}

func (s *FileChannelStorage[T]) dropHold(channelId string) error {
	return s.withHoldLock(channelId, func() error {
		path, err := s.holdPath(channelId)
		if err != nil {
			return err
		}
		if rmErr := os.Remove(path); rmErr != nil && !batchsettlement.IsNotExist(rmErr) {
			return rmErr
		}
		return nil
	})
}

func (s *FileChannelStorage[T]) withHoldLock(channelId string, fn func() error) error {
	path, err := s.holdPath(channelId)
	if err != nil {
		return err
	}
	lockPath := path + ".lock"
	if err := os.MkdirAll(filepath.Dir(lockPath), 0o755); err != nil {
		return fmt.Errorf("mkdir %s: %w", filepath.Dir(lockPath), err)
	}
	lockFile, err := AcquireExclusiveFile(lockPath, nil)
	if err != nil {
		return err
	}
	defer func() {
		_ = lockFile.Close()
		_ = os.Remove(lockPath)
	}()
	return fn()
}

// ExclusiveFileOptions bounds exclusive lock-file create attempts.
type ExclusiveFileOptions struct {
	MaxAttempts     int
	RetryIntervalMs int
	StaleMs         int
}

func (o *ExclusiveFileOptions) withDefaults() ExclusiveFileOptions {
	out := ExclusiveFileOptions{}
	if o != nil {
		out = *o
	}
	if out.MaxAttempts <= 0 {
		out.MaxAttempts = fileLockMaxAttempts
	}
	if out.RetryIntervalMs <= 0 {
		out.RetryIntervalMs = fileLockRetryIntervalMs
	}
	if out.StaleMs <= 0 {
		out.StaleMs = fileLockStaleMs
	}
	return out
}

// AcquireExclusiveFile creates lockPath with O_EXCL, polling until the marker
// is free or stale (mtime older than StaleMs). Stale markers are unlinked so a
// crash cannot pin the channel forever.
func AcquireExclusiveFile(lockPath string, opts *ExclusiveFileOptions) (*os.File, error) {
	cfg := opts.withDefaults()
	staleAfter := time.Duration(cfg.StaleMs) * time.Millisecond
	retryInterval := time.Duration(cfg.RetryIntervalMs) * time.Millisecond
	for attempt := 0; attempt < cfg.MaxAttempts; attempt++ {
		f, err := os.OpenFile(lockPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
		if err == nil {
			return f, nil
		}
		if !errors.Is(err, os.ErrExist) {
			return nil, fmt.Errorf("acquire lock %s: %w", lockPath, err)
		}
		info, statErr := os.Stat(lockPath)
		if statErr != nil {
			if batchsettlement.IsNotExist(statErr) {
				continue
			}
			return nil, fmt.Errorf("acquire lock %s: %w", lockPath, statErr)
		}
		if time.Since(info.ModTime()) >= staleAfter {
			_ = os.Remove(lockPath)
			continue
		}
		time.Sleep(retryInterval)
	}
	return nil, fmt.Errorf("acquire lock %s: contended", lockPath)
}
