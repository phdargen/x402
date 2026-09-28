package server

import (
	"encoding/json"

	batchsettlement "github.com/x402-foundation/x402/go/v2/mechanisms/svm/batch-settlement"
)

func extraString(extra map[string]any, field string) string {
	if extra == nil {
		return ""
	}
	text, _ := extra[field].(string)
	return text
}

func asRequirementInt(value any) (int64, bool) {
	switch typed := value.(type) {
	case int:
		return int64(typed), true
	case int64:
		return typed, true
	case float64:
		if typed != float64(int64(typed)) {
			return 0, false
		}
		return int64(typed), true
	case json.Number:
		parsed, err := typed.Int64()
		return parsed, err == nil
	default:
		return 0, false
	}
}

func digitsU64(value any) (uint64, bool) {
	text, ok := value.(string)
	if !ok || !batchsettlement.IsDigits(text) {
		return 0, false
	}
	parsed, err := batchsettlement.AmountToU64(text, "amount")
	return parsed, err == nil
}

func structToMap(value any) (map[string]any, error) {
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

// addU64 reports whether left+right fits in a uint64.
func addU64(left, right uint64) (uint64, bool) {
	sum := left + right
	return sum, sum >= left
}

// mulU64 reports whether left*right fits in a uint64.
func mulU64(left, right uint64) (uint64, bool) {
	if left == 0 || right == 0 {
		return 0, true
	}
	product := left * right
	return product, product/left == right
}
