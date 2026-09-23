package facilitator

import (
	"context"
	"strings"
	"testing"
	"time"

	batchsettlement "github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement"
	"github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement/storage"
)

const afterClaimNetwork = "eip155:84532"

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

func managedAfterClaimStores(t *testing.T) (*storage.InMemoryChannelStorage[*FacilitatorChannel], storage.SettleTargetStorage) {
	t.Helper()
	return storage.NewInMemoryChannelStorage[*FacilitatorChannel](), storage.NewInMemorySettleTargetStorage()
}

func TestParseFacilitatorRetention(t *testing.T) {
	t.Parallel()
	got, err := ParseFacilitatorRetention("when-unused")
	if err != nil || got != RetentionWhenUnused {
		t.Fatalf("got %q err=%v", got, err)
	}
	got, err = ParseFacilitatorRetention("")
	if err != nil || got != RetentionWhenUnused {
		t.Fatalf("default got %q err=%v", got, err)
	}
	if _, err := ParseFacilitatorRetention("bogus"); err == nil {
		t.Fatal("expected invalid retention error")
	}
}

func TestAfterClaim_DoesNotDeleteWhenFullyClaimed(t *testing.T) {
	t.Parallel()
	store, targets := managedAfterClaimStores(t)
	channel := afterClaimChannel("5000", 0)
	if err := seedChannel(store, channel); err != nil {
		t.Fatal(err)
	}
	if err := AfterClaim(context.Background(), store, store, []batchsettlement.BatchSettlementVoucherClaim{afterClaimVoucher(channel)}, afterClaimNetwork, attestedCharge(channel), nil, RetentionWhenUnused, targets); err != nil {
		t.Fatalf("AfterClaim: %v", err)
	}
	got, err := store.Get(context.Background(), channel.ChannelId)
	if err != nil || got == nil {
		t.Fatalf("row deleted: %v", err)
	}
	page, err := targets.SettleQuery(context.Background(), storage.SettleQuery{Network: afterClaimNetwork, Limit: intPtr(10)})
	if err != nil || len(page.Items) != 1 {
		t.Fatalf("settle target upsert: %v items=%d", err, len(page.Items))
	}
}

func TestAfterClaim_SubtractsAttestedChargeCount(t *testing.T) {
	t.Parallel()
	store, targets := managedAfterClaimStores(t)
	channel := afterClaimChannel("5000", 2)
	if err := seedChannel(store, channel); err != nil {
		t.Fatal(err)
	}
	if err := AfterClaim(context.Background(), store, store, []batchsettlement.BatchSettlementVoucherClaim{afterClaimVoucher(channel)}, afterClaimNetwork, attestedCharge(channel), nil, "", targets); err != nil {
		t.Fatalf("AfterClaim: %v", err)
	}
	got, err := store.Get(context.Background(), channel.ChannelId)
	if err != nil {
		t.Fatal(err)
	}
	if got.ChargeCount != 0 {
		t.Fatalf("chargeCount=%d want 0", got.ChargeCount)
	}
}

func seedChannel(store storage.ChannelStorage[*FacilitatorChannel], channel *FacilitatorChannel) error {
	_, err := store.UpdateChannel(context.Background(), channel.ChannelId, func(current *FacilitatorChannel) *FacilitatorChannel {
		if current != nil {
			return current
		}
		return channel.Clone()
	})
	return err
}

func intPtr(v int) *int {
	return &v
}
