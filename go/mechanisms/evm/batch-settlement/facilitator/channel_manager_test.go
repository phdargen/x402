package facilitator

import (
	"bytes"
	"context"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/evm"
	batchsettlement "github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement"
	"github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement/storage"
)

func managerChannel(t *testing.T, auth *fakeAuthorizerSigner, saltSuffix string, overrides *channelFields) *FacilitatorChannel {
	t.Helper()
	cfg := managedConfig(auth.addr, saltSuffix)
	id := mustChannelId(t, cfg)
	ch := storedManagedChannel(cfg, id, overrides)
	if ch.ChargedCumulativeAmount == "1000" && (overrides == nil || overrides.ChargedCumulativeAmount == "") {
		ch.ChargedCumulativeAmount = "1000"
	}
	if overrides == nil {
		ch.ChargedCumulativeAmount = "1000"
		ch.SignedMaxClaimable = "1000"
		ch.ChargeCount = 2
	}
	return ch
}

func newTestManager(t *testing.T, signer evm.FacilitatorEvmSigner, store storage.ChannelStorage[*FacilitatorChannel], auth *fakeAuthorizerSigner, retention FacilitatorRetention, fctx *x402.FacilitatorContext) *FacilitatorChannelManager {
	t.Helper()
	if auth == nil {
		auth = managedAuthorizer()
	}
	if signer == nil {
		signer = newManagedSigner(t, nil)
	}
	if store == nil {
		store = storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	}
	mgr, err := NewFacilitatorChannelManager(FacilitatorChannelManagerConfig{
		Storage:          store,
		Signer:           signer,
		AuthorizerSigner: auth,
		Retention:        retention,
		Context:          fctx,
	})
	if err != nil {
		t.Fatal(err)
	}
	return mgr
}

func TestFacilitatorChannelManager_ClaimEmpty(t *testing.T) {
	mgr := newTestManager(t, newManagedSigner(t, nil), nil, nil, "", nil)
	results, err := mgr.Claim(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 0 {
		t.Fatalf("got %d", len(results))
	}
}

func TestFacilitatorChannelManager_ClaimAppliesTotals(t *testing.T) {
	auth := managedAuthorizer()
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	ch := managerChannel(t, auth, "00", &channelFields{
		ChargedCumulativeAmount: "1000",
		SignedMaxClaimable:      "1000",
		ChargeCount:             2,
	})
	seedManagedChannel(t, store, ch)
	signer := newManagedSigner(t, nil)
	mgr := newTestManager(t, signer, store, auth, "", nil)

	results, err := mgr.Claim(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 1 || results[0].Vouchers != 1 {
		t.Fatalf("results = %+v", results)
	}
	got, _ := store.Get(context.Background(), ch.ChannelId)
	if got.TotalClaimed != "1000" {
		t.Fatalf("totalClaimed = %s", got.TotalClaimed)
	}
	if got.ChargeCount != 0 {
		t.Fatalf("chargeCount = %d", got.ChargeCount)
	}
}

func TestFacilitatorChannelManager_ClaimAppendsBuilderSuffix(t *testing.T) {
	auth := managedAuthorizer()
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	ch := managerChannel(t, auth, "00", &channelFields{
		ChargedCumulativeAmount: "1000",
		SignedMaxClaimable:      "1000",
		ChargeCount:             2,
	})
	seedManagedChannel(t, store, ch)
	signer := newManagedSigner(t, nil)
	suffix := []byte{0x80, 0x21, 0xab, 0xcd}
	mgr := newTestManager(t, signer, store, auth, "", builderContext(suffix))

	if _, err := mgr.Claim(context.Background(), nil); err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(signer.lastDataSuffix, suffix) {
		t.Fatalf("suffix missing from %x", signer.lastDataSuffix)
	}
	counts := batchsettlement.ParseChargeCountsSuffix(signer.lastDataSuffix)
	if len(counts) != 1 || counts[0] != 2 {
		t.Fatalf("counts = %v", counts)
	}
}

func TestFacilitatorChannelManager_ClaimPreservesInFlightChargeCount(t *testing.T) {
	auth := managedAuthorizer()
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	ch := managerChannel(t, auth, "00", &channelFields{
		ChargedCumulativeAmount: "1000",
		SignedMaxClaimable:      "1000",
		ChargeCount:             3,
	})
	seedManagedChannel(t, store, ch)
	signer := newManagedSigner(t, nil)
	origWrite := signer.writeContract
	signer.writeContract = func(functionName string, args ...interface{}) (string, error) {
		if _, err := store.UpdateChannel(context.Background(), ch.ChannelId, func(current *FacilitatorChannel) *FacilitatorChannel {
			if current == nil {
				return current
			}
			next := current.Clone()
			next.ChargeCount = current.ChargeCount + 2
			return next
		}); err != nil {
			t.Fatal(err)
		}
		if origWrite != nil {
			return origWrite(functionName, args...)
		}
		return successTxHash, nil
	}
	mgr := newTestManager(t, signer, store, auth, "", nil)
	if _, err := mgr.Claim(context.Background(), nil); err != nil {
		t.Fatal(err)
	}
	got, _ := store.Get(context.Background(), ch.ChannelId)
	if got.ChargeCount != 2 {
		t.Fatalf("chargeCount = %d, want 2", got.ChargeCount)
	}
	counts := batchsettlement.ParseChargeCountsSuffix(signer.lastDataSuffix)
	if len(counts) != 1 || counts[0] != 3 {
		t.Fatalf("attested counts = %v", counts)
	}
}

func TestFacilitatorChannelManager_ClaimBatches(t *testing.T) {
	auth := managedAuthorizer()
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	for _, suffix := range []string{"01", "02", "03"} {
		ch := managerChannel(t, auth, suffix, &channelFields{
			ChargedCumulativeAmount: "1000",
			SignedMaxClaimable:      "1000",
			ChargeCount:             1,
		})
		seedManagedChannel(t, store, ch)
	}
	signer := newManagedSigner(t, nil)
	mgr := newTestManager(t, signer, store, auth, "", nil)
	results, err := mgr.Claim(context.Background(), &FacilitatorClaimOptions{MaxClaimsPerBatch: 2})
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 2 {
		t.Fatalf("batches = %d, want 2", len(results))
	}
	if signer.writeCalls != 2 {
		t.Fatalf("writes = %d", signer.writeCalls)
	}
}

func TestFacilitatorChannelManager_ClaimSkipsNonIdle(t *testing.T) {
	auth := managedAuthorizer()
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	ch := managerChannel(t, auth, "00", &channelFields{
		ChargedCumulativeAmount: "1000",
		SignedMaxClaimable:      "1000",
		LastRequestTimestamp:    time.Now().UnixMilli(),
		ChargeCount:             1,
	})
	seedManagedChannel(t, store, ch)
	mgr := newTestManager(t, nil, store, auth, "", nil)
	idle := 3600
	results, err := mgr.Claim(context.Background(), &FacilitatorClaimOptions{IdleSecs: &idle})
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 0 {
		t.Fatalf("got %+v", results)
	}
}

func TestFacilitatorChannelManager_ClaimUsesQuery(t *testing.T) {
	auth := managedAuthorizer()
	inner := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	skipped := managerChannel(t, auth, "01", &channelFields{
		ChargedCumulativeAmount: "5000", SignedMaxClaimable: "5000", ChargeCount: 1,
	})
	selected := managerChannel(t, auth, "02", &channelFields{
		ChargedCumulativeAmount: "5000", SignedMaxClaimable: "5000", ChargeCount: 1,
	})
	seedManagedChannel(t, inner, skipped)
	seedManagedChannel(t, inner, selected)
	store := &hookStore{inner: inner, useQuery: true, queryItems: []*FacilitatorChannel{selected}}
	signer := newManagedSigner(t, nil)
	mgr := newTestManager(t, signer, store, auth, "", nil)

	results, err := mgr.Claim(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if store.queryCalls == 0 {
		t.Fatal("expected Query")
	}
	if len(results) != 1 {
		t.Fatalf("results = %+v", results)
	}
	if signer.writeCalls != 1 {
		t.Fatalf("writes = %d", signer.writeCalls)
	}
}

func TestFacilitatorChannelManager_ClaimSimulationFailureLeavesStore(t *testing.T) {
	auth := managedAuthorizer()
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	ch := managerChannel(t, auth, "00", &channelFields{
		ChargedCumulativeAmount: "5000",
		SignedMaxClaimable:      "5000",
		ChargeCount:             3,
	})
	seedManagedChannel(t, store, ch)
	signer := newManagedSigner(t, &managedRPC{simFail: "claimWithSignature"})
	mgr := newTestManager(t, signer, store, auth, "", nil)
	_, err := mgr.Claim(context.Background(), nil)
	if err == nil {
		t.Fatal("expected claim failure")
	}
	got, _ := store.Get(context.Background(), ch.ChannelId)
	if got.ChargeCount != 3 || got.TotalClaimed != "0" {
		t.Fatalf("store mutated: %+v", got)
	}
}

func TestFacilitatorChannelManager_SettleSimulationFailure(t *testing.T) {
	auth := managedAuthorizer()
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	ch := managerChannel(t, auth, "00", &channelFields{TotalClaimed: "5000", ChargedCumulativeAmount: "5000"})
	seedManagedChannel(t, store, ch)
	signer := newManagedSigner(t, &managedRPC{simFail: "settle", receiverClaimed: bigInt(5000)})
	mgr := newTestManager(t, signer, store, auth, "", nil)
	_, err := mgr.Settle(context.Background())
	if err == nil {
		t.Fatal("expected settle failure")
	}
}

func TestFacilitatorChannelManager_ClaimAndSettleEmpty(t *testing.T) {
	mgr := newTestManager(t, nil, nil, nil, "", nil)
	claims, settle, err := mgr.ClaimAndSettle(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(claims) != 0 || len(settle) != 0 {
		t.Fatalf("claims=%v settle=%v", claims, settle)
	}
}

func TestFacilitatorChannelManager_SettleAlreadySettledDoesNotThrow(t *testing.T) {
	auth := managedAuthorizer()
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	ch := managerChannel(t, auth, "00", &channelFields{TotalClaimed: "5000", ChargedCumulativeAmount: "5000"})
	seedManagedChannel(t, store, ch)
	signer := newManagedSigner(t, &managedRPC{receiverClaimed: bigInt(5000), receiverSettled: bigInt(5000)})
	mgr := newTestManager(t, signer, store, auth, "", nil)
	results, err := mgr.Settle(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 0 {
		t.Fatalf("got %+v", results)
	}
}

func TestFacilitatorChannelManager_SettleAppendsBuilderSuffix(t *testing.T) {
	auth := managedAuthorizer()
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	ch := managerChannel(t, auth, "00", &channelFields{TotalClaimed: "5000", ChargedCumulativeAmount: "5000"})
	seedManagedChannel(t, store, ch)
	signer := newManagedSigner(t, &managedRPC{receiverClaimed: bigInt(5000), receiverSettled: bigInt(0)})
	suffix := []byte{0x80, 0x21, 0xaa, 0xbb}
	mgr := newTestManager(t, signer, store, auth, "", builderContext(suffix))
	results, err := mgr.Settle(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 1 {
		t.Fatalf("results = %+v", results)
	}
	if !bytes.Equal(signer.lastDataSuffix, suffix) {
		t.Fatalf("suffix = %x", signer.lastDataSuffix)
	}
}

func TestFacilitatorChannelManager_SettleUsesSettleQuery(t *testing.T) {
	auth := managedAuthorizer()
	inner := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	ch := managerChannel(t, auth, "00", &channelFields{TotalClaimed: "5000"})
	seedManagedChannel(t, inner, ch)
	store := &hookStore{inner: inner, useSettleQuery: true, settleQueryItems: nil}
	signer := newManagedSigner(t, nil)
	mgr := newTestManager(t, signer, store, auth, "", nil)
	results, err := mgr.Settle(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if store.settleQueryCalls == 0 {
		t.Fatal("expected SettleQuery")
	}
	if len(results) != 0 || signer.writeCalls != 0 {
		t.Fatalf("results=%v writes=%d", results, signer.writeCalls)
	}
}

func TestFacilitatorChannelManager_RefundRemainingEscrow(t *testing.T) {
	auth := managedAuthorizer()
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	ch := managerChannel(t, auth, "01", &channelFields{
		ChargedCumulativeAmount: "1000",
		SignedMaxClaimable:      "1000",
		Balance:                 "10000",
		ChargeCount:             0,
	})
	seedManagedChannel(t, store, ch)
	mgr := newTestManager(t, nil, store, auth, "", nil)
	results, err := mgr.Refund(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 1 || !strings.EqualFold(results[0].Channel, ch.ChannelId) {
		t.Fatalf("results = %+v", results)
	}
}

func TestFacilitatorChannelManager_RefundSkipsLiveLock(t *testing.T) {
	auth := managedAuthorizer()
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	ch := managerChannel(t, auth, "00", &channelFields{
		ChargedCumulativeAmount: "1000",
		Balance:                 "10000",
		ChargeCount:             0,
	})
	seedManagedChannel(t, store, ch)
	ok, err := store.Acquire(context.Background(), ch.ChannelId, "pending", 60_000)
	if err != nil || !ok {
		t.Fatalf("acquire: %v %v", ok, err)
	}
	mgr := newTestManager(t, nil, store, auth, "", nil)
	results, err := mgr.Refund(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 0 {
		t.Fatalf("got %+v", results)
	}
}

func TestFacilitatorChannelManager_RefundClaimsThenRefunds(t *testing.T) {
	auth := managedAuthorizer()
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	ch := managerChannel(t, auth, "00", &channelFields{
		ChargedCumulativeAmount: "5000",
		SignedMaxClaimable:      "5000",
		Balance:                 "10000",
		TotalClaimed:            "0",
		ChargeCount:             2,
	})
	seedManagedChannel(t, store, ch)
	signer := newManagedSigner(t, nil)
	mgr := newTestManager(t, signer, store, auth, "", nil)
	results, err := mgr.Refund(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 1 {
		t.Fatalf("results = %+v", results)
	}
	if signer.writeCalls == 0 {
		t.Fatal("expected write")
	}
}

func TestFacilitatorChannelManager_RefundIdleIgnoresZeroBalance(t *testing.T) {
	auth := managedAuthorizer()
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	ch := managerChannel(t, auth, "00", &channelFields{
		Balance:                 "0",
		ChargedCumulativeAmount: "1000",
		TotalClaimed:            "1000",
		LastRequestTimestamp:    time.Now().UnixMilli() - 120_000,
	})
	seedManagedChannel(t, store, ch)
	mgr := newTestManager(t, nil, store, auth, "", nil)
	results, err := mgr.RefundIdleChannels(context.Background(), 60)
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 0 {
		t.Fatalf("got %+v", results)
	}
}

func TestFacilitatorChannelManager_RetentionForever(t *testing.T) {
	auth := managedAuthorizer()
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	ch := managerChannel(t, auth, "00", &channelFields{
		ChargedCumulativeAmount: "1000",
		SignedMaxClaimable:      "1000",
		Balance:                 "1000",
		ChargeCount:             1,
	})
	seedManagedChannel(t, store, ch)
	mgr := newTestManager(t, nil, store, auth, RetentionForever, nil)
	if _, err := mgr.Claim(context.Background(), nil); err != nil {
		t.Fatal(err)
	}
	got, _ := store.Get(context.Background(), ch.ChannelId)
	if got == nil {
		t.Fatal("expected retained closed row")
	}
}

func TestFacilitatorChannelManager_ClaimOnlyWhenFullyEarmarked(t *testing.T) {
	auth := managedAuthorizer()
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	ch := managerChannel(t, auth, "00", &channelFields{
		ChargedCumulativeAmount: "10000",
		SignedMaxClaimable:      "10000",
		Balance:                 "10000",
		TotalClaimed:            "0",
		ChargeCount:             1,
	})
	seedManagedChannel(t, store, ch)
	signer := newManagedSigner(t, nil)
	mgr := newTestManager(t, signer, store, auth, "", nil)
	results, err := mgr.Refund(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 1 {
		t.Fatalf("results = %+v", results)
	}
	if got := signer.writeFns; len(got) == 0 || (got[0] != "claimWithSignature" && got[0] != "claim") {
		t.Fatalf("writeFns = %v", got)
	}
}

func TestFacilitatorChannelManager_RefundIdleRespectsIdleWindow(t *testing.T) {
	auth := managedAuthorizer()
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	ch := managerChannel(t, auth, "00", &channelFields{
		Balance:                 "10000",
		ChargedCumulativeAmount: "0",
		LastRequestTimestamp:    time.Now().UnixMilli(),
		ChargeCount:             0,
	})
	seedManagedChannel(t, store, ch)
	mgr := newTestManager(t, nil, store, auth, "", nil)
	results, err := mgr.RefundIdleChannels(context.Background(), 3600)
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 0 {
		t.Fatalf("got %+v", results)
	}
}

func TestFacilitatorChannelManager_StartStopDoesNotDoubleStart(t *testing.T) {
	mgr := newTestManager(t, nil, nil, nil, "", nil)
	interval := 5
	mgr.Start(FacilitatorAutoConfig{ClaimIntervalSecs: &interval})
	mgr.Start(FacilitatorAutoConfig{ClaimIntervalSecs: &interval})
	if len(mgr.timers) != 1 {
		t.Fatalf("timers = %d", len(mgr.timers))
	}
	if err := mgr.Stop(context.Background(), false); err != nil {
		t.Fatal(err)
	}
	if len(mgr.timers) != 0 {
		t.Fatalf("timers after stop = %d", len(mgr.timers))
	}
}

func TestFacilitatorChannelManager_StopDoesNotEnqueue(t *testing.T) {
	mgr := newTestManager(t, nil, nil, nil, "", nil)
	var called atomic.Int32
	interval := 1
	mgr.Start(FacilitatorAutoConfig{
		ClaimIntervalSecs: &interval,
		OnClaim:           func(FacilitatorClaimResult) { called.Add(1) },
	})
	if err := mgr.Stop(context.Background(), false); err != nil {
		t.Fatal(err)
	}
	time.Sleep(1200 * time.Millisecond)
	if got := called.Load(); got != 0 {
		t.Fatalf("onClaim = %d", got)
	}
}

func TestFacilitatorChannelManager_AutoClaimError(t *testing.T) {
	auth := managedAuthorizer()
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	ch := managerChannel(t, auth, "00", &channelFields{
		ChargedCumulativeAmount: "5000",
		SignedMaxClaimable:      "5000",
		ChargeCount:             1,
	})
	seedManagedChannel(t, store, ch)
	signer := newManagedSigner(t, &managedRPC{simFail: "claimWithSignature"})
	mgr := newTestManager(t, signer, store, auth, "", nil)
	saw := make(chan error, 1)
	interval := 1
	mgr.Start(FacilitatorAutoConfig{
		ClaimIntervalSecs: &interval,
		OnError: func(err error) {
			select {
			case saw <- err:
			default:
			}
		},
	})
	select {
	case <-saw:
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for claim error")
	}
	_ = mgr.Stop(context.Background(), false)
}

func TestFacilitatorChannelManager_FlushOnStop(t *testing.T) {
	auth := managedAuthorizer()
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	ch := managerChannel(t, auth, "00", &channelFields{
		ChargedCumulativeAmount: "1000",
		SignedMaxClaimable:      "1000",
		ChargeCount:             1,
	})
	seedManagedChannel(t, store, ch)
	signer := newManagedSigner(t, &managedRPC{receiverClaimed: bigInt(1000)})
	mgr := newTestManager(t, signer, store, auth, "", nil)
	interval := 60
	mgr.Start(FacilitatorAutoConfig{ClaimIntervalSecs: &interval, SettleIntervalSecs: &interval})
	if err := mgr.Stop(context.Background(), true); err != nil {
		t.Fatal(err)
	}
	got, _ := store.Get(context.Background(), ch.ChannelId)
	if got != nil && got.TotalClaimed != "1000" {
		t.Fatalf("expected claimed, got %+v", got)
	}
}

func TestFacilitatorChannelManager_PendingSettleSkipped(t *testing.T) {
	auth := managedAuthorizer()
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	ch := managerChannel(t, auth, "00", &channelFields{
		TotalClaimed:            "5000",
		ChargedCumulativeAmount: "5000",
	})
	seedManagedChannel(t, store, ch)
	signer := newManagedSigner(t, &managedRPC{receiverClaimed: bigInt(5000), receiverSettled: bigInt(5000)})
	mgr := newTestManager(t, signer, store, auth, "", nil)
	var settled atomic.Int32
	var errored atomic.Int32
	interval := 1
	mgr.Start(FacilitatorAutoConfig{
		SettleIntervalSecs: &interval,
		OnSettle:           func(FacilitatorSettleResult) { settled.Add(1) },
		OnError:            func(error) { errored.Add(1) },
	})
	time.Sleep(1500 * time.Millisecond)
	_ = mgr.Stop(context.Background(), false)
	if settled.Load() != 0 || errored.Load() != 0 || signer.writeCalls != 0 {
		t.Fatalf("settle=%d err=%d writes=%d", settled.Load(), errored.Load(), signer.writeCalls)
	}
}
