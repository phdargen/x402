package facilitator

import (
	"bytes"
	"context"
	"strings"
	"testing"

	x402 "github.com/x402-foundation/x402/go/v2"
	batchsettlement "github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement"
	"github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement/storage"
	"github.com/x402-foundation/x402/go/v2/types"
)

func TestScheme_DirectSubmitModeRequiresSubmitter(t *testing.T) {
	_, err := NewBatchSettlementEvmSchemeWithConfig(
		&fakeFacilitatorSigner{addresses: []string{managedFacilitator}},
		managedAuthorizer(),
		&BatchSettlementEvmSchemeConfig{SubmitMode: SubmitModeDirect},
	)
	if err == nil || !strings.Contains(err.Error(), `submitMode "direct" requires authorizerSubmitter`) {
		t.Fatalf("got %v", err)
	}
}

func TestScheme_DirectSubmitModeRejectsMismatchedSubmitter(t *testing.T) {
	_, err := NewBatchSettlementEvmSchemeWithConfig(
		&fakeFacilitatorSigner{addresses: []string{managedFacilitator}},
		managedAuthorizer(),
		&BatchSettlementEvmSchemeConfig{
			SubmitMode:          SubmitModeDirect,
			AuthorizerSubmitter: &fakeFacilitatorSigner{addresses: []string{managedFacilitator}},
		},
	)
	if err == nil || !strings.Contains(err.Error(), "authorizerSubmitter.getAddresses() must be exactly [authorizerSigner.address]") {
		t.Fatalf("got %v", err)
	}
}

func TestScheme_GetExtraAdvertisesVoucherStore(t *testing.T) {
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	scheme, err := NewBatchSettlementEvmSchemeWithConfig(
		newManagedSigner(t, nil),
		managedAuthorizer(),
		&BatchSettlementEvmSchemeConfig{
			VoucherStore: &VoucherStoreConfig{Storage: store},
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	got := scheme.GetExtra(x402.Network(managedNetwork))
	if got["voucherStore"] != true {
		t.Fatalf("extra = %+v", got)
	}
	if got["withdrawDelay"] != 900 {
		t.Fatalf("withdrawDelay = %v", got["withdrawDelay"])
	}
}

func TestScheme_VoucherStoreRequiresAuthorizer(t *testing.T) {
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	_, err := NewBatchSettlementEvmSchemeWithConfig(
		newManagedSigner(t, nil),
		nil,
		&BatchSettlementEvmSchemeConfig{
			VoucherStore: &VoucherStoreConfig{Storage: store},
		},
	)
	if err == nil || !strings.Contains(err.Error(), "voucherStore requires authorizerSigner") {
		t.Fatalf("got %v", err)
	}
}

func TestScheme_ManagedVerifyUnavailableWithoutStore(t *testing.T) {
	scheme := NewBatchSettlementEvmScheme(newManagedSigner(t, nil), managedAuthorizer())
	auth := managedAuthorizer()
	cfg := managedConfig(auth.addr, "00")
	channelId := mustChannelId(t, cfg)
	resp, err := scheme.Verify(context.Background(),
		voucherEnvelope(cfg, voucherFields(channelId, "1000", dummySig), ""),
		managedRequirements(auth.addr), nil)
	if err != nil {
		t.Fatal(err)
	}
	if resp.IsValid || resp.InvalidReason != ErrVoucherStoreUnavailable {
		t.Fatalf("got %+v", resp)
	}
}

func TestScheme_ManagedSettleUnavailableWithoutStore(t *testing.T) {
	scheme := NewBatchSettlementEvmScheme(newManagedSigner(t, nil), managedAuthorizer())
	auth := managedAuthorizer()
	cfg := managedConfig(auth.addr, "00")
	channelId := mustChannelId(t, cfg)
	resp, err := scheme.Settle(context.Background(),
		voucherEnvelope(cfg, voucherFields(channelId, "1000", dummySig), ""),
		managedRequirements(auth.addr), nil)
	if err != nil {
		t.Fatal(err)
	}
	if resp.Success || resp.ErrorReason != ErrVoucherStoreUnavailable {
		t.Fatalf("got %+v", resp)
	}
}

func TestScheme_CreateChannelManagerRequiresStore(t *testing.T) {
	scheme := NewBatchSettlementEvmScheme(newManagedSigner(t, nil), managedAuthorizer())
	_, err := scheme.CreateChannelManager(nil)
	if err == nil || !strings.Contains(err.Error(), "voucherStore") {
		t.Fatalf("got %v", err)
	}
}

func TestScheme_CreateChannelManagerWithStore(t *testing.T) {
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	scheme, err := NewBatchSettlementEvmSchemeWithConfig(
		newManagedSigner(t, nil),
		managedAuthorizer(),
		&BatchSettlementEvmSchemeConfig{VoucherStore: &VoucherStoreConfig{Storage: store}},
	)
	if err != nil {
		t.Fatal(err)
	}
	mgr, err := scheme.CreateChannelManager(nil)
	if err != nil || mgr == nil {
		t.Fatalf("mgr=%v err=%v", mgr, err)
	}
}

func TestScheme_ManagedClaimAfterClaim(t *testing.T) {
	auth := managedAuthorizer()
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	cfg := managedConfig(auth.addr, "00")
	channelId := mustChannelId(t, cfg)
	seedManagedChannel(t, store, storedManagedChannel(cfg, channelId, &channelFields{
		ChargedCumulativeAmount: "1000",
		SignedMaxClaimable:      "1000",
		Signature:               "0xcafe",
		ChargeCount:             4,
	}))
	signer := newManagedSigner(t, nil)
	scheme, err := NewBatchSettlementEvmSchemeWithConfig(signer, auth, &BatchSettlementEvmSchemeConfig{
		VoucherStore: &VoucherStoreConfig{Storage: store},
	})
	if err != nil {
		t.Fatal(err)
	}
	claim := batchsettlement.BatchSettlementVoucherClaim{Signature: "0xcafe", TotalClaimed: "1000"}
	claim.Voucher.Channel = cfg
	claim.Voucher.MaxClaimableAmount = "1000"
	payload := managedEnvelope((&batchsettlement.BatchSettlementClaimPayload{
		Type:   "claim",
		Claims: []batchsettlement.BatchSettlementVoucherClaim{claim},
	}).ToMap())

	resp, err := scheme.Settle(context.Background(), payload, managedRequirements(auth.addr), nil)
	if err != nil || !resp.Success {
		t.Fatalf("got %+v %v", resp, err)
	}
	got, _ := store.Get(channelId)
	if got.TotalClaimed != "1000" || got.ChargeCount != 0 {
		t.Fatalf("stored %+v", got)
	}
	if !bytes.HasPrefix(signer.lastDataSuffix, []byte{0x50, 0xb1, 0x80, 0xc6}) {
		t.Fatalf("dataSuffix = %x", signer.lastDataSuffix)
	}
}

func TestScheme_ManagedClaimComposesBuilderSuffix(t *testing.T) {
	auth := managedAuthorizer()
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	cfg := managedConfig(auth.addr, "00")
	channelId := mustChannelId(t, cfg)
	seedManagedChannel(t, store, storedManagedChannel(cfg, channelId, &channelFields{
		ChargeCount: 6, Signature: "0xcafe",
	}))
	signer := newManagedSigner(t, nil)
	scheme, err := NewBatchSettlementEvmSchemeWithConfig(signer, auth, &BatchSettlementEvmSchemeConfig{
		VoucherStore: &VoucherStoreConfig{Storage: store},
	})
	if err != nil {
		t.Fatal(err)
	}
	claim := batchsettlement.BatchSettlementVoucherClaim{Signature: "0xcafe", TotalClaimed: "1000"}
	claim.Voucher.Channel = cfg
	claim.Voucher.MaxClaimableAmount = "1000"
	payload := managedEnvelope((&batchsettlement.BatchSettlementClaimPayload{
		Type:   "claim",
		Claims: []batchsettlement.BatchSettlementVoucherClaim{claim},
	}).ToMap())
	builder := []byte{0x80, 0x21, 0xab, 0xcd}

	resp, err := scheme.Settle(context.Background(), payload, managedRequirements(auth.addr), builderContext(builder))
	if err != nil || !resp.Success {
		t.Fatalf("got %+v %v", resp, err)
	}
	if !bytes.Contains(signer.lastDataSuffix, builder) {
		t.Fatalf("missing builder suffix in %x", signer.lastDataSuffix)
	}
	counts := batchsettlement.ParseChargeCountsSuffix(signer.lastDataSuffix)
	if len(counts) != 1 || counts[0] != 6 {
		t.Fatalf("counts = %v", counts)
	}
}

func TestScheme_ManagedClaimSimulationLeavesStore(t *testing.T) {
	auth := managedAuthorizer()
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	cfg := managedConfig(auth.addr, "00")
	channelId := mustChannelId(t, cfg)
	seedManagedChannel(t, store, storedManagedChannel(cfg, channelId, &channelFields{ChargeCount: 4}))
	signer := newManagedSigner(t, &managedRPC{simFail: "claimWithSignature"})
	scheme, err := NewBatchSettlementEvmSchemeWithConfig(signer, auth, &BatchSettlementEvmSchemeConfig{
		VoucherStore: &VoucherStoreConfig{Storage: store},
	})
	if err != nil {
		t.Fatal(err)
	}
	claim := batchsettlement.BatchSettlementVoucherClaim{Signature: dummySig, TotalClaimed: "1000"}
	claim.Voucher.Channel = cfg
	claim.Voucher.MaxClaimableAmount = "1000"
	payload := managedEnvelope((&batchsettlement.BatchSettlementClaimPayload{
		Type:   "claim",
		Claims: []batchsettlement.BatchSettlementVoucherClaim{claim},
	}).ToMap())

	resp, err := scheme.Settle(context.Background(), payload, managedRequirements(auth.addr), nil)
	if err != nil {
		t.Fatal(err)
	}
	if resp.Success {
		t.Fatalf("expected failure %+v", resp)
	}
	got, _ := store.Get(channelId)
	if got.ChargeCount != 4 {
		t.Fatalf("chargeCount = %d", got.ChargeCount)
	}
}

func TestScheme_ManagedVoucherSettleIncrementsChargeCount(t *testing.T) {
	auth := managedAuthorizer()
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	cfg := managedConfig(auth.addr, "00")
	channelId := mustChannelId(t, cfg)
	seedManagedChannel(t, store, storedManagedChannel(cfg, channelId, &channelFields{ChargeCount: 2}))
	scheme, err := NewBatchSettlementEvmSchemeWithConfig(newManagedSigner(t, nil), auth, &BatchSettlementEvmSchemeConfig{
		VoucherStore: &VoucherStoreConfig{Storage: store},
	})
	if err != nil {
		t.Fatal(err)
	}
	voucher := voucherFields(channelId, "2000", dummySig)
	acquireBound(t, store, "0xpending", voucher)
	reqs := managedRequirements(auth.addr)
	reqs.Amount = "1000"

	resp, err := scheme.Settle(context.Background(), voucherEnvelope(cfg, voucher, "0xpending"), reqs, nil)
	if err != nil || !resp.Success {
		t.Fatalf("got %+v %v", resp, err)
	}
	if extraInt(resp, "chargeCount") != 3 {
		t.Fatalf("chargeCount = %d", extraInt(resp, "chargeCount"))
	}
}

func TestScheme_SelfManagedRefundIdentityMismatch(t *testing.T) {
	auth := managedAuthorizer()
	delegated := storage.NewInMemoryDelegatedAuthStore()
	cfg := managedConfig(auth.addr, "00")
	channelId := mustChannelId(t, cfg)
	if err := delegated.Bind(storage.DelegatedAuthBinding{
		ChannelId: channelId, Network: managedNetwork, CallerIdentity: "bound-service",
	}); err != nil {
		t.Fatal(err)
	}
	scheme, err := NewBatchSettlementEvmSchemeWithConfig(newManagedSigner(t, nil), auth, &BatchSettlementEvmSchemeConfig{
		ResolveCallerIdentity: func(DelegatedSettleContext) (string, error) { return "other-service", nil },
		DelegatedAuthStore:    delegated,
	})
	if err != nil {
		t.Fatal(err)
	}
	payload := managedEnvelope((&batchsettlement.BatchSettlementEnrichedRefundPayload{
		Type:          "refund",
		ChannelConfig: cfg,
		Voucher:       voucherFields(channelId, "0", dummySig),
		Amount:        "1000",
		RefundNonce:   "0",
	}).ToMap())
	reqs := types.PaymentRequirements{
		Scheme:  batchsettlement.SchemeBatched,
		Network: managedNetwork,
		Amount:  "1000",
		Asset:   managedToken,
		PayTo:   managedReceiver,
		Extra:   map[string]interface{}{"receiverAuthorizer": auth.addr},
	}

	resp, err := scheme.Settle(context.Background(), payload, reqs, nil)
	if err != nil {
		t.Fatal(err)
	}
	if resp.Success || resp.ErrorReason != ErrRefundAuthorizerSignature {
		t.Fatalf("got %+v", resp)
	}
}

func TestScheme_SelfManagedRefundMissingBinding(t *testing.T) {
	auth := managedAuthorizer()
	scheme, err := NewBatchSettlementEvmSchemeWithConfig(newManagedSigner(t, nil), auth, &BatchSettlementEvmSchemeConfig{
		ResolveCallerIdentity: func(DelegatedSettleContext) (string, error) { return "svc", nil },
		DelegatedAuthStore:    storage.NewInMemoryDelegatedAuthStore(),
	})
	if err != nil {
		t.Fatal(err)
	}
	cfg := managedConfig(auth.addr, "00")
	channelId := mustChannelId(t, cfg)
	payload := managedEnvelope((&batchsettlement.BatchSettlementEnrichedRefundPayload{
		Type:          "refund",
		ChannelConfig: cfg,
		Voucher:       voucherFields(channelId, "0", dummySig),
		Amount:        "1000",
		RefundNonce:   "0",
	}).ToMap())
	reqs := types.PaymentRequirements{
		Scheme:  batchsettlement.SchemeBatched,
		Network: managedNetwork,
		Extra:   map[string]interface{}{"receiverAuthorizer": auth.addr},
	}
	resp, err := scheme.Settle(context.Background(), payload, reqs, nil)
	if err != nil {
		t.Fatal(err)
	}
	if resp.Success || resp.ErrorReason != ErrRefundAuthorizerSignature {
		t.Fatalf("got %+v", resp)
	}
}

func TestScheme_SelfManagedRefundMalformedAmount(t *testing.T) {
	auth := managedAuthorizer()
	delegated := storage.NewInMemoryDelegatedAuthStore()
	cfg := managedConfig(auth.addr, "00")
	channelId := mustChannelId(t, cfg)
	_ = delegated.Bind(storage.DelegatedAuthBinding{ChannelId: channelId, Network: managedNetwork, CallerIdentity: "svc"})
	scheme, err := NewBatchSettlementEvmSchemeWithConfig(newManagedSigner(t, nil), auth, &BatchSettlementEvmSchemeConfig{
		ResolveCallerIdentity: func(DelegatedSettleContext) (string, error) { return "svc", nil },
		DelegatedAuthStore:    delegated,
	})
	if err != nil {
		t.Fatal(err)
	}
	payload := managedEnvelope((&batchsettlement.BatchSettlementEnrichedRefundPayload{
		Type:          "refund",
		ChannelConfig: cfg,
		Voucher:       voucherFields(channelId, "0", dummySig),
		Amount:        "nope",
		RefundNonce:   "0",
	}).ToMap())
	reqs := types.PaymentRequirements{Scheme: batchsettlement.SchemeBatched, Network: managedNetwork}
	resp, err := scheme.Settle(context.Background(), payload, reqs, nil)
	if err != nil {
		t.Fatal(err)
	}
	if resp.Success || resp.ErrorReason != ErrRefundAmountInvalid {
		t.Fatalf("got %+v", resp)
	}
}

func TestScheme_DirectModeDispatchesUnsignedClaim(t *testing.T) {
	auth := managedAuthorizer()
	submitter := newManagedSigner(t, nil)
	submitter.addresses = []string{auth.addr}
	relay := newManagedSigner(t, nil)
	scheme, err := NewBatchSettlementEvmSchemeWithConfig(relay, auth, &BatchSettlementEvmSchemeConfig{
		SubmitMode:          SubmitModeDirect,
		AuthorizerSubmitter: submitter,
	})
	if err != nil {
		t.Fatal(err)
	}
	cfg := managedConfig(auth.addr, "00")
	claim := batchsettlement.BatchSettlementVoucherClaim{Signature: dummySig, TotalClaimed: "1000"}
	claim.Voucher.Channel = cfg
	claim.Voucher.MaxClaimableAmount = "1000"
	payload := managedEnvelope((&batchsettlement.BatchSettlementClaimPayload{
		Type:   "claim",
		Claims: []batchsettlement.BatchSettlementVoucherClaim{claim},
	}).ToMap())
	reqs := types.PaymentRequirements{Scheme: batchsettlement.SchemeBatched, Network: managedNetwork}

	resp, err := scheme.Settle(context.Background(), payload, reqs, nil)
	if err != nil || !resp.Success {
		t.Fatalf("got %+v %v", resp, err)
	}
	if submitter.writeCalls == 0 {
		t.Fatal("expected authorizer submitter write")
	}
	if relay.writeCalls != 0 {
		t.Fatalf("relay writes = %d", relay.writeCalls)
	}
	if got := submitter.writeFns; len(got) == 0 || got[0] != "claim" {
		t.Fatalf("writeFns = %v", got)
	}
}

func TestScheme_DirectModeRelaysPresignedClaim(t *testing.T) {
	auth := managedAuthorizer()
	submitter := newManagedSigner(t, nil)
	submitter.addresses = []string{auth.addr}
	relay := newManagedSigner(t, nil)
	scheme, err := NewBatchSettlementEvmSchemeWithConfig(relay, auth, &BatchSettlementEvmSchemeConfig{
		SubmitMode:          SubmitModeDirect,
		AuthorizerSubmitter: submitter,
	})
	if err != nil {
		t.Fatal(err)
	}
	cfg := managedConfig(auth.addr, "00")
	claim := batchsettlement.BatchSettlementVoucherClaim{Signature: dummySig, TotalClaimed: "1000"}
	claim.Voucher.Channel = cfg
	claim.Voucher.MaxClaimableAmount = "1000"
	payload := managedEnvelope((&batchsettlement.BatchSettlementClaimPayload{
		Type:                     "claim",
		Claims:                   []batchsettlement.BatchSettlementVoucherClaim{claim},
		ClaimAuthorizerSignature: "0x" + strings.Repeat("ab", 65),
	}).ToMap())
	reqs := types.PaymentRequirements{Scheme: batchsettlement.SchemeBatched, Network: managedNetwork}

	resp, err := scheme.Settle(context.Background(), payload, reqs, nil)
	if err != nil || !resp.Success {
		t.Fatalf("got %+v %v", resp, err)
	}
	if relay.writeCalls == 0 {
		t.Fatal("expected relay write")
	}
	if submitter.writeCalls != 0 {
		t.Fatalf("submitter writes = %d", submitter.writeCalls)
	}
}

func TestScheme_GetExtraAdvertisesRefundAuth(t *testing.T) {
	scheme, err := NewBatchSettlementEvmSchemeWithConfig(newManagedSigner(t, nil), managedAuthorizer(), &BatchSettlementEvmSchemeConfig{
		ResolveCallerIdentity: func(DelegatedSettleContext) (string, error) { return "svc", nil },
	})
	if err != nil {
		t.Fatal(err)
	}
	got := scheme.GetExtra(x402.Network(managedNetwork))
	if got["refundAuth"] != true {
		t.Fatalf("extra = %+v", got)
	}
}
