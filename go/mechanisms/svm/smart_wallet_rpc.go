package svm

import (
	"context"
	"encoding/base64"
	"fmt"
	"strconv"

	solana "github.com/gagliardetto/solana-go"
	addresslookuptable "github.com/gagliardetto/solana-go/programs/address-lookup-table"
	"github.com/gagliardetto/solana-go/rpc"
)

// maxSupportedTxVersion is passed to getTransaction so v0 (lookup-table)
// transactions are returned instead of rejected.
var maxSupportedTxVersion uint64

type simulateWithInnerResult struct {
	Value *struct {
		Err               interface{}            `json:"err"`
		InnerInstructions []rpc.InnerInstruction `json:"innerInstructions"`
	} `json:"value"`
}

// SimulateWithInnerInstructions simulates a transaction with inner instruction
// recording. Signature verification is off; the fee-payer slot may be empty.
func SimulateWithInnerInstructions(ctx context.Context, client *rpc.Client, tx *solana.Transaction) ([]rpc.InnerInstruction, error) {
	txData, err := tx.MarshalBinary()
	if err != nil {
		return nil, fmt.Errorf("failed to encode transaction: %w", err)
	}
	params := []interface{}{
		base64.StdEncoding.EncodeToString(txData),
		rpc.M{
			"encoding":          "base64",
			"sigVerify":         false,
			"commitment":        DefaultCommitment,
			"innerInstructions": true,
		},
	}
	var out simulateWithInnerResult
	if err := client.RPCCallForInto(ctx, &out, "simulateTransaction", params); err != nil {
		return nil, fmt.Errorf("simulation failed: %w", err)
	}
	if out.Value == nil {
		return nil, fmt.Errorf("simulation failed: empty result")
	}
	if out.Value.Err != nil {
		return nil, fmt.Errorf("simulation failed: transaction would fail on-chain")
	}
	return out.Value.InnerInstructions, nil
}

// ConfirmedTransactionInnerInstructions fetches a confirmed transaction's CPI
// trace and the loaded account-key list inner-instruction indices address.
func ConfirmedTransactionInnerInstructions(ctx context.Context, client *rpc.Client, signature solana.Signature) ([]rpc.InnerInstruction, solana.PublicKeySlice, error) {
	result, err := client.GetTransaction(ctx, signature, &rpc.GetTransactionOpts{
		Encoding:                       solana.EncodingBase64,
		Commitment:                     DefaultCommitment,
		MaxSupportedTransactionVersion: &maxSupportedTxVersion,
	})
	if err != nil {
		return nil, nil, err
	}
	if result == nil || result.Meta == nil || result.Transaction == nil {
		return nil, nil, fmt.Errorf("transaction not indexed")
	}
	tx, err := result.Transaction.GetTransaction()
	if err != nil {
		return nil, nil, fmt.Errorf("failed to decode confirmed transaction: %w", err)
	}
	keys := append(solana.PublicKeySlice{}, tx.Message.AccountKeys...)
	keys = append(keys, result.Meta.LoadedAddresses.Writable...)
	keys = append(keys, result.Meta.LoadedAddresses.ReadOnly...)
	return result.Meta.InnerInstructions, keys, nil
}

// TokenAccountBalance returns the raw token amount of an ATA. The bool is
// false when the account does not exist.
func TokenAccountBalance(ctx context.Context, client *rpc.Client, tokenAccount solana.PublicKey) (uint64, bool, error) {
	result, err := client.GetTokenAccountBalance(ctx, tokenAccount, DefaultCommitment)
	if err != nil {
		return 0, false, err
	}
	if result == nil || result.Value == nil {
		return 0, false, nil
	}
	amount, err := strconv.ParseUint(result.Value.Amount, 10, 64)
	if err != nil {
		return 0, false, fmt.Errorf("invalid token account balance: %w", err)
	}
	return amount, true, nil
}

// AddressLookupTables fetches the address lists stored in the given lookup tables.
func AddressLookupTables(ctx context.Context, client *rpc.Client, tables []solana.PublicKey) (map[solana.PublicKey]solana.PublicKeySlice, error) {
	out := make(map[solana.PublicKey]solana.PublicKeySlice, len(tables))
	for _, table := range tables {
		state, err := addresslookuptable.GetAddressLookupTable(ctx, client, table)
		if err != nil {
			return nil, fmt.Errorf("failed to fetch address lookup table %s: %w", table, err)
		}
		out[table] = state.Addresses
	}
	return out, nil
}
