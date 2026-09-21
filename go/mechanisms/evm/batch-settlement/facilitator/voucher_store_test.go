package facilitator

import (
	"context"
	"errors"
	"math/big"
	"strings"
	"sync"
	"testing"
	"time"

	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/evm"
	batchsettlement "github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement"
	"github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement/storage"
	"github.com/x402-foundation/x402/go/v2/types"
)

func TestVerifyManaged_RejectsWhenAdmissionLockHeld(t *testing.T) {
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	auth := managedAuthorizer()
	cfg := managedConfig(auth.addr, "00")
	channelId := mustChannelId(t, cfg)
	ok, err := store.Acquire(context.Background(), channelId, "0xother", 60_000)
	if err != nil || !ok {
		t.Fatalf("acquire: %v %v", ok, err)
	}

	resp, err := VerifyManaged(context.Background(), managedDeps(t, store, store, auth, nil),
		voucherEnvelope(cfg, voucherFields(channelId, "1000", dummySig), ""),
		managedRequirements(auth.addr), nil)
	if err != nil {
		t.Fatal(err)
	}
	if resp.IsValid || resp.InvalidReason != ErrChannelBusy {
		t.Fatalf("got %+v", resp)
	}
}

func TestVerifyManaged_ConcurrentSameSignatureBusy(t *testing.T) {
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	auth := managedAuthorizer()
	cfg := managedConfig(auth.addr, "00")
	channelId := mustChannelId(t, cfg)
	seedManagedChannel(t, store, storedManagedChannel(cfg, channelId, nil))
	deps := managedDeps(t, store, store, auth, nil)
	payload := voucherEnvelope(cfg, voucherFields(channelId, "2000", dummySig), "")
	reqs := managedRequirements(auth.addr)

	var wg sync.WaitGroup
	results := make([]*struct {
		resp *x402.VerifyResponse
		err  error
	}, 2)
	wg.Add(2)
	for i := 0; i < 2; i++ {
		go func() {
			defer wg.Done()
			resp, err := VerifyManaged(context.Background(), deps, payload, reqs, nil)
			results[i] = &struct {
				resp *x402.VerifyResponse
				err  error
			}{resp, err}
		}()
	}
	wg.Wait()

	valid, busy := 0, 0
	for _, r := range results {
		if r.err != nil {
			t.Fatalf("err: %v", r.err)
		}
		if r.resp.IsValid {
			valid++
			if pendingIdFrom(r.resp) == "" {
				t.Fatal("missing pendingId")
			}
		}
		if r.resp.InvalidReason == ErrChannelBusy {
			busy++
		}
	}
	if valid != 1 || busy != 1 {
		t.Fatalf("valid=%d busy=%d", valid, busy)
	}
}

func TestSettleManaged_ReleasesLockWhenPendingIdEchoed(t *testing.T) {
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	auth := managedAuthorizer()
	cfg := managedConfig(auth.addr, "00")
	channelId := mustChannelId(t, cfg)
	voucher := voucherFields(channelId, "2000", dummySig)
	seedManagedChannel(t, store, storedManagedChannel(cfg, channelId, nil))
	deps := managedDeps(t, store, store, auth, nil)
	reqs := managedRequirements(auth.addr)
	reqs.Amount = "1000"

	verified, err := VerifyManaged(context.Background(), deps, voucherEnvelope(cfg, voucher, ""), reqs, nil)
	if err != nil || !verified.IsValid {
		t.Fatalf("verify: %+v %v", verified, err)
	}
	pendingId := pendingIdFrom(verified)
	held, _ := store.IsHeld(context.Background(), channelId, "")
	if !held {
		t.Fatal("expected held lock")
	}

	settled, err := SettleManaged(context.Background(), deps, voucherEnvelope(cfg, voucher, pendingId), reqs, nil, nil)
	if err != nil || !settled.Success {
		t.Fatalf("settle: %+v %v", settled, err)
	}
	held, _ = store.IsHeld(context.Background(), channelId, "")
	if held {
		t.Fatal("expected lock released")
	}
}

func TestSettleManaged_ZeroAmountDoesNotIncrementChargeCount(t *testing.T) {
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	auth := managedAuthorizer()
	cfg := managedConfig(auth.addr, "00")
	channelId := mustChannelId(t, cfg)
	voucher := voucherFields(channelId, "2000", dummySig)
	seedManagedChannel(t, store, storedManagedChannel(cfg, channelId, &channelFields{
		SignedMaxClaimable: "2000",
		ChargeCount:        2,
	}))
	deps := managedDeps(t, store, store, auth, nil)
	reqs := managedRequirements(auth.addr)
	reqs.Amount = "1000"

	verified, err := VerifyManaged(context.Background(), deps, voucherEnvelope(cfg, voucher, ""), reqs, nil)
	if err != nil || !verified.IsValid {
		t.Fatalf("verify: %+v %v", verified, err)
	}
	reqs.Amount = "0"
	settled, err := SettleManaged(context.Background(), deps, voucherEnvelope(cfg, voucher, pendingIdFrom(verified)), reqs, nil, nil)
	if err != nil || !settled.Success {
		t.Fatalf("settle: %+v %v", settled, err)
	}
	if extraInt(settled, "chargeCount") != 2 {
		t.Fatalf("chargeCount extra = %d", extraInt(settled, "chargeCount"))
	}
	got, _ := store.Get(context.Background(), channelId)
	if got.ChargedCumulativeAmount != "1000" || got.ChargeCount != 2 {
		t.Fatalf("stored %+v", got)
	}
}

func TestVerifyManaged_RejectsClientCancel(t *testing.T) {
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	auth := managedAuthorizer()
	cfg := managedConfig(auth.addr, "00")
	channelId := mustChannelId(t, cfg)
	payload := cancelEnvelope(cfg, voucherFields(channelId, "1000", dummySig), "")

	resp, err := VerifyManaged(context.Background(), managedDeps(t, store, store, auth, nil), payload, managedRequirements(auth.addr), nil)
	if err != nil {
		t.Fatal(err)
	}
	if resp.IsValid || resp.InvalidReason != ErrUnexpectedCancel {
		t.Fatalf("got %+v", resp)
	}
	held, _ := store.IsHeld(context.Background(), channelId, "")
	if held {
		t.Fatal("lock should not be taken")
	}
}

func TestVerifyManaged_WrongWithdrawDelay(t *testing.T) {
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	auth := managedAuthorizer()
	cfg := managedConfig(auth.addr, "00")
	channelId := mustChannelId(t, cfg)
	reqs := managedRequirements(auth.addr)
	reqs.Extra["withdrawDelay"] = 600

	resp, err := VerifyManaged(context.Background(), managedDeps(t, store, store, auth, nil),
		voucherEnvelope(cfg, voucherFields(channelId, "1000", dummySig), ""), reqs, nil)
	if err != nil {
		t.Fatal(err)
	}
	if resp.IsValid || resp.InvalidReason != ErrWithdrawDelayMismatch {
		t.Fatalf("got %+v", resp)
	}
}

func TestVerifyManaged_UnsupportedPayloadType(t *testing.T) {
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	auth := managedAuthorizer()
	resp, err := VerifyManaged(context.Background(), managedDeps(t, store, store, auth, nil),
		managedEnvelope(map[string]interface{}{"type": "claim", "claims": []interface{}{}}),
		managedRequirements(auth.addr), nil)
	if err != nil {
		t.Fatal(err)
	}
	if resp.IsValid || resp.InvalidReason != ErrInvalidPayload {
		t.Fatalf("got %+v", resp)
	}
}

func TestVerifyManaged_StoreReadFailure(t *testing.T) {
	inner := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	store := &hookStore{inner: inner, getErr: errors.New("store unavailable")}
	auth := managedAuthorizer()
	cfg := managedConfig(auth.addr, "00")
	channelId := mustChannelId(t, cfg)

	resp, err := VerifyManaged(context.Background(), managedDeps(t, store, store, auth, nil),
		voucherEnvelope(cfg, voucherFields(channelId, "1000", dummySig), ""),
		managedRequirements(auth.addr), nil)
	if err != nil {
		t.Fatal(err)
	}
	if resp.IsValid || resp.InvalidReason != ErrRpcReadFailed {
		t.Fatalf("got %+v", resp)
	}
}

func TestVerifyManaged_StoreReadFailureDeposit(t *testing.T) {
	inner := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	store := &hookStore{inner: inner, getErr: errors.New("store unavailable")}
	auth := managedAuthorizer()
	cfg := managedConfig(auth.addr, "00")
	channelId := mustChannelId(t, cfg)
	reqs := managedRequirements(auth.addr)
	reqs.Amount = "1000"

	resp, err := VerifyManaged(context.Background(), managedDeps(t, store, store, auth, nil),
		managedDepositEnvelope(cfg, channelId), reqs, nil)
	if err != nil {
		t.Fatal(err)
	}
	if resp.IsValid || resp.InvalidReason != ErrRpcReadFailed {
		t.Fatalf("got %+v", resp)
	}
}

func TestVerifyManaged_StoreReadFailureRefund(t *testing.T) {
	inner := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	store := &hookStore{inner: inner, getErr: errors.New("store unavailable")}
	auth := managedAuthorizer()
	cfg := managedConfig(auth.addr, "00")
	channelId := mustChannelId(t, cfg)

	resp, err := VerifyManaged(context.Background(), managedDeps(t, store, store, auth, nil),
		refundEnvelope(cfg, voucherFields(channelId, "5000", dummySig), "0", "", ""),
		managedRequirements(auth.addr), nil)
	if err != nil {
		t.Fatal(err)
	}
	if resp.IsValid || resp.InvalidReason != ErrRpcReadFailed {
		t.Fatalf("got %+v", resp)
	}
}

func TestSettleManaged_ChargeCommitStorageError(t *testing.T) {
	inner := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	auth := managedAuthorizer()
	cfg := managedConfig(auth.addr, "00")
	channelId := mustChannelId(t, cfg)
	seedManagedChannel(t, inner, storedManagedChannel(cfg, channelId, nil))
	store := &hookStore{inner: inner, updateErr: errors.New("storage write failed")}

	resp, err := SettleManaged(context.Background(), managedDeps(t, store, store, auth, nil),
		voucherEnvelope(cfg, voucherFields(channelId, "2000", dummySig), ""),
		managedRequirements(auth.addr), nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if resp.Success || resp.ErrorReason != ErrChannelBusy {
		t.Fatalf("got %+v", resp)
	}
}

func TestSettleManaged_UnsupportedPayloadType(t *testing.T) {
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	auth := managedAuthorizer()
	resp, err := SettleManaged(context.Background(), managedDeps(t, store, store, auth, nil),
		managedEnvelope(map[string]interface{}{"type": "settle", "receiver": managedReceiver, "token": managedToken}),
		managedRequirements(auth.addr), nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if resp.Success || resp.ErrorReason != ErrInvalidPayload {
		t.Fatalf("got %+v", resp)
	}
}

func TestSettleManaged_InvalidSignatureWithoutLock(t *testing.T) {
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	auth := managedAuthorizer()
	cfg := managedConfig(auth.addr, "00")
	channelId := mustChannelId(t, cfg)
	signer := newManagedSigner(t, &managedRPC{invalidSig: true})

	resp, err := SettleManaged(context.Background(), managedDeps(t, store, store, auth, signer),
		voucherEnvelope(cfg, voucherFields(channelId, "1000", dummySig), ""),
		managedRequirements(auth.addr), nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if resp.Success || resp.ErrorReason != ErrVoucherSignatureInvalid {
		t.Fatalf("got %+v", resp)
	}
}

func TestSettleManaged_RefundWatermarkMismatch(t *testing.T) {
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	auth := managedAuthorizer()
	cfg := managedConfig(auth.addr, "00")
	channelId := mustChannelId(t, cfg)
	seedManagedChannel(t, store, storedManagedChannel(cfg, channelId, &channelFields{ChargedCumulativeAmount: "1000"}))
	deps := managedDeps(t, store, store, auth, nil)
	deps.ResolveCallerIdentity = func(DelegatedSettleContext) (string, error) { return "svc", nil }
	bindManagedIdentity(t, deps.DelegatedAuthStore, channelId, "svc")

	resp, err := SettleManaged(context.Background(), deps,
		refundEnvelope(cfg, voucherFields(channelId, "5000", dummySig), "1000", "", ""),
		managedRequirements(auth.addr), nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if resp.Success || resp.ErrorReason != ErrCumulativeAmountMismatch {
		t.Fatalf("got %+v", resp)
	}
}

func TestSettleManaged_HeldPathChannelIdMismatch(t *testing.T) {
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	auth := managedAuthorizer()
	cfg := managedConfig(auth.addr, "00")
	channelId := mustChannelId(t, cfg)
	voucher := voucherFields(channelId, "2000", dummySig)
	acquireBound(t, store, "0xpending", voucher)
	bad := cfg
	bad.Salt = managedSalt("01")

	resp, err := SettleManaged(context.Background(), managedDeps(t, store, store, auth, nil),
		voucherEnvelope(bad, voucher, "0xpending"),
		managedRequirements(auth.addr), nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if resp.Success || resp.ErrorReason != ErrChannelIdMismatch {
		t.Fatalf("got %+v", resp)
	}
}

func TestSettleManaged_EmptyStoreBootstrapsFromOnchain(t *testing.T) {
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	auth := managedAuthorizer()
	cfg := managedConfig(auth.addr, "00")
	channelId := mustChannelId(t, cfg)
	rpc := &managedRPC{totalClaimed: bigInt(0)}
	signer := newManagedSigner(t, rpc)

	resp, err := SettleManaged(context.Background(), managedDeps(t, store, store, auth, signer),
		voucherEnvelope(cfg, voucherFields(channelId, "1000", dummySig), ""),
		managedRequirements(auth.addr), nil, nil)
	if err != nil || !resp.Success {
		t.Fatalf("got %+v %v", resp, err)
	}
	got, _ := store.Get(context.Background(), channelId)
	if got == nil || got.ChargedCumulativeAmount != "1000" {
		t.Fatalf("stored %+v", got)
	}
}

func TestVerifyManaged_MismatchWithoutRowOmitsVoucherState(t *testing.T) {
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	auth := managedAuthorizer()
	cfg := managedConfig(auth.addr, "00")
	channelId := mustChannelId(t, cfg)
	reqs := managedRequirements(auth.addr)
	reqs.Amount = "1000"

	resp, err := VerifyManaged(context.Background(), managedDeps(t, store, store, auth, nil),
		voucherEnvelope(cfg, voucherFields(channelId, "5000", dummySig), ""), reqs, nil)
	if err != nil {
		t.Fatal(err)
	}
	if resp.IsValid || resp.InvalidReason != ErrCumulativeAmountMismatch {
		t.Fatalf("got %+v", resp)
	}
	vs, _ := resp.Extra["voucherState"].(map[string]interface{})
	if len(vs) != 0 {
		t.Fatalf("voucherState = %+v", vs)
	}
}

func TestVerifyManaged_CorruptStoredWatermarkIsMismatch(t *testing.T) {
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	auth := managedAuthorizer()
	cfg := managedConfig(auth.addr, "00")
	channelId := mustChannelId(t, cfg)
	seedManagedChannel(t, store, storedManagedChannel(cfg, channelId, &channelFields{ChargedCumulativeAmount: "not-a-number"}))
	reqs := managedRequirements(auth.addr)
	reqs.Amount = "1000"

	resp, err := VerifyManaged(context.Background(), managedDeps(t, store, store, auth, nil),
		voucherEnvelope(cfg, voucherFields(channelId, "2000", dummySig), ""), reqs, nil)
	if err != nil {
		t.Fatal(err)
	}
	if resp.IsValid || resp.InvalidReason != ErrCumulativeAmountMismatch {
		t.Fatalf("corrupt watermark must fail closed, got %+v", resp)
	}
}

func TestVerifyManaged_NonceFailureIsVoucherStoreUnavailable(t *testing.T) {
	oldCreateNonce := createNonce
	createNonce = func() (string, error) { return "", errors.New("rand down") }
	defer func() { createNonce = oldCreateNonce }()

	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	auth := managedAuthorizer()
	cfg := managedConfig(auth.addr, "00")
	channelId := mustChannelId(t, cfg)

	resp, err := VerifyManaged(context.Background(), managedDeps(t, store, store, auth, nil),
		voucherEnvelope(cfg, voucherFields(channelId, "2000", dummySig), ""),
		managedRequirements(auth.addr), nil)
	if err != nil {
		t.Fatal(err)
	}
	if resp.IsValid || resp.InvalidReason != ErrVoucherStoreUnavailable {
		t.Fatalf("nonce failure is not RPC, got %+v", resp)
	}
}

func managedDepositEnvelope(cfg batchsettlement.ChannelConfig, channelId string) types.PaymentPayload {
	p := &batchsettlement.BatchSettlementDepositPayload{
		Type:          "deposit",
		ChannelConfig: cfg,
		Voucher:       voucherFields(channelId, "1000", dummySig),
		Deposit: batchsettlement.BatchSettlementDepositData{
			Amount: "1000",
			Authorization: batchsettlement.BatchSettlementDepositAuthorization{
				Erc3009Authorization: goodErc3009Auth(),
			},
		},
	}
	return managedEnvelope(p.ToMap())
}

func managedDepositSigner(t *testing.T) *fakeFacilitatorSigner {
	t.Helper()
	var writeSeen bool
	return &fakeFacilitatorSigner{
		addresses: []string{managedFacilitator},
		chainId:   big.NewInt(84532),
		writeContract: func(functionName string, _ ...interface{}) (string, error) {
			if functionName != "deposit" {
				return "", errors.New("unexpected write " + functionName)
			}
			writeSeen = true
			return successTxHash, nil
		},
		waitForReceipt: func(txHash string) (*evm.TransactionReceipt, error) {
			return &evm.TransactionReceipt{Status: evm.TxStatusSuccess, TxHash: txHash}, nil
		},
		readContract: func(functionName string, _ ...interface{}) (interface{}, error) {
			if functionName != evm.FunctionTryAggregate {
				return nil, errors.New("unexpected rpc")
			}
			if !writeSeen {
				return multicallChannelStateResult(t, big.NewInt(0), big.NewInt(0), 0, big.NewInt(0)), nil
			}
			return multicallChannelStateResult(t, big.NewInt(1000), big.NewInt(0), 0, big.NewInt(0)), nil
		},
	}
}

func TestSettleManagedDeposit_IdentityErrorFailsClosed(t *testing.T) {
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	auth := managedAuthorizer()
	cfg := managedConfig(auth.addr, "02")
	channelId := mustChannelId(t, cfg)
	deps := managedDeps(t, store, store, auth, managedDepositSigner(t))
	deps.ResolveCallerIdentity = func(DelegatedSettleContext) (string, error) { return "", errors.New("idp down") }

	resp, err := SettleManaged(context.Background(), deps,
		managedDepositEnvelope(cfg, channelId),
		managedRequirements(auth.addr), nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if resp.Success || resp.ErrorReason != ErrDelegatedSettleUnauthenticated {
		t.Fatalf("identity failure must fail the deposit closed, got %+v", resp)
	}
	if got, _ := store.Get(context.Background(), channelId); got != nil {
		t.Fatal("failed deposit must not commit a channel row")
	}
	if binding, _ := deps.DelegatedAuthStore.Get(context.Background(), channelId, managedNetwork); binding != nil {
		t.Fatal("failed deposit must not leave a binding")
	}
}

func TestSettleManagedDeposit_BindingConflictDoesNotBlockDeposit(t *testing.T) {
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	auth := managedAuthorizer()
	cfg := managedConfig(auth.addr, "03")
	channelId := mustChannelId(t, cfg)
	deps := managedDeps(t, store, store, auth, managedDepositSigner(t))
	if err := deps.DelegatedAuthStore.Bind(context.Background(), storage.DelegatedAuthBinding{
		ChannelId: channelId, Network: managedNetwork, CallerIdentity: "owner-a",
	}); err != nil {
		t.Fatal(err)
	}
	deps.ResolveCallerIdentity = func(DelegatedSettleContext) (string, error) { return "owner-b", nil }

	resp, err := SettleManaged(context.Background(), deps,
		managedDepositEnvelope(cfg, channelId),
		managedRequirements(auth.addr), nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !resp.Success {
		t.Fatalf("binding conflict must not fail deposit at resolve time, got %+v", resp)
	}
	binding, _ := deps.DelegatedAuthStore.Get(context.Background(), channelId, managedNetwork)
	if binding == nil || binding.CallerIdentity != "owner-a" {
		t.Fatalf("async bind conflict must keep the first binding, got %+v", binding)
	}
}

func TestSettleManagedDeposit_SameIdentityRebindsIdempotently(t *testing.T) {
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	auth := managedAuthorizer()
	cfg := managedConfig(auth.addr, "04")
	channelId := mustChannelId(t, cfg)
	deps := managedDeps(t, store, store, auth, managedDepositSigner(t))
	if err := deps.DelegatedAuthStore.Bind(context.Background(), storage.DelegatedAuthBinding{
		ChannelId: channelId, Network: managedNetwork, CallerIdentity: "svc",
	}); err != nil {
		t.Fatal(err)
	}
	deps.ResolveCallerIdentity = func(DelegatedSettleContext) (string, error) { return "svc", nil }

	resp, err := SettleManaged(context.Background(), deps,
		managedDepositEnvelope(cfg, channelId),
		managedRequirements(auth.addr), nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !resp.Success {
		t.Fatalf("same-identity rebind must succeed, got %+v", resp)
	}
	got, _ := store.Get(context.Background(), channelId)
	if got == nil {
		t.Fatal("expected stored channel")
	}
	binding, _ := deps.DelegatedAuthStore.Get(context.Background(), channelId, managedNetwork)
	if binding == nil || binding.CallerIdentity != "svc" {
		t.Fatalf("delegated binding = %+v, want svc", binding)
	}
}

func TestSettleManaged_SubstitutedVoucherPendingIdMismatch(t *testing.T) {
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	auth := managedAuthorizer()
	cfg := managedConfig(auth.addr, "00")
	channelId := mustChannelId(t, cfg)
	voucher := voucherFields(channelId, "2000", dummySig)
	seedManagedChannel(t, store, storedManagedChannel(cfg, channelId, nil))
	deps := managedDeps(t, store, store, auth, nil)
	reqs := managedRequirements(auth.addr)
	reqs.Amount = "1000"

	verified, err := VerifyManaged(context.Background(), deps, voucherEnvelope(cfg, voucher, ""), reqs, nil)
	if err != nil || !verified.IsValid {
		t.Fatalf("verify: %+v %v", verified, err)
	}
	pendingId := pendingIdFrom(verified)
	rpcSigner := newManagedSigner(t, &managedRPC{})
	deps.Signer = rpcSigner

	sub := voucherFields(channelId, "9999", "0xdeadbeef")
	subReqs := managedRequirements(auth.addr)
	subReqs.Amount = "500"
	substituted, err := SettleManaged(context.Background(), deps, voucherEnvelope(cfg, sub, pendingId), subReqs, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if substituted.Success || substituted.ErrorReason != ErrPendingIdMismatch {
		t.Fatalf("got %+v", substituted)
	}
	held, _ := store.IsHeld(context.Background(), channelId, "")
	if !held {
		t.Fatal("reservation should remain live")
	}
	if rpcSigner.verifyCalls != 0 {
		t.Fatalf("verifyCalls=%d", rpcSigner.verifyCalls)
	}

	genuine, err := SettleManaged(context.Background(), deps, voucherEnvelope(cfg, voucher, pendingId), subReqs, nil, nil)
	if err != nil || !genuine.Success {
		t.Fatalf("genuine: %+v %v", genuine, err)
	}
	held, _ = store.IsHeld(context.Background(), channelId, "")
	if held {
		t.Fatal("expected lock released")
	}
}

func TestSettleManaged_OmittedPendingIdWhileReservationLive(t *testing.T) {
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	auth := managedAuthorizer()
	cfg := managedConfig(auth.addr, "00")
	channelId := mustChannelId(t, cfg)
	voucher := voucherFields(channelId, "2000", dummySig)
	acquireBound(t, store, "0xother", voucher)
	rpcSigner := newManagedSigner(t, &managedRPC{})
	deps := managedDeps(t, store, store, auth, rpcSigner)

	result, err := SettleManaged(context.Background(), deps,
		voucherEnvelope(cfg, voucher, ""),
		managedRequirements(auth.addr), nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if result.Success || result.ErrorReason != ErrPendingIdMismatch {
		t.Fatalf("got %+v", result)
	}
	if rpcSigner.verifyCalls != 0 {
		t.Fatalf("verifyCalls=%d, want 0", rpcSigner.verifyCalls)
	}
	held, _ := store.IsHeld(context.Background(), channelId, "")
	if !held {
		t.Fatal("reservation should remain live")
	}
}

func TestSettleManaged_HeldPathRequirementMismatches(t *testing.T) {
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	auth := managedAuthorizer()
	cfg := managedConfig(auth.addr, "00")
	channelId := mustChannelId(t, cfg)
	voucher := voucherFields(channelId, "2000", dummySig)
	payload := voucherEnvelope(cfg, voucher, "0xpending")
	deps := managedDeps(t, store, store, auth, nil)

	acquireBound(t, store, "0xpending", voucher)
	assetReqs := managedRequirements(auth.addr)
	assetReqs.Asset = managedReceiver
	asset, err := SettleManaged(context.Background(), deps, payload, assetReqs, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if asset.ErrorReason != ErrTokenMismatch {
		t.Fatalf("asset: %+v", asset)
	}

	acquireBound(t, store, "0xpending", voucher)
	payToReqs := managedRequirements(auth.addr)
	payToReqs.PayTo = managedPayer
	payTo, err := SettleManaged(context.Background(), deps, payload, payToReqs, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if payTo.ErrorReason != ErrReceiverMismatch {
		t.Fatalf("payTo: %+v", payTo)
	}

	acquireBound(t, store, "0xpending", voucher)
	authReqs := managedRequirements(auth.addr)
	authReqs.Extra["receiverAuthorizer"] = "0x1111111111111111111111111111111111111111"
	mismatch, err := SettleManaged(context.Background(), deps, payload, authReqs, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if mismatch.ErrorReason != ErrReceiverAuthorizerMismatch {
		t.Fatalf("authorizer: %+v", mismatch)
	}
}

func TestSettleManaged_FallsThroughWhenPendingIdLockGone(t *testing.T) {
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	auth := managedAuthorizer()
	cfg := managedConfig(auth.addr, "00")
	channelId := mustChannelId(t, cfg)
	rpc := &managedRPC{}
	signer := newManagedSigner(t, rpc)

	resp, err := SettleManaged(context.Background(), managedDeps(t, store, store, auth, signer),
		voucherEnvelope(cfg, voucherFields(channelId, "1000", dummySig), "0xpending"),
		managedRequirements(auth.addr), nil, nil)
	if err != nil || !resp.Success {
		t.Fatalf("got %+v %v", resp, err)
	}
	if rpc.tryAggregate == 0 {
		t.Fatal("expected onchain verify")
	}
}

func TestSettleManaged_LockLostManagedRequirementMismatch(t *testing.T) {
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	auth := managedAuthorizer()
	cfg := managedConfig(auth.addr, "00")
	channelId := mustChannelId(t, cfg)
	rpc := &managedRPC{}
	signer := newManagedSigner(t, rpc)

	authReqs := managedRequirements(auth.addr)
	authReqs.Extra["receiverAuthorizer"] = "0x1111111111111111111111111111111111111111"
	resp, err := SettleManaged(context.Background(), managedDeps(t, store, store, auth, signer),
		voucherEnvelope(cfg, voucherFields(channelId, "1000", dummySig), "0xstale"),
		authReqs, nil, nil)
	if err != nil || resp.Success {
		t.Fatalf("got %+v %v", resp, err)
	}
	if resp.ErrorReason != ErrReceiverAuthorizerMismatch {
		t.Fatalf("authorizer: %+v", resp)
	}
	if rpc.tryAggregate != 0 {
		t.Fatal("expected managedRequirement check before onchain verify")
	}

	delayReqs := managedRequirements(auth.addr)
	delayReqs.Extra["withdrawDelay"] = 600
	delay, err := SettleManaged(context.Background(), managedDeps(t, store, store, auth, signer),
		voucherEnvelope(cfg, voucherFields(channelId, "1000", dummySig), "0xstale"),
		delayReqs, nil, nil)
	if err != nil || delay.Success {
		t.Fatalf("got %+v %v", delay, err)
	}
	if delay.ErrorReason != ErrWithdrawDelayMismatch {
		t.Fatalf("withdrawDelay: %+v", delay)
	}
}

func TestVerifyManaged_SkipsOnchainWhenCachedEOAFresh(t *testing.T) {
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	auth := managedAuthorizer()
	cfg := managedConfig(auth.addr, "00")
	cfg.PayerAuthorizer = managedPayer
	channelId := mustChannelId(t, cfg)
	sig := eoaVoucherSignature(t, channelId, "2000", managedNetwork)
	seedManagedChannel(t, store, storedManagedChannel(cfg, channelId, &channelFields{
		Balance:            "10000",
		TotalClaimed:       "0",
		OnchainSyncedAt:    time.Now().UnixMilli(),
		SignedMaxClaimable: "1000",
	}))
	rpc := &managedRPC{}
	signer := newManagedSigner(t, rpc)
	reqs := managedRequirements(auth.addr)
	reqs.Amount = "1000"

	resp, err := VerifyManaged(context.Background(), managedDeps(t, store, store, auth, signer),
		voucherEnvelope(cfg, voucherFields(channelId, "2000", sig), ""), reqs, nil)
	if err != nil || !resp.IsValid {
		t.Fatalf("got %+v %v", resp, err)
	}
	if rpc.tryAggregate != 0 {
		t.Fatalf("tryAggregate=%d, want cached path", rpc.tryAggregate)
	}
}

func TestVerifyManaged_StaleCacheFallsBackToOnchain(t *testing.T) {
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	auth := managedAuthorizer()
	cfg := managedConfig(auth.addr, "00")
	cfg.PayerAuthorizer = managedPayer
	channelId := mustChannelId(t, cfg)
	sig := eoaVoucherSignature(t, channelId, "2000", managedNetwork)
	seedManagedChannel(t, store, storedManagedChannel(cfg, channelId, &channelFields{
		Balance:         "10000",
		TotalClaimed:    "0",
		OnchainSyncedAt: 1,
	}))
	rpc := &managedRPC{}
	signer := newManagedSigner(t, rpc)
	reqs := managedRequirements(auth.addr)
	reqs.Amount = "1000"

	resp, err := VerifyManaged(context.Background(), managedDeps(t, store, store, auth, signer),
		voucherEnvelope(cfg, voucherFields(channelId, "2000", sig), ""), reqs, nil)
	if err != nil || !resp.IsValid {
		t.Fatalf("got %+v %v", resp, err)
	}
	if rpc.tryAggregate == 0 {
		t.Fatal("expected onchain fallback")
	}
}

func TestVerifyManaged_ZeroTtlAlwaysReadsOnchain(t *testing.T) {
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	auth := managedAuthorizer()
	cfg := managedConfig(auth.addr, "00")
	channelId := mustChannelId(t, cfg)
	seedManagedChannel(t, store, storedManagedChannel(cfg, channelId, &channelFields{
		OnchainSyncedAt: time.Now().UnixMilli(),
	}))
	rpc := &managedRPC{}
	signer := newManagedSigner(t, rpc)
	deps := managedDeps(t, store, store, auth, signer)
	zero := int64(0)
	deps.OnchainStateTtlMs = &zero
	reqs := managedRequirements(auth.addr)
	reqs.Amount = "1000"

	resp, err := VerifyManaged(context.Background(), deps,
		voucherEnvelope(cfg, voucherFields(channelId, "2000", dummySig), ""), reqs, nil)
	if err != nil || !resp.IsValid {
		t.Fatalf("got %+v %v", resp, err)
	}
	if rpc.tryAggregate == 0 {
		t.Fatal("expected onchain read")
	}
}

func TestVerifyManaged_RejectsEOASignatureBeforeLock(t *testing.T) {
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	auth := managedAuthorizer()
	cfg := managedConfig(auth.addr, "00")
	cfg.PayerAuthorizer = managedPayer
	channelId := mustChannelId(t, cfg)

	resp, err := VerifyManaged(context.Background(), managedDeps(t, store, store, auth, nil),
		voucherEnvelope(cfg, voucherFields(channelId, "1000", dummySig), ""),
		managedRequirements(auth.addr), nil)
	if err != nil {
		t.Fatal(err)
	}
	if resp.IsValid || resp.InvalidReason != ErrVoucherSignatureInvalid {
		t.Fatalf("got %+v", resp)
	}
	held, _ := store.IsHeld(context.Background(), channelId, "")
	if held {
		t.Fatal("lock should not be taken")
	}
}

func TestVerifyManaged_RethrowsLockImplementationError(t *testing.T) {
	inner := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	store := &hookStore{inner: inner, acquireErr: syntaxLockErr()}
	auth := managedAuthorizer()
	cfg := managedConfig(auth.addr, "00")
	channelId := mustChannelId(t, cfg)

	_, err := VerifyManaged(context.Background(), managedDeps(t, store, store, auth, nil),
		voucherEnvelope(cfg, voucherFields(channelId, "1000", dummySig), ""),
		managedRequirements(auth.addr), nil)
	if err == nil {
		t.Fatal("expected lock implementation error")
	}
}

func TestSettleManaged_ChargeCommitConflict(t *testing.T) {
	inner := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	store := &hookStore{inner: inner, updateConflict: true}
	auth := managedAuthorizer()
	cfg := managedConfig(auth.addr, "00")
	channelId := mustChannelId(t, cfg)

	resp, err := SettleManaged(context.Background(), managedDeps(t, store, store, auth, nil),
		voucherEnvelope(cfg, voucherFields(channelId, "1000", dummySig), ""),
		managedRequirements(auth.addr), nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if resp.Success || resp.ErrorReason != ErrChannelBusy {
		t.Fatalf("got %+v", resp)
	}
}

func TestSettleManaged_ChargeExceedsSignedCap(t *testing.T) {
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	auth := managedAuthorizer()
	cfg := managedConfig(auth.addr, "00")
	channelId := mustChannelId(t, cfg)
	seedManagedChannel(t, store, storedManagedChannel(cfg, channelId, &channelFields{
		ChargedCumulativeAmount: "500",
	}))
	voucher := voucherFields(channelId, "1000", dummySig)
	acquireBound(t, store, "0xpending", voucher)
	reqs := managedRequirements(auth.addr)
	reqs.Amount = "1000"

	resp, err := SettleManaged(context.Background(), managedDeps(t, store, store, auth, nil),
		voucherEnvelope(cfg, voucher, "0xpending"), reqs, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if resp.Success || resp.ErrorReason != ErrChargeExceedsSignedCumulative {
		t.Fatalf("got %+v", resp)
	}
}

func TestSettleManaged_IncrementsChargeCount(t *testing.T) {
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	auth := managedAuthorizer()
	cfg := managedConfig(auth.addr, "00")
	channelId := mustChannelId(t, cfg)
	seedManagedChannel(t, store, storedManagedChannel(cfg, channelId, &channelFields{ChargeCount: 2}))
	voucher := voucherFields(channelId, "2000", dummySig)
	acquireBound(t, store, "0xpending", voucher)
	reqs := managedRequirements(auth.addr)
	reqs.Amount = "1000"

	resp, err := SettleManaged(context.Background(), managedDeps(t, store, store, auth, nil),
		voucherEnvelope(cfg, voucher, "0xpending"), reqs, nil, nil)
	if err != nil || !resp.Success {
		t.Fatalf("got %+v %v", resp, err)
	}
	if extraInt(resp, "chargeCount") != 3 {
		t.Fatalf("chargeCount = %d", extraInt(resp, "chargeCount"))
	}
}

func TestSettleManaged_RefundWithoutConsent(t *testing.T) {
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	auth := managedAuthorizer()
	cfg := managedConfig(auth.addr, "00")
	channelId := mustChannelId(t, cfg)
	seedManagedChannel(t, store, storedManagedChannel(cfg, channelId, &channelFields{
		ChargedCumulativeAmount: "1000",
	}))

	resp, err := SettleManaged(context.Background(), managedDeps(t, store, store, auth, nil),
		refundEnvelope(cfg, voucherFields(channelId, "1000", dummySig), "1000", "", ""),
		managedRequirements(auth.addr), nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if resp.Success || resp.ErrorReason != ErrRefundAuthorizerSignature {
		t.Fatalf("got %+v", resp)
	}
}

func TestSettleManaged_RefundMalformedAmount(t *testing.T) {
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	auth := managedAuthorizer()
	cfg := managedConfig(auth.addr, "00")
	channelId := mustChannelId(t, cfg)
	seedManagedChannel(t, store, storedManagedChannel(cfg, channelId, nil))

	resp, err := SettleManaged(context.Background(), managedDeps(t, store, store, auth, nil),
		refundEnvelope(cfg, voucherFields(channelId, "1000", dummySig), "nope", "", ""),
		managedRequirements(auth.addr), nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if resp.Success || resp.ErrorReason != ErrRefundAmountInvalid {
		t.Fatalf("got %+v", resp)
	}
}

func TestSettleManaged_RefundZeroAmount(t *testing.T) {
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	auth := managedAuthorizer()
	cfg := managedConfig(auth.addr, "00")
	channelId := mustChannelId(t, cfg)
	seedManagedChannel(t, store, storedManagedChannel(cfg, channelId, nil))

	resp, err := SettleManaged(context.Background(), managedDeps(t, store, store, auth, nil),
		refundEnvelope(cfg, voucherFields(channelId, "1000", dummySig), "0", "", ""),
		managedRequirements(auth.addr), nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if resp.Success || resp.ErrorReason != ErrRefundAmountInvalid {
		t.Fatalf("got %+v", resp)
	}
}

func TestSettleManaged_RefundAuthorizerConsent(t *testing.T) {
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	auth := managedAuthorizer()
	refundAuth := auth.addr
	packed, err := batchsettlement.PackRefundAuthorizerSalt("0x"+strings.Repeat("ab", 12), refundAuth)
	if err != nil {
		t.Fatal(err)
	}
	cfg := managedConfig(auth.addr, "00")
	cfg.Salt = packed
	channelId := mustChannelId(t, cfg)
	_, sig := signRefundConsent(t, channelId, "1000", "0", managedNetwork)
	seedManagedChannel(t, store, storedManagedChannel(cfg, channelId, &channelFields{
		ChargedCumulativeAmount: "1000",
		ChargeCount:             0,
	}))
	reqs := managedRequirements(auth.addr)
	reqs.Extra["refundAuthorizer"] = refundAuth
	reqs.Amount = "0"

	resp, err := SettleManaged(context.Background(), managedDeps(t, store, store, auth, nil),
		refundEnvelope(cfg, voucherFields(channelId, "1000", dummySig), "1000", "", sig),
		reqs, nil, nil)
	if err != nil || !resp.Success {
		t.Fatalf("got %+v %v", resp, err)
	}
}

func TestSettleManaged_RefundCallerIdentity(t *testing.T) {
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	auth := managedAuthorizer()
	cfg := managedConfig(auth.addr, "00")
	channelId := mustChannelId(t, cfg)
	seedManagedChannel(t, store, storedManagedChannel(cfg, channelId, &channelFields{
		ChargedCumulativeAmount: "1000",
	}))
	deps := managedDeps(t, store, store, auth, nil)
	bindManagedIdentity(t, deps.DelegatedAuthStore, channelId, "bound-service")
	deps.ResolveCallerIdentity = func(DelegatedSettleContext) (string, error) { return "bound-service", nil }

	resp, err := SettleManaged(context.Background(), deps,
		refundEnvelope(cfg, voucherFields(channelId, "1000", dummySig), "1000", "", ""),
		managedRequirements(auth.addr), nil, nil)
	if err != nil || !resp.Success {
		t.Fatalf("got %+v %v", resp, err)
	}
}

func TestSettleManaged_RefundIdentityMismatch(t *testing.T) {
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	auth := managedAuthorizer()
	cfg := managedConfig(auth.addr, "00")
	channelId := mustChannelId(t, cfg)
	seedManagedChannel(t, store, storedManagedChannel(cfg, channelId, nil))
	deps := managedDeps(t, store, store, auth, nil)
	bindManagedIdentity(t, deps.DelegatedAuthStore, channelId, "bound-service")
	deps.ResolveCallerIdentity = func(DelegatedSettleContext) (string, error) { return "other", nil }

	resp, err := SettleManaged(context.Background(), deps,
		refundEnvelope(cfg, voucherFields(channelId, "1000", dummySig), "1000", "", ""),
		managedRequirements(auth.addr), nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if resp.Success || resp.ErrorReason != ErrRefundAuthorizerSignature {
		t.Fatalf("got %+v", resp)
	}
}

func TestSettleManaged_RefundIdentityResolutionError(t *testing.T) {
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	auth := managedAuthorizer()
	cfg := managedConfig(auth.addr, "00")
	channelId := mustChannelId(t, cfg)
	seedManagedChannel(t, store, storedManagedChannel(cfg, channelId, nil))
	deps := managedDeps(t, store, store, auth, nil)
	deps.ResolveCallerIdentity = func(DelegatedSettleContext) (string, error) { return "", errors.New("boom") }

	resp, err := SettleManaged(context.Background(), deps,
		refundEnvelope(cfg, voucherFields(channelId, "1000", dummySig), "1000", "", ""),
		managedRequirements(auth.addr), nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if resp.Success || resp.ErrorReason != ErrRefundAuthorizerSignature {
		t.Fatalf("got %+v", resp)
	}
}

func TestSettleManaged_RefundDelegatedAuthLookupFailure(t *testing.T) {
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	auth := managedAuthorizer()
	cfg := managedConfig(auth.addr, "00")
	channelId := mustChannelId(t, cfg)
	seedManagedChannel(t, store, storedManagedChannel(cfg, channelId, nil))
	deps := managedDeps(t, store, store, auth, nil)
	deps.ResolveCallerIdentity = func(DelegatedSettleContext) (string, error) { return "svc", nil }
	deps.DelegatedAuthStore = failingDelegatedAuth{}

	resp, err := SettleManaged(context.Background(), deps,
		refundEnvelope(cfg, voucherFields(channelId, "1000", dummySig), "1000", "", ""),
		managedRequirements(auth.addr), nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if resp.Success || resp.ErrorReason != ErrRefundAuthorizerSignature {
		t.Fatalf("got %+v", resp)
	}
}

func TestSettleManaged_RefundMissingDelegatedAuthBinding(t *testing.T) {
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	auth := managedAuthorizer()
	cfg := managedConfig(auth.addr, "00")
	channelId := mustChannelId(t, cfg)
	seedManagedChannel(t, store, storedManagedChannel(cfg, channelId, &channelFields{
		ChargedCumulativeAmount: "5000",
		ChargeCount:             0,
	}))
	deps := managedDeps(t, store, store, auth, nil)
	deps.ResolveCallerIdentity = func(DelegatedSettleContext) (string, error) { return "service-bound", nil }

	resp, err := SettleManaged(context.Background(), deps,
		refundEnvelope(cfg, voucherFields(channelId, "5000", dummySig), "5000", "", ""),
		managedRequirements(auth.addr), nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if resp.Success || resp.ErrorReason != ErrRefundAuthorizerSignature {
		t.Fatalf("got %+v", resp)
	}
}

func TestSettleManaged_CancelReleasesLock(t *testing.T) {
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	auth := managedAuthorizer()
	cfg := managedConfig(auth.addr, "00")
	channelId := mustChannelId(t, cfg)
	voucher := voucherFields(channelId, "2000", dummySig)
	acquireBound(t, store, "0xpending", voucher)

	resp, err := SettleManaged(context.Background(), managedDeps(t, store, store, auth, nil),
		cancelEnvelope(cfg, voucher, "0xpending"),
		managedRequirements(auth.addr), nil, nil)
	if err != nil || !resp.Success {
		t.Fatalf("got %+v %v", resp, err)
	}
	held, _ := store.IsHeld(context.Background(), channelId, "")
	if held {
		t.Fatal("expected released")
	}
}

func TestSettleManaged_ContinuesWhenLockReleaseFails(t *testing.T) {
	inner := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	store := &hookStore{inner: inner, releaseErr: errors.New("release failed")}
	auth := managedAuthorizer()
	cfg := managedConfig(auth.addr, "00")
	channelId := mustChannelId(t, cfg)
	seedManagedChannel(t, inner, storedManagedChannel(cfg, channelId, nil))
	voucher := voucherFields(channelId, "2000", dummySig)
	acquireBound(t, inner, "0xpending", voucher)
	reqs := managedRequirements(auth.addr)
	reqs.Amount = "1000"

	resp, err := SettleManaged(context.Background(), managedDeps(t, store, store, auth, nil),
		voucherEnvelope(cfg, voucher, "0xpending"), reqs, nil, nil)
	if err != nil || !resp.Success {
		t.Fatalf("got %+v %v", resp, err)
	}
}

func TestVerifyManaged_RefundAuthorizerSaltMismatch(t *testing.T) {
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	auth := managedAuthorizer()
	cfg := managedConfig(auth.addr, "00")
	channelId := mustChannelId(t, cfg)
	reqs := managedRequirements(auth.addr)
	reqs.Extra["refundAuthorizer"] = managedPayer

	resp, err := VerifyManaged(context.Background(), managedDeps(t, store, store, auth, nil),
		voucherEnvelope(cfg, voucherFields(channelId, "1000", dummySig), ""), reqs, nil)
	if err != nil {
		t.Fatal(err)
	}
	if resp.IsValid || resp.InvalidReason != ErrRefundAuthorizerMismatch {
		t.Fatalf("got %+v", resp)
	}
}

func TestVerifyManaged_NonAddressReceiverAuthorizer(t *testing.T) {
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	auth := managedAuthorizer()
	cfg := managedConfig(auth.addr, "00")
	channelId := mustChannelId(t, cfg)
	reqs := managedRequirements(auth.addr)
	reqs.Extra["receiverAuthorizer"] = "not-an-address"

	resp, err := VerifyManaged(context.Background(), managedDeps(t, store, store, auth, nil),
		voucherEnvelope(cfg, voucherFields(channelId, "1000", dummySig), ""), reqs, nil)
	if err != nil {
		t.Fatal(err)
	}
	if resp.IsValid || resp.InvalidReason != ErrReceiverAuthorizerMismatch {
		t.Fatalf("got %+v", resp)
	}
}

func TestVerifyManaged_MismatchIncludesVoucherState(t *testing.T) {
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	auth := managedAuthorizer()
	cfg := managedConfig(auth.addr, "00")
	channelId := mustChannelId(t, cfg)
	seedManagedChannel(t, store, storedManagedChannel(cfg, channelId, &channelFields{
		SignedMaxClaimable: "1000",
		Signature:          dummySig,
	}))
	reqs := managedRequirements(auth.addr)
	reqs.Amount = "1000"

	resp, err := VerifyManaged(context.Background(), managedDeps(t, store, store, auth, nil),
		voucherEnvelope(cfg, voucherFields(channelId, "5000", dummySig), ""), reqs, nil)
	if err != nil {
		t.Fatal(err)
	}
	if resp.IsValid || resp.InvalidReason != ErrCumulativeAmountMismatch {
		t.Fatalf("got %+v", resp)
	}
	vs, _ := resp.Extra["voucherState"].(map[string]interface{})
	if extraString(vs, "signature") != dummySig {
		t.Fatalf("voucherState = %+v", vs)
	}
}

func TestSettleManaged_PartialRefundKeepsRow(t *testing.T) {
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	auth := managedAuthorizer()
	refundAuth := auth.addr
	packed, err := batchsettlement.PackRefundAuthorizerSalt("0x"+strings.Repeat("11", 12), refundAuth)
	if err != nil {
		t.Fatal(err)
	}
	cfg := managedConfig(auth.addr, "00")
	cfg.Salt = packed
	channelId := mustChannelId(t, cfg)
	_, sig := signRefundConsent(t, channelId, "1000", "0", managedNetwork)
	seedManagedChannel(t, store, storedManagedChannel(cfg, channelId, &channelFields{
		ChargedCumulativeAmount: "5000",
		Balance:                 "10000",
		ChargeCount:             1,
	}))
	reqs := managedRequirements(auth.addr)
	reqs.Extra["refundAuthorizer"] = refundAuth

	resp, err := SettleManaged(context.Background(), managedDeps(t, store, store, auth, nil),
		refundEnvelope(cfg, voucherFields(channelId, "5000", dummySig), "1000", "", sig),
		reqs, nil, nil)
	if err != nil || !resp.Success {
		t.Fatalf("got %+v %v", resp, err)
	}
	got, _ := store.Get(context.Background(), channelId)
	if got == nil {
		t.Fatal("expected retained row")
	}
}

func TestSettleManaged_FullRefundDeletesRow(t *testing.T) {
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	auth := managedAuthorizer()
	refundAuth := auth.addr
	packed, err := batchsettlement.PackRefundAuthorizerSalt("0x"+strings.Repeat("22", 12), refundAuth)
	if err != nil {
		t.Fatal(err)
	}
	cfg := managedConfig(auth.addr, "00")
	cfg.Salt = packed
	channelId := mustChannelId(t, cfg)
	_, sig := signRefundConsent(t, channelId, "10000", "0", managedNetwork)
	seedManagedChannel(t, store, storedManagedChannel(cfg, channelId, &channelFields{
		ChargedCumulativeAmount: "0",
		SignedMaxClaimable:      "0",
		Balance:                 "10000",
		ChargeCount:             0,
	}))
	reqs := managedRequirements(auth.addr)
	reqs.Extra["refundAuthorizer"] = refundAuth

	resp, err := SettleManaged(context.Background(), managedDeps(t, store, store, auth, nil),
		refundEnvelope(cfg, voucherFields(channelId, "0", dummySig), "10000", "", sig),
		reqs, nil, nil)
	if err != nil || !resp.Success {
		t.Fatalf("got %+v %v", resp, err)
	}
	got, _ := store.Get(context.Background(), channelId)
	if got != nil {
		t.Fatalf("expected deleted row, got %+v", got)
	}
}

func TestVerifyManaged_RefundMatchesWatermark(t *testing.T) {
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	auth := managedAuthorizer()
	cfg := managedConfig(auth.addr, "00")
	channelId := mustChannelId(t, cfg)
	seedManagedChannel(t, store, storedManagedChannel(cfg, channelId, &channelFields{
		ChargedCumulativeAmount: "1000",
	}))
	reqs := managedRequirements(auth.addr)
	reqs.Amount = "0"

	resp, err := VerifyManaged(context.Background(), managedDeps(t, store, store, auth, nil),
		refundEnvelope(cfg, voucherFields(channelId, "1000", dummySig), "", "", ""), reqs, nil)
	if err != nil || !resp.IsValid {
		t.Fatalf("got %+v %v", resp, err)
	}
}

type failingDelegatedAuth struct{}

func (failingDelegatedAuth) Bind(_ context.Context, _ storage.DelegatedAuthBinding) error { return nil }
func (failingDelegatedAuth) Get(_ context.Context, _, _ string) (*storage.DelegatedAuthBinding, error) {
	return nil, errors.New("auth store down")
}
func (failingDelegatedAuth) Delete(_ context.Context, _, _ string) error { return nil }
