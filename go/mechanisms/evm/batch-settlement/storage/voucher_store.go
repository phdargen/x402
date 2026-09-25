package storage

import (
	"context"
	"encoding/hex"
	"math/big"
	"strconv"
	"strings"
	"time"

	"github.com/ethereum/go-ethereum/crypto"

	batchsettlement "github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement"
	"github.com/x402-foundation/x402/go/v2/types"
)

const (
	minPendingTtlMs = 5_000
	maxPendingTtlMs = 10 * 60 * 1000
)

// VoucherStoreMode says who owns the authoritative offchain voucher store.
type VoucherStoreMode string

const (
	VoucherStoreModeSelf        VoucherStoreMode = "self"
	VoucherStoreModeFacilitator VoucherStoreMode = "facilitator"
)

// CommitVoucherChargeInput is the charge increment, signed cap, voucher, and
// optional snapshot/map applied by CommitVoucherCharge.
type CommitVoucherChargeInput[T ChannelRecord[T]] struct {
	Increment           *big.Int
	SignedCap           *big.Int
	Voucher             batchsettlement.BatchSettlementVoucherFields
	Snapshot            T
	ResolveSnapshot     func(current T) T
	RecoverFromSnapshot *bool
	Now                 int64
	LocalVerify         bool
	Map                 func(T) T
}

// CommitVoucherChargeStatus is the CAS outcome of CommitVoucherCharge.
type CommitVoucherChargeStatus string

const (
	CommitMissing     CommitVoucherChargeStatus = "missing"
	CommitCapExceeded CommitVoucherChargeStatus = "cap_exceeded"
	CommitCommitted   CommitVoucherChargeStatus = "committed"
	CommitConflict    CommitVoucherChargeStatus = "conflict"
)

// CommitVoucherChargeResult is the CAS outcome of CommitVoucherCharge.
type CommitVoucherChargeResult[T ChannelRecord[T]] struct {
	Status   CommitVoucherChargeStatus
	Charged  string
	Previous *Channel
	Current  T
}

// IsFacilitatorManaged reports whether extra.voucherStore is the boolean true.
func IsFacilitatorManaged(extra map[string]interface{}) bool {
	if extra == nil {
		return false
	}
	v, ok := extra["voucherStore"].(bool)
	return ok && v
}

// VoucherStoreModeOf resolves VoucherStoreMode from payment requirements.
func VoucherStoreModeOf(requirements types.PaymentRequirements) VoucherStoreMode {
	if IsFacilitatorManaged(requirements.Extra) {
		return VoucherStoreModeFacilitator
	}
	return VoucherStoreModeSelf
}

// PendingTtlMs computes the bounded admission-lock TTL from the resource
// timeout. The result is clamped to 5s–600s. A zero or negative timeout
// is treated as zero before clamping.
func PendingTtlMs(maxTimeoutSeconds int) int64 {
	requestedMs := int64(maxTimeoutSeconds) * 1000
	if requestedMs < 0 {
		requestedMs = 0
	}
	if requestedMs < minPendingTtlMs {
		return minPendingTtlMs
	}
	if requestedMs > maxPendingTtlMs {
		return maxPendingTtlMs
	}
	return requestedMs
}

// DefaultOnchainStateTtlMs derives a freshness window from the channel
// withdraw delay: withdrawDelay/3, clamped between 30 seconds and 5 minutes.
func DefaultOnchainStateTtlMs(withdrawDelaySeconds int) int64 {
	if withdrawDelaySeconds < 0 {
		withdrawDelaySeconds = 0
	}
	ttl := int64(withdrawDelaySeconds) * 1000 / 3
	const minTtl = int64(30 * 1000)
	const maxTtl = int64(5 * 60 * 1000)
	if ttl < minTtl {
		return minTtl
	}
	if ttl > maxTtl {
		return maxTtl
	}
	return ttl
}

// AdmissionOwner binds a server-authored pendingId to the voucher it reserved.
//
// The lock store only holds one owner string, so the reservation key is this
// hash rather than the wire pendingId. A settle that echoes pendingId with a
// different voucher cannot present as the holder.
func AdmissionOwner(pendingId string, voucher batchsettlement.BatchSettlementVoucherFields) string {
	material := strings.ToLower(pendingId + "|" + voucher.ChannelId + "|" + voucher.MaxClaimableAmount + "|" + voucher.Signature)
	return "0x" + hex.EncodeToString(crypto.Keccak256([]byte(material)))
}

// ChannelStateExtra converts stored channel state into the public response snapshot.
func ChannelStateExtra(channel *Channel, chargedCumulativeAmount *string) batchsettlement.BatchSettlementChannelStateExtra {
	extra := batchsettlement.BatchSettlementChannelStateExtra{
		ChannelId:           channel.ChannelId,
		Balance:             channel.Balance,
		TotalClaimed:        channel.TotalClaimed,
		WithdrawRequestedAt: channel.WithdrawRequestedAt,
		RefundNonce:         strconv.Itoa(channel.RefundNonce),
	}
	if chargedCumulativeAmount != nil {
		extra.ChargedCumulativeAmount = *chargedCumulativeAmount
	}
	return extra
}

// PaymentResponseExtra builds payment-response extra. Self-managed paid
// responses are channelState, then chargedAmount. Facilitator-managed adds
// chargeCount after that. Refunds omit chargedAmount.
func PaymentResponseExtra(
	channelState batchsettlement.BatchSettlementChannelStateExtra,
	chargedAmount *string,
	chargeCount *int,
) batchsettlement.BatchSettlementPaymentResponseExtra {
	out := batchsettlement.BatchSettlementPaymentResponseExtra{
		ChannelState: &channelState,
		ChargeCount:  chargeCount,
	}
	if chargedAmount != nil {
		out.ChargedAmount = *chargedAmount
	}
	return out
}

// CommitVoucherCharge atomically increments chargedCumulativeAmount under the
// storage CAS.
//
// Any storage outcome other than status "updated" with a committed callback
// result (including status "conflict" from a contended compare-and-write)
// maps to status "conflict".
func CommitVoucherCharge[T ChannelRecord[T]](ctx context.Context, store ChannelStorage[T], channelId string, input CommitVoucherChargeInput[T]) (*CommitVoucherChargeResult[T], error) {
	now := input.Now
	if now == 0 {
		now = time.Now().UnixMilli()
	}
	var outcome *CommitVoucherChargeResult[T]

	updateResult, err := store.UpdateChannel(ctx, channelId, func(current T) T {
		recoverFromSnapshot := true
		if input.RecoverFromSnapshot != nil {
			recoverFromSnapshot = *input.RecoverFromSnapshot
		}
		resolved := input.Snapshot
		if input.ResolveSnapshot != nil {
			resolved = input.ResolveSnapshot(current)
		}
		base := current
		if isZeroRecord(base) && recoverFromSnapshot {
			base = resolved
		}
		if isZeroRecord(base) {
			outcome = &CommitVoucherChargeResult[T]{Status: CommitMissing}
			return current
		}

		charged, ok := new(big.Int).SetString(base.Base().ChargedCumulativeAmount, 10)
		if !ok || charged.Sign() < 0 {
			// Fail closed on a corrupt watermark: leave the row unchanged.
			// The CAS no-op maps to CommitConflict below.
			outcome = &CommitVoucherChargeResult[T]{Status: CommitConflict}
			return current
		}
		increment := input.Increment
		if increment == nil {
			increment = new(big.Int)
		}
		signedCap := input.SignedCap
		if signedCap == nil {
			signedCap = new(big.Int)
		}
		newCharged := new(big.Int).Add(charged, increment)
		if newCharged.Cmp(signedCap) > 0 {
			outcome = &CommitVoucherChargeResult[T]{Status: CommitCapExceeded, Charged: newCharged.String()}
			return current
		}

		updated := base.Clone()
		ub := updated.Base()
		if !input.LocalVerify && !isZeroRecord(resolved) {
			snap := resolved.Base()
			ub.Balance = snap.Balance
			// Deposit snapshots mirror escrow; the claimed watermark only moves forward.
			ub.TotalClaimed = maxUint256String(ub.TotalClaimed, snap.TotalClaimed)
			ub.WithdrawRequestedAt = snap.WithdrawRequestedAt
			ub.RefundNonce = snap.RefundNonce
			ub.OnchainSyncedAt = now
		}
		ub.ChargedCumulativeAmount = newCharged.String()
		ub.SignedMaxClaimable = input.Voucher.MaxClaimableAmount
		ub.Signature = input.Voucher.Signature
		ub.LastRequestTimestamp = now
		if input.Map != nil {
			updated = input.Map(updated)
		}
		outcome = &CommitVoucherChargeResult[T]{Status: CommitCommitted, Previous: base.Base().Clone(), Current: updated}
		return updated
	})
	if err != nil {
		return nil, err
	}
	if outcome != nil && (outcome.Status == CommitMissing || outcome.Status == CommitCapExceeded) {
		return outcome, nil
	}
	if updateResult.Status != ChannelUpdated || outcome == nil || outcome.Status != CommitCommitted {
		return &CommitVoucherChargeResult[T]{Status: CommitConflict}, nil
	}
	return outcome, nil
}

// maxUint256String returns the greater decimal uint256.
// An unparseable operand leaves current in place.
func maxUint256String(current, next string) string {
	cmp, ok := Uint256Cmp(current, next)
	if !ok || cmp >= 0 {
		return current
	}
	return next
}
