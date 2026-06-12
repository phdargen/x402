package buildercode

import (
	"context"
	"reflect"
	"testing"

	"github.com/x402-foundation/x402/go/v2/types"
)

func TestNewBuilderCodeClientExtensionRejectsInvalidCode(t *testing.T) {
	defer func() {
		if recover() == nil {
			t.Fatal("expected panic for invalid service code")
		}
	}()
	NewBuilderCodeClientExtension("Bad-Code")
}

func TestClientExtensionKey(t *testing.T) {
	if got := NewBuilderCodeClientExtension(serviceCode).Key(); got != BUILDER_CODE {
		t.Fatalf("expected key %q, got %q", BUILDER_CODE, got)
	}
}

func TestClientExtensionAttachesServiceCode(t *testing.T) {
	ext := NewBuilderCodeClientExtension(serviceCode)
	enriched, err := ext.EnrichPaymentPayload(context.Background(), types.PaymentPayload{X402Version: 2}, types.PaymentRequired{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	want := map[string]interface{}{"info": map[string]interface{}{"s": []string{serviceCode}}}
	if !reflect.DeepEqual(enriched.Extensions[BUILDER_CODE], want) {
		t.Fatalf("expected %v, got %v", want, enriched.Extensions[BUILDER_CODE])
	}
}

func TestClientExtensionAttachesMultipleServiceCodes(t *testing.T) {
	ext := NewBuilderCodeClientExtension(serviceCode, "bc_other")
	enriched, err := ext.EnrichPaymentPayload(context.Background(), types.PaymentPayload{X402Version: 2}, types.PaymentRequired{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	want := map[string]interface{}{"info": map[string]interface{}{"s": []string{serviceCode, "bc_other"}}}
	if !reflect.DeepEqual(enriched.Extensions[BUILDER_CODE], want) {
		t.Fatalf("expected %v, got %v", want, enriched.Extensions[BUILDER_CODE])
	}
}

func TestClientExtensionPreservesUnrelatedExtensions(t *testing.T) {
	ext := NewBuilderCodeClientExtension(serviceCode)
	payload := types.PaymentPayload{
		X402Version: 2,
		Extensions:  map[string]interface{}{"other": map[string]interface{}{"kept": true}},
	}

	enriched, err := ext.EnrichPaymentPayload(context.Background(), payload, types.PaymentRequired{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if !reflect.DeepEqual(enriched.Extensions["other"], map[string]interface{}{"kept": true}) {
		t.Fatalf("unrelated extension not preserved: %v", enriched.Extensions["other"])
	}
	want := map[string]interface{}{"info": map[string]interface{}{"s": []string{serviceCode}}}
	if !reflect.DeepEqual(enriched.Extensions[BUILDER_CODE], want) {
		t.Fatalf("expected %v, got %v", want, enriched.Extensions[BUILDER_CODE])
	}
}

func TestDeclareBuilderCodeExtensionRejectsInvalidCode(t *testing.T) {
	defer func() {
		if recover() == nil {
			t.Fatal("expected panic for invalid app code")
		}
	}()
	DeclareBuilderCodeExtension("INVALID")
}

func TestDeclareBuilderCodeExtensionShape(t *testing.T) {
	declared := DeclareBuilderCodeExtension(appCode)
	ext, ok := declared[BUILDER_CODE].(map[string]interface{})
	if !ok {
		t.Fatalf("expected builder-code map, got %T", declared[BUILDER_CODE])
	}
	info, ok := ext["info"].(map[string]interface{})
	if !ok || info["a"] != appCode {
		t.Fatalf("expected info.a=%q, got %+v", appCode, ext["info"])
	}
	if _, ok := ext["schema"]; !ok {
		t.Fatal("expected schema in declaration")
	}
}
