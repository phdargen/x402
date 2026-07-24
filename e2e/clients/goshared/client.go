package goshared

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"

	"github.com/ethereum/go-ethereum/ethclient"

	x402 "github.com/x402-foundation/x402/go/v2"
	x402http "github.com/x402-foundation/x402/go/v2/http"
	batchedclient "github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement/client"
	exactevm "github.com/x402-foundation/x402/go/v2/mechanisms/evm/exact/client"
	exactevmv1 "github.com/x402-foundation/x402/go/v2/mechanisms/evm/exact/v1/client"
	uptoevm "github.com/x402-foundation/x402/go/v2/mechanisms/evm/upto/client"
	svmconfig "github.com/x402-foundation/x402/go/v2/mechanisms/svm"
	svm "github.com/x402-foundation/x402/go/v2/mechanisms/svm/exact/client"
	svmv1 "github.com/x402-foundation/x402/go/v2/mechanisms/svm/exact/v1/client"
	evmsigners "github.com/x402-foundation/x402/go/v2/signers/evm"
	svmsigners "github.com/x402-foundation/x402/go/v2/signers/svm"
)

// StepResult is the JSON shape the harness expects per request step.
type StepResult struct {
	Success         bool        `json:"success"`
	Data            interface{} `json:"data,omitempty"`
	StatusCode      int         `json:"status_code,omitempty"`
	PaymentResponse interface{} `json:"payment_response,omitempty"`
	Error           string      `json:"error,omitempty"`
}

// AggregateResult mirrors TS aggregateBatchResult() output.
type AggregateResult struct {
	Success         bool        `json:"success"`
	Data            interface{} `json:"data,omitempty"`
	StatusCode      int         `json:"status_code,omitempty"`
	PaymentResponse interface{} `json:"payment_response,omitempty"`
}

// SettleResponseExtractor reads PAYMENT-RESPONSE headers.
type SettleResponseExtractor interface {
	GetPaymentSettleResponse(headers map[string]string) (*x402.SettleResponse, error)
}

// ClientContext holds a configured payment-capable HTTP client for e2e runs.
type ClientContext struct {
	URL           string
	HTTPClient    *http.Client
	Settle        SettleResponseExtractor
	BatchedScheme *batchedclient.BatchSettlementEvmScheme
	BatchPhase    string
}

// CreateClient builds the shared x402 client used by go-http e2e.
func CreateClient() *ClientContext {
	serverURL := os.Getenv("RESOURCE_SERVER_URL")
	if serverURL == "" {
		log.Fatal("RESOURCE_SERVER_URL is required")
	}

	endpointPath := os.Getenv("ENDPOINT_PATH")
	if endpointPath == "" {
		endpointPath = "/protected"
	}

	evmPrivateKey := os.Getenv("CLIENT_EVM_PRIVATE_KEY")
	if evmPrivateKey == "" {
		log.Fatal("CLIENT_EVM_PRIVATE_KEY environment variable is required")
	}

	svmPrivateKey := os.Getenv("CLIENT_SVM_PRIVATE_KEY")
	if svmPrivateKey == "" {
		log.Fatal("CLIENT_SVM_PRIVATE_KEY environment variable is required")
	}

	evmRpcURL := os.Getenv("EVM_RPC_URL")
	if evmRpcURL == "" {
		evmRpcURL = "https://sepolia.base.org"
	}
	ethClient, err := ethclient.Dial(evmRpcURL)
	if err != nil {
		OutputError(fmt.Sprintf("Failed to connect to EVM RPC: %v", err))
		return nil
	}

	evmSigner, err := evmsigners.NewClientSignerFromPrivateKeyWithClient(evmPrivateKey, ethClient)
	if err != nil {
		OutputError(fmt.Sprintf("Failed to create EVM signer: %v", err))
		return nil
	}

	svmSigner, err := svmsigners.NewClientSignerFromPrivateKey(svmPrivateKey)
	if err != nil {
		OutputError(fmt.Sprintf("Failed to create SVM signer: %v", err))
		return nil
	}

	var evmConfig *exactevm.ExactEvmSchemeConfig
	if evmRpcURL != "" {
		evmConfig = &exactevm.ExactEvmSchemeConfig{RPCURL: evmRpcURL}
	}

	var uptoConfig *uptoevm.UptoEvmSchemeConfig
	if evmRpcURL != "" {
		uptoConfig = &uptoevm.UptoEvmSchemeConfig{RPCURL: evmRpcURL}
	}

	var svmCfg *svmconfig.ClientConfig
	if svmRpcURL := os.Getenv("SVM_RPC_URL"); svmRpcURL != "" {
		svmCfg = &svmconfig.ClientConfig{RPCURL: svmRpcURL}
	}

	batchedCfg := &batchedclient.BatchSettlementEvmSchemeOptions{}
	if salt := os.Getenv("CHANNEL_SALT"); salt != "" {
		batchedCfg.Salt = salt
	}
	if voucherKey := os.Getenv("CLIENT_EVM_VOUCHER_SIGNER_PRIVATE_KEY"); voucherKey != "" {
		voucherSigner, err := evmsigners.NewClientSignerFromPrivateKeyWithClient(voucherKey, ethClient)
		if err != nil {
			OutputError(fmt.Sprintf("Failed to create voucher signer: %v", err))
			return nil
		}
		batchedCfg.VoucherSigner = voucherSigner
	}
	batchedScheme := batchedclient.NewBatchSettlementEvmScheme(evmSigner, batchedCfg)

	x402Client := x402.Newx402Client().
		Register("eip155:*", exactevm.NewExactEvmScheme(evmSigner, evmConfig)).
		Register("eip155:*", uptoevm.NewUptoEvmScheme(evmSigner, uptoConfig)).
		Register("eip155:*", batchedScheme).
		Register("solana:*", svm.NewExactSvmScheme(svmSigner, svmCfg)).
		RegisterV1("base-sepolia", exactevmv1.NewExactEvmSchemeV1(evmSigner)).
		RegisterV1("base", exactevmv1.NewExactEvmSchemeV1(evmSigner)).
		RegisterV1("solana-devnet", svmv1.NewExactSvmSchemeV1(svmSigner, svmCfg)).
		RegisterV1("solana", svmv1.NewExactSvmSchemeV1(svmSigner, svmCfg))

	httpClient := x402http.Newx402HTTPClient(x402Client)
	client := x402http.WrapHTTPClientWithPayment(http.DefaultClient, httpClient)

	return &ClientContext{
		URL:           serverURL + endpointPath,
		HTTPClient:    client,
		Settle:        httpClient,
		BatchedScheme: batchedScheme,
		BatchPhase:    os.Getenv("BATCH_SETTLEMENT_PHASE"),
	}
}

// RunScenario executes the single-request or batch-settlement client flow.
func RunScenario(ctx context.Context, c *ClientContext) {
	switch c.BatchPhase {
	case "initial":
		deposit := IssueRequest(ctx, c.HTTPClient, c.Settle, c.URL)
		voucher := IssueRequest(ctx, c.HTTPClient, c.Settle, c.URL)
		Emit(Aggregate("initial", []StepResult{deposit, voucher}, map[string]StepResult{
			"deposit": deposit,
			"voucher": voucher,
		}))
	case "recovery-refund":
		recoveryVoucher := IssueRequest(ctx, c.HTTPClient, c.Settle, c.URL)
		refund := IssueRefund(ctx, c.BatchedScheme, c.URL)
		Emit(Aggregate("recovery-refund", []StepResult{recoveryVoucher, refund}, map[string]StepResult{
			"recoveryVoucher": recoveryVoucher,
			"refund":          refund,
		}))
	case "full":
		deposit := IssueRequest(ctx, c.HTTPClient, c.Settle, c.URL)
		voucher := IssueRequest(ctx, c.HTTPClient, c.Settle, c.URL)
		refund := IssueRefund(ctx, c.BatchedScheme, c.URL)
		Emit(Aggregate("full", []StepResult{deposit, voucher, refund}, map[string]StepResult{
			"deposit": deposit,
			"voucher": voucher,
			"refund":  refund,
		}))
	case "":
		Emit(ToAggregate(IssueRequest(ctx, c.HTTPClient, c.Settle, c.URL)))
	default:
		OutputError(fmt.Sprintf("Unknown BATCH_SETTLEMENT_PHASE: %s", c.BatchPhase))
	}
}

// IssueRequest performs a single paid GET.
func IssueRequest(
	ctx context.Context,
	client *http.Client,
	httpClient SettleResponseExtractor,
	url string,
) StepResult {
	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return StepResult{Success: false, Error: fmt.Sprintf("Failed to create request: %v", err)}
	}
	resp, err := client.Do(req)
	if err != nil {
		return StepResult{Success: false, Error: fmt.Sprintf("Request failed: %v", err)}
	}
	defer resp.Body.Close()

	var responseData interface{}
	if err := json.NewDecoder(resp.Body).Decode(&responseData); err != nil {
		return StepResult{Success: false, Error: fmt.Sprintf("Failed to decode response: %v", err), StatusCode: resp.StatusCode}
	}

	var paymentResponse interface{}
	if header := resp.Header.Get("PAYMENT-RESPONSE"); header != "" {
		if settleResp, err := httpClient.GetPaymentSettleResponse(map[string]string{"PAYMENT-RESPONSE": header}); err == nil {
			paymentResponse = settleResp
		}
	} else if header := resp.Header.Get("X-PAYMENT-RESPONSE"); header != "" {
		if settleResp, err := httpClient.GetPaymentSettleResponse(map[string]string{"X-PAYMENT-RESPONSE": header}); err == nil {
			paymentResponse = settleResp
		}
	}

	success := true
	if resp.StatusCode == 402 {
		success = false
	} else if settleResp, ok := paymentResponse.(*x402.SettleResponse); ok && settleResp != nil {
		success = settleResp.Success
	}

	return StepResult{
		Success:         success,
		Data:            responseData,
		StatusCode:      resp.StatusCode,
		PaymentResponse: paymentResponse,
	}
}

// IssueRefund triggers a cooperative refund on the batch-settlement channel.
func IssueRefund(ctx context.Context, scheme *batchedclient.BatchSettlementEvmScheme, url string) StepResult {
	settle, err := scheme.Refund(ctx, url, &batchedclient.RefundOptions{})
	if err != nil {
		return StepResult{
			Success:    false,
			Error:      fmt.Sprintf("Refund failed: %v", err),
			StatusCode: 200,
			Data:       map[string]bool{"refund": true},
		}
	}
	return StepResult{
		Success:         settle.Success,
		Data:            map[string]bool{"refund": true},
		StatusCode:      200,
		PaymentResponse: settle,
	}
}

// Aggregate builds the multi-step batchSettlement payload.
func Aggregate(phase string, results []StepResult, details map[string]StepResult) AggregateResult {
	last := results[len(results)-1]
	allOk := true
	for _, r := range results {
		if !r.Success {
			allOk = false
			break
		}
	}
	batch := map[string]interface{}{
		"phase":    phase,
		"requests": results,
	}
	for k, v := range details {
		batch[k] = v
	}
	return AggregateResult{
		Success:         allOk,
		Data:            map[string]interface{}{"batchSettlement": batch},
		StatusCode:      last.StatusCode,
		PaymentResponse: last.PaymentResponse,
	}
}

// ToAggregate lifts a single StepResult into the wrapper shape.
func ToAggregate(s StepResult) AggregateResult {
	return AggregateResult{
		Success:         s.Success,
		Data:            s.Data,
		StatusCode:      s.StatusCode,
		PaymentResponse: s.PaymentResponse,
	}
}

// Emit prints an aggregate result as JSON.
func Emit(result AggregateResult) {
	data, err := json.Marshal(result)
	if err != nil {
		log.Fatalf("Failed to marshal result: %v", err)
	}
	fmt.Println(string(data))
}

// OutputError prints a step error and exits.
func OutputError(errorMsg string) {
	data, _ := json.Marshal(StepResult{Success: false, Error: errorMsg})
	fmt.Println(string(data))
	os.Exit(1)
}
