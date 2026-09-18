package main

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"

	batchsettlement "github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement"
	batchedfac "github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement/facilitator"
	"github.com/x402-foundation/x402/go/v2/extensions/buildercode"
)

func logClaimAttestation(
	ctx context.Context,
	result batchedfac.FacilitatorClaimResult,
	signer *facilitatorEvmSigner,
) {
	if result.Transaction == "" {
		return
	}
	hash := result.Transaction
	input, err := signer.TransactionInput(ctx, hash)
	if err != nil {
		fmt.Printf("[voucher store] Failed to load claim tx %s: %v\n", hash, err)
		return
	}
	logs, err := signer.ReceiptLogs(ctx, hash)
	if err != nil {
		fmt.Printf("[voucher store] Failed to load claim receipt %s: %v\n", hash, err)
		return
	}
	attestation := batchsettlement.DecodeClaimAttestation(input, logs, result.Network)
	builderCode, _ := buildercode.ParseBuilderCodeSuffixFromCalldata("0x" + hex.EncodeToString(input))

	chargeCounts := make([]string, len(attestation.ChargeCounts))
	for i, c := range attestation.ChargeCounts {
		chargeCounts[i] = fmt.Sprintf("%d", c)
	}

	payload := map[string]interface{}{
		"tx":                hash,
		"functionName":      attestation.FunctionName,
		"claimFunctionName": nil,
		"chargeCounts":      chargeCounts,
		"builderCode":       nil,
		"channels":          attestation.Channels,
	}
	if attestation.ClaimFunctionName != "" {
		payload["claimFunctionName"] = attestation.ClaimFunctionName
	}
	if builderCode != nil {
		payload["builderCode"] = builderCode
	}
	encoded, _ := json.Marshal(payload)
	fmt.Printf("[voucher store] Claim attestation %s\n", string(encoded))
}

func logRefundSettlementAttestation(
	ctx context.Context,
	result batchedfac.FacilitatorRefundResult,
	signer *facilitatorEvmSigner,
) {
	if result.Transaction == "" {
		return
	}
	hash := result.Transaction
	input, err := signer.TransactionInput(ctx, hash)
	if err != nil {
		fmt.Printf("[voucher store] Failed to load refund tx %s: %v\n", hash, err)
		return
	}
	logs, err := signer.ReceiptLogs(ctx, hash)
	if err != nil {
		fmt.Printf("[voucher store] Failed to load refund receipt %s: %v\n", hash, err)
		return
	}
	attestation := batchsettlement.DecodeClaimAttestation(input, logs, result.Network)
	builderCode, _ := buildercode.ParseBuilderCodeSuffixFromCalldata("0x" + hex.EncodeToString(input))

	chargeCounts := make([]string, len(attestation.ChargeCounts))
	for i, c := range attestation.ChargeCounts {
		chargeCounts[i] = fmt.Sprintf("%d", c)
	}

	payload := map[string]interface{}{
		"tx":                hash,
		"channelId":         result.Channel,
		"functionName":      attestation.FunctionName,
		"claimFunctionName": nil,
		"chargeCounts":      chargeCounts,
		"builderCode":       nil,
		"channels":          attestation.Channels,
	}
	if attestation.ClaimFunctionName != "" {
		payload["claimFunctionName"] = attestation.ClaimFunctionName
	}
	if builderCode != nil {
		payload["builderCode"] = builderCode
	}
	encoded, _ := json.Marshal(payload)
	fmt.Printf("[voucher store] Refund attestation %s\n", string(encoded))
}
