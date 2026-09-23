package storage

import (
	"context"
	"math"
	"math/big"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const defaultSettleTargetPageSize = 100

// SettleTargetPageCursor encodes lastAttemptAt for settle-target paging.
type SettleTargetPageCursor struct {
	LastAttemptAt int64
	Receiver      string
	Token         string
}

// EncodeSettleTargetCursor serializes paging state for settle targets.
func EncodeSettleTargetCursor(c SettleTargetPageCursor) string {
	if c.LastAttemptAt == 0 && c.Receiver == "" && c.Token == "" {
		return ""
	}
	return strconv.FormatInt(c.LastAttemptAt, 10) + "|" + strings.ToLower(c.Receiver) + "|" + strings.ToLower(c.Token)
}

// DecodeSettleTargetCursor parses paging state for settle targets.
func DecodeSettleTargetCursor(raw string) (SettleTargetPageCursor, bool) {
	if raw == "" {
		return SettleTargetPageCursor{}, true
	}
	parts := strings.SplitN(raw, "|", 3)
	if len(parts) != 3 {
		return SettleTargetPageCursor{}, false
	}
	at, err := strconv.ParseInt(parts[0], 10, 64)
	if err != nil {
		return SettleTargetPageCursor{}, false
	}
	return SettleTargetPageCursor{
		LastAttemptAt: at,
		Receiver:      parts[1],
		Token:         parts[2],
	}, true
}

// SettleTargetClaimDelta is the claim amount added to a receiver pair.
type SettleTargetClaimDelta struct {
	Network  string
	Receiver string
	Token    string
	Amount   *big.Int
}

// SettleTargetStorage caches claimed-but-unsettled (network, receiver, token) pairs.
// SettleQuery returns pendingAmount > MinPending (nil means > 0). Sync deletes non-positive pending.
type SettleTargetStorage interface {
	SettleQuery(ctx context.Context, filter SettleQuery) (*QueryPage[SettleTarget], error)
	ApplySettleTargetClaimDelta(ctx context.Context, delta SettleTargetClaimDelta) error
	DeleteSettleTarget(ctx context.Context, target SettleTarget) error
	StampSettleTargetAttempts(ctx context.Context, targets []SettleTarget, atMillis int64) error
	SyncSettleTargetFromChain(ctx context.Context, target SettleTarget, pending *big.Int) error
}

// InMemorySettleTargetStorage is a process-local cache. Each row is keyed by its own network.
type InMemorySettleTargetStorage struct {
	mu      sync.Mutex
	entries map[string]*inMemorySettleTargetEntry
}

type inMemorySettleTargetEntry struct {
	network       string
	receiver      string
	token         string
	pendingAmount int64
	lastAttemptAt int64
}

var _ SettleTargetStorage = (*InMemorySettleTargetStorage)(nil)

func NewInMemorySettleTargetStorage() *InMemorySettleTargetStorage {
	return &InMemorySettleTargetStorage{
		entries: make(map[string]*inMemorySettleTargetEntry),
	}
}

func settleTargetKey(network, receiver, token string) string {
	return strings.ToLower(network) + ":" + strings.ToLower(receiver) + ":" + strings.ToLower(token)
}

func (s *InMemorySettleTargetStorage) SettleQuery(
	_ context.Context,
	filter SettleQuery,
) (*QueryPage[SettleTarget], error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	type row struct {
		target SettleTarget
		at     int64
	}
	rows := make([]row, 0, len(s.entries))
	for _, entry := range s.entries {
		if !pendingAboveMin(entry.pendingAmount, filter.MinPending) {
			continue
		}
		if filter.Network != "" && !strings.EqualFold(entry.network, filter.Network) {
			continue
		}
		rows = append(rows, row{
			target: SettleTarget{
				Network:  entry.network,
				Receiver: entry.receiver,
				Token:    entry.token,
			},
			at: entry.lastAttemptAt,
		})
	}
	sort.Slice(rows, func(i, j int) bool {
		if rows[i].at != rows[j].at {
			return rows[i].at < rows[j].at
		}
		if rows[i].target.Receiver != rows[j].target.Receiver {
			return rows[i].target.Receiver < rows[j].target.Receiver
		}
		return rows[i].target.Token < rows[j].target.Token
	})
	cursor, ok := DecodeSettleTargetCursor(filter.Cursor)
	if !ok {
		return &QueryPage[SettleTarget]{Items: []SettleTarget{}}, nil
	}
	start := 0
	if cursor.LastAttemptAt != 0 || cursor.Receiver != "" || cursor.Token != "" {
		for i, row := range rows {
			if row.at > cursor.LastAttemptAt {
				start = i
				break
			}
			if row.at == cursor.LastAttemptAt {
				ki := row.target.Receiver + ":" + row.target.Token
				ck := strings.ToLower(cursor.Receiver) + ":" + strings.ToLower(cursor.Token)
				if ki > ck {
					start = i
					break
				}
			}
			if i == len(rows)-1 {
				start = len(rows)
			}
		}
	}
	limit := settleQueryLimit(filter.Limit)
	end := start + limit
	if end > len(rows) {
		end = len(rows)
	}
	items := make([]SettleTarget, 0, end-start)
	for _, row := range rows[start:end] {
		items = append(items, row.target)
	}
	out := &QueryPage[SettleTarget]{Items: items}
	if end < len(rows) && len(items) > 0 {
		last := rows[end-1]
		out.Cursor = EncodeSettleTargetCursor(SettleTargetPageCursor{
			LastAttemptAt: last.at,
			Receiver:      last.target.Receiver,
			Token:         last.target.Token,
		})
	}
	return out, nil
}

func settleQueryLimit(limit *int) int {
	if limit == nil || *limit <= 0 {
		return defaultSettleTargetPageSize
	}
	return *limit
}

func (s *InMemorySettleTargetStorage) ApplySettleTargetClaimDelta(
	_ context.Context,
	delta SettleTargetClaimDelta,
) error {
	if delta.Amount == nil || delta.Amount.Sign() <= 0 {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	key := settleTargetKey(delta.Network, delta.Receiver, delta.Token)
	entry := s.entries[key]
	now := time.Now().UnixMilli()
	if entry == nil {
		entry = &inMemorySettleTargetEntry{
			network:       delta.Network,
			receiver:      strings.ToLower(delta.Receiver),
			token:         strings.ToLower(delta.Token),
			lastAttemptAt: now,
		}
		s.entries[key] = entry
	}
	entry.pendingAmount = saturateAddInt64(entry.pendingAmount, delta.Amount)
	return nil
}

func (s *InMemorySettleTargetStorage) DeleteSettleTarget(_ context.Context, target SettleTarget) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.entries, settleTargetKey(target.Network, target.Receiver, target.Token))
	return nil
}

func (s *InMemorySettleTargetStorage) StampSettleTargetAttempts(_ context.Context, targets []SettleTarget, atMillis int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, target := range targets {
		entry := s.entries[settleTargetKey(target.Network, target.Receiver, target.Token)]
		if entry != nil {
			entry.lastAttemptAt = atMillis
		}
	}
	return nil
}

func (s *InMemorySettleTargetStorage) SyncSettleTargetFromChain(
	_ context.Context,
	target SettleTarget,
	pending *big.Int,
) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	key := settleTargetKey(target.Network, target.Receiver, target.Token)
	entry := s.entries[key]
	if pending == nil || pending.Sign() <= 0 {
		delete(s.entries, key)
		return nil
	}
	if entry == nil {
		entry = &inMemorySettleTargetEntry{
			network:  target.Network,
			receiver: strings.ToLower(target.Receiver),
			token:    strings.ToLower(target.Token),
		}
		s.entries[key] = entry
	}
	entry.pendingAmount = bigIntToSaturatedInt64(pending)
	entry.lastAttemptAt = time.Now().UnixMilli()
	return nil
}

func saturateAddInt64(current int64, delta *big.Int) int64 {
	if delta == nil || delta.Sign() <= 0 {
		return current
	}
	if !delta.IsInt64() {
		return math.MaxInt64
	}
	add := delta.Int64()
	if current > math.MaxInt64-add {
		return math.MaxInt64
	}
	return current + add
}

func bigIntToSaturatedInt64(v *big.Int) int64 {
	if v == nil || v.Sign() <= 0 {
		return 0
	}
	if !v.IsInt64() {
		return math.MaxInt64
	}
	return v.Int64()
}

// pendingAboveMin reports pending > minPending. A threshold above MaxInt64 matches nothing.
func pendingAboveMin(pending int64, minPending *big.Int) bool {
	if pending <= 0 {
		return false
	}
	if minPending == nil {
		return true
	}
	if !minPending.IsInt64() {
		return false
	}
	return pending > minPending.Int64()
}
