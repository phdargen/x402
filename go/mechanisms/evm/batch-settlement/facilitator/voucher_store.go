package facilitator

import (
	"context"
	"errors"
	"fmt"
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
	Retention               FacilitatorRetention
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

	if batchsettlement.IsVoucherPayload(raw) && !strings.EqualFold(channelConfig.PayerAuthorizer, zeroAddress) {
		vp, parseErr := batchsettlement.VoucherPayloadFromMap(raw)
		if parseErr != nil || !batchsettlement.VerifyEoaVoucherSignature(vp, requirements.Network) {
			return &x402.VerifyResponse{IsValid: false, InvalidReason: ErrVoucherSignatureInvalid, Payer: payer}, nil
		}
	}

	channelId := voucher.ChannelId
	pendingId, nonceErr := createNonce()
	if nonceErr != nil {
		return &x402.VerifyResponse{IsValid: false, InvalidReason: ErrVoucherStoreUnavailable, Payer: payer}, nil
	}
	owner := storage.AdmissionOwner(pendingId, voucher)
	reserved := false
	defer func() {
		if reserved {
			_ = releaseLock(ctx, deps, channelId, owner)
		}
	}()

	acquired, acqErr := deps.LockStorage.Acquire(ctx, channelId, owner, storage.PendingTtlMs(requirements.MaxTimeoutSeconds))
	if impl := storage.RethrowLockImplementationError(acqErr); impl != nil {
		return nil, impl
	}
	if acqErr != nil || !acquired {
		if acqErr != nil {
			return &x402.VerifyResponse{IsValid: false, InvalidReason: ErrRpcReadFailed, Payer: payer}, nil
		}
		return &x402.VerifyResponse{IsValid: false, InvalidReason: ErrChannelBusy, Payer: payer}, nil
	}
	reserved = true

	stored, getErr := deps.Storage.Get(ctx, channelId)
	if impl := storage.RethrowLockImplementationError(getErr); impl != nil {
		return nil, impl
	}
	if getErr != nil {
		return &x402.VerifyResponse{IsValid: false, InvalidReason: ErrRpcReadFailed, Payer: payer}, nil
	}

	verified, verifyErr := verifyManagedPayload(ctx, deps, payload, requirements, fctx, stored)
	if impl := storage.RethrowLockImplementationError(verifyErr); impl != nil {
		return nil, impl
	}
	if verifyErr != nil {
		return verifyResponseFromErr(verifyErr, payer), nil
	}
	if !verified.IsValid {
		return verified, nil
	}

	onchainClaimed := readExtraTotalClaimed(verified.Extra)
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
		return settleManagedVoucher(ctx, deps, vp, requirements)
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

func settleManagedVoucher(
	ctx context.Context,
	deps VoucherStoreDeps,
	raw *batchsettlement.BatchSettlementVoucherPayload,
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

	held, heldErr := admissionHeld(ctx, deps, channelId, owner)
	if impl := storage.RethrowLockImplementationError(heldErr); impl != nil {
		return nil, impl
	}
	if heldErr != nil {
		held = false
	}
	if held {
		if configErr := batchsettlement.ValidateChannelConfig(raw.ChannelConfig, raw.Voucher.ChannelId, requirements); configErr != "" {
			return failSettle(requirements, configErr), nil
		}
	} else {
		anyHeld, anyErr := deps.LockStorage.IsHeld(ctx, channelId, "")
		if impl := storage.RethrowLockImplementationError(anyErr); impl != nil {
			return nil, impl
		}
		if anyErr == nil && anyHeld {
			return failSettle(requirements, ErrPendingIdMismatch), nil
		}
		verified, err := VerifyVoucher(ctx, deps.Signer, raw, requirements, raw.ChannelConfig)
		if err != nil {
			return failSettle(requirements, invalidReasonOr(err, ErrVoucherSignatureInvalid)), nil
		}
		if !verified.IsValid {
			reason := verified.InvalidReason
			if reason == "" {
				reason = ErrVoucherSignatureInvalid
			}
			return failSettle(requirements, reason), nil
		}
	}

	increment, _ := new(big.Int).SetString(requirements.Amount, 10)
	if increment == nil {
		increment = new(big.Int)
	}
	signedCap, _ := new(big.Int).SetString(raw.Voucher.MaxClaimableAmount, 10)
	if signedCap == nil {
		signedCap = new(big.Int)
	}
	var mapper func(*FacilitatorChannel) *FacilitatorChannel
	if increment.Sign() != 0 {
		network := requirements.Network
		mapper = func(channel *FacilitatorChannel) *FacilitatorChannel {
			return incrementChargeCount(channel, network)
		}
	}
	outcome, err := storage.CommitVoucherCharge(ctx, deps.Storage, channelId, storage.CommitVoucherChargeInput[*FacilitatorChannel]{
		Increment: increment,
		SignedCap: signedCap,
		Voucher:   raw.Voucher,
		Map:       mapper,
	})
	if err != nil {
		return failSettle(requirements, ErrChannelBusy), nil
	}
	if outcome.Status == storage.CommitMissing {
		snapshot, snapErr := provisionalFromOnchain(ctx, deps, raw, requirements)
		if snapErr != nil {
			return failSettle(requirements, ErrRpcReadFailed), nil
		}
		outcome, err = storage.CommitVoucherCharge(ctx, deps.Storage, channelId, storage.CommitVoucherChargeInput[*FacilitatorChannel]{
			Increment: increment,
			SignedCap: signedCap,
			Voucher:   raw.Voucher,
			Snapshot:  snapshot,
			Map:       mapper,
		})
		if err != nil {
			return failSettle(requirements, ErrChannelBusy), nil
		}
	}
	if outcome.Status == storage.CommitMissing {
		return failSettle(requirements, ErrMissingChannel), nil
	}
	if outcome.Status == storage.CommitCapExceeded {
		return failSettle(requirements, ErrChargeExceedsSignedCumulative), nil
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

	identity, bindErr := ResolveDepositDelegatedCaller(ctx, deps.ResolveCallerIdentity, deps.DelegatedAuthStore,
		payment, raw, requirements, fctx)
	if bindErr != nil {
		var se *x402.SettleError
		if errors.As(bindErr, &se) {
			return failSettle(requirements, se.ErrorReason), nil
		}
		return failSettle(requirements, ErrVoucherStoreUnavailable), nil
	}

	settled, err := SettleDeposit(ctx, deps.Signer, raw, requirements, payment.Extensions, fctx, dataSuffix, deps.EIP6492AllowedFactories, deps.PendingStore, deps.DelegatedAuthStore, identity)
	if err != nil {
		return nil, err
	}
	if !settled.Success {
		return settled, nil
	}

	increment, _ := new(big.Int).SetString(requirements.Amount, 10)
	if increment == nil {
		increment = new(big.Int)
	}
	signedCap, _ := new(big.Int).SetString(raw.Voucher.MaxClaimableAmount, 10)
	if signedCap == nil {
		signedCap = new(big.Int)
	}
	outcome, commitErr := storage.CommitVoucherCharge(ctx, deps.Storage, channelId, storage.CommitVoucherChargeInput[*FacilitatorChannel]{
		Increment: increment,
		SignedCap: signedCap,
		Voucher:   raw.Voucher,
		ResolveSnapshot: func(current *FacilitatorChannel) *FacilitatorChannel {
			return depositChargeSnapshot(raw, requirements, settled.Extra, current)
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

	claims := rebuildClaims(stored)
	attested := 0
	if len(claims) > 0 {
		attested = stored.ChargeCount
	}
	amount := resolveRefundAmount(raw.Amount, stored)
	nonce := fmt.Sprintf("%d", stored.RefundNonce)
	enriched := *raw
	enriched.Amount = amount
	enriched.RefundNonce = nonce
	enriched.Claims = claims
	enriched.RefundAuthorizerSignature = ""
	enriched.ClaimAuthorizerSignature = ""

	var claimSuffix []byte
	if len(claims) > 0 {
		claimSuffix, err = batchsettlement.EncodeChargeCountsSuffix([]uint64{uint64(attested)})
		if err != nil {
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
	if err != nil {
		return nil, err
	}
	if !settled.Success {
		return settled, nil
	}

	extraState, _ := settled.Extra["channelState"].(map[string]interface{})
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
		chargeCount := current.ChargeCount - attested
		if chargeCount < 0 {
			chargeCount = 0
		}
		next := current.Clone()
		next.Balance = balance
		next.TotalClaimed = totalClaimed
		next.ChargeCount = chargeCount
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
		if ShouldDeleteVoucherRow(deps.Retention, false, next, chargeCount) {
			return nil
		}
		return next
	})
	if err != nil {
		return settled, nil
	}
	if updated != nil && updated.Status == storage.ChannelDeleted && deps.DelegatedAuthStore != nil {
		_ = deps.DelegatedAuthStore.Delete(ctx, channelId, requirements.Network)
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
		ttl := storage.DefaultOnchainStateTtlMs(deps.WithdrawDelay)
		if deps.OnchainStateTtlMs != nil {
			ttl = *deps.OnchainStateTtlMs
		}
		if cached := batchsettlement.EvaluateVoucherAgainstCachedState(vp, requirements, cachedOnchain(stored), time.Now().UnixMilli(), ttl); cached != nil {
			return cached, nil
		}
		return VerifyVoucher(ctx, deps.Signer, vp, requirements, vp.ChannelConfig)
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

func depositChargeSnapshot(
	raw *batchsettlement.BatchSettlementDepositPayload,
	requirements types.PaymentRequirements,
	extra map[string]interface{},
	stored *FacilitatorChannel,
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

func provisionalFromOnchain(
	ctx context.Context,
	deps VoucherStoreDeps,
	raw *batchsettlement.BatchSettlementVoucherPayload,
	requirements types.PaymentRequirements,
) (*FacilitatorChannel, error) {
	state, err := ReadChannelState(ctx, deps.Signer, raw.Voucher.ChannelId)
	if err != nil {
		return nil, err
	}
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
			LastRequestTimestamp:    time.Now().UnixMilli(),
			Network:                 requirements.Network,
		},
		ChargeCount: 0,
	}, nil
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

func readExtraTotalClaimed(extra map[string]interface{}) string {
	if s := optionalUintString(extra["totalClaimed"]); s != nil {
		return *s
	}
	return "0"
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

func failSettle(requirements types.PaymentRequirements, errorReason string) *x402.SettleResponse {
	return &x402.SettleResponse{
		Success:     false,
		ErrorReason: errorReason,
		Transaction: "",
		Network:     x402.Network(requirements.Network),
	}
}

// depositPersistReason maps a non-committed deposit charge outcome to a
// fail-closed error reason.
func depositPersistReason(outcome *storage.CommitVoucherChargeResult[*FacilitatorChannel]) string {
	if outcome != nil {
		switch outcome.Status {
		case storage.CommitCapExceeded:
			return ErrChargeExceedsSignedCumulative
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
