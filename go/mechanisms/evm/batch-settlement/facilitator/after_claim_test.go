package facilitator

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	batchsettlement "github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement"
	"github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement/storage"
)

const afterClaimNetwork = "eip155:84532"

type failingIsHeldStore struct {
	storage.ChannelLockStorage
}

func (s failingIsHeldStore) IsHeld(_ context.Context, _ string, _ string) (bool, error) {
	return false, errors.New("lock store unavailable")
}

func afterClaimConfig() batchsettlement.ChannelConfig {
	return batchsettlement.ChannelConfig{
		Payer:              "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
		PayerAuthorizer:    zeroAddress,
		Receiver:           "0x9876543210987654321098765432109876543210",
		ReceiverAuthorizer: "0x1111111111111111111111111111111111111111",
		Token:              "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
		WithdrawDelay:      900,
		Salt:               managedSalt("00"),
	}
}

func afterClaimChannel(balance string, chargeCount int) *FacilitatorChannel {
	cfg := afterClaimConfig()
	channelId, err := batchsettlement.ComputeChannelId(cfg, afterClaimNetwork)
	if err != nil {
		panic(err)
	}
	return &FacilitatorChannel{
		Channel: storage.Channel{
			ChannelId:               channelId,
			ChannelConfig:           cfg,
			ChargedCumulativeAmount: "5000",
			SignedMaxClaimable:      "5000",
			Signature:               "0xdeadbeef",
			Balance:                 balance,
			TotalClaimed:            "0",
			LastRequestTimestamp:    time.Now().UnixMilli(),
			Network:                 afterClaimNetwork,
		},
		ChargeCount: chargeCount,
	}
}

func afterClaimVoucher(channel *FacilitatorChannel) batchsettlement.BatchSettlementVoucherClaim {
	claim := batchsettlement.BatchSettlementVoucherClaim{
		Signature:    "0xdeadbeef",
		TotalClaimed: "5000",
	}
	claim.Voucher.Channel = channel.ChannelConfig
	claim.Voucher.MaxClaimableAmount = "5000"
	return claim
}

func attestedCharge(channels ...*FacilitatorChannel) map[string]int {
	out := make(map[string]int, len(channels))
	for _, ch := range channels {
		out[strings.ToLower(ch.ChannelId)] = ch.ChargeCount
	}
	return out
}

func TestParseFacilitatorRetention(t *testing.T) {
	t.Parallel()
	got, err := ParseFacilitatorRetention("at-claim")
	if err != nil || got != RetentionAtClaim {
		t.Fatalf("got %q err=%v", got, err)
	}
	got, err = ParseFacilitatorRetention("")
	if err != nil || got != RetentionUntilClosed {
		t.Fatalf("default got %q err=%v", got, err)
	}
	if _, err := ParseFacilitatorRetention("bogus"); err == nil {
		t.Fatal("expected error")
	}
}

func TestShouldDeleteVoucherRow_AtClaim(t *testing.T) {
	t.Parallel()
	channel := &FacilitatorChannel{}
	channel.ChargedCumulativeAmount = "5000"
	channel.Balance = "10000"
	channel.TotalClaimed = "0"
	if ShouldDeleteVoucherRow(RetentionAtClaim, false, channel, 0) {
		t.Fatal("expected keep while unclaimed")
	}
	channel.TotalClaimed = "5000"
	if !ShouldDeleteVoucherRow(RetentionAtClaim, false, channel, 0) {
		t.Fatal("expected delete when claimable exhausted with balance left")
	}
	if ShouldDeleteVoucherRow(RetentionUntilClosed, false, channel, 0) {
		t.Fatal("until-closed should keep row while balance exceeds claimed")
	}
}

func TestAfterClaim_SubtractsAttestedChargeCount(t *testing.T) {
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	channel := afterClaimChannel("10000", 3)
	seedManagedChannel(t, store, channel)

	if err := AfterClaim(context.Background(), store, store, []batchsettlement.BatchSettlementVoucherClaim{afterClaimVoucher(channel)}, afterClaimNetwork, attestedCharge(channel), nil, ""); err != nil {
		t.Fatal(err)
	}
	got, err := store.Get(context.Background(), channel.ChannelId)
	if err != nil {
		t.Fatal(err)
	}
	if got.TotalClaimed != "5000" {
		t.Fatalf("totalClaimed = %s", got.TotalClaimed)
	}
	if got.ChargeCount != 0 {
		t.Fatalf("chargeCount = %d", got.ChargeCount)
	}
}

func TestAfterClaim_PreservesInFlightIncrements(t *testing.T) {
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	channel := afterClaimChannel("10000", 3)
	seedManagedChannel(t, store, channel)
	if _, err := store.UpdateChannel(context.Background(), channel.ChannelId, func(current *FacilitatorChannel) *FacilitatorChannel {
		next := current.Clone()
		next.ChargeCount = 5
		return next
	}); err != nil {
		t.Fatal(err)
	}

	if err := AfterClaim(context.Background(), store, store, []batchsettlement.BatchSettlementVoucherClaim{afterClaimVoucher(channel)}, afterClaimNetwork, attestedCharge(channel), nil, ""); err != nil {
		t.Fatal(err)
	}
	got, err := store.Get(context.Background(), channel.ChannelId)
	if err != nil {
		t.Fatal(err)
	}
	if got.ChargeCount != 2 {
		t.Fatalf("chargeCount = %d, want 2", got.ChargeCount)
	}
}

func TestAfterClaim_DeletesAtClaimWhenNothingClaimable(t *testing.T) {
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	channel := afterClaimChannel("10000", 0)
	seedManagedChannel(t, store, channel)

	if err := AfterClaim(context.Background(), store, store, []batchsettlement.BatchSettlementVoucherClaim{afterClaimVoucher(channel)}, afterClaimNetwork, attestedCharge(channel), nil, RetentionAtClaim); err != nil {
		t.Fatal(err)
	}
	got, err := store.Get(context.Background(), channel.ChannelId)
	if err != nil {
		t.Fatal(err)
	}
	if got != nil {
		t.Fatalf("expected deleted row, got %+v", got)
	}
}

func TestAfterClaim_KeepsUntilClosedWhenEscrowRemains(t *testing.T) {
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	channel := afterClaimChannel("10000", 0)
	seedManagedChannel(t, store, channel)

	if err := AfterClaim(context.Background(), store, store, []batchsettlement.BatchSettlementVoucherClaim{afterClaimVoucher(channel)}, afterClaimNetwork, attestedCharge(channel), nil, RetentionUntilClosed); err != nil {
		t.Fatal(err)
	}
	got, err := store.Get(context.Background(), channel.ChannelId)
	if err != nil {
		t.Fatal(err)
	}
	if got == nil {
		t.Fatal("expected retained row while balance exceeds totalClaimed")
	}
}

func TestAfterClaim_DeletesClosedRowUntilClosed(t *testing.T) {
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	channel := afterClaimChannel("5000", 0)
	seedManagedChannel(t, store, channel)

	if err := AfterClaim(context.Background(), store, store, []batchsettlement.BatchSettlementVoucherClaim{afterClaimVoucher(channel)}, afterClaimNetwork, attestedCharge(channel), nil, RetentionUntilClosed); err != nil {
		t.Fatal(err)
	}
	got, err := store.Get(context.Background(), channel.ChannelId)
	if err != nil {
		t.Fatal(err)
	}
	if got != nil {
		t.Fatalf("expected deleted row, got %+v", got)
	}
}

func TestAfterClaim_KeepsClosedRowWhenForever(t *testing.T) {
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	channel := afterClaimChannel("5000", 0)
	seedManagedChannel(t, store, channel)

	if err := AfterClaim(context.Background(), store, store, []batchsettlement.BatchSettlementVoucherClaim{afterClaimVoucher(channel)}, afterClaimNetwork, attestedCharge(channel), nil, RetentionForever); err != nil {
		t.Fatal(err)
	}
	got, err := store.Get(context.Background(), channel.ChannelId)
	if err != nil {
		t.Fatal(err)
	}
	if got == nil {
		t.Fatal("expected retained row")
	}
}

func TestAfterClaim_IgnoresMissingRows(t *testing.T) {
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	channel := afterClaimChannel("10000", 3)
	attested := map[string]int{strings.ToLower(channel.ChannelId): 3}

	if err := AfterClaim(context.Background(), store, store, []batchsettlement.BatchSettlementVoucherClaim{afterClaimVoucher(channel)}, afterClaimNetwork, attested, nil, ""); err != nil {
		t.Fatal(err)
	}
	got, err := store.Get(context.Background(), channel.ChannelId)
	if err != nil {
		t.Fatal(err)
	}
	if got != nil {
		t.Fatal("expected no row")
	}
}

func TestAfterClaim_DoesNotDeleteWhileAdmissionLockHeld(t *testing.T) {
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	channel := afterClaimChannel("5000", 0)
	seedManagedChannel(t, store, channel)
	ok, err := store.Acquire(context.Background(), channel.ChannelId, "pending-settle", 60_000)
	if err != nil || !ok {
		t.Fatalf("acquire: ok=%v err=%v", ok, err)
	}

	if err := AfterClaim(context.Background(), store, store, []batchsettlement.BatchSettlementVoucherClaim{afterClaimVoucher(channel)}, afterClaimNetwork, attestedCharge(channel), nil, ""); err != nil {
		t.Fatal(err)
	}
	got, err := store.Get(context.Background(), channel.ChannelId)
	if err != nil {
		t.Fatal(err)
	}
	if got == nil {
		t.Fatal("expected row retained while lock held")
	}
}

func TestAfterClaim_DeletesWhenLockInspectionFails(t *testing.T) {
	store := storage.NewInMemoryChannelStorage[*FacilitatorChannel]()
	channel := afterClaimChannel("5000", 0)
	seedManagedChannel(t, store, channel)

	if err := AfterClaim(context.Background(), store, failingIsHeldStore{store}, []batchsettlement.BatchSettlementVoucherClaim{afterClaimVoucher(channel)}, afterClaimNetwork, attestedCharge(channel), nil, ""); err != nil {
		t.Fatal(err)
	}
	got, err := store.Get(context.Background(), channel.ChannelId)
	if err != nil {
		t.Fatal(err)
	}
	if got != nil {
		t.Fatal("expected deleted row when lock inspection fails")
	}
}
