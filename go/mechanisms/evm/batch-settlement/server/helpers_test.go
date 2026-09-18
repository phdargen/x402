package server

import batchsettlement "github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement"

const (
	testChA = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	testChB = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	testChC = "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
)

func sampleSession(id, charged string) *ChannelSession {
	return &ChannelSession{
		ChannelId:               id,
		ChannelConfig:           batchsettlement.ChannelConfig{Payer: "0x1", Receiver: "0x2"},
		ChargedCumulativeAmount: charged,
		SignedMaxClaimable:      "1000",
		Signature:               "0xsig",
		Balance:                 "900",
		TotalClaimed:            "100",
		WithdrawRequestedAt:     0,
		RefundNonce:             0,
		LastRequestTimestamp:    1,
	}
}
