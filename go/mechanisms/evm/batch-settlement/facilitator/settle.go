package facilitator

import (
	"context"
	"fmt"
	"math/big"
	"strings"

	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"

	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/evm"
	batchsettlement "github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement"
	"github.com/x402-foundation/x402/go/v2/types"
)

// SettleGasLimit is the gas limit for settle submissions.
const SettleGasLimit uint64 = 120_000

// ExecuteSettle executes a settle action, transferring claimed funds to the receiver.
// Calls settle(receiver, token) on the BatchSettlement contract.
func ExecuteSettle(
	ctx context.Context,
	signer evm.FacilitatorEvmSigner,
	payload *batchsettlement.BatchSettlementSettlePayload,
	requirements types.PaymentRequirements,
	dataSuffix []byte,
) (*x402.SettleResponse, error) {
	network := x402.Network(requirements.Network)
	receiver := common.HexToAddress(payload.Receiver)
	token := common.HexToAddress(payload.Token)

	totalClaimed, totalSettled, readErr := readReceiverSettlementTotals(ctx, signer, receiver, token)
	if readErr != nil {
		return &x402.SettleResponse{ //nolint:nilerr // RPC read failure -> error encoded in response
			Success:      false,
			ErrorReason:  ErrRpcReadFailed,
			ErrorMessage: readErr.Error(),
			Transaction:  "",
			Network:      network,
		}, nil
	}
	if totalClaimed.Cmp(totalSettled) <= 0 {
		return &x402.SettleResponse{ //nolint:nilerr // no-op settle -> error encoded in response
			Success:      false,
			ErrorReason:  ErrNothingToSettle,
			ErrorMessage: "nothing to settle for receiver and token",
			Transaction:  "",
			Network:      network,
		}, nil
	}

	_, simErr := signer.ReadContract(
		ctx,
		batchsettlement.BatchSettlementAddress,
		batchsettlement.BatchSettlementSettleABI,
		"settle",
		receiver,
		token,
	)
	if simErr != nil {
		return &x402.SettleResponse{ //nolint:nilerr // simulation failure → error encoded in response
			Success:      false,
			ErrorReason:  ErrSettleSimulationFailed,
			ErrorMessage: simErr.Error(),
			Transaction:  "",
			Network:      network,
		}, nil
	}

	txHash, err := signer.WriteContract(
		ctx,
		batchsettlement.BatchSettlementAddress,
		batchsettlement.BatchSettlementSettleABI,
		"settle",
		dataSuffix,
		receiver,
		token,
	)
	if err != nil {
		return nil, x402.NewSettleError(ErrSettleTransactionFailed, "", network, "",
			fmt.Sprintf("settle transaction failed: %s", evm.TruncateErrorMessage(err.Error())))
	}
	receipt, err := evm.WaitForSettleReceipt(ctx, signer, txHash, "", network,
		ErrSettleTransactionFailed, ErrTransactionReverted)
	if err != nil {
		return nil, err
	}

	return &x402.SettleResponse{
		Success:     true,
		Transaction: txHash,
		Network:     network,
		Amount:      settledAmountFromReceipt(receipt, receiver, token),
	}, nil
}

func settledAmountFromReceipt(receipt *evm.TransactionReceipt, receiver, token common.Address) string {
	if receipt == nil || receipt.Logs == nil {
		return ""
	}
	parsed, err := abi.JSON(strings.NewReader(string(batchsettlement.BatchSettlementSettledEventABI)))
	if err != nil {
		return "0"
	}
	event, ok := parsed.Events["Settled"]
	if !ok {
		return "0"
	}
	contractAddr := common.HexToAddress(batchsettlement.BatchSettlementAddress)
	for _, log := range receipt.Logs {
		if log == nil || log.Address != contractAddr {
			continue
		}
		if len(log.Topics) < 4 || log.Topics[0] != event.ID {
			continue
		}
		logReceiver := common.BytesToAddress(log.Topics[1].Bytes())
		logToken := common.BytesToAddress(log.Topics[2].Bytes())
		if logReceiver != receiver || logToken != token {
			continue
		}
		unpacked, err := event.Inputs.NonIndexed().Unpack(log.Data)
		if err != nil || len(unpacked) == 0 {
			continue
		}
		amount, ok := unpacked[0].(*big.Int)
		if !ok {
			continue
		}
		return amount.String()
	}
	return "0"
}

func readReceiverSettlementTotals(
	ctx context.Context,
	signer evm.FacilitatorEvmSigner,
	receiver common.Address,
	token common.Address,
) (*big.Int, *big.Int, error) {
	raw, err := signer.ReadContract(
		ctx,
		batchsettlement.BatchSettlementAddress,
		batchsettlement.BatchSettlementReceiversABI,
		"receivers",
		receiver,
		token,
	)
	if err != nil {
		return nil, nil, err
	}

	outputs, ok := raw.([]interface{})
	if !ok || len(outputs) < 2 {
		return nil, nil, fmt.Errorf("receivers returned %T, want two uint128 values", raw)
	}

	totalClaimed, ok := outputs[0].(*big.Int)
	if !ok {
		return nil, nil, fmt.Errorf("receivers totalClaimed returned %T, want *big.Int", outputs[0])
	}
	totalSettled, ok := outputs[1].(*big.Int)
	if !ok {
		return nil, nil, fmt.Errorf("receivers totalSettled returned %T, want *big.Int", outputs[1])
	}

	return totalClaimed, totalSettled, nil
}
