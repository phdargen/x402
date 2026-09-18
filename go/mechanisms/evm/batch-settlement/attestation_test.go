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
