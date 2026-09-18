package storage

import (
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
	Limit          *int
	Cursor         string
}

// SettleQuery filters distinct claimed (network, receiver, token) tuples.
type SettleQuery struct {
	Network string
	Limit   *int
	Cursor  string
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
	Query(filter ChannelQuery, opts *ChannelStoreOptions) (*QueryPage[T], error)
}

// SettleQuerier is an optional indexed settle-target query. QuerySettleTargets
// type-asserts this and falls back to SettleQueryByScan when it is absent.
type SettleQuerier interface {
	SettleQuery(filter SettleQuery, opts *ChannelStoreOptions) (*QueryPage[SettleTarget], error)
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
		if uint256Cmp(channel.ChargedCumulativeAmount, channel.TotalClaimed) <= 0 {
			return false
		}
		return matchesIdle(channel, filter.IdleAtOrBefore)
	case QueryKindIdleRefundable:
		if uint256Cmp(channel.Balance, "0") == 0 {
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
// channels first; other kinds preserve input order. The input slice is not mutated.
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
			return pendingA < pendingB
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
func QueryByScan[T ChannelRecord[T]](store ChannelStorage[T], filter ChannelQuery) (*QueryPage[T], error) {
	all, err := store.List()
	if err != nil {
		return nil, err
	}
	matched := make([]T, 0, len(all))
	for _, channel := range all {
		if MatchesChannelQuery(channel.Base(), filter) {
			matched = append(matched, channel)
		}
	}
	return pageItems(SortChannels(matched, filter), filter.Limit, filter.Cursor), nil
}

// SettleQueryByScan lists claimed rows (totalClaimed > 0) deduped per
// (network, receiver, token) in first-seen order.
func SettleQueryByScan[T ChannelRecord[T]](store ChannelStorage[T], filter SettleQuery) (*QueryPage[SettleTarget], error) {
	all, err := store.List()
	if err != nil {
		return nil, err
	}
	targets := make([]SettleTarget, 0)
	seen := make(map[string]struct{})
	for _, record := range all {
		channel := record.Base()
		if uint256Cmp(channel.TotalClaimed, "0") == 0 {
			continue
		}
		network := channelNetwork(channel)
		if network == "" {
			network = filter.Network
		}
		if network == "" || (filter.Network != "" && network != filter.Network) {
			continue
		}
		receiver := channel.ChannelConfig.Receiver
		token := channel.ChannelConfig.Token
		key := network + ":" + strings.ToLower(receiver) + ":" + strings.ToLower(token)
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		targets = append(targets, SettleTarget{Network: network, Receiver: receiver, Token: token})
	}
	return pageItems(targets, filter.Limit, filter.Cursor), nil
}

// QueryChannels runs a named worker query, using a native ChannelQuerier when
// present and QueryByScan otherwise.
func QueryChannels[T ChannelRecord[T]](store ChannelStorage[T], filter ChannelQuery, opts *ChannelStoreOptions) (*QueryPage[T], error) {
	if querier, ok := store.(ChannelQuerier[T]); ok {
		page, err := querier.Query(filter, opts)
		if err != nil {
			return nil, err
		}
		if page != nil {
			return page, nil
		}
	}
	return QueryByScan(store, filter)
}

// QuerySettleTargets lists distinct claimed settle targets, using a native
// SettleQuerier when present and SettleQueryByScan otherwise.
func QuerySettleTargets[T ChannelRecord[T]](store ChannelStorage[T], filter SettleQuery, opts *ChannelStoreOptions) (*QueryPage[SettleTarget], error) {
	if querier, ok := store.(SettleQuerier); ok {
		page, err := querier.SettleQuery(filter, opts)
		if err != nil {
			return nil, err
		}
		if page != nil {
			return page, nil
		}
	}
	return SettleQueryByScan(store, filter)
}

func matchesIdle(channel *Channel, idleAtOrBefore *int64) bool {
	if idleAtOrBefore == nil {
		return true
	}
	return channel.LastRequestTimestamp <= *idleAtOrBefore
}

func channelNetwork(channel *Channel) string {
	if channel == nil {
		return ""
	}
	return channel.Network
}

func pageItems[T any](items []T, limit *int, cursor string) *QueryPage[T] {
	start := parseQueryCursor(cursor)
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

func parseQueryCursor(cursor string) int {
	if cursor == "" {
		return 0
	}
	parsed, err := strconv.Atoi(cursor)
	if err != nil || parsed < 0 {
		return 0
	}
	return parsed
}

func uint256Cmp(a, b string) int {
	ai, okA := new(big.Int).SetString(a, 10)
	bi, okB := new(big.Int).SetString(b, 10)
	if !okA {
		ai = new(big.Int)
	}
	if !okB {
		bi = new(big.Int)
	}
	return ai.Cmp(bi)
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
