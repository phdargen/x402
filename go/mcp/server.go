// Package mcp provides MCP (Model Context Protocol) integration for x402.
//
// Server-side: Use NewPaymentWrapper to wrap MCP tool handlers with
// automatic x402 payment verification and settlement.
//
// Client-side: Use CallPaidTool to make MCP tool calls with automatic
// x402 payment handling.
package mcp

import (
	"context"
	"encoding/json"
	"fmt"
	"log"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/types"
)

// ToolHandler is the function signature for MCP tool handlers.
// This is an alias for the official MCP SDK's mcp.ToolHandler type.
type ToolHandler = mcp.ToolHandler

// PaymentWrapper wraps MCP tool handlers with x402 payment verification and settlement.
type PaymentWrapper struct {
	server *x402.X402ResourceServer
	config PaymentWrapperConfig
}

// NewPaymentWrapper creates a new payment wrapper for MCP tool handlers.
//
// Example:
//
//	wrapper := mcp402.NewPaymentWrapper(resourceServer, mcp402.PaymentWrapperConfig{
//	    Accepts:  weatherAccepts,
//	    Resource: &types.ResourceInfo{URL: "mcp://tool/get_weather", Description: "Get weather"},
//	})
//
//	wrappedHandler := wrapper.Wrap(func(ctx context.Context, request *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
//	    // extract args from request.Params.Arguments
//	    return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: "result"}}}, nil
//	})
func NewPaymentWrapper(server *x402.X402ResourceServer, config PaymentWrapperConfig) *PaymentWrapper {
	if len(config.Accepts) == 0 {
		panic("PaymentWrapperConfig.Accepts must have at least one payment requirement")
	}
	for _, requirement := range config.Accepts {
		schemeServer := server.GetRegisteredScheme(x402.Network(requirement.Network), requirement.Scheme)
		if schemeServer == nil {
			panic(fmt.Sprintf(
				`[x402] No scheme implementation registered for %q on network %q`,
				requirement.Scheme, requirement.Network,
			))
		}
		if _, _, err := x402.ResolvePaymentFlow(schemeServer, requirement); err != nil {
			panic(err.Error())
		}
	}
	return &PaymentWrapper{server: server, config: config}
}

// Wrap wraps a tool handler with x402 payment verification and settlement.
// The returned handler can be used directly with mcpServer.AddTool().
//
// Flow:
//  1. Extracts x402/payment from request _meta
//  2. If no payment, returns 402 payment required error
//  3. Verifies payment via facilitator (when the flow requires it)
//  4. Settles before the handler when the flow requires it
//  5. OnBeforeExecution hook (if configured)
//  6. Executes the original handler
//  7. OnAfterExecution hook (if configured)
//  8. Settles after the handler when the flow requires it (else echoes before-handler settle)
//  9. OnAfterSettlement hook (if configured)
//  10. Returns result with settlement info in _meta
func (w *PaymentWrapper) Wrap(handler ToolHandler) ToolHandler {
	return func(ctx context.Context, request *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		// Extract payment from _meta
		paymentData := extractPaymentFromRequest(request)

		if paymentData == nil {
			return w.paymentRequiredResult("Payment Required"), nil
		}

		// Marshal/unmarshal to convert to PaymentPayload
		payloadBytes, err := json.Marshal(paymentData)
		if err != nil {
			return w.paymentRequiredResult(fmt.Sprintf("Invalid payment: %v", err)), nil
		}

		var payload types.PaymentPayload
		if err := json.Unmarshal(payloadBytes, &payload); err != nil {
			return w.paymentRequiredResult(fmt.Sprintf("Invalid payment payload: %v", err)), nil
		}

		// Match the payload against the advertised accepts
		matched := w.server.FindMatchingRequirements(w.config.Accepts, payload)
		if matched == nil {
			return w.paymentRequiredResult("No matching payment requirements found"), nil
		}
		requirements := *matched

		flow, err := w.server.GetPaymentFlow(requirements)
		if err != nil {
			log.Printf("[x402] MCP payment flow resolve error: %v", err)
			return w.internalServerErrorResult(nil), nil
		}
		phases, err := x402.ResolvePaymentFlowPhases(flow)
		if err != nil {
			log.Printf("[x402] MCP payment flow phases error: %v", err)
			return w.internalServerErrorResult(nil), nil
		}

		// Verify payment -- return tool error result, NOT Go error
		verifyResp, err := w.server.VerifyPayment(ctx, payload, requirements)
		if err != nil {
			return w.paymentRequiredResult(
				fmt.Sprintf("Payment verification error: %v", err)), nil
		}
		if !verifyResp.IsValid {
			return w.paymentRequiredResult(
				fmt.Sprintf("Payment verification failed: %s", verifyResp.InvalidReason)), nil
		}

		var beforeHandlerSettlement *x402.CompletedSettlement
		if phases.SettleBeforeHandler {
			settleResp, settleErr := w.server.SettlePaymentWithExtensions(
				ctx, payload, requirements, nil, nil, x402.SettlePhaseBeforeHandler,
			)
			if settleErr != nil {
				log.Printf("[x402] MCP before-handler settlement error: %v", settleErr)
				return w.settlementFailedResult("Settlement failed"), nil
			}
			if !settleResp.Success {
				return w.settlementFailedResult(
					fmt.Sprintf("Settlement failed: %s", settleResp.ErrorReason)), nil
			}
			beforeHandlerSettlement = &x402.CompletedSettlement{
				Phase:        x402.SettlePhaseBeforeHandler,
				Flow:         flow,
				Result:       settleResp,
				Requirements: requirements,
			}
		}

		// Parse args from request for hooks
		args := parseArgsFromRequest(request)

		// OnBeforeExecution hook
		if w.config.Hooks != nil && w.config.Hooks.OnBeforeExecution != nil {
			hookCtx := ServerHookContext{
				ToolName:            request.Params.Name,
				Arguments:           args,
				PaymentRequirements: requirements,
				PaymentPayload:      payload,
			}
			ok, err := (*w.config.Hooks.OnBeforeExecution)(hookCtx)
			if err != nil {
				return w.paymentRequiredResult(fmt.Sprintf("before execution hook error: %v", err)), nil
			}
			if !ok {
				return w.paymentRequiredResult("Execution aborted by OnBeforeExecution hook"), nil
			}
		}

		// Execute the original handler
		result, err := handler(ctx, request)
		if err != nil {
			if beforeHandlerSettlement != nil {
				return w.internalServerErrorResult(beforeHandlerSettlement.Result), nil
			}
			return nil, err
		}

		// If handler returned an error result, don't settle after-handler;
		// echo before-handler receipt when present.
		if result.IsError {
			if beforeHandlerSettlement != nil {
				if result.Meta == nil {
					result.Meta = mcp.Meta{}
				}
				result.Meta[PaymentResponseMetaKey] = beforeHandlerSettlement.Result
			}
			return result, nil
		}

		// OnAfterExecution hook
		if w.config.Hooks != nil && w.config.Hooks.OnAfterExecution != nil {
			mcpResult := callToolResultToMCPToolResult(result)
			hookCtx := AfterExecutionContext{
				ServerHookContext: ServerHookContext{
					ToolName:            request.Params.Name,
					Arguments:           args,
					PaymentRequirements: requirements,
					PaymentPayload:      payload,
				},
				Result: mcpResult,
			}
			_ = (*w.config.Hooks.OnAfterExecution)(hookCtx) // Non-fatal
		}

		var settleResp *x402.SettleResponse
		if !phases.SettleAfterHandler {
			if beforeHandlerSettlement != nil {
				settleResp = beforeHandlerSettlement.Result
			}
		} else {
			var settleErr error
			settleResp, settleErr = w.server.SettlePaymentWithExtensions(
				ctx, payload, requirements, nil, nil, x402.SettlePhaseAfterHandler,
			)
			if settleErr != nil {
				log.Printf("[x402] MCP settlement error: %v", settleErr)
				return w.settlementFailedResult("Settlement failed"), nil
			}
			if !settleResp.Success {
				return w.settlementFailedResult(
					fmt.Sprintf("Settlement failed: %s", settleResp.ErrorReason)), nil
			}
		}

		// OnAfterSettlement hook
		if settleResp != nil && w.config.Hooks != nil && w.config.Hooks.OnAfterSettlement != nil {
			hookCtx := SettlementContext{
				ServerHookContext: ServerHookContext{
					ToolName:            request.Params.Name,
					Arguments:           args,
					PaymentRequirements: requirements,
					PaymentPayload:      payload,
				},
				Settlement: *settleResp,
			}
			_ = (*w.config.Hooks.OnAfterSettlement)(hookCtx) // Non-fatal
		}

		// Attach payment response to result _meta
		if settleResp != nil {
			if result.Meta == nil {
				result.Meta = mcp.Meta{}
			}
			result.Meta[PaymentResponseMetaKey] = settleResp
		}

		return result, nil
	}
}

// parseArgsFromRequest extracts arguments from the request as map[string]interface{}.
func parseArgsFromRequest(request *mcp.CallToolRequest) map[string]interface{} {
	args := make(map[string]interface{})
	if request.Params.Arguments != nil {
		if err := json.Unmarshal(request.Params.Arguments, &args); err != nil {
			return args
		}
	}
	return args
}

// paymentRequiredResult creates an MCP error result with payment required info.
// Per spec, sets both structuredContent and content[0].text with isError: true.
func (w *PaymentWrapper) paymentRequiredResult(errorMsg string) *mcp.CallToolResult {
	resource := w.config.Resource
	if resource == nil {
		resource = &types.ResourceInfo{
			URL:         "mcp://tool/unknown",
			Description: "Unknown tool",
			MimeType:    "application/json",
		}
	}

	pr := types.PaymentRequired{
		X402Version: 2,
		Accepts:     w.config.Accepts,
		Error:       errorMsg,
		Resource:    resource,
		Extensions:  w.config.Extensions,
	}

	data, _ := json.Marshal(pr)

	// Unmarshal to map for structuredContent (any type)
	var structuredContent map[string]any
	_ = json.Unmarshal(data, &structuredContent)

	return &mcp.CallToolResult{
		Content: []mcp.Content{
			&mcp.TextContent{Text: string(data)},
		},
		StructuredContent: structuredContent,
		IsError:           true,
	}
}

// settlementFailedResult creates a spec-compliant settlement failure result.
// Per spec R5, settlement failure follows the same format as payment required
// (structuredContent + content[0].text + isError: true).
func (w *PaymentWrapper) settlementFailedResult(errorMsg string) *mcp.CallToolResult {
	return w.paymentRequiredResult(errorMsg)
}

// internalServerErrorResult returns a generic internal error, optionally echoing
// a before-handler settlement receipt in _meta.
func (w *PaymentWrapper) internalServerErrorResult(settleResp *x402.SettleResponse) *mcp.CallToolResult {
	result := &mcp.CallToolResult{
		Content: []mcp.Content{
			&mcp.TextContent{Text: "Internal Server Error"},
		},
		IsError: true,
	}
	if settleResp != nil {
		result.Meta = mcp.Meta{PaymentResponseMetaKey: settleResp}
	}
	return result
}

// extractPaymentFromRequest extracts x402/payment from the request's _meta.
func extractPaymentFromRequest(request *mcp.CallToolRequest) interface{} {
	meta := request.Params.Meta
	if meta == nil {
		return nil
	}
	return meta[PaymentMetaKey]
}
