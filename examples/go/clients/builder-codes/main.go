package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"

	"github.com/joho/godotenv"
	x402 "github.com/x402-foundation/x402/go"
	x402http "github.com/x402-foundation/x402/go/http"
	evm "github.com/x402-foundation/x402/go/mechanisms/evm/exact/client"
	evmsigners "github.com/x402-foundation/x402/go/signers/evm"
)

// peek is a logging RoundTripper that prints the buildercode extension data
// flowing in both directions: the codes the server declared in its 402, and
// the codes the SDK forwarded back in the X-Payment header.
type peek struct{ inner http.RoundTripper }

func (p *peek) RoundTrip(req *http.Request) (*http.Response, error) {
	if h := req.Header.Get("X-Payment"); h != "" {
		if raw, err := base64.StdEncoding.DecodeString(h); err == nil {
			var payload map[string]any
			if json.Unmarshal(raw, &payload) == nil {
				if ext, ok := payload["extensions"]; ok {
					b, _ := json.MarshalIndent(ext, "", "  ")
					fmt.Printf("➡️  payload.extensions sent:\n%s\n", b)
				}
			}
		}
	}

	resp, err := p.inner.RoundTrip(req)
	if err != nil {
		return resp, err
	}

	// Server returns 402 with PaymentRequired in the Payment-Required header,
	// not the body. Decode and log the extensions so we can confirm what the
	// server declared.
	if resp.StatusCode == http.StatusPaymentRequired {
		if hdr := resp.Header.Get("Payment-Required"); hdr != "" {
			if raw, err := base64.StdEncoding.DecodeString(hdr); err == nil {
				var pr map[string]any
				if json.Unmarshal(raw, &pr) == nil {
					if ext, ok := pr["extensions"]; ok {
						b, _ := json.MarshalIndent(ext, "", "  ")
						fmt.Printf("⬅️  402 extensions:\n%s\n", b)
					}
				}
			}
		}
		// Restore body in case downstream wants to read it
		body, _ := io.ReadAll(resp.Body)
		resp.Body = io.NopCloser(bytes.NewReader(body))
	}
	return resp, nil
}

func main() {
	_ = godotenv.Load()

	priv := os.Getenv("EVM_PRIVATE_KEY_CLIENT")
	url := os.Getenv("SERVER_URL")
	if priv == "" || url == "" {
		fmt.Println("EVM_PRIVATE_KEY_CLIENT and SERVER_URL required")
		os.Exit(1)
	}

	signer, err := evmsigners.NewClientSignerFromPrivateKey(priv)
	if err != nil {
		fmt.Printf("signer: %v\n", err)
		os.Exit(1)
	}

	x402Client := x402.Newx402Client()
	x402Client.Register("eip155:*", evm.NewExactEvmScheme(signer, nil))

	httpInner := &http.Client{Transport: &peek{inner: http.DefaultTransport}}
	wrapped := x402http.WrapHTTPClientWithPayment(httpInner, x402http.Newx402HTTPClient(x402Client))

	resp, err := wrapped.Get(url)
	if err != nil {
		fmt.Printf("request: %v\n", err)
		os.Exit(1)
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)
	fmt.Printf("\n✅ %s\n%s\n", resp.Status, body)

	if pr := resp.Header.Get("PAYMENT-RESPONSE"); pr != "" {
		if raw, err := base64.StdEncoding.DecodeString(pr); err == nil {
			fmt.Printf("\n💰 settlement: %s\n", raw)
		}
	}
}
