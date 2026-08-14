package x402

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

var (
	moneyStringPattern = regexp.MustCompile(`^-?\d+(?:\.\d+)?$`)
	moneyParsePattern  = regexp.MustCompile(`^\$?\s*(-?\d+(?:\.\d+)?)(?:\s+([A-Za-z][A-Za-z0-9.]*))?$`)
	tokenAmountPattern = regexp.MustCompile(`^-?\d+\.?\d*$`)
	scientificPattern  = regexp.MustCompile(`[eE]`)
)

// ValidatePaymentPayload performs basic validation on a payment payload
// Version-aware: handles both v1 and v2 payload structures
func ValidatePaymentPayload(p PaymentPayload) error {
	if p.X402Version < 1 || p.X402Version > 2 {
		return fmt.Errorf("unsupported x402 version: %d", p.X402Version)
	}

	// V2 validation: check accepted field
	if p.X402Version == 2 {
		if p.Accepted.Scheme == "" {
			return fmt.Errorf("payment scheme is required")
		}
		if p.Accepted.Network == "" {
			return fmt.Errorf("payment network is required")
		}
	}

	// Both v1 and v2 must have payload
	if p.Payload == nil {
		return fmt.Errorf("payment payload is required")
	}

	// Note: v1 validation is minimal here - scheme/network are validated
	// by the mechanism-specific facilitator based on the payment requirements
	return nil
}

// ValidatePaymentRequirements performs basic validation on payment requirements
func ValidatePaymentRequirements(r PaymentRequirements) error {
	if r.Scheme == "" {
		return fmt.Errorf("payment scheme is required")
	}
	if r.Network == "" {
		return fmt.Errorf("payment network is required")
	}
	if r.Asset == "" {
		return fmt.Errorf("payment asset is required")
	}
	// Note: Amount check is skipped for v1 compatibility (v1 uses maxAmountRequired)
	// Version-specific facilitators will validate amount fields as needed
	if r.PayTo == "" {
		return fmt.Errorf("payment recipient is required")
	}
	return nil
}

// findByNetworkAndScheme finds a scheme implementation for a given network/scheme combination
// This supports pattern matching for networks (e.g., "eip155:*")
func findByNetworkAndScheme[T any](networkMap map[Network]map[string]T, scheme string, network Network) T {
	var zero T

	// Try exact match first
	if schemeMap, exists := networkMap[network]; exists {
		if impl, exists := schemeMap[scheme]; exists {
			return impl
		}
	}

	// Try pattern matching
	for registeredNetwork, schemeMap := range networkMap {
		if network.Match(registeredNetwork) || registeredNetwork.Match(network) {
			if impl, exists := schemeMap[scheme]; exists {
				return impl
			}
		}
	}

	return zero
}

// findSchemesByNetwork finds all schemes for a given network
func findSchemesByNetwork[T any](networkMap map[Network]map[string]T, network Network) map[string]T {
	// Try exact match first
	if schemeMap, exists := networkMap[network]; exists {
		return schemeMap
	}

	// Try pattern matching
	for registeredNetwork, schemeMap := range networkMap {
		if network.Match(registeredNetwork) || registeredNetwork.Match(network) {
			return schemeMap
		}
	}

	return nil
}

// NumberToDecimalString converts a float64 to a plain decimal string without scientific notation.
func NumberToDecimalString(n float64) string {
	return strconv.FormatFloat(n, 'f', -1, 64)
}

// ParseMoneyString parses a money string into a finite, non-negative decimal number.
// Accepts plain decimal strings with an optional leading dollar sign.
// Rejects ticker suffixes — use ParseMoney when a symbol may be present.
func ParseMoneyString(money string) (float64, error) {
	cleaned := strings.TrimSpace(strings.TrimPrefix(money, "$"))
	if !moneyStringPattern.MatchString(cleaned) || scientificPattern.MatchString(cleaned) {
		return 0, fmt.Errorf("invalid money format: %s", money)
	}
	amount, err := strconv.ParseFloat(cleaned, 64)
	if err != nil || amount < 0 {
		return 0, fmt.Errorf("invalid money format: %s", money)
	}
	return amount, nil
}

// ParseMoney parses money into amount and optional uppercase ticker.
// "1.50 USDT" → symbol; "1.50 USD" and bare amounts have none.
// Glued tickers ("1.50USDT") are rejected.
func ParseMoney(money Price) (amount float64, symbol string, err error) {
	switch v := money.(type) {
	case float64:
		if v < 0 {
			return 0, "", fmt.Errorf("invalid money format: %v", v)
		}
		return v, "", nil
	case float32:
		if v < 0 {
			return 0, "", fmt.Errorf("invalid money format: %v", v)
		}
		return float64(v), "", nil
	case int:
		if v < 0 {
			return 0, "", fmt.Errorf("invalid money format: %v", v)
		}
		return float64(v), "", nil
	case int64:
		if v < 0 {
			return 0, "", fmt.Errorf("invalid money format: %v", v)
		}
		return float64(v), "", nil
	case string:
		trimmed := strings.TrimSpace(v)
		match := moneyParsePattern.FindStringSubmatch(trimmed)
		if match == nil {
			return 0, "", fmt.Errorf("invalid money format: %s", v)
		}
		parsed, parseErr := ParseMoneyString(match[1])
		if parseErr != nil {
			return 0, "", parseErr
		}
		rawSymbol := match[2]
		if rawSymbol == "" || strings.ToUpper(rawSymbol) == "USD" {
			return parsed, "", nil
		}
		return parsed, strings.ToUpper(rawSymbol), nil
	default:
		return 0, "", fmt.Errorf("invalid money format: %v", money)
	}
}

// ConvertToTokenAmount converts a decimal amount to token smallest units.
// Accepts only plain decimal strings — scientific notation is not allowed.
func ConvertToTokenAmount(decimalAmount string, decimals int) (string, error) {
	if scientificPattern.MatchString(decimalAmount) {
		return "", fmt.Errorf("invalid amount: %s — use decimal notation, not scientific notation", decimalAmount)
	}
	if !tokenAmountPattern.MatchString(decimalAmount) {
		return "", fmt.Errorf("invalid amount: %s", decimalAmount)
	}
	intPart, decPart, found := strings.Cut(decimalAmount, ".")
	if !found {
		decPart = ""
	}
	paddedDec := decPart + strings.Repeat("0", decimals)
	if len(paddedDec) > decimals {
		paddedDec = paddedDec[:decimals]
	}
	tokenAmount := strings.TrimLeft(intPart+paddedDec, "0")
	if tokenAmount == "" {
		tokenAmount = "0"
	}
	if tokenAmount == "0" && strings.ContainsAny(decimalAmount, "123456789") {
		return "", fmt.Errorf("amount %s is too small to represent with %d decimal places", decimalAmount, decimals)
	}
	return tokenAmount, nil
}
