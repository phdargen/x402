package batchsettlement

// IsDigits reports whether value is a non-empty decimal digit string.
func IsDigits(value string) bool {
	if value == "" {
		return false
	}
	for _, ch := range value {
		if ch < '0' || ch > '9' {
			return false
		}
	}
	return true
}
