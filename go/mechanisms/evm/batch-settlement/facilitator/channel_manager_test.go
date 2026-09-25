package facilitator

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"math/big"
	"reflect"
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

func seedManagerSettleTarget(t *testing.T, mgr *FacilitatorChannelManager, ch *FacilitatorChannel) {
	t.Helper()
	if err := mgr.settleTargetStorage.ApplySettleTargetClaimDelta(context.Background(), storage.SettleTargetClaimDelta{
		Network:  ch.Network,
		Receiver: ch.ChannelConfig.Receiver,
		Token:    ch.ChannelConfig.Token,
		Amount:   bigInt(1),
	}); err != nil {
		t.Fatal(err)
	}
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
	// Claim is capacity-capped per run: Limit == MaxClaimsPerBatch so the
	// worker query early-stops. With 3 claimable and Max=2 the first run
	// claims 2 in one batch; the remainder is picked up on the next run.
	results, err := mgr.Claim(context.Background(), &FacilitatorClaimOptions{MaxClaimsPerBatch: 2})
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 1 {
		t.Fatalf("batches = %d, want 1 (capacity-capped)", len(results))
	}
	if results[0].Vouchers != 2 {
		t.Fatalf("vouchers = %d, want 2", results[0].Vouchers)
	}
	if signer.writeCalls != 1 {
		t.Fatalf("writes = %d, want 1", signer.writeCalls)
	}
	results, err = mgr.Claim(context.Background(), &FacilitatorClaimOptions{MaxClaimsPerBatch: 2})
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 1 || results[0].Vouchers != 1 {
		t.Fatalf("second run results = %+v, want 1 batch of 1", results)
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
	results, err := mgr.Claim(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 0 {
		t.Fatalf("results = %+v", results)
	}
	got, _ := store.Get(context.Background(), ch.ChannelId)
	if got.ChargeCount != 3 || got.TotalClaimed != "0" {
		t.Fatalf("store mutated: %+v", got)
	}
}

func TestFacilitatorChannelManager_ClaimContinuesAfterBatchFailure(t *testing.T) {
	auth := managedAuthorizer()
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	channels := make([]*FacilitatorChannel, 0, 2)
	for _, suffix := range []string{"01", "02"} {
		ch := managerChannel(t, auth, suffix, &channelFields{
			ChargedCumulativeAmount: "1000",
			SignedMaxClaimable:      "1000",
			ChargeCount:             1,
		})
		seedManagedChannel(t, store, ch)
		channels = append(channels, ch)
	}
	signer := newManagedSigner(t, nil)
	innerRead := signer.readContract
	claimSims := 0
	signer.readContract = func(functionName string, args ...interface{}) (interface{}, error) {
		if functionName == "claimWithSignature" {
			claimSims++
			if claimSims == 1 {
				return nil, fmt.Errorf("execution reverted")
			}
		}
		return innerRead(functionName, args...)
	}
	mgr := newTestManager(t, signer, store, auth, "", nil)
	results, err := mgr.Claim(context.Background(), &FacilitatorClaimOptions{
		MaxClaimsPerBatch: 1,
		MaxTxsPerRun:      2,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 1 || results[0].Vouchers != 1 {
		t.Fatalf("results = %+v, want the successful batch", results)
	}
	if signer.writeCalls != 1 {
		t.Fatalf("writes = %d, want 1", signer.writeCalls)
	}
	claimed := 0
	untouched := 0
	for _, ch := range channels {
		got, getErr := store.Get(context.Background(), ch.ChannelId)
		if getErr != nil {
			t.Fatal(getErr)
		}
		if got.TotalClaimed == "1000" {
			claimed++
		} else if got.TotalClaimed == "0" && got.ChargeCount == 1 {
			untouched++
		} else {
			t.Fatalf("channel %s totalClaimed=%s chargeCount=%d", ch.ChannelId, got.TotalClaimed, got.ChargeCount)
		}
	}
	if claimed != 1 || untouched != 1 {
		t.Fatalf("claimed=%d untouched=%d", claimed, untouched)
	}
}

func TestFacilitatorChannelManager_SettleSimulationFailure(t *testing.T) {
	auth := managedAuthorizer()
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	ch := managerChannel(t, auth, "00", &channelFields{TotalClaimed: "5000", ChargedCumulativeAmount: "5000"})
	seedManagedChannel(t, store, ch)
	signer := newManagedSigner(t, &managedRPC{simFail: "multicall", receiverClaimed: bigInt(5000), receiverSettled: bigInt(0)})
	mgr := newTestManager(t, signer, store, auth, "", nil)
	seedManagerSettleTarget(t, mgr, ch)
	var reported []string
	results, err := mgr.Settle(context.Background(), &FacilitatorSettleOptions{
		OnError: func(err error, target *storage.SettleTarget) {
			if target != nil {
				reported = append(reported, target.Receiver)
			}
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 0 {
		t.Fatalf("results = %+v", results)
	}
	if len(reported) != 1 {
		t.Fatalf("reported = %v", reported)
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
	seedManagerSettleTarget(t, mgr, ch)
	results, err := mgr.Settle(context.Background(), nil)
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
	seedManagerSettleTarget(t, mgr, ch)
	results, err := mgr.Settle(context.Background(), nil)
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
	targets := &recordingSettleTargets{}
	signer := newManagedSigner(t, nil)
	mgr := newTestManager(t, signer, inner, auth, "", nil)
	mgr.settleTargetStorage = targets
	results, err := mgr.Settle(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if targets.calls == 0 {
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
	signer := newManagedSigner(t, &managedRPC{readFail: true})
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

func TestFacilitatorChannelManager_ClaimPassesThresholdOptions(t *testing.T) {
	auth := managedAuthorizer()
	inner := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	ch := managerChannel(t, auth, "01", &channelFields{
		ChargedCumulativeAmount: "5000", SignedMaxClaimable: "5000", ChargeCount: 1,
	})
	seedManagedChannel(t, inner, ch)
	store := &hookStore{inner: inner, useQuery: true, queryItems: []*FacilitatorChannel{ch}}
	signer := newManagedSigner(t, nil)
	mgr := newTestManager(t, signer, store, auth, "", nil)

	minUnclaimed := "1000"
	if _, err := mgr.Claim(context.Background(), &FacilitatorClaimOptions{MinUnclaimed: &minUnclaimed, UnclaimedDesc: true}); err != nil {
		t.Fatal(err)
	}
	if store.queryFilter.MinUnclaimed == nil || *store.queryFilter.MinUnclaimed != minUnclaimed {
		t.Fatalf("MinUnclaimed = %+v, want %q", store.queryFilter.MinUnclaimed, minUnclaimed)
	}
	if !store.queryFilter.UnclaimedDesc {
		t.Fatal("UnclaimedDesc not passed through")
	}
}

type claimQueryRecorder struct {
	*storage.InMemoryChannelStorage[*FacilitatorChannel]
	calls   int
	filters []storage.ChannelQuery
}

func (s *claimQueryRecorder) Query(ctx context.Context, filter storage.ChannelQuery, opts *storage.ChannelStoreOptions) (*storage.QueryPage[*FacilitatorChannel], error) {
	s.calls++
	s.filters = append(s.filters, filter)
	return storage.QueryByScan[*FacilitatorChannel](ctx, s, filter)
}

func TestFacilitatorChannelManager_ClaimOldestFirstOverflowRequeriesUnclaimedDesc(t *testing.T) {
	auth := managedAuthorizer()
	inner := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	for _, suffix := range []string{"01", "02"} {
		ch := managerChannel(t, auth, suffix, &channelFields{
			ChargedCumulativeAmount: "5000",
			SignedMaxClaimable:      "5000",
			ChargeCount:             1,
		})
		seedManagedChannel(t, inner, ch)
	}
	store := &claimQueryRecorder{InMemoryChannelStorage: inner}
	signer := newManagedSigner(t, nil)
	mgr := newTestManager(t, signer, store, auth, "", nil)

	minUnclaimed := "1000"
	idle := 86400
	opts := &FacilitatorClaimOptions{
		MaxClaimsPerBatch: 1,
		MaxTxsPerRun:      1,
		OldestFirst:       true,
		MinUnclaimed:      &minUnclaimed,
		IdleSecs:          &idle,
	}
	if _, err := mgr.Claim(context.Background(), opts); err != nil {
		t.Fatal(err)
	}
	if store.calls != 2 {
		t.Fatalf("queryCalls = %d, want probe + overflow re-query", store.calls)
	}
	if !store.filters[0].OldestFirst || store.filters[0].UnclaimedDesc {
		t.Fatalf("first filter = %+v, want oldest-first probe", store.filters[0])
	}
	if !store.filters[1].UnclaimedDesc || store.filters[1].OldestFirst {
		t.Fatalf("second filter = %+v, want UnclaimedDesc re-query", store.filters[1])
	}
	if signer.writeCalls != 1 {
		t.Fatalf("writes = %d, want 1 submission", signer.writeCalls)
	}
	claimed := 0
	for _, suffix := range []string{"01", "02"} {
		ch := managerChannel(t, auth, suffix, nil)
		got, getErr := inner.Get(context.Background(), ch.ChannelId)
		if getErr != nil {
			t.Fatal(getErr)
		}
		if got != nil && got.TotalClaimed == "5000" {
			claimed++
		}
	}
	if claimed != 1 {
		t.Fatalf("claimed rows = %d, want 1", claimed)
	}
}

func TestFacilitatorChannelManager_ClaimPassesMaxTxsPerRunLimit(t *testing.T) {
	auth := managedAuthorizer()
	inner := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	store := &hookStore{inner: inner, useQuery: true}
	signer := newManagedSigner(t, nil)
	mgr := newTestManager(t, signer, store, auth, "", nil)

	if _, err := mgr.Claim(context.Background(), &FacilitatorClaimOptions{MaxClaimsPerBatch: 2, MaxTxsPerRun: 3}); err != nil {
		t.Fatal(err)
	}
	if store.queryFilter.Limit == nil || *store.queryFilter.Limit != 6 {
		t.Fatalf("Limit = %v, want 6", store.queryFilter.Limit)
	}
}

func TestFacilitatorChannelManager_SettleMulticall(t *testing.T) {
	auth := managedAuthorizer()
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	ch := managerChannel(t, auth, "00", &channelFields{TotalClaimed: "5000", ChargedCumulativeAmount: "5000"})
	seedManagedChannel(t, store, ch)
	signer := newManagedSigner(t, &managedRPC{receiverClaimed: bigInt(5000), receiverSettled: bigInt(0)})
	mgr := newTestManager(t, signer, store, auth, "", nil)
	if err := mgr.settleTargetStorage.ApplySettleTargetClaimDelta(context.Background(), storage.SettleTargetClaimDelta{
		Network:  ch.Network,
		Receiver: ch.ChannelConfig.Receiver,
		Token:    ch.ChannelConfig.Token,
		Amount:   bigInt(2),
	}); err != nil {
		t.Fatal(err)
	}
	minPending := "1"
	results, err := mgr.Settle(context.Background(), &FacilitatorSettleOptions{
		MinPending:      &minPending,
		MaxSettlesPerTx: 10,
		MaxTxsPerRun:    1,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 1 {
		t.Fatalf("results = %+v", results)
	}
	if signer.writeFns[len(signer.writeFns)-1] != "multicall" {
		t.Fatalf("writeFns = %v, want multicall", signer.writeFns)
	}
}

func TestFacilitatorChannelManager_SettleDropsFailedReceiverReads(t *testing.T) {
	auth := managedAuthorizer()
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	good := finishedManagedChannel(t, auth, "61")
	bad := finishedManagedChannel(t, auth, "62")
	bad.ChannelConfig.Receiver = "0x1111111111111111111111111111111111111111"
	seedManagedChannel(t, store, good)
	seedManagedChannel(t, store, bad)
	signer := newManagedSigner(t, &managedRPC{
		receiverClaimed: bigInt(1000),
		receiverSettled: bigInt(1000),
		failReceivers: map[string]struct{}{
			strings.ToLower(bad.ChannelConfig.Receiver): {},
		},
	})
	mgr := newTestManager(t, signer, store, auth, "", nil)
	seedManagerSettleTarget(t, mgr, good)
	seedManagerSettleTarget(t, mgr, bad)
	results, err := mgr.Settle(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 0 || signer.writeCalls != 0 {
		t.Fatalf("results=%+v writes=%d", results, signer.writeCalls)
	}
	if got, _ := store.Get(context.Background(), good.ChannelId); got != nil {
		t.Fatal("expected good receiver to be cleaned up")
	}
	if got, _ := store.Get(context.Background(), bad.ChannelId); got == nil {
		t.Fatal("expected failed receiver read to keep the row")
	}
}

func TestFacilitatorChannelManager_SettleRetriesReceiverMulticall(t *testing.T) {
	auth := managedAuthorizer()
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	ch := managerChannel(t, auth, "71", &channelFields{TotalClaimed: "5000", ChargedCumulativeAmount: "5000"})
	seedManagedChannel(t, store, ch)
	signer := newManagedSigner(t, &managedRPC{receiverClaimed: bigInt(5000), receiverSettled: bigInt(0)})
	inner := signer.readContract
	var attempts int
	signer.readContract = func(functionName string, args ...interface{}) (interface{}, error) {
		if functionName == evm.FunctionTryAggregate {
			attempts++
			if attempts < multicallAttempts {
				return nil, fmt.Errorf("rpc down")
			}
		}
		return inner(functionName, args...)
	}
	mgr := newTestManager(t, signer, store, auth, "", nil)
	seedManagerSettleTarget(t, mgr, ch)
	results, err := mgr.Settle(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if attempts != multicallAttempts+1 || len(results) != 1 {
		t.Fatalf("attempts=%d results=%+v", attempts, results)
	}
}

func TestFacilitatorChannelManager_SettleReceiverReadGivesUpAfterRetries(t *testing.T) {
	auth := managedAuthorizer()
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	ch := managerChannel(t, auth, "72", &channelFields{TotalClaimed: "5000", ChargedCumulativeAmount: "5000"})
	seedManagedChannel(t, store, ch)
	signer := newManagedSigner(t, &managedRPC{receiverClaimed: bigInt(5000), receiverSettled: bigInt(0)})
	inner := signer.readContract
	var attempts int
	signer.readContract = func(functionName string, args ...interface{}) (interface{}, error) {
		if functionName == evm.FunctionTryAggregate {
			attempts++
			return nil, fmt.Errorf("rpc down")
		}
		return inner(functionName, args...)
	}
	mgr := newTestManager(t, signer, store, auth, "", nil)
	seedManagerSettleTarget(t, mgr, ch)
	_, err := mgr.Settle(context.Background(), nil)
	if err == nil {
		t.Fatal("expected receiver read failure")
	}
	if attempts != multicallAttempts || signer.writeCalls != 0 {
		t.Fatalf("attempts=%d writes=%d", attempts, signer.writeCalls)
	}
	if got, _ := store.Get(context.Background(), ch.ChannelId); got == nil {
		t.Fatal("expected the row to remain")
	}
}

func TestFacilitatorChannelManager_ClaimDefaultOptionsUnchanged(t *testing.T) {
	auth := managedAuthorizer()
	inner := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	ch := managerChannel(t, auth, "01", &channelFields{
		ChargedCumulativeAmount: "5000", SignedMaxClaimable: "5000", ChargeCount: 1,
	})
	seedManagedChannel(t, inner, ch)
	store := &hookStore{inner: inner, useQuery: true, queryItems: []*FacilitatorChannel{ch}}
	signer := newManagedSigner(t, nil)
	mgr := newTestManager(t, signer, store, auth, "", nil)

	if _, err := mgr.Claim(context.Background(), nil); err != nil {
		t.Fatal(err)
	}
	if store.queryFilter.MinUnclaimed != nil {
		t.Fatalf("MinUnclaimed = %q, want nil", *store.queryFilter.MinUnclaimed)
	}
	if store.queryFilter.UnclaimedDesc {
		t.Fatal("UnclaimedDesc should default to false")
	}
	if store.queryFilter.IdleAtOrBefore != nil {
		t.Fatal("IdleAtOrBefore should default to nil")
	}
}

func TestFacilitatorChannelManager_ClaimSubmitsActiveAndIdleRows(t *testing.T) {
	auth := managedAuthorizer()
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	recent := managerChannel(t, auth, "01", &channelFields{
		ChargedCumulativeAmount: "5000",
		SignedMaxClaimable:      "5000",
		LastRequestTimestamp:    time.Now().UnixMilli(),
		ChargeCount:             1,
	})
	idle := managerChannel(t, auth, "02", &channelFields{
		ChargedCumulativeAmount: "100",
		SignedMaxClaimable:      "100",
		LastRequestTimestamp:    time.Now().UnixMilli() - 48*60*60*1000,
		ChargeCount:             1,
	})
	seedManagedChannel(t, store, recent)
	seedManagedChannel(t, store, idle)
	signer := newManagedSigner(t, nil)
	mgr := newTestManager(t, signer, store, auth, "", nil)
	idleSecs := 86400
	minUnclaimed := "1000"
	results, err := mgr.Claim(context.Background(), &FacilitatorClaimOptions{
		IdleSecs:     &idleSecs,
		MinUnclaimed: &minUnclaimed,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 1 || results[0].Vouchers != 2 {
		t.Fatalf("results = %+v", results)
	}
	if signer.writeCalls != 1 {
		t.Fatalf("writes = %d", signer.writeCalls)
	}
	gotRecent, _ := store.Get(context.Background(), recent.ChannelId)
	gotIdle, _ := store.Get(context.Background(), idle.ChannelId)
	if gotRecent.TotalClaimed != "5000" || gotIdle.TotalClaimed != "100" {
		t.Fatalf("recent=%s idle=%s", gotRecent.TotalClaimed, gotIdle.TotalClaimed)
	}
}

func TestFacilitatorChannelManager_ClaimSubmitsRecentWithdrawPendingBelowThreshold(t *testing.T) {
	auth := managedAuthorizer()
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	ch := managerChannel(t, auth, "03", &channelFields{
		ChargedCumulativeAmount: "100",
		SignedMaxClaimable:      "100",
		LastRequestTimestamp:    time.Now().UnixMilli(),
		WithdrawRequestedAt:     10,
		ChargeCount:             1,
	})
	seedManagedChannel(t, store, ch)
	signer := newManagedSigner(t, nil)
	mgr := newTestManager(t, signer, store, auth, "", nil)
	idleSecs := 86400
	minUnclaimed := "1000"
	results, err := mgr.Claim(context.Background(), &FacilitatorClaimOptions{
		IdleSecs:     &idleSecs,
		MinUnclaimed: &minUnclaimed,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 1 || results[0].Vouchers != 1 {
		t.Fatalf("results = %+v", results)
	}
	got, _ := store.Get(context.Background(), ch.ChannelId)
	if got.TotalClaimed != "100" {
		t.Fatalf("totalClaimed = %s", got.TotalClaimed)
	}
}

func TestFacilitatorChannelManager_ClaimBisectsSimulationFailure(t *testing.T) {
	auth := managedAuthorizer()
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	good := managerChannel(t, auth, "11", &channelFields{
		ChargedCumulativeAmount: "1000",
		SignedMaxClaimable:      "1000",
		ChargeCount:             1,
	})
	bad := managerChannel(t, auth, "12", &channelFields{
		ChargedCumulativeAmount: "7777",
		SignedMaxClaimable:      "7777",
		ChargeCount:             4,
	})
	seedManagedChannel(t, store, good)
	seedManagedChannel(t, store, bad)
	rpc := &managedRPC{resyncView: &managedChainView{
		Balance:      big.NewInt(50),
		TotalClaimed: big.NewInt(50),
		WithdrawAt:   42,
	}}
	signer := newManagedSigner(t, rpc)
	innerRead := signer.readContract
	signer.readContract = func(functionName string, args ...interface{}) (interface{}, error) {
		if functionName == "claimWithSignature" && claimBatchContains(args, "7777") {
			return nil, fmt.Errorf("execution reverted: ClaimExceedsBalance")
		}
		return innerRead(functionName, args...)
	}
	mgr := newTestManager(t, signer, store, auth, "", nil)
	results, err := mgr.Claim(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 1 || results[0].Vouchers != 1 {
		t.Fatalf("results = %+v", results)
	}
	gotGood, _ := store.Get(context.Background(), good.ChannelId)
	gotBad, _ := store.Get(context.Background(), bad.ChannelId)
	if gotGood.TotalClaimed != "1000" || gotGood.ChargeCount != 0 {
		t.Fatalf("good = total %s count %d", gotGood.TotalClaimed, gotGood.ChargeCount)
	}
	if gotBad.TotalClaimed != "50" || gotBad.Balance != "50" || gotBad.WithdrawRequestedAt != 42 || gotBad.ChargeCount != 4 {
		t.Fatalf("bad = %+v", gotBad.Channel)
	}
}

func TestFacilitatorChannelManager_ClaimDropsFailedPreflightReads(t *testing.T) {
	auth := managedAuthorizer()
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	good := managerChannel(t, auth, "61", &channelFields{
		ChargedCumulativeAmount: "1000",
		SignedMaxClaimable:      "1000",
		ChargeCount:             1,
	})
	bad := managerChannel(t, auth, "62", &channelFields{
		ChargedCumulativeAmount: "1000",
		SignedMaxClaimable:      "1000",
		ChargeCount:             3,
	})
	seedManagedChannel(t, store, good)
	seedManagedChannel(t, store, bad)
	signer := newManagedSigner(t, &managedRPC{failReads: map[string]struct{}{
		strings.ToLower(bad.ChannelId): {},
	}})
	mgr := newTestManager(t, signer, store, auth, "", nil)
	results, err := mgr.Claim(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 1 || results[0].Vouchers != 1 || signer.writeCalls != 1 {
		t.Fatalf("results=%+v writes=%d", results, signer.writeCalls)
	}
	gotGood, _ := store.Get(context.Background(), good.ChannelId)
	gotBad, _ := store.Get(context.Background(), bad.ChannelId)
	if gotGood.TotalClaimed != "1000" || gotGood.ChargeCount != 0 {
		t.Fatalf("good = total %s count %d", gotGood.TotalClaimed, gotGood.ChargeCount)
	}
	if gotBad.TotalClaimed != "0" || gotBad.ChargeCount != 3 {
		t.Fatalf("bad = total %s count %d", gotBad.TotalClaimed, gotBad.ChargeCount)
	}
}

func TestFacilitatorChannelManager_ClaimRetriesPreflightMulticall(t *testing.T) {
	auth := managedAuthorizer()
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	ch := managerChannel(t, auth, "71", &channelFields{
		ChargedCumulativeAmount: "1000",
		SignedMaxClaimable:      "1000",
		ChargeCount:             1,
	})
	seedManagedChannel(t, store, ch)
	signer := newManagedSigner(t, nil)
	inner := signer.readContract
	var attempts int
	signer.readContract = func(functionName string, args ...interface{}) (interface{}, error) {
		if functionName == evm.FunctionTryAggregate {
			attempts++
			if attempts < multicallAttempts {
				return nil, fmt.Errorf("rpc down")
			}
		}
		return inner(functionName, args...)
	}
	mgr := newTestManager(t, signer, store, auth, "", nil)
	results, err := mgr.Claim(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if attempts != multicallAttempts || len(results) != 1 || results[0].Vouchers != 1 {
		t.Fatalf("attempts=%d results=%+v", attempts, results)
	}
	got, _ := store.Get(context.Background(), ch.ChannelId)
	if got.TotalClaimed != "1000" {
		t.Fatalf("totalClaimed = %s", got.TotalClaimed)
	}
}

func TestFacilitatorChannelManager_ClaimPreflightGivesUpAfterRetries(t *testing.T) {
	auth := managedAuthorizer()
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	ch := managerChannel(t, auth, "72", &channelFields{
		ChargedCumulativeAmount: "1000",
		SignedMaxClaimable:      "1000",
		ChargeCount:             1,
	})
	seedManagedChannel(t, store, ch)
	signer := newManagedSigner(t, nil)
	inner := signer.readContract
	var attempts int
	signer.readContract = func(functionName string, args ...interface{}) (interface{}, error) {
		if functionName == evm.FunctionTryAggregate {
			attempts++
			return nil, fmt.Errorf("rpc down")
		}
		return inner(functionName, args...)
	}
	mgr := newTestManager(t, signer, store, auth, "", nil)
	_, err := mgr.Claim(context.Background(), nil)
	if err == nil {
		t.Fatal("expected preflight failure")
	}
	if attempts != multicallAttempts {
		t.Fatalf("attempts = %d, want %d", attempts, multicallAttempts)
	}
	got, _ := store.Get(context.Background(), ch.ChannelId)
	if got.TotalClaimed != "0" || got.ChargeCount != 1 {
		t.Fatalf("totalClaimed=%s chargeCount=%d", got.TotalClaimed, got.ChargeCount)
	}
}

func TestFacilitatorChannelManager_ClaimSkipsDrainedRow(t *testing.T) {
	auth := managedAuthorizer()
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	ch := managerChannel(t, auth, "21", &channelFields{
		ChargedCumulativeAmount: "1000",
		SignedMaxClaimable:      "1000",
		Balance:                 "10000",
		ChargeCount:             2,
	})
	seedManagedChannel(t, store, ch)
	rpc := &managedRPC{chainViews: map[string]managedChainView{
		strings.ToLower(ch.ChannelId): {Balance: big.NewInt(40), TotalClaimed: big.NewInt(40), WithdrawAt: 7},
	}}
	signer := newManagedSigner(t, rpc)
	mgr := newTestManager(t, signer, store, auth, "", nil)
	results, err := mgr.Claim(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 0 || signer.writeCalls != 0 {
		t.Fatalf("results=%+v writes=%d", results, signer.writeCalls)
	}
	got, _ := store.Get(context.Background(), ch.ChannelId)
	if got.Balance != "40" || got.TotalClaimed != "40" || got.WithdrawRequestedAt != 7 || got.ChargeCount != 2 {
		t.Fatalf("resynced = balance %s claimed %s withdraw %d count %d", got.Balance, got.TotalClaimed, got.WithdrawRequestedAt, got.ChargeCount)
	}
	reads := rpc.tryAggregate
	results, err = mgr.Claim(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 0 || signer.writeCalls != 0 || rpc.tryAggregate != reads {
		t.Fatalf("reselected results=%+v writes=%d reads=%d want %d", results, signer.writeCalls, rpc.tryAggregate, reads)
	}
}

func TestFacilitatorChannelManager_ClaimPartialWithdrawUsesBalance(t *testing.T) {
	auth := managedAuthorizer()
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	ch := managerChannel(t, auth, "31", &channelFields{
		ChargedCumulativeAmount: "1000",
		SignedMaxClaimable:      "1000",
		ChargeCount:             1,
	})
	seedManagedChannel(t, store, ch)
	rpc := &managedRPC{chainViews: map[string]managedChainView{
		strings.ToLower(ch.ChannelId): {Balance: big.NewInt(400), TotalClaimed: big.NewInt(0)},
	}}
	signer := newManagedSigner(t, rpc)
	var submitted []string
	origWrite := signer.writeContract
	signer.writeContract = func(functionName string, args ...interface{}) (string, error) {
		if functionName == "claimWithSignature" || functionName == "claim" {
			submitted = claimTotalsFromArgs(args)
		}
		if origWrite != nil {
			return origWrite(functionName, args...)
		}
		return successTxHash, nil
	}
	mgr := newTestManager(t, signer, store, auth, "", nil)
	results, err := mgr.Claim(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 1 || results[0].Vouchers != 1 {
		t.Fatalf("results = %+v", results)
	}
	if len(submitted) != 1 || submitted[0] != "400" {
		t.Fatalf("submitted = %v, want 400", submitted)
	}
	got, _ := store.Get(context.Background(), ch.ChannelId)
	if got.TotalClaimed != "400" {
		t.Fatalf("totalClaimed = %s", got.TotalClaimed)
	}
}

func TestFacilitatorChannelManager_ClaimSkipsMismatchedAuthorizer(t *testing.T) {
	auth := managedAuthorizer()
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	kept := managerChannel(t, auth, "41", &channelFields{
		ChargedCumulativeAmount: "1000",
		SignedMaxClaimable:      "1000",
		ChargeCount:             1,
	})
	skipped := managerChannel(t, auth, "42", &channelFields{
		ChargedCumulativeAmount: "1000",
		SignedMaxClaimable:      "1000",
		ChargeCount:             1,
	})
	skipped.ChannelConfig.ReceiverAuthorizer = "0x1111111111111111111111111111111111111111"
	seedManagedChannel(t, store, kept)
	seedManagedChannel(t, store, skipped)
	signer := newManagedSigner(t, nil)
	mgr := newTestManager(t, signer, store, auth, "", nil)
	results, err := mgr.Claim(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 1 || results[0].Vouchers != 1 || signer.writeCalls != 1 {
		t.Fatalf("results=%+v writes=%d", results, signer.writeCalls)
	}
	gotKept, _ := store.Get(context.Background(), kept.ChannelId)
	gotSkipped, _ := store.Get(context.Background(), skipped.ChannelId)
	if gotKept.TotalClaimed != "1000" || gotSkipped.TotalClaimed != "0" {
		t.Fatalf("kept=%s skipped=%s", gotKept.TotalClaimed, gotSkipped.TotalClaimed)
	}
}

func TestFacilitatorChannelManager_SettleCleanupMatchesLowercaseTarget(t *testing.T) {
	auth := managedAuthorizer()
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	ch := finishedManagedChannel(t, auth, "51")
	seedManagedChannel(t, store, ch)
	signer := newManagedSigner(t, &managedRPC{receiverClaimed: bigInt(1000), receiverSettled: bigInt(1000)})
	mgr := newTestManager(t, signer, store, auth, "", nil)
	if err := mgr.settleTargetStorage.ApplySettleTargetClaimDelta(context.Background(), storage.SettleTargetClaimDelta{
		Network:  ch.Network,
		Receiver: strings.ToLower(ch.ChannelConfig.Receiver),
		Token:    strings.ToLower(ch.ChannelConfig.Token),
		Amount:   bigInt(1),
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := mgr.Settle(context.Background(), nil); err != nil {
		t.Fatal(err)
	}
	got, _ := store.Get(context.Background(), ch.ChannelId)
	if got != nil {
		t.Fatalf("expected cleanup, got %+v", got.Channel)
	}
}

func TestFacilitatorChannelManager_SettleCleanupKeepsHeldRow(t *testing.T) {
	auth := managedAuthorizer()
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	ch := finishedManagedChannel(t, auth, "52")
	seedManagedChannel(t, store, ch)
	ok, err := store.Acquire(context.Background(), ch.ChannelId, "hot-path", 60_000)
	if err != nil || !ok {
		t.Fatalf("acquire: ok=%v err=%v", ok, err)
	}
	signer := newManagedSigner(t, &managedRPC{receiverClaimed: bigInt(1000), receiverSettled: bigInt(1000)})
	mgr := newTestManager(t, signer, store, auth, "", nil)
	if err := mgr.settleTargetStorage.ApplySettleTargetClaimDelta(context.Background(), storage.SettleTargetClaimDelta{
		Network:  ch.Network,
		Receiver: strings.ToLower(ch.ChannelConfig.Receiver),
		Token:    strings.ToLower(ch.ChannelConfig.Token),
		Amount:   bigInt(1),
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := mgr.Settle(context.Background(), nil); err != nil {
		t.Fatal(err)
	}
	got, _ := store.Get(context.Background(), ch.ChannelId)
	if got == nil {
		t.Fatal("held row was deleted")
	}
}

func finishedManagedChannel(t *testing.T, auth *fakeAuthorizerSigner, salt string) *FacilitatorChannel {
	t.Helper()
	return managerChannel(t, auth, salt, &channelFields{
		ChargedCumulativeAmount: "1000",
		SignedMaxClaimable:      "1000",
		Balance:                 "1000",
		TotalClaimed:            "1000",
	})
}

func claimBatchContains(args []interface{}, total string) bool {
	for _, got := range claimTotalsFromArgs(args) {
		if got == total {
			return true
		}
	}
	return false
}

func claimTotalsFromArgs(args []interface{}) []string {
	if len(args) == 0 {
		return nil
	}
	value := reflect.ValueOf(args[0])
	if value.Kind() != reflect.Slice {
		return nil
	}
	out := make([]string, 0, value.Len())
	for i := 0; i < value.Len(); i++ {
		total := value.Index(i).FieldByName("TotalClaimed")
		if !total.IsValid() || total.IsNil() {
			continue
		}
		out = append(out, total.Interface().(*big.Int).String())
	}
	return out
}

func TestFacilitatorChannelManager_SortsWithdrawPendingBeforeReservedIdle(t *testing.T) {
	t.Parallel()
	rows := []*FacilitatorChannel{
		{Channel: storage.Channel{ChannelId: "high", ChargedCumulativeAmount: "900", TotalClaimed: "0", LastRequestTimestamp: 3}},
		{Channel: storage.Channel{ChannelId: "late-withdraw", ChargedCumulativeAmount: "1", TotalClaimed: "0", WithdrawRequestedAt: 50}},
		{Channel: storage.Channel{ChannelId: "idle", ChargedCumulativeAmount: "10", TotalClaimed: "0", LastRequestTimestamp: 1}},
		{Channel: storage.Channel{ChannelId: "early-withdraw", ChargedCumulativeAmount: "1", TotalClaimed: "0", WithdrawRequestedAt: 10}},
		{Channel: storage.Channel{ChannelId: "mid", ChargedCumulativeAmount: "400", TotalClaimed: "0", LastRequestTimestamp: 2}},
	}
	sortClaimRows(rows, map[string]struct{}{"idle": {}})
	got := make([]string, len(rows))
	for i, row := range rows {
		got[i] = row.ChannelId
	}
	want := []string{"early-withdraw", "late-withdraw", "idle", "high", "mid"}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("order = %v, want %v", got, want)
		}
	}
}

func TestFacilitatorChannelManager_ClaimOldestFirstKeepsIdleReserve(t *testing.T) {
	auth := managedAuthorizer()
	inner := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	// capacity = 5, probe = 6. The oldest idle row is reserved even though its unclaimed amount is smallest.
	specs := []struct {
		suffix    string
		unclaimed string
		at        int64
	}{
		{"01", "1", 1},
		{"02", "100", 2},
		{"03", "200", 3},
		{"04", "300", 4},
		{"05", "400", 5},
		{"06", "500", 6},
	}
	for _, spec := range specs {
		ch := managerChannel(t, auth, spec.suffix, &channelFields{
			ChargedCumulativeAmount: spec.unclaimed,
			SignedMaxClaimable:      spec.unclaimed,
			ChargeCount:             1,
			LastRequestTimestamp:    spec.at,
		})
		seedManagedChannel(t, inner, ch)
	}
	store := &claimQueryRecorder{InMemoryChannelStorage: inner}
	signer := newManagedSigner(t, nil)
	mgr := newTestManager(t, signer, store, auth, "", nil)
	_, err := mgr.Claim(context.Background(), &FacilitatorClaimOptions{
		MaxClaimsPerBatch: 1,
		MaxTxsPerRun:      5,
		OldestFirst:       true,
	})
	if err != nil {
		t.Fatal(err)
	}
	oldest := managerChannel(t, auth, "01", nil)
	dropped := managerChannel(t, auth, "02", nil)
	gotOldest, err := inner.Get(context.Background(), oldest.ChannelId)
	if err != nil {
		t.Fatal(err)
	}
	if gotOldest.TotalClaimed != "1" {
		t.Fatalf("oldest totalClaimed = %s, want the idle reserve claimed", gotOldest.TotalClaimed)
	}
	gotDropped, err := inner.Get(context.Background(), dropped.ChannelId)
	if err != nil {
		t.Fatal(err)
	}
	if gotDropped.TotalClaimed != "0" {
		t.Fatalf("low unclaimed row was claimed: %s", gotDropped.TotalClaimed)
	}
}

func TestFacilitatorChannelManager_ClaimStopsWhenContextCanceled(t *testing.T) {
	auth := managedAuthorizer()
	inner := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	first := managerChannel(t, auth, "01", &channelFields{ChargedCumulativeAmount: "5000", SignedMaxClaimable: "5000", ChargeCount: 1, LastRequestTimestamp: 1})
	second := managerChannel(t, auth, "02", &channelFields{ChargedCumulativeAmount: "9000", SignedMaxClaimable: "9000", ChargeCount: 1, LastRequestTimestamp: 2})
	seedManagedChannel(t, inner, first)
	seedManagedChannel(t, inner, second)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	store := &cancelAfterUpdateStore{InMemoryChannelStorage: inner, cancel: cancel, after: 1}
	signer := newManagedSigner(t, nil)
	mgr := newTestManager(t, signer, store, auth, "", nil)
	_, err := mgr.Claim(ctx, &FacilitatorClaimOptions{
		MaxClaimsPerBatch: 1,
		MaxTxsPerRun:      2,
		UnclaimedDesc:     true,
	})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v, want canceled", err)
	}
	gotFirst, err := inner.Get(context.Background(), first.ChannelId)
	if err != nil {
		t.Fatal(err)
	}
	if gotFirst.TotalClaimed != "0" {
		t.Fatalf("lower unclaimed row was claimed: %s", gotFirst.TotalClaimed)
	}
	gotSecond, err := inner.Get(context.Background(), second.ChannelId)
	if err != nil {
		t.Fatal(err)
	}
	if gotSecond.TotalClaimed != "9000" || gotSecond.ChargeCount != 0 {
		t.Fatalf("landed totalClaimed=%s chargeCount=%d", gotSecond.TotalClaimed, gotSecond.ChargeCount)
	}
	if signer.writeCalls != 1 {
		t.Fatalf("writes = %d, want 1", signer.writeCalls)
	}
}

type cancelAfterUpdateStore struct {
	*storage.InMemoryChannelStorage[*FacilitatorChannel]
	cancel func()
	after  int
	calls  int
}

func (s *cancelAfterUpdateStore) UpdateChannel(ctx context.Context, channelID string, update func(*FacilitatorChannel) *FacilitatorChannel) (*storage.ChannelUpdateResult[*FacilitatorChannel], error) {
	s.calls++
	if s.calls == s.after {
		s.cancel()
	}
	return s.InMemoryChannelStorage.UpdateChannel(ctx, channelID, update)
}

func TestFacilitatorChannelManager_ClaimPreflightAppliesSettleTargetDelta(t *testing.T) {
	auth := managedAuthorizer()
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	ch := managerChannel(t, auth, "11", &channelFields{
		ChargedCumulativeAmount: "5000",
		SignedMaxClaimable:      "5000",
		TotalClaimed:            "0",
		ChargeCount:             1,
	})
	seedManagedChannel(t, store, ch)
	signer := newManagedSigner(t, &managedRPC{
		chainViews: map[string]managedChainView{
			strings.ToLower(ch.ChannelId): {Balance: bigInt(10000), TotalClaimed: bigInt(5000)},
		},
	})
	mgr := newTestManager(t, signer, store, auth, "", nil)
	results, err := mgr.Claim(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 0 || signer.writeCalls != 0 {
		t.Fatalf("results=%v writes=%d, want a skipped claim", results, signer.writeCalls)
	}
	page, err := mgr.settleTargetStorage.SettleQuery(context.Background(), storage.SettleQuery{Network: ch.Network, Limit: intPtr(10)})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 1 {
		t.Fatalf("settle targets = %d, want the ahead delta", len(page.Items))
	}
	got, err := store.Get(context.Background(), ch.ChannelId)
	if err != nil {
		t.Fatal(err)
	}
	if got.TotalClaimed != "5000" {
		t.Fatalf("totalClaimed = %s", got.TotalClaimed)
	}
}

func TestFacilitatorChannelManager_SettleSkipsOneSimulationFailure(t *testing.T) {
	auth := managedAuthorizer()
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	signer := newManagedSigner(t, &managedRPC{receiverClaimed: bigInt(5000), receiverSettled: bigInt(0)})
	innerRead := signer.readContract
	sims := 0
	signer.readContract = func(functionName string, args ...interface{}) (interface{}, error) {
		if functionName == "multicall" {
			sims++
			if sims <= 2 {
				return nil, errors.New("execution reverted")
			}
		}
		return innerRead(functionName, args...)
	}
	mgr := newTestManager(t, signer, store, auth, "", nil)
	first := storage.SettleTarget{Network: managedNetwork, Receiver: "0x1111111111111111111111111111111111111111", Token: managedToken}
	second := storage.SettleTarget{Network: managedNetwork, Receiver: "0x2222222222222222222222222222222222222222", Token: managedToken}
	for _, target := range []storage.SettleTarget{first, second} {
		if err := mgr.settleTargetStorage.ApplySettleTargetClaimDelta(context.Background(), storage.SettleTargetClaimDelta{
			Network: target.Network, Receiver: target.Receiver, Token: target.Token, Amount: bigInt(5),
		}); err != nil {
			t.Fatal(err)
		}
	}
	var skipped []string
	var batchErrs int
	results, err := mgr.Settle(context.Background(), &FacilitatorSettleOptions{
		MaxSettlesPerTx: 2,
		OnError: func(err error, target *storage.SettleTarget) {
			if target == nil {
				batchErrs++
				return
			}
			skipped = append(skipped, target.Receiver)
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if batchErrs != 0 || len(skipped) != 1 || len(results) != 1 {
		t.Fatalf("skipped=%v batchErrs=%d results=%v", skipped, batchErrs, results)
	}
	if results[0].Receiver != second.Receiver {
		t.Fatalf("settled %s, want %s", results[0].Receiver, second.Receiver)
	}
}

func TestFacilitatorChannelManager_SettleReportsBatchFailure(t *testing.T) {
	auth := managedAuthorizer()
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	signer := newManagedSigner(t, &managedRPC{receiverClaimed: bigInt(5000), receiverSettled: bigInt(0)})
	signer.writeContract = func(string, ...interface{}) (string, error) {
		return "", errors.New("rpc down")
	}
	mgr := newTestManager(t, signer, store, auth, "", nil)
	seedManagerSettleTarget(t, mgr, managerChannel(t, auth, "00", &channelFields{TotalClaimed: "5000"}))
	var got error
	results, err := mgr.Settle(context.Background(), &FacilitatorSettleOptions{
		OnError: func(err error, target *storage.SettleTarget) {
			got = err
			if target != nil {
				t.Fatal("batch failure should not carry a target")
			}
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if got == nil || len(results) != 0 {
		t.Fatalf("onError=%v results=%v", got, results)
	}
}

func TestFacilitatorChannelManager_ClaimReportsBatchFailure(t *testing.T) {
	auth := managedAuthorizer()
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	ch := managerChannel(t, auth, "03", &channelFields{ChargedCumulativeAmount: "5000", SignedMaxClaimable: "5000", ChargeCount: 1})
	seedManagedChannel(t, store, ch)
	signer := newManagedSigner(t, nil)
	signer.writeContract = func(string, ...interface{}) (string, error) {
		return "", errors.New("rpc down")
	}
	mgr := newTestManager(t, signer, store, auth, "", nil)
	var got error
	results, err := mgr.Claim(context.Background(), &FacilitatorClaimOptions{
		OnError: func(err error, channelID string) {
			got = err
			if channelID != "" {
				t.Fatalf("batch failure channelID = %s", channelID)
			}
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if got == nil || len(results) != 0 {
		t.Fatalf("onError=%v results=%v", got, results)
	}
}

func TestFacilitatorChannelManager_RefundClaimsApplySettleTargetDelta(t *testing.T) {
	auth := managedAuthorizer()
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	ch := managerChannel(t, auth, "00", &channelFields{
		ChargedCumulativeAmount: "5000",
		SignedMaxClaimable:      "5000",
		Balance:                 "10000",
		TotalClaimed:            "1000",
		ChargeCount:             2,
	})
	seedManagedChannel(t, store, ch)
	signer := newManagedSigner(t, nil)
	mgr := newTestManager(t, signer, store, auth, "", nil)
	if _, err := mgr.Refund(context.Background()); err != nil {
		t.Fatal(err)
	}
	page, err := mgr.settleTargetStorage.SettleQuery(context.Background(), storage.SettleQuery{Network: ch.Network, Limit: intPtr(10)})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 1 {
		t.Fatalf("settle targets = %d", len(page.Items))
	}

	targets := storage.NewInMemorySettleTargetStorage()
	deps := managedDeps(t, store, store, auth, signer)
	deps.SettleTargetStorage = targets
	refundAuth := auth.addr
	packed, err := batchsettlement.PackRefundAuthorizerSalt("0x"+strings.Repeat("11", 12), refundAuth)
	if err != nil {
		t.Fatal(err)
	}
	cfg := ch.ChannelConfig
	cfg.Salt = packed
	channelID := mustChannelId(t, cfg)
	_, sig := signRefundConsent(t, channelID, "1000", "0", managedNetwork)
	hot := storedManagedChannel(cfg, channelID, &channelFields{
		ChargedCumulativeAmount: "5000",
		Balance:                 "10000",
		TotalClaimed:            "1000",
		ChargeCount:             1,
	})
	seedManagedChannel(t, store, hot)
	reqs := managedRequirements(auth.addr)
	reqs.Extra["refundAuthorizer"] = refundAuth
	resp, err := SettleManaged(context.Background(), deps,
		refundEnvelope(cfg, voucherFields(channelID, "5000", dummySig), "1000", "", sig),
		reqs, nil, nil)
	if err != nil || resp == nil || !resp.Success {
		t.Fatalf("hot refund %+v %v", resp, err)
	}
	hotPage, err := targets.SettleQuery(context.Background(), storage.SettleQuery{Network: managedNetwork, Limit: intPtr(10)})
	if err != nil {
		t.Fatal(err)
	}
	if len(hotPage.Items) != 1 {
		t.Fatalf("hot settle targets = %d", len(hotPage.Items))
	}
}
