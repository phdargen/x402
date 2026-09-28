package client

import (
	"encoding/json"
	"fmt"
	"strconv"

	solana "github.com/gagliardetto/solana-go"
	"github.com/google/uuid"

	"github.com/x402-foundation/x402/go/v2/mechanisms/svm"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm/paymentchannels"
)

func parseU64(value any, name string) (uint64, error) {
	return paymentchannels.ParseU64(value, name)
}

func formatU64(value uint64) string {
	return strconv.FormatUint(value, 10)
}

func addU64(left, right uint64) (uint64, error) {
	sum := left + right
	if sum < left {
		return 0, fmt.Errorf("batch-settlement amount overflow")
	}
	return sum, nil
}

func subU64(left, right uint64) (uint64, bool) {
	if left < right {
		return 0, false
	}
	return left - right, true
}

func newRequestID() string {
	return uuid.NewString()
}

func encodeTransaction(tx *solana.Transaction) (string, error) {
	return svm.EncodeTransaction(tx)
}

func toPayloadMap(value any) (map[string]any, error) {
	encoded, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := json.Unmarshal(encoded, &out); err != nil {
		return nil, err
	}
	return out, nil
}

func digits(value string) bool {
	if value == "" {
		return false
	}
	for _, char := range value {
		if char < '0' || char > '9' {
			return false
		}
	}
	return true
}
