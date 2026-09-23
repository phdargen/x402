package facilitator

import (
	"context"

	x402 "github.com/x402-foundation/x402/go/v2"
	batchsettlement "github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement"
	"github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement/storage"
	"github.com/x402-foundation/x402/go/v2/types"
)

// FacilitatorChannel is the facilitator-managed channel record.
type FacilitatorChannel struct {
	storage.Channel
	ChargeCount int `json:"chargeCount"`
}

// Base returns the shared channel fields.
func (c *FacilitatorChannel) Base() *storage.Channel {
	if c == nil {
		return nil
	}
	return &c.Channel
}

// Clone returns a shallow copy. A nil receiver stays nil so missing rows stay missing.
func (c *FacilitatorChannel) Clone() *FacilitatorChannel {
	if c == nil {
		return nil
	}
	cp := *c
	return &cp
}

var _ storage.ChannelRecord[*FacilitatorChannel] = (*FacilitatorChannel)(nil)

// DelegatedSettleStep is the settle step that requests a caller identity.
type DelegatedSettleStep string

const (
	DelegatedSettleStepDeposit DelegatedSettleStep = "deposit"
	DelegatedSettleStepRefund  DelegatedSettleStep = "refund"
)

// DelegatedSettleContext is passed to ResolveCallerIdentity.
type DelegatedSettleContext struct {
	Ctx                context.Context
	Step               DelegatedSettleStep
	ChannelId          string
	Network            string
	Payer              string
	Amount             string
	Payload            types.PaymentPayload
	Requirements       types.PaymentRequirements
	FacilitatorContext *x402.FacilitatorContext
}

// ResolveCallerIdentity resolves a stable caller identity for a delegated settle.
type ResolveCallerIdentity func(ctx DelegatedSettleContext) (string, error)

// VoucherStoreConfig is read only when BatchSettlementEvmSchemeConfig.VoucherStore is set.
type VoucherStoreConfig struct {
	Storage     storage.ChannelStorage[*FacilitatorChannel]
	LockStorage storage.ChannelLockStorage
	// SettleTargetStorage caches claimed-but-unsettled (network, receiver, token) pairs.
	// Nil defaults to an in-memory cache.
	SettleTargetStorage storage.SettleTargetStorage
	WithdrawDelay       int
	// OnchainStateTtlMs is the cached onchain accept window. nil derives from
	// WithdrawDelay. 0 disables the cache and always re-reads onchain.
	OnchainStateTtlMs *int64
	// Retention controls when voucher rows are removed. Empty defaults to when-unused.
	Retention FacilitatorRetention
}

func cachedOnchain(channel *FacilitatorChannel) *batchsettlement.CachedChannelOnchain {
	if channel == nil {
		return nil
	}
	return &batchsettlement.CachedChannelOnchain{
		ChannelId:           channel.ChannelId,
		Balance:             channel.Balance,
		TotalClaimed:        channel.TotalClaimed,
		WithdrawRequestedAt: channel.WithdrawRequestedAt,
		RefundNonce:         channel.RefundNonce,
		OnchainSyncedAt:     channel.OnchainSyncedAt,
	}
}
