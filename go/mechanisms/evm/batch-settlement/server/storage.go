package server

import (
	batchsettlement "github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement"
	"github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement/storage"
)

type (
	ChannelSession             = storage.Channel
	ChannelUpdateStatus        = storage.ChannelUpdateStatus
	ChannelUpdateResult        = storage.ChannelUpdateResult[*storage.Channel]
	SessionStorage             = storage.ChannelStorage[*storage.Channel]
	ChannelLockStorage         = storage.ChannelLockStorage
	InMemoryChannelStorage     = storage.InMemoryChannelStorage[*storage.Channel]
	ChannelQuery               = storage.ChannelQuery
	ChannelStoreOptions        = storage.ChannelStoreOptions
	SettleQuery                = storage.SettleQuery
	SettleTarget               = storage.SettleTarget
	DelegatedAuthBinding       = storage.DelegatedAuthBinding
	DelegatedAuthStore         = storage.DelegatedAuthStore
	InMemoryDelegatedAuthStore = storage.InMemoryDelegatedAuthStore
	VoucherStoreMode           = storage.VoucherStoreMode
	SelectClaimableOptions     = storage.SelectClaimableOptions
)

const (
	ChannelUpdated              = storage.ChannelUpdated
	ChannelUnchanged            = storage.ChannelUnchanged
	ChannelDeleted              = storage.ChannelDeleted
	ChannelConflict             = storage.ChannelConflict
	VoucherStoreModeSelf        = storage.VoucherStoreModeSelf
	VoucherStoreModeFacilitator = storage.VoucherStoreModeFacilitator
	QueryKindClaimable          = storage.QueryKindClaimable
	QueryKindIdleRefundable     = storage.QueryKindIdleRefundable
	QueryKindWithdrawPending    = storage.QueryKindWithdrawPending
)

// NewInMemoryChannelStorage creates a new in-memory server session storage.
func NewInMemoryChannelStorage() *InMemoryChannelStorage {
	return storage.NewInMemoryChannelStorage[*storage.Channel]()
}

// RethrowLockImplementationError returns err when it is a lock-store
// implementation/parse failure so callers fail closed.
func RethrowLockImplementationError(err error) error {
	return storage.RethrowLockImplementationError(err)
}

// IsChannelLockStorage reports whether value implements ChannelLockStorage.
func IsChannelLockStorage(value any) bool {
	return storage.IsChannelLockStorage(value)
}

// MatchesChannelQuery reports whether channel satisfies filter.
func MatchesChannelQuery(channel *ChannelSession, filter ChannelQuery) bool {
	return storage.MatchesChannelQuery(channel, filter)
}

// SortChannels orders query matches. Claimable rows put withdraw-pending
// channels first; other kinds preserve input order.
func SortChannels(channels []*ChannelSession, filter ChannelQuery) []*ChannelSession {
	return storage.SortChannels(channels, filter)
}

// QueryByScan dumps List(), filters, sorts, and slices.
func QueryByScan(store SessionStorage, filter ChannelQuery) (*storage.QueryPage[*storage.Channel], error) {
	return storage.QueryByScan(store, filter)
}

// QueryChannels runs a named worker query, using a native query when present.
func QueryChannels(store SessionStorage, filter ChannelQuery, opts *ChannelStoreOptions) (*storage.QueryPage[*storage.Channel], error) {
	return storage.QueryChannels(store, filter, opts)
}

// QuerySettleTargets lists distinct claimed settle targets.
func QuerySettleTargets(store SessionStorage, filter SettleQuery, opts *ChannelStoreOptions) (*storage.QueryPage[SettleTarget], error) {
	return storage.QuerySettleTargets(store, filter, opts)
}

// SettleQueryByScan lists claimed rows deduped per (network, receiver, token).
func SettleQueryByScan(store SessionStorage, filter SettleQuery) (*storage.QueryPage[SettleTarget], error) {
	return storage.SettleQueryByScan(store, filter)
}

// NewInMemoryDelegatedAuthStore creates an empty in-memory binding store.
func NewInMemoryDelegatedAuthStore() *InMemoryDelegatedAuthStore {
	return storage.NewInMemoryDelegatedAuthStore()
}

// SelectClaimableVouchers collects vouchers whose charged watermark exceeds
// onchain totalClaimed, optionally applying an idle window.
func SelectClaimableVouchers(channels []*ChannelSession, opts *SelectClaimableOptions) []batchsettlement.BatchSettlementVoucherClaim {
	return storage.SelectClaimableVouchers(channels, opts)
}

// ApplyClaimedTotals advances stored totalClaimed after a successful claim.
func ApplyClaimedTotals(store SessionStorage, claims []batchsettlement.BatchSettlementVoucherClaim, network string) error {
	return storage.ApplyClaimedTotals(store, claims, network)
}
