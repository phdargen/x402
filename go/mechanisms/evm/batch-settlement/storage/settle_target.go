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

// SettleTargetPageCursor encodes lastAttemptAt for eligible target paging.
type SettleTargetPageCursor struct {
	LastAttemptAt int64
	Receiver      string
	Token         string
}

// EncodeSettleTargetCursor serializes paging state for eligible settle targets.
func EncodeSettleTargetCursor(c SettleTargetPageCursor) string {
	if c.LastAttemptAt == 0 && c.Receiver == "" && c.Token == "" {
		return ""
	}
	return strconv.FormatInt(c.LastAttemptAt, 10) + "|" + strings.ToLower(c.Receiver) + "|" + strings.ToLower(c.Token)
}

// DecodeSettleTargetCursor parses paging state for eligible settle targets.
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

// SettleTargetStore tracks cached pending per receiver pair for settle discovery.
type SettleTargetStore interface {
	SettleQuerier
	ApplySettleTargetClaimDelta(ctx context.Context, delta SettleTargetClaimDelta, minPending *big.Int) error
	DeleteSettleTarget(ctx context.Context, target SettleTarget) error
	StampSettleTargetAttempts(ctx context.Context, targets []SettleTarget, atMillis int64) error
	SyncSettleTargetFromChain(ctx context.Context, target SettleTarget, pending *big.Int, minPending *big.Int) error
}

// InMemorySettleTargetStore backs settle targets beside channel records in tests and file storage.
type InMemorySettleTargetStore struct {
	mu      sync.Mutex
	network string
	entries map[string]*inMemorySettleTargetEntry
}

type inMemorySettleTargetEntry struct {
	receiver      string
	token         string
	pendingAmount int64
	eligible      bool
	lastAttemptAt int64
}

func NewInMemorySettleTargetStore(network string) *InMemorySettleTargetStore {
	return &InMemorySettleTargetStore{
		network: network,
		entries: make(map[string]*inMemorySettleTargetEntry),
	}
}

func settleTargetKey(receiver, token string) string {
	return strings.ToLower(receiver) + ":" + strings.ToLower(token)
}

func (s *InMemorySettleTargetStore) SettleQuery(
	_ context.Context,
	filter SettleQuery,
	_ *ChannelStoreOptions,
) (*QueryPage[SettleTarget], error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if filter.Network != "" && filter.Network != s.network {
		return &QueryPage[SettleTarget]{Items: []SettleTarget{}}, nil
	}
	type row struct {
		target SettleTarget
		at     int64
	}
	rows := make([]row, 0, len(s.entries))
	for _, entry := range s.entries {
		if !entry.eligible {
			continue
		}
		rows = append(rows, row{
			target: SettleTarget{
				Network:  s.network,
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
		ki := strings.ToLower(rows[i].target.Receiver) + ":" + strings.ToLower(rows[i].target.Token)
		kj := strings.ToLower(rows[j].target.Receiver) + ":" + strings.ToLower(rows[j].target.Token)
		return ki < kj
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
				ki := strings.ToLower(row.target.Receiver) + ":" + strings.ToLower(row.target.Token)
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
	limit := defaultSettleTargetPageSize
	if filter.Limit != nil {
		limit = *filter.Limit
		if limit < 0 {
			limit = 0
		}
	}
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

func (s *InMemorySettleTargetStore) ApplySettleTargetClaimDelta(
	_ context.Context,
	delta SettleTargetClaimDelta,
	minPending *big.Int,
) error {
	if delta.Amount == nil || delta.Amount.Sign() <= 0 {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	key := settleTargetKey(delta.Receiver, delta.Token)
	entry := s.entries[key]
	now := time.Now().UnixMilli()
	if entry == nil {
		entry = &inMemorySettleTargetEntry{
			receiver:      delta.Receiver,
			token:         delta.Token,
			lastAttemptAt: now,
		}
		s.entries[key] = entry
	}
	entry.pendingAmount = saturateAddInt64(entry.pendingAmount, delta.Amount)
	entry.eligible = pendingEligibleInt64(entry.pendingAmount, minPending)
	return nil
}

func (s *InMemorySettleTargetStore) DeleteSettleTarget(_ context.Context, target SettleTarget) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.entries, settleTargetKey(target.Receiver, target.Token))
	return nil
}

func (s *InMemorySettleTargetStore) StampSettleTargetAttempts(_ context.Context, targets []SettleTarget, atMillis int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, target := range targets {
		entry := s.entries[settleTargetKey(target.Receiver, target.Token)]
		if entry != nil {
			entry.lastAttemptAt = atMillis
		}
	}
	return nil
}

// InMemoryManagedChannelStorage pairs channels with in-memory settle targets.
type InMemoryManagedChannelStorage[T ChannelRecord[T]] struct {
	*InMemoryChannelStorage[T]
	*InMemorySettleTargetStore
}

func NewInMemoryManagedChannelStorage[T ChannelRecord[T]](network string) *InMemoryManagedChannelStorage[T] {
	return &InMemoryManagedChannelStorage[T]{
		InMemoryChannelStorage:    NewInMemoryChannelStorage[T](),
		InMemorySettleTargetStore: NewInMemorySettleTargetStore(network),
	}
}

func (s *InMemoryManagedChannelStorage[T]) QueryByReceiverToken(
	ctx context.Context,
	network, receiver, token string,
) ([]T, error) {
	return QueryChannelsByReceiverToken(ctx, s.InMemoryChannelStorage, network, receiver, token)
}

func (s *InMemorySettleTargetStore) SyncSettleTargetFromChain(
	_ context.Context,
	target SettleTarget,
	pending *big.Int,
	minPending *big.Int,
) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	key := settleTargetKey(target.Receiver, target.Token)
	entry := s.entries[key]
	if pending == nil || pending.Sign() <= 0 {
		delete(s.entries, key)
		return nil
	}
	if entry == nil {
		entry = &inMemorySettleTargetEntry{receiver: target.Receiver, token: target.Token}
		s.entries[key] = entry
	}
	entry.pendingAmount = bigIntToSaturatedInt64(pending)
	entry.eligible = pendingEligibleInt64(entry.pendingAmount, minPending)
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

func pendingEligibleInt64(pending int64, minPending *big.Int) bool {
	if pending <= 0 {
		return false
	}
	if minPending == nil {
		return true
	}
	if !minPending.IsInt64() {
		return int64(math.MaxInt64) > 0
	}
	return pending > minPending.Int64()
}

// ChannelReceiverTokenQuerier lists channels for one receiver and token.
type ChannelReceiverTokenQuerier[T ChannelRecord[T]] interface {
	QueryByReceiverToken(ctx context.Context, network, receiver, token string) ([]T, error)
}

// QueryChannelsByReceiverToken loads channels for cleanup after settle.
func QueryChannelsByReceiverToken[T ChannelRecord[T]](
	ctx context.Context,
	store ChannelStorage[T],
	network, receiver, token string,
) ([]T, error) {
	if querier, ok := store.(ChannelReceiverTokenQuerier[T]); ok {
		return querier.QueryByReceiverToken(ctx, network, receiver, token)
	}
	all, err := store.List(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]T, 0)
	wantReceiver := strings.ToLower(receiver)
	wantToken := strings.ToLower(token)
	for _, row := range all {
		base := row.Base()
		if base == nil {
			continue
		}
		if network != "" && channelNetwork(base) != network {
			continue
		}
		if strings.ToLower(base.ChannelConfig.Receiver) != wantReceiver ||
			strings.ToLower(base.ChannelConfig.Token) != wantToken {
			continue
		}
		out = append(out, row)
	}
	return out, nil
}
