package buildercode

import (
	"bytes"
	"encoding/hex"
	"testing"
)

func TestValidateCode(t *testing.T) {
	good := []string{"a", "bc_app", "abc123", "bc_my_facilitator_xx"}
	for _, c := range good {
		if err := validateCode(c); err != nil {
			t.Errorf("expected %q valid, got %v", c, err)
		}
	}
	bad := []string{"", "BC_APP", "bc-app", "bc app", "bc_" + string(make([]byte, 32))}
	for _, c := range bad {
		if err := validateCode(c); err == nil {
			t.Errorf("expected %q invalid", c)
		}
	}
}

func TestEncodeBuilderCodeSuffixLayout(t *testing.T) {
	suffix, err := EncodeBuilderCodeSuffix(ExtensionData{A: "bc_app", W: "bc_fac"})
	if err != nil {
		t.Fatal(err)
	}
	// Trailing 16 bytes must be the marker.
	if !bytes.Equal(suffix[len(suffix)-16:], Marker) {
		t.Errorf("trailing 16 bytes != marker; got %x", suffix[len(suffix)-16:])
	}
	// Schema byte directly precedes marker.
	if suffix[len(suffix)-17] != SchemaID {
		t.Errorf("schema byte = 0x%x, want 0x%x", suffix[len(suffix)-17], SchemaID)
	}
	// Two big-endian length bytes precede schema; must equal cbor length.
	declaredLen := int(suffix[len(suffix)-19])<<8 | int(suffix[len(suffix)-18])
	cborLen := len(suffix) - 19
	if declaredLen != cborLen {
		t.Errorf("declared cbor length = %d, want %d", declaredLen, cborLen)
	}
}

func TestEncodeBuilderCodeSuffixFixture(t *testing.T) {
	// Hand-computed CBOR for {"a":"bc_app","w":"bc_fac","s":["bc_morpho"]}:
	//   a3                          map(3)
	//   61 61                       text(1) "a"
	//   66 62 63 5f 61 70 70        text(6) "bc_app"
	//   61 77                       text(1) "w"
	//   66 62 63 5f 66 61 63        text(6) "bc_fac"
	//   61 73                       text(1) "s"
	//   81 69 62 63 5f 6d 6f 72 70 68 6f   array(1) [text(9) "bc_morpho"]
	wantCbor, _ := hex.DecodeString("a36161666263" + "5f617070" + "6177666263" + "5f666163" + "617381696263" + "5f6d6f7270686f")
	suffix, err := EncodeBuilderCodeSuffix(ExtensionData{A: "bc_app", W: "bc_fac", S: []string{"bc_morpho"}})
	if err != nil {
		t.Fatal(err)
	}
	gotCbor := suffix[:len(suffix)-19]
	if !bytes.Equal(gotCbor, wantCbor) {
		t.Errorf("cbor bytes\n got: %x\nwant: %x", gotCbor, wantCbor)
	}
}

func TestEncodeBuilderCodeSuffixSkipsEmpty(t *testing.T) {
	// Only "w" set — should produce a single-entry map.
	suffix, err := EncodeBuilderCodeSuffix(ExtensionData{W: "bc_fac"})
	if err != nil {
		t.Fatal(err)
	}
	cbor := suffix[:len(suffix)-19]
	// map(1) = 0xa1
	if cbor[0] != 0xa1 {
		t.Errorf("cbor map header = 0x%x, want 0xa1", cbor[0])
	}
}

func TestDeclareBuilderCodeExtension(t *testing.T) {
	d, err := DeclareBuilderCodeExtension("bc_app", "bc_morpho", "bc_aerodrome")
	if err != nil {
		t.Fatal(err)
	}
	if d.A != "bc_app" || len(d.S) != 2 || d.S[0] != "bc_morpho" {
		t.Errorf("unexpected ExtensionData: %+v", d)
	}
	if _, err := DeclareBuilderCodeExtension("BadCode"); err == nil {
		t.Error("expected validation error for BadCode")
	}
	if _, err := DeclareBuilderCodeExtension("bc_app", "bad-code"); err == nil {
		t.Error("expected validation error for bad service code")
	}
}

func TestFacilitatorBuildCalldataSuffix(t *testing.T) {
	ext, err := NewFacilitatorExtension(FacilitatorConfig{BuilderCode: "bc_fac"})
	if err != nil {
		t.Fatal(err)
	}

	// Map shape (post-JSON-unmarshal).
	suffixA, err := ext.BuildCalldataSuffix(map[string]interface{}{
		Key: map[string]interface{}{
			"a": "bc_app",
			"s": []interface{}{"bc_morpho"},
		},
	})
	if err != nil {
		t.Fatal(err)
	}

	// Struct shape.
	suffixB, err := ext.BuildCalldataSuffix(map[string]interface{}{
		Key: ExtensionData{A: "bc_app", S: []string{"bc_morpho"}},
	})
	if err != nil {
		t.Fatal(err)
	}

	if !bytes.Equal(suffixA, suffixB) {
		t.Errorf("map and struct shapes produced different suffixes:\n  map:    %x\n  struct: %x", suffixA, suffixB)
	}

	// Nil extensions should still produce a suffix containing only "w".
	suffixC, err := ext.BuildCalldataSuffix(nil)
	if err != nil {
		t.Fatal(err)
	}
	if suffixC[0] != 0xa1 {
		t.Errorf("nil-ext cbor map header = 0x%x, want 0xa1 (1-entry map)", suffixC[0])
	}
}

func TestNewFacilitatorExtensionRejectsBadCode(t *testing.T) {
	if _, err := NewFacilitatorExtension(FacilitatorConfig{BuilderCode: "BadCode"}); err == nil {
		t.Error("expected validation error")
	}
}
