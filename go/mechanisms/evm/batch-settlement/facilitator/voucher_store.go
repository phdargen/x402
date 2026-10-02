package facilitator

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"math/big"
	"regexp"
	"strings"
	"time"

	"github.com/ethereum/go-ethereum/common"

	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/evm"
	batchsettlement "github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement"
	"github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement/storage"
	"github.com/x402-foundation/x402/go/v2/types"
)

var decimalUintRe = regexp.MustCompile(`^\d+$`)

// createNonce generates the verify admission pendingId. It is a variable so
// unit tests can force the crypto/rand failure path without stubbing.
var createNonce = evm.CreateNonce

// VoucherStoreDeps is the store, lock, and signer bag for managed verify/settle.
type VoucherStoreDeps struct {
	Signer                  evm.FacilitatorEvmSigner
	AuthorizerSigner        batchsettlement.AuthorizerSigner
	AuthorizerSubmitter     evm.FacilitatorEvmSigner
	SubmitMode              SubmitMode
	Storage                 storage.ChannelStorage[*FacilitatorChannel]
	LockStorage             storage.ChannelLockStorage
	WithdrawDelay           int
	OnchainStateTtlMs       *int64
	ResolveCallerIdentity   ResolveCallerIdentity
	DelegatedAuthStore      storage.DelegatedAuthStore
	EIP6492AllowedFactories []string
	PendingStore            x402.PendingSettlementStore
	KeepFinishedRows        bool
	SettleTargetStorage     storage.SettleTargetStorage
	OnStorageError          func(err error, network, channelId string)
	Logger                  *slog.Logger
}

func boundAdmissionOwner(pendingId string, voucher batchsettlement.BatchSettlementVoucherFields) string {
	if pendingId == "" {
		return ""
	}
	return storage.AdmissionOwner(pendingId, voucher)
}

func admissionHeld(ctx context.Context, deps VoucherStoreDeps, channelId, owner string) (bool, error) {
	if owner == "" {
		return false, nil
	}
	return deps.LockStorage.IsHeld(ctx, channelId, owner)
}

func releaseAdmission(ctx context.Context, deps VoucherStoreDeps, channelId, owner string) error {
	if owner == "" {
		return nil
	}
	return releaseLock(ctx, deps, channelId, owner)
}

// acquireAdmission reserves the channel for a fresh owner bound to voucher.
// A live hold or lock I/O failure is a *x402.VerifyError for callers to map
// into verify/settle responses; implementation errors are returned as-is.
func acquireAdmission(
	ctx context.Context,
	deps VoucherStoreDeps,
	voucher batchsettlement.BatchSettlementVoucherFields,
	ttlMs int64,
	missReason string,
) (pendingId, owner string, err error) {
	pendingId, err = createNonce()
	if err != nil {
		return "", "", x402.NewVerifyError(ErrVoucherStoreUnavailable, "", err.Error())
	}
	owner = storage.AdmissionOwner(pendingId, voucher)
	acquired, err := deps.LockStorage.Acquire(ctx, voucher.ChannelId, owner, ttlMs)
	if impl := storage.RethrowLockImplementationError(err); impl != nil {
		return "", "", impl
	}
	if err != nil {
		return "", "", x402.NewVerifyError(ErrRpcReadFailed, "", err.Error())
	}
	if !acquired {
		return "", "", x402.NewVerifyError(missReason, "", "")
	}
	return pendingId, owner, nil
}

func onchainStateTtlMs(deps VoucherStoreDeps) int64 {
	if deps.OnchainStateTtlMs != nil {
		return *deps.OnchainStateTtlMs
	}
	return storage.DefaultOnchainStateTtlMs(deps.WithdrawDelay)
}

// VerifyManaged is facilitator-managed /verify.
func VerifyManaged(
	ctx context.Context,
	deps VoucherStoreDeps,
	payload types.PaymentPayload,
	requirements types.PaymentRequirements,
	fctx *x402.FacilitatorContext,
) (*x402.VerifyResponse, error) {
	raw := payload.Payload
	if raw == nil || !isManagedClientPayload(raw) {
		return &x402.VerifyResponse{IsValid: false, InvalidReason: ErrInvalidPayload}, nil
	}
	if _, ok := raw["cancel"]; ok {
		payer := payloadPayer(raw)
		return &x402.VerifyResponse{IsValid: false, InvalidReason: ErrUnexpectedCancel, Payer: payer}, nil
	}

	channelConfig, voucher, payer, err := parseManagedChannel(raw)
	if err != nil {
		return &x402.VerifyResponse{IsValid: false, InvalidReason: ErrInvalidPayload, Payer: payer}, nil
	}
	if managedErr := managedRequirementError(deps, channelConfig.Salt, requirements); managedErr != "" {
		return &x402.VerifyResponse{IsValid: false, InvalidReason: managedErr, Payer: payer}, nil
	}
	// requirements.amount comes from the resource server and floors every paid request, so it is
	// validated before any cached-state path can consume it. Refunds are zero-charge and skip it.
	if !batchsettlement.IsRefundPayload(raw) {
		if _, ok := parseRequirementsAmount(requirements.Amount); !ok {
			reason := ErrInvalidVoucherPayload
			if batchsettlement.IsDepositPayload(raw) {
				reason = ErrInvalidDepositPayload
			}
			return &x402.VerifyResponse{IsValid: false, InvalidReason: reason, InvalidMessage: "invalid requirements amount", Payer: payer}, nil
		}
		// accepted.amount is the priced maximum.
		if payload.Accepted.Amount != requirements.Amount {
			return &x402.VerifyResponse{IsValid: false, InvalidReason: ErrInvalidPayload, Payer: payer}, nil
		}
	}

	var clearance eoaSignatureClearance
	if batchsettlement.IsVoucherPayload(raw) && !strings.EqualFold(channelConfig.PayerAuthorizer, zeroAddress) {
		vp, parseErr := batchsettlement.VoucherPayloadFromMap(raw)
		if parseErr != nil || !batchsettlement.VerifyEoaVoucherSignature(vp, requirements.Network) {
			return &x402.VerifyResponse{IsValid: false, InvalidReason: ErrVoucherSignatureInvalid, Payer: payer}, nil
		}
		clearance = eoaSignatureClearance{
			channelId:    vp.Voucher.ChannelId,
			maxClaimable: vp.Voucher.MaxClaimableAmount,
			signature:    vp.Voucher.Signature,
		}
	}

	channelId := voucher.ChannelId
	pendingId, owner, lockErr := acquireAdmission(ctx, deps, voucher, storage.PendingTtlMs(requirements.MaxTimeoutSeconds), ErrChannelBusy)
	if lockErr != nil {
		if impl := storage.RethrowLockImplementationError(lockErr); impl != nil {
			return nil, impl
		}
		return verifyResponseFromErr(lockErr, payer), nil
	}
	reserved := true
	defer func() {
		if reserved {
			_ = releaseLock(ctx, deps, channelId, owner)
		}
	}()

	stored, getErr := deps.Storage.Get(ctx, channelId)
	if impl := storage.RethrowLockImplementationError(getErr); impl != nil {
		return nil, impl
	}
	if getErr != nil {
		return &x402.VerifyResponse{IsValid: false, InvalidReason: ErrRpcReadFailed, Payer: payer}, nil
	}

	verified, verifyErr := verifyManagedPayload(ctx, deps, payload, requirements, fctx, stored, clearance)
	if impl := storage.RethrowLockImplementationError(verifyErr); impl != nil {
		return nil, impl
	}
	if verifyErr != nil {
		return verifyResponseFromErr(verifyErr, payer), nil
	}
	if !verified.IsValid {
		return verified, nil
	}

	onchainClaimed, claimedOk := readExtraTotalClaimed(verified.Extra)
	if !claimedOk {
		// Without the facilitator-read onchain baseline there is nothing safe to charge against.
		return &x402.VerifyResponse{IsValid: false, InvalidReason: ErrRpcReadFailed, Payer: payer}, nil
	}
	charged := onchainClaimed
	if stored != nil {
		charged = stored.ChargedCumulativeAmount
	}
	isRefund := batchsettlement.IsRefundPayload(raw)
	chargedInt, chargedOk := parseManagedUint(charged)
	if !chargedOk {
		return &x402.VerifyResponse{
			IsValid:       false,
			InvalidReason: ErrCumulativeAmountMismatch,
			Payer:         payer,
			Extra:         mismatchVerifyExtra(channelId, verified.Extra, stored, charged),
		}, nil
	}
	expected := new(big.Int)
	if isRefund {
		expected.Set(chargedInt)
	} else {
		amt, amtOk := parseManagedUint(requirements.Amount)
		if !amtOk {
			return &x402.VerifyResponse{
				IsValid:       false,
				InvalidReason: ErrCumulativeAmountMismatch,
				Payer:         payer,
				Extra:         mismatchVerifyExtra(channelId, verified.Extra, stored, charged),
			}, nil
		}
		expected.Add(chargedInt, amt)
	}
	maxClaimable, maxOk := parseManagedUint(voucher.MaxClaimableAmount)
	if !maxOk || maxClaimable.Cmp(expected) != 0 {
		return &x402.VerifyResponse{
			IsValid:       false,
			InvalidReason: ErrCumulativeAmountMismatch,
			Payer:         payer,
			Extra:         mismatchVerifyExtra(channelId, verified.Extra, stored, charged),
		}, nil
	}

	reserved = false
	extra := copyExtra(verified.Extra)
	extra["chargedCumulativeAmount"] = charged
	extra["pendingId"] = pendingId
	verified.Extra = extra
	return verified, nil
}

// SettleManaged is facilitator-managed /settle.
func SettleManaged(
	ctx context.Context,
	deps VoucherStoreDeps,
	payload types.PaymentPayload,
	requirements types.PaymentRequirements,
	fctx *x402.FacilitatorContext,
	dataSuffix []byte,
) (*x402.SettleResponse, error) {
	raw := payload.Payload
	if raw == nil {
		return failSettle(requirements, ErrInvalidPayload), nil
	}
	if isCancelSettlePayload(raw) {
		return settleManagedCancel(ctx, deps, raw, requirements)
	}
	if batchsettlement.IsVoucherPayload(raw) {
		vp, err := batchsettlement.VoucherPayloadFromMap(raw)
		if err != nil {
			return nil, x402.NewSettleError(ErrInvalidPayload, "", x402.Network(requirements.Network), "", err.Error())
		}
		return settleManagedVoucher(ctx, deps, vp, payload.Accepted.Amount, requirements)
	}
	if batchsettlement.IsDepositPayload(raw) {
		dp, err := batchsettlement.DepositPayloadFromMap(raw)
		if err != nil {
			return nil, x402.NewSettleError(ErrInvalidPayload, "", x402.Network(requirements.Network), "", err.Error())
		}
		return settleManagedDeposit(ctx, deps, payload, dp, requirements, fctx, dataSuffix)
	}
	if batchsettlement.IsRefundPayload(raw) {
		rp, err := batchsettlement.EnrichedRefundPayloadFromMap(raw)
		if err != nil {
			return nil, x402.NewSettleError(ErrInvalidPayload, "", x402.Network(requirements.Network), "", err.Error())
		}
		return settleManagedRefund(ctx, deps, payload, rp, requirements, fctx, dataSuffix)
	}
	return failSettle(requirements, ErrInvalidPayload), nil
}

func settleManagedCancel(
	ctx context.Context,
	deps VoucherStoreDeps,
	raw map[string]interface{},
	requirements types.PaymentRequirements,
) (*x402.SettleResponse, error) {
	_, voucher, payer, err := parseManagedChannel(raw)
	if err != nil {
		return nil, x402.NewSettleError(ErrInvalidPayload, "", x402.Network(requirements.Network), "", err.Error())
	}
	pendingId, _ := raw["pendingId"].(string)
	owner := boundAdmissionOwner(pendingId, voucher)
	if impl := storage.RethrowLockImplementationError(releaseAdmission(ctx, deps, voucher.ChannelId, owner)); impl != nil {
		return nil, impl
	}
	return &x402.SettleResponse{
		Success:     true,
		Transaction: "",
		Network:     x402.Network(requirements.Network),
		Payer:       strings.ToLower(payer),
		Amount:      "",
	}, nil
}

// settleChargeBounds re-checks the verify watermark at settle.
// expectedCharged is signedCap minus acceptedAmount.
func settleChargeBounds(acceptedAmount, actualAmount, signedCap string) (increment, cap, expectedCharged *big.Int, reason string) {
	accepted, ok := parseRequirementsAmount(acceptedAmount)
	if !ok {
		return nil, nil, nil, ErrInvalidPayload
	}
	increment, ok = parseRequirementsAmount(actualAmount)
	if !ok {
		return nil, nil, nil, ErrInvalidPayload
	}
	cap, ok = parseManagedUint(signedCap)
	if !ok {
		return nil, nil, nil, ErrInvalidPayload
	}
	if increment.Cmp(accepted) > 0 {
		return nil, nil, nil, ErrChargeExceedsSignedCumulative
	}
	if accepted.Cmp(cap) > 0 {
		return nil, nil, nil, ErrInvalidPayload
	}
	return increment, cap, new(big.Int).Sub(cap, accepted), ""
}

func settleManagedVoucher(
	ctx context.Context,
	deps VoucherStoreDeps,
	raw *batchsettlement.BatchSettlementVoucherPayload,
	acceptedAmount string,
	requirements types.PaymentRequirements,
) (*x402.SettleResponse, error) {
	channelId := raw.Voucher.ChannelId
	owner := boundAdmissionOwner(raw.PendingId, raw.Voucher)
	defer func() {
		_ = releaseAdmission(ctx, deps, channelId, owner)
	}()

	if managedErr := managedRequirementError(deps, raw.ChannelConfig.Salt, requirements); managedErr != "" {
		return failSettle(requirements, managedErr), nil
	}
	increment, signedCap, expectedCharged, boundReason := settleChargeBounds(acceptedAmount, requirements.Amount, raw.Voucher.MaxClaimableAmount)
	if boundReason != "" {
		return failSettle(requirements, boundReason), nil
	}

	held, heldErr := admissionHeld(ctx, deps, channelId, owner)
	if impl := storage.RethrowLockImplementationError(heldErr); impl != nil {
		return nil, impl
	}
	var mirror voucherMirror
	var reason string
	if heldErr == nil && held {
		if configErr := batchsettlement.ValidateChannelConfig(raw.ChannelConfig, raw.Voucher.ChannelId, requirements); configErr != "" {
			return failSettle(requirements, configErr), nil
		}
		var err error
		mirror, err = heldVoucherMirror(ctx, deps, raw, requirements)
		if resp, settleErr := failSettleFromErr(requirements, err); settleErr != nil || resp != nil {
			return resp, settleErr
		}
	} else {
		_, fresh, err := acquireAdmission(ctx, deps, raw.Voucher, storage.PendingTtlMs(requirements.MaxTimeoutSeconds), ErrPendingIdMismatch)
		if resp, settleErr := failSettleFromErr(requirements, err); settleErr != nil || resp != nil {
			return resp, settleErr
		}
		defer func() {
			_ = releaseAdmission(ctx, deps, channelId, fresh)
		}()
		mirror, reason = verifiedVoucherMirror(ctx, deps, raw, requirements)
	}
	if reason != "" {
		return failSettle(requirements, reason), nil
	}

	var mapper func(*FacilitatorChannel) *FacilitatorChannel
	if increment.Sign() != 0 {
		network := requirements.Network
		mapper = func(channel *FacilitatorChannel) *FacilitatorChannel {
			return incrementChargeCount(channel, network)
		}
	}
	outcome, err := storage.CommitVoucherCharge(ctx, deps.Storage, channelId, storage.CommitVoucherChargeInput[*FacilitatorChannel]{
		Increment:       increment,
		SignedCap:       signedCap,
		ExpectedCharged: expectedCharged,
		Voucher:         raw.Voucher,
		ResolveSnapshot: mirror.snapshot,
		Map:             mapper,
	})
	if err != nil {
		return failSettle(requirements, ErrChannelBusy), nil
	}
	if outcome.Status == storage.CommitMissing {
		return failSettle(requirements, ErrMissingChannel), nil
	}
	if outcome.Status == storage.CommitCapExceeded {
		return failSettle(requirements, ErrChargeExceedsSignedCumulative), nil
	}
	if outcome.Status == storage.CommitWatermarkMismatch {
		return failSettle(requirements, ErrCumulativeAmountMismatch), nil
	}
	if outcome.Status != storage.CommitCommitted {
		return failSettle(requirements, ErrChannelBusy), nil
	}

	chargedAmt := requirements.Amount
	chargeCount := outcome.Current.ChargeCount
	channelState := storage.ChannelStateExtra(outcome.Current.Base(), &outcome.Current.ChargedCumulativeAmount)
	extra := storage.PaymentResponseExtra(channelState, &chargedAmt, &chargeCount)
	return &x402.SettleResponse{
		Success:     true,
		Transaction: "",
		Network:     x402.Network(requirements.Network),
		Payer:       strings.ToLower(raw.ChannelConfig.Payer),
		Amount:      "",
		Extra:       extra.ToMap(),
	}, nil
}

func settleManagedDeposit(
	ctx context.Context,
	deps VoucherStoreDeps,
	payment types.PaymentPayload,
	raw *batchsettlement.BatchSettlementDepositPayload,
	requirements types.PaymentRequirements,
	fctx *x402.FacilitatorContext,
	dataSuffix []byte,
) (*x402.SettleResponse, error) {
	channelId := raw.Voucher.ChannelId
	owner := boundAdmissionOwner(raw.PendingId, raw.Voucher)
	defer func() {
		_ = releaseAdmission(ctx, deps, channelId, owner)
	}()

	// Reject an actual above the accepted maximum before broadcast. The commit
	// below still re-checks the watermark on a reconciled retry.
	increment, signedCap, expectedCharged, boundReason := settleChargeBounds(payment.Accepted.Amount, requirements.Amount, raw.Voucher.MaxClaimableAmount)
	if boundReason != "" {
		return failSettle(requirements, boundReason), nil
	}

	identity, bindErr := ResolveDepositDelegatedCaller(ctx, deps.ResolveCallerIdentity, deps.DelegatedAuthStore,
		payment, raw, requirements, fctx)
	if bindErr != nil {
		var se *x402.SettleError
		if errors.As(bindErr, &se) {
			return failSettle(requirements, se.ErrorReason), nil
		}
		return failSettle(requirements, ErrVoucherStoreUnavailable), nil
	}

	settled, syncedAt, err := SettleDeposit(ctx, deps.Signer, raw, requirements, payment.Extensions, fctx, dataSuffix, deps.EIP6492AllowedFactories, deps.PendingStore,
		newDelegatedDepositBinding(deps.DelegatedAuthStore, identity, deps.OnStorageError))
	if err != nil {
		return nil, err
	}
	if !settled.Success {
		return settled, nil
	}

	outcome, commitErr := storage.CommitVoucherCharge(ctx, deps.Storage, channelId, storage.CommitVoucherChargeInput[*FacilitatorChannel]{
		Increment:       increment,
		SignedCap:       signedCap,
		ExpectedCharged: expectedCharged,
		Voucher:         raw.Voucher,
		ResolveSnapshot: func(current *FacilitatorChannel) *FacilitatorChannel {
			return depositChargeSnapshot(raw, requirements, settled.Extra, current, syncedAt)
		},
		Map: func(channel *FacilitatorChannel) *FacilitatorChannel {
			return incrementChargeCount(channel, requirements.Network)
		},
	})
	if commitErr != nil {
		return failDepositPersist(settled, ErrVoucherStoreUnavailable), nil
	}
	if outcome == nil || outcome.Status != storage.CommitCommitted {
		return failDepositPersist(settled, depositPersistReason(outcome)), nil
	}

	channelState := storage.ChannelStateExtra(outcome.Current.Base(), &outcome.Current.ChargedCumulativeAmount)
	if nested, ok := settled.Extra["channelState"].(map[string]interface{}); ok {
		merged := copyExtra(nested)
		for k, v := range channelState.ToMap() {
			merged[k] = v
		}
		chargedAmt := requirements.Amount
		chargeCount := outcome.Current.ChargeCount
		cs := channelStateFromMap(merged)
		extra := storage.PaymentResponseExtra(cs, &chargedAmt, &chargeCount)
		settled.Extra = extra.ToMap()
		return settled, nil
	}
	chargedAmt := requirements.Amount
	chargeCount := outcome.Current.ChargeCount
	extra := storage.PaymentResponseExtra(channelState, &chargedAmt, &chargeCount)
	merged := copyExtra(settled.Extra)
	for k, v := range extra.ToMap() {
		merged[k] = v
	}
	settled.Extra = merged
	return settled, nil
}

func settleManagedRefund(
	ctx context.Context,
	deps VoucherStoreDeps,
	payment types.PaymentPayload,
	raw *batchsettlement.BatchSettlementEnrichedRefundPayload,
	requirements types.PaymentRequirements,
	fctx *x402.FacilitatorContext,
	dataSuffix []byte,
) (*x402.SettleResponse, error) {
	channelId := raw.Voucher.ChannelId
	owner := boundAdmissionOwner(raw.PendingId, raw.Voucher)
	defer func() {
		_ = releaseAdmission(ctx, deps, channelId, owner)
	}()

	if amountError := refundAmountError(raw.Amount); amountError != "" {
		return failSettle(requirements, amountError), nil
	}
	stored, err := deps.Storage.Get(ctx, channelId)
	if err != nil {
		return failSettle(requirements, ErrRpcReadFailed), nil
	}
	if consentErr := checkRefundConsent(ctx, deps, payment, raw, requirements, fctx, stored); consentErr != "" {
		return failSettle(requirements, consentErr), nil
	}
	if stored == nil {
		return failSettle(requirements, ErrCumulativeAmountMismatch), nil
	}
	if !sameUint(raw.Voucher.MaxClaimableAmount, stored.ChargedCumulativeAmount) {
		return failSettle(requirements, ErrCumulativeAmountMismatch), nil
	}

	if _, readErr := ReadChannelState(ctx, deps.Signer, channelId); readErr != nil {
		return failSettle(requirements, ErrRpcReadFailed), nil
	}

	claims := rebuildClaims(stored)
	amount := resolveRefundAmount(raw.Amount, stored)
	nonce := fmt.Sprintf("%d", stored.RefundNonce)
	enriched := *raw
	enriched.Amount = amount
	enriched.RefundNonce = nonce
	enriched.Claims = claims
	enriched.RefundAuthorizerSignature = ""
	enriched.ClaimAuthorizerSignature = ""

	var (
		claimSuffix []byte
		begun       []attestedClaim
	)
	if len(claims) > 0 {
		one, busy, beginErr := beginAttestedClaim(ctx, deps.Storage, channelId, claims[0].TotalClaimed, time.Now().UnixMilli())
		if beginErr != nil {
			return nil, beginErr
		}
		if busy {
			return failSettle(requirements, ErrChannelBusy), nil
		}
		begun = []attestedClaim{one}
		claimSuffix, err = batchsettlement.EncodeChargeCountsSuffix([]uint64{chargeCountUint(one.Count)})
		if err != nil {
			_ = abortAttestedClaims(ctx, deps.Storage, begun)
			return failSettle(requirements, ErrRpcReadFailed), nil
		}
	}
	settled, err := SubmitRefund(ctx, SubmitRefundInput{
		Network:         requirements.Network,
		Payload:         &enriched,
		DataSuffix:      dataSuffix,
		ClaimDataSuffix: claimSuffix,
	}, SubmitContext{
		SubmitMode:          deps.SubmitMode,
		Signer:              deps.Signer,
		AuthorizerSigner:    deps.AuthorizerSigner,
		AuthorizerSubmitter: deps.AuthorizerSubmitter,
	})
	landed, releaseErr := releaseAttestedClaims(ctx, deps.Storage, begun, err, settled)
	if err != nil {
		if releaseErr != nil {
			return nil, releaseErr
		}
		return nil, err
	}
	if !landed {
		if releaseErr != nil {
			return nil, releaseErr
		}
		return settled, nil
	}

	extraState, _ := settled.Extra["channelState"].(map[string]interface{})
	if len(claims) > 0 {
		newClaimed := refundClaimedTotal(stored.TotalClaimed, claims, extraState)
		if deltaErr := applyClaimedSettleDelta(ctx, deps.SettleTargetStorage, requirements.Network, stored.ChannelConfig.Receiver, stored.ChannelConfig.Token, newClaimed, stored.TotalClaimed); deltaErr != nil {
			return settled, nil
		}
		if finishErr := finishAttestedClaim(ctx, deps.Storage, channelId, newClaimed); finishErr != nil {
			voucherStoreLogger(deps).Warn("batch-settlement: refund landed but attested claim was not applied", "channel_id", channelId, "error", finishErr)
		}
	}
	if releaseErr != nil {
		voucherStoreLogger(deps).Warn("batch-settlement: refund landed but claim marker hash was not stored", "channel_id", channelId, "error", releaseErr)
	}
	balance := stored.Balance
	totalClaimed := stored.TotalClaimed
	if extraState != nil {
		if v, ok := extraState["balance"].(string); ok {
			balance = v
		}
		if v, ok := extraState["totalClaimed"].(string); ok {
			totalClaimed = v
		}
	}

	updated, err := deps.Storage.UpdateChannel(ctx, channelId, func(current *FacilitatorChannel) *FacilitatorChannel {
		if current == nil {
			return current
		}
		next := current.Clone()
		next.Balance = balance
		next.TotalClaimed = totalClaimed
		if extraState != nil {
			if v, ok := extraNumber(extraState["withdrawRequestedAt"]); ok {
				next.WithdrawRequestedAt = v
			}
			if v, ok := extraUintString(extraState["refundNonce"]); ok {
				if n, ok := extraNumber(v); ok {
					next.RefundNonce = n
				}
			} else if v, ok := extraNumber(extraState["refundNonce"]); ok {
				next.RefundNonce = v
			} else {
				next.RefundNonce = current.RefundNonce + 1
			}
		} else {
			next.RefundNonce = current.RefundNonce + 1
		}
		next.LastRequestTimestamp = time.Now().UnixMilli()
		if ShouldDeleteNeverClaimedRefundRow(deps.KeepFinishedRows, next, next.ChargeCount, totalClaimed) {
			return nil
		}
		return next
	})
	if err != nil {
		return settled, nil
	}
	if updated != nil && updated.Status == storage.ChannelConflict {
		voucherStoreLogger(deps).Warn("batch-settlement: refund landed but channel row update conflicted", "channel_id", channelId)
	}

	chargeCount := 0
	if updated != nil && updated.Channel != nil {
		chargeCount = updated.Channel.ChargeCount
	}
	cs := storage.ChannelStateExtra(stored.Base(), &stored.ChargedCumulativeAmount)
	if extraState != nil {
		merged := copyExtra(extraState)
		for k, v := range cs.ToMap() {
			if k == "chargedCumulativeAmount" {
				merged[k] = v
			}
		}
		cs = channelStateFromMap(merged)
	}
	extra := storage.PaymentResponseExtra(cs, nil, &chargeCount)
	settled.Extra = extra.ToMap()
	return settled, nil
}

func verifyManagedPayload(
	ctx context.Context,
	deps VoucherStoreDeps,
	payload types.PaymentPayload,
	requirements types.PaymentRequirements,
	fctx *x402.FacilitatorContext,
	stored *FacilitatorChannel,
	clearance eoaSignatureClearance,
) (*x402.VerifyResponse, error) {
	raw := payload.Payload
	if batchsettlement.IsDepositPayload(raw) {
		dp, err := batchsettlement.DepositPayloadFromMap(raw)
		if err != nil {
			return nil, x402.NewVerifyError(ErrInvalidPayload, payloadPayer(raw), err.Error())
		}
		return VerifyDeposit(ctx, deps.Signer, dp, requirements, payload.Extensions, fctx, deps.EIP6492AllowedFactories)
	}
	if batchsettlement.IsVoucherPayload(raw) {
		vp, err := batchsettlement.VoucherPayloadFromMap(raw)
		if err != nil {
			return nil, x402.NewVerifyError(ErrInvalidPayload, payloadPayer(raw), err.Error())
		}
		if cached := batchsettlement.EvaluateVoucherAgainstCachedState(vp, requirements, cachedOnchain(stored), time.Now().UnixMilli(), onchainStateTtlMs(deps)); cached != nil {
			return cached, nil
		}
		return verifyVoucherFields(ctx, deps.Signer, &vp.Voucher, vp.ChannelConfig, requirements, false, clearance)
	}
	rp, err := batchsettlement.RefundPayloadFromMap(raw)
	if err != nil {
		return nil, x402.NewVerifyError(ErrInvalidPayload, payloadPayer(raw), err.Error())
	}
	return VerifyRefundVoucher(ctx, deps.Signer, rp, requirements, rp.ChannelConfig)
}

func managedRequirementError(deps VoucherStoreDeps, salt string, requirements types.PaymentRequirements) string {
	extra := requirements.Extra
	if extra == nil {
		extra = map[string]interface{}{}
	}
	advertised, _ := extra["receiverAuthorizer"].(string)
	if advertised == "" || !sameAddress(advertised, deps.AuthorizerSigner.Address()) {
		return ErrReceiverAuthorizerMismatch
	}
	delay, ok := extraNumber(extra["withdrawDelay"])
	if !ok || delay != deps.WithdrawDelay {
		return ErrWithdrawDelayMismatch
	}
	refundAuthorizer, _ := extra["refundAuthorizer"].(string)
	if refundAuthorizer != "" {
		unpacked := batchsettlement.UnpackRefundAuthorizer(salt)
		if !sameAddress(unpacked, refundAuthorizer) {
			return ErrRefundAuthorizerMismatch
		}
	}
	return ""
}

func checkRefundConsent(
	ctx context.Context,
	deps VoucherStoreDeps,
	payment types.PaymentPayload,
	raw *batchsettlement.BatchSettlementEnrichedRefundPayload,
	requirements types.PaymentRequirements,
	fctx *x402.FacilitatorContext,
	stored *FacilitatorChannel,
) string {
	if amountError := refundAmountError(raw.Amount); amountError != "" {
		return amountError
	}
	extra := requirements.Extra
	if extra == nil {
		extra = map[string]interface{}{}
	}
	refundAuthorizer, _ := extra["refundAuthorizer"].(string)
	if refundAuthorizer != "" {
		unpacked := batchsettlement.UnpackRefundAuthorizer(raw.ChannelConfig.Salt)
		if !sameAddress(unpacked, refundAuthorizer) {
			return ErrRefundAuthorizerMismatch
		}
		signature := raw.RefundAuthorizerSignature
		if signature == "" {
			if v, ok := payment.Payload["refundAuthorizerSignature"].(string); ok {
				signature = v
			}
		}
		if signature == "" {
			return ErrRefundAuthorizerSignature
		}
		amount := resolveRefundAmount(raw.Amount, stored)
		nonce := "0"
		if stored != nil {
			nonce = fmt.Sprintf("%d", stored.RefundNonce)
		}
		if !verifyRefundAuthorizerSignature(signature, refundAuthorizer, raw.Voucher.ChannelId, amount, nonce, requirements.Network) {
			return ErrRefundAuthorizerSignature
		}
		return ""
	}

	if deps.ResolveCallerIdentity == nil {
		return ErrRefundAuthorizerSignature
	}
	identity, err := resolveIdentity(deps, DelegatedSettleContext{
		Ctx:                ctx,
		Step:               DelegatedSettleStepRefund,
		ChannelId:          raw.Voucher.ChannelId,
		Network:            requirements.Network,
		Payer:              raw.ChannelConfig.Payer,
		Payload:            payment,
		Requirements:       requirements,
		FacilitatorContext: fctx,
	})
	if err != nil || identity == "" {
		return ErrRefundAuthorizerSignature
	}

	if deps.DelegatedAuthStore == nil {
		return ErrRefundAuthorizerSignature
	}
	binding, getErr := deps.DelegatedAuthStore.Get(ctx, raw.Voucher.ChannelId, requirements.Network)
	if getErr != nil || binding == nil || binding.CallerIdentity != identity {
		return ErrRefundAuthorizerSignature
	}
	return ""
}

func verifyRefundAuthorizerSignature(signature, refundAuthorizer, channelId, amount, nonce, network string) bool {
	chainID, err := evm.GetEvmChainId(network)
	if err != nil {
		return false
	}
	refundAmount, ok := new(big.Int).SetString(amount, 10)
	if !ok {
		return false
	}
	refundNonce, ok := new(big.Int).SetString(nonce, 10)
	if !ok {
		return false
	}
	hash, err := evm.HashTypedData(
		batchsettlement.GetBatchSettlementEip712Domain(chainID),
		batchsettlement.RefundTypes,
		"Refund",
		map[string]interface{}{
			"channelId": channelId,
			"nonce":     refundNonce,
			"amount":    refundAmount,
		},
	)
	if err != nil {
		return false
	}
	ok, err = evm.VerifyEOASignature(hash, common.FromHex(signature), common.HexToAddress(refundAuthorizer))
	return err == nil && ok
}

func resolveIdentity(deps VoucherStoreDeps, settleCtx DelegatedSettleContext) (string, error) {
	if deps.ResolveCallerIdentity == nil {
		return "", nil
	}
	return deps.ResolveCallerIdentity(settleCtx)
}

func releaseLock(ctx context.Context, deps VoucherStoreDeps, channelId, owner string) error {
	err := deps.LockStorage.Release(ctx, channelId, owner)
	if impl := storage.RethrowLockImplementationError(err); impl != nil {
		return impl
	}
	return nil
}

func incrementChargeCount(channel *FacilitatorChannel, network string) *FacilitatorChannel {
	next := channel.Clone()
	next.Network = network
	next.ChargeCount++
	return next
}

// depositChargeSnapshot always carries the settle extra's escrow.
// OnchainSyncedAt is syncedAt, so an unconfirmed deposit leaves the stored stamp.
func depositChargeSnapshot(
	raw *batchsettlement.BatchSettlementDepositPayload,
	requirements types.PaymentRequirements,
	extra map[string]interface{},
	stored *FacilitatorChannel,
	syncedAt int64,
) *FacilitatorChannel {
	confirmed := readDepositConfirmState(extra)
	snap := &FacilitatorChannel{
		Channel: storage.Channel{
			ChannelId:               raw.Voucher.ChannelId,
			ChannelConfig:           raw.ChannelConfig,
			ChargedCumulativeAmount: "0",
			SignedMaxClaimable:      raw.Voucher.MaxClaimableAmount,
			Signature:               raw.Voucher.Signature,
			Balance:                 "0",
			TotalClaimed:            "0",
			LastRequestTimestamp:    time.Now().UnixMilli(),
			OnchainSyncedAt:         syncedAt,
			Network:                 requirements.Network,
		},
	}
	if stored != nil {
		snap.ChannelConfig = stored.ChannelConfig
		snap.ChargedCumulativeAmount = stored.ChargedCumulativeAmount
		snap.Balance = stored.Balance
		snap.TotalClaimed = stored.TotalClaimed
		snap.WithdrawRequestedAt = stored.WithdrawRequestedAt
		snap.RefundNonce = stored.RefundNonce
		snap.LastRequestTimestamp = stored.LastRequestTimestamp
		snap.Network = stored.Network
		snap.ChargeCount = stored.ChargeCount
	}
	if confirmed.TotalClaimed != nil {
		if stored == nil {
			snap.ChargedCumulativeAmount = *confirmed.TotalClaimed
		}
		snap.TotalClaimed = *confirmed.TotalClaimed
	}
	if confirmed.Balance != nil {
		snap.Balance = *confirmed.Balance
	}
	if confirmed.WithdrawRequestedAt != nil {
		snap.WithdrawRequestedAt = *confirmed.WithdrawRequestedAt
	}
	if confirmed.RefundNonce != nil {
		snap.RefundNonce = *confirmed.RefundNonce
	}
	return snap
}

type depositConfirmState struct {
	Balance             *string
	TotalClaimed        *string
	WithdrawRequestedAt *int
	RefundNonce         *int
}

func readDepositConfirmState(extra map[string]interface{}) depositConfirmState {
	state := extra
	if extra != nil {
		if nested, ok := extra["channelState"].(map[string]interface{}); ok && nested != nil {
			state = nested
		}
	}
	if state == nil {
		state = map[string]interface{}{}
	}
	return depositConfirmState{
		Balance:             optionalUintString(state["balance"]),
		TotalClaimed:        optionalUintString(state["totalClaimed"]),
		WithdrawRequestedAt: optionalUintNumber(state["withdrawRequestedAt"]),
		RefundNonce:         optionalUintNumber(state["refundNonce"]),
	}
}

func optionalUintString(value interface{}) *string {
	switch v := value.(type) {
	case string:
		if decimalUintRe.MatchString(v) {
			s := v
			return &s
		}
	case int:
		if v >= 0 {
			s := fmt.Sprintf("%d", v)
			return &s
		}
	case int64:
		if v >= 0 {
			s := fmt.Sprintf("%d", v)
			return &s
		}
	case float64:
		if v >= 0 && v == float64(int(v)) {
			s := fmt.Sprintf("%d", int(v))
			return &s
		}
	}
	return nil
}

func optionalUintNumber(value interface{}) *int {
	if n, ok := extraNumber(value); ok && n >= 0 {
		return &n
	}
	if s, ok := value.(string); ok && decimalUintRe.MatchString(s) {
		n := 0
		_, _ = fmt.Sscanf(s, "%d", &n)
		return &n
	}
	return nil
}

// voucherMirror is the chain read for one voucher settle; OnchainSyncedAt is the pre-RPC sample.
// A nil channel or zero stamp leaves stored escrow untouched.
type voucherMirror struct {
	channel *FacilitatorChannel
}

// snapshot is the charge CAS resolver. A row stamped at or after the read keeps its escrow.
func (m voucherMirror) snapshot(current *FacilitatorChannel) *FacilitatorChannel {
	if m.channel == nil || m.channel.OnchainSyncedAt == 0 {
		return nil
	}
	if current != nil && current.OnchainSyncedAt >= m.channel.OnchainSyncedAt {
		return nil
	}
	return m.channel
}

// heldVoucherMirror reads chain state unless the stored row is fresh.
// A failed read leaves an existing row's escrow and fails a missing row.
func heldVoucherMirror(
	ctx context.Context,
	deps VoucherStoreDeps,
	raw *batchsettlement.BatchSettlementVoucherPayload,
	requirements types.PaymentRequirements,
) (voucherMirror, error) {
	channelId := raw.Voucher.ChannelId
	stored, getErr := deps.Storage.Get(ctx, channelId)
	if impl := storage.RethrowLockImplementationError(getErr); impl != nil {
		return voucherMirror{}, impl
	}
	if getErr != nil {
		return voucherMirror{}, x402.NewSettleError(
			ErrRpcReadFailed, "", x402.Network(requirements.Network), "", getErr.Error(),
		)
	}
	if stored != nil && batchsettlement.IsOnchainStateFresh(*cachedOnchain(stored), onchainStateTtlMs(deps), time.Now().UnixMilli()) {
		return voucherMirror{}, nil
	}
	readAt := time.Now().UnixMilli()
	state, err := ReadChannelState(ctx, deps.Signer, channelId)
	if err != nil {
		if stored != nil {
			return voucherMirror{}, nil
		}
		return voucherMirror{}, x402.NewSettleError(
			ErrRpcReadFailed, "", x402.Network(requirements.Network), "", err.Error(),
		)
	}
	return voucherMirror{channel: mirrorChannel(raw, requirements, state, readAt)}, nil
}

// verifiedVoucherMirror runs the full voucher verify and mirrors the state it read.
func verifiedVoucherMirror(
	ctx context.Context,
	deps VoucherStoreDeps,
	raw *batchsettlement.BatchSettlementVoucherPayload,
	requirements types.PaymentRequirements,
) (voucherMirror, string) {
	readAt := time.Now().UnixMilli()
	verified, err := VerifyVoucher(ctx, deps.Signer, raw, requirements, raw.ChannelConfig)
	if err != nil {
		return voucherMirror{}, invalidReasonOr(err, ErrVoucherSignatureInvalid)
	}
	if !verified.IsValid {
		reason := verified.InvalidReason
		if reason == "" {
			reason = ErrVoucherSignatureInvalid
		}
		return voucherMirror{}, reason
	}
	state, ok := channelStateFromVerifyExtra(verified.Extra)
	if !ok {
		return voucherMirror{}, ErrRpcReadFailed
	}
	return voucherMirror{channel: mirrorChannel(raw, requirements, state, readAt)}, ""
}

// mirrorChannel is the escrow snapshot stamped at readAt.
// A missing row starts from it with charged at onchain totalClaimed.
func mirrorChannel(
	raw *batchsettlement.BatchSettlementVoucherPayload,
	requirements types.PaymentRequirements,
	state *batchsettlement.ChannelState,
	readAt int64,
) *FacilitatorChannel {
	refundNonce := 0
	if state.RefundNonce != nil {
		refundNonce = int(state.RefundNonce.Int64())
	}
	return &FacilitatorChannel{
		Channel: storage.Channel{
			ChannelId:               raw.Voucher.ChannelId,
			ChannelConfig:           raw.ChannelConfig,
			ChargedCumulativeAmount: state.TotalClaimed.String(),
			SignedMaxClaimable:      raw.Voucher.MaxClaimableAmount,
			Signature:               raw.Voucher.Signature,
			Balance:                 state.Balance.String(),
			TotalClaimed:            state.TotalClaimed.String(),
			WithdrawRequestedAt:     state.WithdrawRequestedAt,
			RefundNonce:             refundNonce,
			OnchainSyncedAt:         readAt,
			Network:                 requirements.Network,
		},
	}
}

// channelStateFromVerifyExtra parses BuildVerifyExtra. ok is false when a field is missing or not a uint.
func channelStateFromVerifyExtra(extra map[string]interface{}) (*batchsettlement.ChannelState, bool) {
	balance, okBalance := extraUint(extra["balance"])
	totalClaimed, okClaimed := extraUint(extra["totalClaimed"])
	refundNonce, okNonce := extraUint(extra["refundNonce"])
	withdrawRequestedAt := optionalUintNumber(extra["withdrawRequestedAt"])
	if !okBalance || !okClaimed || !okNonce || withdrawRequestedAt == nil {
		return nil, false
	}
	return &batchsettlement.ChannelState{
		Balance:             balance,
		TotalClaimed:        totalClaimed,
		WithdrawRequestedAt: *withdrawRequestedAt,
		RefundNonce:         refundNonce,
	}, true
}

func extraUint(value interface{}) (*big.Int, bool) {
	s := optionalUintString(value)
	if s == nil {
		return nil, false
	}
	return parseManagedUint(*s)
}

func rebuildClaims(stored *FacilitatorChannel) []batchsettlement.BatchSettlementVoucherClaim {
	if stored == nil {
		return nil
	}
	if _, ok := parseManagedUint(stored.ChargedCumulativeAmount); !ok {
		return nil
	}
	if _, ok := parseManagedUint(stored.TotalClaimed); !ok {
		return nil
	}
	if uintCmp(stored.ChargedCumulativeAmount, stored.TotalClaimed) <= 0 {
		return nil
	}
	claim := batchsettlement.BatchSettlementVoucherClaim{
		Signature:    stored.Signature,
		TotalClaimed: stored.ChargedCumulativeAmount,
	}
	claim.Voucher.Channel = stored.ChannelConfig
	claim.Voucher.MaxClaimableAmount = stored.SignedMaxClaimable
	return []batchsettlement.BatchSettlementVoucherClaim{claim}
}

func refundAmountError(amount string) string {
	if amount == "" {
		return ""
	}
	if !decimalUintRe.MatchString(amount) {
		return ErrRefundAmountInvalid
	}
	n, ok := new(big.Int).SetString(amount, 10)
	if !ok || n.Sign() <= 0 {
		return ErrRefundAmountInvalid
	}
	return ""
}

func resolveRefundAmount(amount string, stored *FacilitatorChannel) string {
	if amount != "" && decimalUintRe.MatchString(amount) {
		return amount
	}
	if stored == nil {
		return "0"
	}
	remainder := new(big.Int)
	bal, _ := new(big.Int).SetString(stored.Balance, 10)
	charged, _ := new(big.Int).SetString(stored.ChargedCumulativeAmount, 10)
	if bal == nil {
		bal = new(big.Int)
	}
	if charged == nil {
		charged = new(big.Int)
	}
	remainder.Sub(bal, charged)
	if remainder.Sign() > 0 {
		return remainder.String()
	}
	return "0"
}

// maxSafeJSONInteger is the largest integer a JSON number carries losslessly (2^53 - 1).
const maxSafeJSONInteger = float64(1<<53 - 1)

// readExtraTotalClaimed reads the onchain totalClaimed baseline from a verify extra.
// Canonical rule shared across SDKs: a plain decimal string with no leading zeros ("0" is the
// only string starting with 0), or a JSON number that is a non-negative safe integer.
// ok=false means the baseline is unavailable and the caller must fail closed, never use zero.
func readExtraTotalClaimed(extra map[string]interface{}) (string, bool) {
	switch v := extra["totalClaimed"].(type) {
	case string:
		n, ok := parseManagedUint(v)
		if !ok || n.String() != v {
			return "", false
		}
		return v, true
	case int:
		if v >= 0 {
			return fmt.Sprintf("%d", v), true
		}
	case int64:
		if v >= 0 {
			return fmt.Sprintf("%d", v), true
		}
	case float64:
		if v >= 0 && v <= maxSafeJSONInteger && v == math.Trunc(v) {
			return fmt.Sprintf("%d", int64(v)), true
		}
	}
	return "", false
}

func mismatchVerifyExtra(channelId string, extra map[string]interface{}, stored *FacilitatorChannel, charged string) map[string]interface{} {
	balance := "0"
	totalClaimed := "0"
	withdrawRequestedAt := 0
	refundNonce := 0
	if stored != nil {
		balance = stored.Balance
		totalClaimed = stored.TotalClaimed
		withdrawRequestedAt = stored.WithdrawRequestedAt
		refundNonce = stored.RefundNonce
	} else if extra != nil {
		if s := optionalUintString(extra["balance"]); s != nil {
			balance = *s
		}
		if s := optionalUintString(extra["totalClaimed"]); s != nil {
			totalClaimed = *s
		}
		if n := optionalUintNumber(extra["withdrawRequestedAt"]); n != nil {
			withdrawRequestedAt = *n
		}
		if n := optionalUintNumber(extra["refundNonce"]); n != nil {
			refundNonce = *n
		}
	}
	cs := storage.ChannelStateExtra(&storage.Channel{
		ChannelId:           channelId,
		Balance:             balance,
		TotalClaimed:        totalClaimed,
		WithdrawRequestedAt: withdrawRequestedAt,
		RefundNonce:         refundNonce,
	}, &charged)
	out := map[string]interface{}{"channelState": cs.ToMap()}
	if stored != nil {
		vs := batchsettlement.BatchSettlementVoucherStateExtra{
			SignedMaxClaimable: stored.SignedMaxClaimable,
			Signature:          stored.Signature,
		}
		out["voucherState"] = vs.ToMap()
	} else {
		out["voucherState"] = map[string]interface{}{}
	}
	return out
}

func voucherStoreLogger(deps VoucherStoreDeps) *slog.Logger {
	if deps.Logger != nil {
		return deps.Logger
	}
	return slog.Default()
}

func failSettle(requirements types.PaymentRequirements, errorReason string) *x402.SettleResponse {
	return &x402.SettleResponse{
		Success:     false,
		ErrorReason: errorReason,
		Transaction: "",
		Network:     x402.Network(requirements.Network),
	}
}

// failSettleFromErr maps admission/mirror failures into a SettleResponse.
// Implementation errors are returned for the caller to propagate.
func failSettleFromErr(requirements types.PaymentRequirements, err error) (*x402.SettleResponse, error) {
	if err == nil {
		return nil, nil
	}
	if impl := storage.RethrowLockImplementationError(err); impl != nil {
		return nil, impl
	}
	var se *x402.SettleError
	if errors.As(err, &se) {
		return failSettle(requirements, se.ErrorReason), nil
	}
	var ve *x402.VerifyError
	if errors.As(err, &ve) {
		return failSettle(requirements, ve.InvalidReason), nil
	}
	return nil, err
}

// depositPersistReason maps a non-committed deposit charge outcome to a
// fail-closed error reason.
func depositPersistReason(outcome *storage.CommitVoucherChargeResult[*FacilitatorChannel]) string {
	if outcome != nil {
		switch outcome.Status {
		case storage.CommitCapExceeded:
			return ErrChargeExceedsSignedCumulative
		case storage.CommitWatermarkMismatch:
			return ErrCumulativeAmountMismatch
		case storage.CommitMissing:
			return ErrMissingChannel
		}
	}
	return ErrChannelBusy
}

// failDepositPersist fails a managed deposit closed after the on-chain tx
// landed but the voucher was not committed. It keeps proof funds moved (tx
// hash, amount, payer, on-chain channelState) so the server does not release
// the resource.
func failDepositPersist(settled *x402.SettleResponse, errorReason string) *x402.SettleResponse {
	return &x402.SettleResponse{
		Success:     false,
		ErrorReason: errorReason,
		Transaction: settled.Transaction,
		Network:     settled.Network,
		Payer:       settled.Payer,
		Amount:      settled.Amount,
		Extra:       settled.Extra,
	}
}

func isCancelSettlePayload(raw map[string]interface{}) bool {
	cancel, _ := raw["cancel"].(bool)
	return cancel
}

func isManagedClientPayload(raw map[string]interface{}) bool {
	return batchsettlement.IsDepositPayload(raw) || batchsettlement.IsVoucherPayload(raw) || batchsettlement.IsRefundPayload(raw)
}

func parseManagedChannel(raw map[string]interface{}) (batchsettlement.ChannelConfig, batchsettlement.BatchSettlementVoucherFields, string, error) {
	var zero batchsettlement.ChannelConfig
	var voucher batchsettlement.BatchSettlementVoucherFields
	configMap, ok := raw["channelConfig"].(map[string]interface{})
	if !ok {
		return zero, voucher, "", errors.New("missing channelConfig")
	}
	config, err := batchsettlement.ChannelConfigFromMap(configMap)
	if err != nil {
		return zero, voucher, "", err
	}
	voucherMap, ok := raw["voucher"].(map[string]interface{})
	if !ok {
		return config, voucher, config.Payer, errors.New("missing voucher")
	}
	if id, ok := voucherMap["channelId"].(string); ok {
		voucher.ChannelId = id
	}
	if amt, ok := voucherMap["maxClaimableAmount"].(string); ok {
		voucher.MaxClaimableAmount = amt
	}
	if sig, ok := voucherMap["signature"].(string); ok {
		voucher.Signature = sig
	}
	return config, voucher, config.Payer, nil
}

func payloadPayer(raw map[string]interface{}) string {
	configMap, _ := raw["channelConfig"].(map[string]interface{})
	if configMap == nil {
		return ""
	}
	payer, _ := configMap["payer"].(string)
	return payer
}

func verifyResponseFromErr(err error, payer string) *x402.VerifyResponse {
	var ve *x402.VerifyError
	if errors.As(err, &ve) {
		p := ve.Payer
		if p == "" {
			p = payer
		}
		return &x402.VerifyResponse{IsValid: false, InvalidReason: ve.InvalidReason, Payer: p}
	}
	return &x402.VerifyResponse{IsValid: false, InvalidReason: ErrRpcReadFailed, Payer: payer}
}

func invalidReasonOr(err error, fallback string) string {
	var ve *x402.VerifyError
	if errors.As(err, &ve) && ve.InvalidReason != "" {
		return ve.InvalidReason
	}
	return fallback
}

func copyExtra(extra map[string]interface{}) map[string]interface{} {
	out := map[string]interface{}{}
	for k, v := range extra {
		out[k] = v
	}
	return out
}

func extraNumber(v interface{}) (int, bool) {
	switch n := v.(type) {
	case int:
		return n, true
	case int64:
		return int(n), true
	case float64:
		return int(n), true
	case string:
		if !decimalUintRe.MatchString(n) {
			return 0, false
		}
		parsed := 0
		if _, err := fmt.Sscanf(n, "%d", &parsed); err != nil {
			return 0, false
		}
		return parsed, true
	default:
		return 0, false
	}
}

func extraUintString(v interface{}) (string, bool) {
	s, ok := v.(string)
	return s, ok
}

func sameUint(a, b string) bool {
	ai, okA := parseManagedUint(a)
	if !okA {
		return false
	}
	bi, okB := parseManagedUint(b)
	if !okB {
		return false
	}
	return ai.Cmp(bi) == 0
}

// uintCmp compares decimal uint strings. Unparsable operands fail closed as
// greater (1) so closed-channel checks never delete a corrupt row; claim
// builders guard with parseManagedUint first and skip corrupt rows.
func uintCmp(a, b string) int {
	ai, okA := parseManagedUint(a)
	if !okA {
		return 1
	}
	bi, okB := parseManagedUint(b)
	if !okB {
		return 1
	}
	return ai.Cmp(bi)
}

// parseManagedUint parses a non-negative decimal uint. ok=false means the
// caller must fail closed (mismatch/skip), never treat the value as zero.
func parseManagedUint(s string) (*big.Int, bool) {
	v, ok := new(big.Int).SetString(s, 10)
	if !ok || v.Sign() < 0 {
		return nil, false
	}
	return v, true
}

func channelStateFromMap(m map[string]interface{}) batchsettlement.BatchSettlementChannelStateExtra {
	cs := batchsettlement.BatchSettlementChannelStateExtra{}
	cs.ChannelId, _ = m["channelId"].(string)
	cs.Balance, _ = m["balance"].(string)
	cs.TotalClaimed, _ = m["totalClaimed"].(string)
	cs.ChargedCumulativeAmount, _ = m["chargedCumulativeAmount"].(string)
	if n, ok := extraNumber(m["withdrawRequestedAt"]); ok {
		cs.WithdrawRequestedAt = n
	}
	if s, ok := m["refundNonce"].(string); ok {
		cs.RefundNonce = s
	} else if n, ok := extraNumber(m["refundNonce"]); ok {
		cs.RefundNonce = fmt.Sprintf("%d", n)
	}
	return cs
}
