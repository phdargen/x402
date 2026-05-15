package buildercode

import "fmt"

// EncodeBuilderCodeSuffix builds a complete ERC-8021 Schema 2 calldata suffix.
//
// Layout: [cbor_data][suffix_data_length (2 bytes, big-endian)][schema_id (1 byte)][marker (16 bytes)]
// suffix_data_length covers cbor_data only.
func EncodeBuilderCodeSuffix(data ExtensionData) ([]byte, error) {
	cborBytes, err := encodeCborMap(data)
	if err != nil {
		return nil, err
	}
	cborLen := len(cborBytes)
	if cborLen > 0xffff {
		return nil, fmt.Errorf("cbor payload too large: %d", cborLen)
	}

	out := make([]byte, 0, cborLen+2+1+len(Marker))
	out = append(out, cborBytes...)
	out = append(out, byte((cborLen>>8)&0xff), byte(cborLen&0xff))
	out = append(out, SchemaID)
	out = append(out, Marker...)
	return out, nil
}

// encodeCborMap emits a minimal CBOR map (major type 5) with single-letter keys
// "a", "w", "s" in that order. Empty fields are skipped.
func encodeCborMap(data ExtensionData) ([]byte, error) {
	type entry struct {
		key string
		// Exactly one of strVal / arrVal is set.
		strVal string
		arrVal []string
		isArr  bool
	}
	var entries []entry
	if data.A != "" {
		entries = append(entries, entry{key: "a", strVal: data.A})
	}
	if data.W != "" {
		entries = append(entries, entry{key: "w", strVal: data.W})
	}
	if len(data.S) > 0 {
		entries = append(entries, entry{key: "s", arrVal: data.S, isArr: true})
	}

	header, err := encodeCborMajorType(5, len(entries))
	if err != nil {
		return nil, err
	}

	out := append([]byte(nil), header...)
	for _, e := range entries {
		k, err := encodeCborString(e.key)
		if err != nil {
			return nil, err
		}
		out = append(out, k...)

		if e.isArr {
			arr, err := encodeCborArray(e.arrVal)
			if err != nil {
				return nil, err
			}
			out = append(out, arr...)
		} else {
			v, err := encodeCborString(e.strVal)
			if err != nil {
				return nil, err
			}
			out = append(out, v...)
		}
	}
	return out, nil
}

// encodeCborString emits a CBOR text string (major type 3).
func encodeCborString(value string) ([]byte, error) {
	header, err := encodeCborMajorType(3, len(value))
	if err != nil {
		return nil, err
	}
	out := make([]byte, 0, len(header)+len(value))
	out = append(out, header...)
	out = append(out, []byte(value)...)
	return out, nil
}

// encodeCborArray emits a CBOR array (major type 4) of text strings.
func encodeCborArray(values []string) ([]byte, error) {
	header, err := encodeCborMajorType(4, len(values))
	if err != nil {
		return nil, err
	}
	out := append([]byte(nil), header...)
	for _, v := range values {
		s, err := encodeCborString(v)
		if err != nil {
			return nil, err
		}
		out = append(out, s...)
	}
	return out, nil
}

// encodeCborMajorType emits a CBOR initial byte plus optional length argument.
func encodeCborMajorType(majorType int, value int) ([]byte, error) {
	if value < 0 {
		return nil, fmt.Errorf("negative cbor length: %d", value)
	}
	mt := byte(majorType << 5)
	switch {
	case value <= 23:
		return []byte{mt | byte(value)}, nil
	case value <= 0xff:
		return []byte{mt | 24, byte(value)}, nil
	case value <= 0xffff:
		return []byte{mt | 25, byte((value >> 8) & 0xff), byte(value & 0xff)}, nil
	default:
		return nil, fmt.Errorf("cbor value too large: %d", value)
	}
}
