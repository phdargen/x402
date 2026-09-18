package batchsettlement

import (
	"bytes"
	"math/big"
	"strings"

	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"

	"github.com/x402-foundation/x402/go/v2/mechanisms/evm"
)

// ChargeCountsMagic is bytes4(keccak256("x402ChargeCounts(uint64[])")).
const ChargeCountsMagic = "0x50b180c6"

const (
	dynamicArrayHeaderBytes = 64
	wordBytes               = 32
	// maxSafeChargeCountLength is the largest ABI array length we will accept
	// (53-bit integer). Larger length words are treated as undecodable.
	maxSafeChargeCountLength = 1<<53 - 1
)

var (
	chargeCountsArgs   abi.Arguments
	batchCallMethods   map[string]abi.Method
	chargeCountsMagicB []byte
)

func init() {
	uint64Arr, err := abi.NewType("uint64[]", "", nil)
	if err != nil {
		panic("charge counts ABI: " + err.Error())
	}
	chargeCountsArgs = abi.Arguments{{Type: uint64Arr}}
	chargeCountsMagicB = common.FromHex(ChargeCountsMagic)

	batchCallMethods = make(map[string]abi.Method)
	registerMethods(BatchSettlementClaimABI)
	registerMethods(BatchSettlementClaimWithSignatureABI)
	registerMethods(BatchSettlementMulticallABI)
	registerMethods(BatchSettlementRefundABI)
	registerMethods(BatchSettlementRefundWithSignatureABI)
	registerMethods(BatchSettlementSettleABI)
	registerMethods(BatchSettlementDepositABI)
}

func registerMethods(abiJSON []byte) {
	parsed, err := abi.JSON(strings.NewReader(string(abiJSON)))
	if err != nil {
		panic("batch-settlement ABI: " + err.Error())
	}
	for _, method := range parsed.Methods {
		batchCallMethods[string(method.ID)] = method
	}
}

// EncodeChargeCountsSuffix encodes magic || abi.encode(uint64[]) for a claim dataSuffix.
func EncodeChargeCountsSuffix(counts []uint64) ([]byte, error) {
	if counts == nil {
		counts = []uint64{}
	}
	encoded, err := chargeCountsArgs.Pack(counts)
	if err != nil {
		return nil, err
	}
	return append(append([]byte{}, chargeCountsMagicB...), encoded...), nil
}

// ComposeClaimDataSuffix places charge counts first and an optional builder-code suffix last.
func ComposeClaimDataSuffix(counts []uint64, builderSuffix []byte) ([]byte, error) {
	suffix, err := EncodeChargeCountsSuffix(counts)
	if err != nil {
		return nil, err
	}
	return evm.AppendDataSuffix(suffix, builderSuffix), nil
}

// ExtractClaimCalldata unwraps one level of multicall recursively and returns
// the first inner claim / claimWithSignature calldata, or nil when none is present.
func ExtractClaimCalldata(calldata []byte) []byte {
	decoded, ok := decodeBatchCall(calldata)
	if !ok {
		return nil
	}
	if decoded.Name == "claim" || decoded.Name == "claimWithSignature" {
		return calldata
	}
	if decoded.Name != "multicall" || len(decoded.Args) == 0 {
		return nil
	}
	for _, item := range bytesSliceArg(decoded.Args[0]) {
		if found := ExtractClaimCalldata(item); found != nil {
			return found
		}
	}
	return nil
}

// ParseChargeCountsFromCalldata ABI-decodes a claim (unwrapping multicall) and
// reads the charge-count suffix. Nil means no claim or no attestation.
func ParseChargeCountsFromCalldata(calldata []byte) []uint64 {
	claimCalldata := ExtractClaimCalldata(calldata)
	if claimCalldata == nil {
		return nil
	}
	leftover, ok := leftoverAfterClaimArgs(claimCalldata)
	if !ok {
		return nil
	}
	return ParseChargeCountsSuffix(leftover)
}

// ParseChargeCountsSuffix decodes magic || abi.encode(uint64[]) from the start
// of a leftover blob. A later suffix is ignored. Nil means no magic / truncated.
func ParseChargeCountsSuffix(leftover []byte) []uint64 {
	if len(leftover) < len(chargeCountsMagicB) || !bytes.Equal(leftover[:len(chargeCountsMagicB)], chargeCountsMagicB) {
		return nil
	}
	encoded := leftover[len(chargeCountsMagicB):]
	if len(encoded) < dynamicArrayHeaderBytes {
		return nil
	}
	length := new(big.Int).SetBytes(encoded[wordBytes:dynamicArrayHeaderBytes])
	if !length.IsUint64() {
		return nil
	}
	n := length.Uint64()
	if n > maxSafeChargeCountLength {
		return nil
	}
	sizedBytes := dynamicArrayHeaderBytes + int(n)*wordBytes
	if len(encoded) < sizedBytes {
		return nil
	}
	decoded, err := chargeCountsArgs.Unpack(encoded[:sizedBytes])
	if err != nil || len(decoded) == 0 {
		return nil
	}
	return uint64SliceArg(decoded[0])
}

type decodedBatchCall struct {
	Name   string
	Method abi.Method
	Args   []interface{}
}

func decodeBatchCall(calldata []byte) (decodedBatchCall, bool) {
	if len(calldata) < 4 {
		return decodedBatchCall{}, false
	}
	method, ok := batchCallMethods[string(calldata[:4])]
	if !ok {
		return decodedBatchCall{}, false
	}
	args, err := method.Inputs.Unpack(calldata[4:])
	if err != nil {
		return decodedBatchCall{}, false
	}
	return decodedBatchCall{Name: method.Name, Method: method, Args: args}, true
}

func leftoverAfterClaimArgs(calldata []byte) ([]byte, bool) {
	decoded, ok := decodeBatchCall(calldata)
	if !ok || (decoded.Name != "claim" && decoded.Name != "claimWithSignature") {
		return nil, false
	}
	packed, err := decoded.Method.Inputs.Pack(decoded.Args...)
	if err != nil {
		return nil, false
	}
	full := append(append([]byte{}, decoded.Method.ID...), packed...)
	if !bytes.HasPrefix(calldata, full) {
		return nil, false
	}
	return calldata[len(full):], true
}

func bytesSliceArg(v interface{}) [][]byte {
	switch x := v.(type) {
	case [][]byte:
		return x
	case []interface{}:
		out := make([][]byte, 0, len(x))
		for _, item := range x {
			b, ok := item.([]byte)
			if !ok {
				return nil
			}
			out = append(out, b)
		}
		return out
	default:
		return nil
	}
}

func uint64SliceArg(v interface{}) []uint64 {
	switch x := v.(type) {
	case []uint64:
		out := make([]uint64, len(x))
		copy(out, x)
		return out
	case []*big.Int:
		out := make([]uint64, len(x))
		for i, n := range x {
			if n == nil || !n.IsUint64() {
				return nil
			}
			out[i] = n.Uint64()
		}
		return out
	case []interface{}:
		out := make([]uint64, 0, len(x))
		for _, item := range x {
			switch n := item.(type) {
			case *big.Int:
				if n == nil || !n.IsUint64() {
					return nil
				}
				out = append(out, n.Uint64())
			case uint64:
				out = append(out, n)
			default:
				return nil
			}
		}
		return out
	default:
		return nil
	}
}
