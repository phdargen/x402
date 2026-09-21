package batchsettlement

import (
	"math/big"
	"strings"
	"testing"

	"github.com/ethereum/go-ethereum/common"

	"github.com/x402-foundation/x402/go/v2/mechanisms/evm"
)

const attestationNetwork = "eip155:84532"

func TestDecodeClaimAttestation_StandaloneClaim(t *testing.T) {
	suffix, err := EncodeChargeCountsSuffix([]uint64{4})
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	calldata := evm.AppendDataSuffix(mustClaimCalldata(t, "claim"), suffix)
	attestation := DecodeClaimAttestation(calldata, nil, attestationNetwork)
	if attestation.FunctionName != "claim" {
		t.Fatalf("functionName = %q", attestation.FunctionName)
	}
	if attestation.ClaimFunctionName != "claim" {
		t.Fatalf("claimFunctionName = %q", attestation.ClaimFunctionName)
	}
	if !uint64sEqual(attestation.ChargeCounts, []uint64{4}) {
		t.Fatalf("chargeCounts = %v", attestation.ChargeCounts)
	}
	if len(attestation.Channels) != 1 {
		t.Fatalf("channels len = %d", len(attestation.Channels))
	}
	wantID, err := ComputeChannelId(chargeCountChannel, attestationNetwork)
	if err != nil {
		t.Fatalf("ComputeChannelId: %v", err)
	}
	if !strings.EqualFold(attestation.Channels[0].ChannelId, wantID) {
		t.Fatalf("channelId = %q, want %q", attestation.Channels[0].ChannelId, wantID)
	}
	if attestation.Channels[0].ChargeCount != "4" {
		t.Fatalf("chargeCount = %q", attestation.Channels[0].ChargeCount)
	}
}

func TestDecodeClaimAttestation_UnwrapsMulticallClaimAndRefund(t *testing.T) {
	suffix, err := EncodeChargeCountsSuffix([]uint64{4})
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	innerClaim := evm.AppendDataSuffix(mustClaimCalldata(t, "claim"), suffix)
	refund := mustPack(t, BatchSettlementRefundABI, "refund", toContractChannelConfig(chargeCountChannel), big.NewInt(100))
	outer := mustPack(t, BatchSettlementMulticallABI, "multicall", [][]byte{innerClaim, refund})
	if !uint64sEqual(ParseChargeCountsFromCalldata(outer), []uint64{4}) {
		t.Fatalf("shared parser = %v", ParseChargeCountsFromCalldata(outer))
	}

	attestation := DecodeClaimAttestation(outer, nil, attestationNetwork)
	if attestation.FunctionName != "multicall" {
		t.Fatalf("functionName = %q", attestation.FunctionName)
	}
	if attestation.ClaimFunctionName != "claim" {
		t.Fatalf("claimFunctionName = %q", attestation.ClaimFunctionName)
	}
	if !uint64sEqual(attestation.ChargeCounts, []uint64{4}) {
		t.Fatalf("chargeCounts = %v", attestation.ChargeCounts)
	}
	if len(attestation.Channels) != 1 {
		t.Fatalf("channels len = %d", len(attestation.Channels))
	}
	if attestation.Channels[0].ChargeCount != "4" {
		t.Fatalf("chargeCount = %q", attestation.Channels[0].ChargeCount)
	}
}

func TestDecodeClaimAttestation_RefundOnlyMulticall(t *testing.T) {
	refund := mustPack(t, BatchSettlementRefundABI, "refund", toContractChannelConfig(chargeCountChannel), big.NewInt(100))
	outer := mustPack(t, BatchSettlementMulticallABI, "multicall", [][]byte{refund})
	attestation := DecodeClaimAttestation(outer, nil, attestationNetwork)
	if attestation.FunctionName != "multicall" {
		t.Fatalf("functionName = %q", attestation.FunctionName)
	}
	if attestation.Channels != nil {
		t.Fatalf("channels = %+v, want nil", attestation.Channels)
	}
}

func TestDecodeClaimAttestation_UndecodableCalldata(t *testing.T) {
	attestation := DecodeClaimAttestation(common.FromHex("0xabcd"), nil, attestationNetwork)
	if attestation.FunctionName != "unknown" {
		t.Fatalf("functionName = %q", attestation.FunctionName)
	}
	if attestation.Channels != nil {
		t.Fatalf("channels = %+v, want nil", attestation.Channels)
	}
}

func TestDecodeClaimAttestation_OmitsClaimAmountsWhenLogsUnparseable(t *testing.T) {
	suffix, err := EncodeChargeCountsSuffix([]uint64{1})
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	calldata := evm.AppendDataSuffix(mustClaimCalldata(t, "claim"), suffix)
	attestation := DecodeClaimAttestation(calldata, []ReceiptLog{{Data: []byte{0x01}}}, attestationNetwork)
	if len(attestation.Channels) != 1 {
		t.Fatalf("channels len = %d", len(attestation.Channels))
	}
	if attestation.Channels[0].ClaimAmount != "" || attestation.Channels[0].NewTotalClaimed != "" {
		t.Fatalf("claim fields = %+v", attestation.Channels[0])
	}
}

func TestDecodeClaimAttestation_MulticallWithoutInnerClaim(t *testing.T) {
	outer := mustPack(t, BatchSettlementMulticallABI, "multicall", [][]byte{common.FromHex("0xdeadbeef")})
	attestation := DecodeClaimAttestation(outer, nil, attestationNetwork)
	if attestation.FunctionName != "multicall" {
		t.Fatalf("functionName = %q", attestation.FunctionName)
	}
	if attestation.Channels != nil {
		t.Fatalf("channels = %+v, want nil", attestation.Channels)
	}
}

func TestDecodeClaimAttestation_ClaimWithSignatureJoinsClaimedLogs(t *testing.T) {
	suffix, err := EncodeChargeCountsSuffix([]uint64{2})
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	calldata := evm.AppendDataSuffix(mustClaimCalldata(t, "claimWithSignature"), suffix)
	channelId, err := ComputeChannelId(chargeCountChannel, attestationNetwork)
	if err != nil {
		t.Fatalf("ComputeChannelId: %v", err)
	}
	logs := []ReceiptLog{mustClaimedLog(t, channelId, 500, 1500)}
	attestation := DecodeClaimAttestation(calldata, logs, attestationNetwork)
	if attestation.ClaimFunctionName != "claimWithSignature" {
		t.Fatalf("claimFunctionName = %q", attestation.ClaimFunctionName)
	}
	if attestation.Channels[0].ClaimAmount != "500" || attestation.Channels[0].NewTotalClaimed != "1500" {
		t.Fatalf("channels[0] = %+v", attestation.Channels[0])
	}
}

func TestDecodeClaimAttestation_ClaimWithoutChargeCountSuffix(t *testing.T) {
	calldata := mustClaimCalldata(t, "claim")
	attestation := DecodeClaimAttestation(calldata, nil, attestationNetwork)
	if attestation.ChargeCounts != nil {
		t.Fatalf("chargeCounts = %v", attestation.ChargeCounts)
	}
	if attestation.Channels[0].ChargeCount != "" {
		t.Fatalf("chargeCount = %q", attestation.Channels[0].ChargeCount)
	}
}

func mustClaimedLog(t *testing.T, channelId string, claimAmount, newTotalClaimed int64) ReceiptLog {
	t.Helper()
	data, err := claimedEvent.Inputs.NonIndexed().Pack(big.NewInt(claimAmount), big.NewInt(newTotalClaimed))
	if err != nil {
		t.Fatalf("pack Claimed data: %v", err)
	}
	senderTopic := common.BytesToHash(common.LeftPadBytes(
		common.HexToAddress("0x70997970C51812dc3A010C7d01b50e0d17dc79C8").Bytes(), 32))
	return ReceiptLog{
		Topics: []common.Hash{
			claimedEvent.ID,
			common.HexToHash(channelId),
			senderTopic,
		},
		Data: data,
	}
}
