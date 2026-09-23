package storage

import (
	"context"
	"math/big"
	"strconv"
	"strings"
)

// ChannelStoreOptions are per-call options for indexed queries.
type ChannelStoreOptions struct {
	// Unused by the scan shim; native adapters may honour cancellation.
}

// QueryKind is the closed set of worker reads channel managers issue.
type QueryKind string

const (
	QueryKindClaimable       QueryKind = "claimable"
	QueryKindIdleRefundable  QueryKind = "idleRefundable"
	QueryKindWithdrawPending QueryKind = "withdrawPending"
)

// ChannelQuery is a named worker query. Adapters that ignore a field would
// over-return, and over-returning is the dangerous direction (cooperative
// refund of channels that are not idle).
type ChannelQuery struct {
	Kind           QueryKind
	Network        string
	IdleAtOrBefore *int64
	// MinUnclaimed is an optional decimal uint256 unclaimed threshold; absent means any positive unclaimed.
	MinUnclaimed *string
	// UnclaimedDesc sorts claimable rows highest-unclaimed first.
	UnclaimedDesc bool
	// OldestFirst sorts claimable rows by lastRequestTimestamp ascending (withdraw-pending first, then earliest withdrawRequestedAt).
	OldestFirst bool
	Limit       *int
	Cursor      string
}

// SettleQuery filters distinct claimed (network, receiver, token) tuples.
type SettleQuery struct {
	Network    string
	Limit      *int
	Cursor     string
	MinPending *big.Int
}

// SettleTarget is a distinct claimed (network, receiver, token) used by facilitator settle.
type SettleTarget struct {
	Network  string
	Receiver string
	Token    string
}

// QueryPage is one page from Query or SettleQuery.
type QueryPage[T any] struct {
	Items  []T
	Cursor string
}

// ChannelQuerier is an optional indexed worker query. QueryChannels type-asserts
// this and falls back to QueryByScan when it is absent.
type ChannelQuerier[T ChannelRecord[T]] interface {
	Query(ctx context.Context, filter ChannelQuery, opts *ChannelStoreOptions) (*QueryPage[T], error)
}

// ChannelReceiverTokenQuerier lists channels for one receiver and token.
type ChannelReceiverTokenQuerier[T ChannelRecord[T]] interface {
	QueryByReceiverToken(ctx context.Context, network, receiver, token string) ([]T, error)
}

// MatchesChannelQuery reports whether channel satisfies filter.
//
// Uint256 comparisons use big.Int so lexicographic string order cannot leak
// into adapters. When filter.Network is set, a row without a Network field
// does not match.
func MatchesChannelQuery(channel *Channel, filter ChannelQuery) bool {
	if channel == nil {
		return false
	}
	if filter.Network != "" && channelNetwork(channel) != filter.Network {
		return false
	}

	switch filter.Kind {
	case QueryKindClaimable:
		charged, chargedOk := ParseUint256(channel.ChargedCumulativeAmount)
		claimed, claimedOk := ParseUint256(channel.TotalClaimed)
		if !chargedOk || !claimedOk || charged.Cmp(claimed) <= 0 {
			return false
		}
		if filter.MinUnclaimed != nil && filter.IdleAtOrBefore != nil {
			return matchesUnclaimedThreshold(charged, claimed, *filter.MinUnclaimed) ||
				matchesIdle(channel, filter.IdleAtOrBefore)
		}
		if filter.MinUnclaimed != nil {
			return matchesUnclaimedThreshold(charged, claimed, *filter.MinUnclaimed)
		}
		return matchesIdle(channel, filter.IdleAtOrBefore)
	case QueryKindIdleRefundable:
		balance, ok := ParseUint256(channel.Balance)
		if !ok || balance.Sign() == 0 {
			return false
		}
		return matchesIdle(channel, filter.IdleAtOrBefore)
	case QueryKindWithdrawPending:
		return channel.WithdrawRequestedAt > 0
	default:
		panic("unhandled channel query: " + string(filter.Kind))
	}
}

// SortChannels orders query matches. Claimable rows put withdraw-pending
// first, then highest-unclaimed when UnclaimedDesc is set, or oldest
// lastRequestTimestamp when OldestFirst is set.
func SortChannels[T ChannelRecord[T]](channels []T, filter ChannelQuery) []T {
	out := append([]T(nil), channels...)
	switch filter.Kind {
	case QueryKindClaimable:
		stableSortChannels(out, func(a, b T) bool {
			pendingA := 1
			if a.Base().WithdrawRequestedAt > 0 {
				pendingA = 0
			}
			pendingB := 1
			if b.Base().WithdrawRequestedAt > 0 {
				pendingB = 0
			}
			if pendingA != pendingB {
				return pendingA < pendingB
			}
			if filter.UnclaimedDesc {
				return unclaimedValue(a.Base()).Cmp(unclaimedValue(b.Base())) > 0
			}
			if filter.OldestFirst {
				baseA := a.Base()
				baseB := b.Base()
				if baseA.WithdrawRequestedAt > 0 && baseB.WithdrawRequestedAt > 0 &&
					baseA.WithdrawRequestedAt != baseB.WithdrawRequestedAt {
					return baseA.WithdrawRequestedAt < baseB.WithdrawRequestedAt
				}
				return baseA.LastRequestTimestamp < baseB.LastRequestTimestamp
			}
			return false
		})
		return out
	case QueryKindIdleRefundable, QueryKindWithdrawPending:
		return out
	default:
		panic("unhandled channel query: " + string(filter.Kind))
	}
}

// QueryByScan dumps List(), filters, sorts, and slices. Limit/cursor only page
// the already-loaded match list; a native adapter should apply them as read bounds.
func QueryByScan[T ChannelRecord[T]](ctx context.Context, store ChannelStorage[T], filter ChannelQuery) (*QueryPage[T], error) {
	all, err := store.List(ctx)
	if err != nil {
		return nil, err
	}
	matched := make([]T, 0, len(all))
	for _, channel := range all {
		if MatchesChannelQuery(channel.Base(), filter) {
			matched = append(matched, channel)
		}
	}
	return PageItems(SortChannels(matched, filter), filter.Limit, filter.Cursor), nil
}

// QueryChannels runs a named worker query, using a native ChannelQuerier when
// present and QueryByScan otherwise.
func QueryChannels[T ChannelRecord[T]](ctx context.Context, store ChannelStorage[T], filter ChannelQuery, opts *ChannelStoreOptions) (*QueryPage[T], error) {
	if querier, ok := store.(ChannelQuerier[T]); ok {
		page, err := querier.Query(ctx, filter, opts)
		if err != nil {
			return nil, err
		}
		if page != nil {
			return page, nil
		}
	}
	return QueryByScan(ctx, store, filter)
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

func matchesIdle(channel *Channel, idleAtOrBefore *int64) bool {
	if idleAtOrBefore == nil {
		return true
	}
	return channel.LastRequestTimestamp <= *idleAtOrBefore
}

// matchesUnclaimedThreshold reports whether charged-claimed meets threshold.
// An unparseable threshold fails closed.
func matchesUnclaimedThreshold(charged, claimed *big.Int, minUnclaimed string) bool {
	threshold, ok := ParseUint256(minUnclaimed)
	if !ok {
		return false
	}
	return new(big.Int).Sub(charged, claimed).Cmp(threshold) >= 0
}

// unclaimedValue returns charged-claimed, or zero when corrupt. Ordering
// helper for already-matched rows only.
func unclaimedValue(channel *Channel) *big.Int {
	charged, chargedOk := ParseUint256(channel.ChargedCumulativeAmount)
	claimed, claimedOk := ParseUint256(channel.TotalClaimed)
	if !chargedOk || !claimedOk {
		return new(big.Int)
	}
	delta := new(big.Int).Sub(charged, claimed)
	if delta.Sign() < 0 {
		return new(big.Int)
	}
	return delta
}

func channelNetwork(channel *Channel) string {
	if channel == nil {
		return ""
	}
	return channel.Network
}

func PageItems[T any](items []T, limit *int, cursor string) *QueryPage[T] {
	start := ParseQueryCursor(cursor)
	remaining := len(items) - start
	if remaining <= 0 {
		return &QueryPage[T]{Items: []T{}}
	}
	size := remaining
	if limit != nil {
		size = *limit
		if size < 0 {
			size = 0
		}
	}
	end := start + size
	if end > len(items) {
		end = len(items)
	}
	page := append([]T(nil), items[start:end]...)
	out := &QueryPage[T]{Items: page}
	if end < len(items) {
		out.Cursor = strconv.Itoa(end)
	}
	return out
}

func ParseQueryCursor(cursor string) int {
	if cursor == "" {
		return 0
	}
	parsed, err := strconv.Atoi(cursor)
	if err != nil || parsed < 0 {
		return 0
	}
	return parsed
}

// ParseUint256 parses a decimal uint256. ok=false means the caller must skip
// (query/claim scans) or fail closed (writes, verify) — never treat as zero.
func ParseUint256(s string) (*big.Int, bool) {
	v, ok := new(big.Int).SetString(s, 10)
	if !ok || v.Sign() < 0 {
		return nil, false
	}
	return v, true
}

// Uint256Cmp compares decimal uint256 strings. ok=false means either operand
// failed to parse, and the caller must skip the row, not treat it as zero.
func Uint256Cmp(a, b string) (int, bool) {
	ai, okA := ParseUint256(a)
	if !okA {
		return 0, false
	}
	bi, okB := ParseUint256(b)
	if !okB {
		return 0, false
	}
	return ai.Cmp(bi), true
}

func stableSortChannels[T ChannelRecord[T]](channels []T, less func(a, b T) bool) {
	// Insertion sort keeps equal-priority rows in input order.
	for i := 1; i < len(channels); i++ {
		j := i
		for j > 0 && less(channels[j], channels[j-1]) {
			channels[j], channels[j-1] = channels[j-1], channels[j]
			j--
		}
	}
}
