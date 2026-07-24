package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/e2e/servers/goshared"
	nethttpmw "github.com/x402-foundation/x402/go/v2/http/nethttp"
)

var shutdownRequested bool

// net/http E2E Test Server with x402 v2 Payment Middleware

func main() {
	cfg := goshared.LoadConfig()
	schemes := goshared.BuildSchemes(cfg)
	routes := goshared.BuildRoutes(cfg)
	facilitatorClient := goshared.NewFacilitatorClient(cfg)

// Create ServeMux and register handlers
	mux := http.NewServeMux()

	// Protected endpoint - requires payment to access
	mux.HandleFunc("GET /exact/evm/eip3009", func(w http.ResponseWriter, r *http.Request) {
		if shutdownRequested {
			writeJSON(w, http.StatusServiceUnavailable, map[string]interface{}{
				"error": "Server shutting down",
			})
			return
		}

		writeJSON(w, http.StatusOK, map[string]interface{}{
			"message":   "Protected endpoint accessed successfully (EVM)",
			"timestamp": time.Now().Format(time.RFC3339),
			"network":   "eip155:84532",
		})
	})

	// Protected SVM endpoint - requires payment to access
	mux.HandleFunc("GET /exact/svm", func(w http.ResponseWriter, r *http.Request) {
		if shutdownRequested {
			writeJSON(w, http.StatusServiceUnavailable, map[string]interface{}{
				"error": "Server shutting down",
			})
			return
		}

		writeJSON(w, http.StatusOK, map[string]interface{}{
			"message":   "Protected endpoint accessed successfully (SVM)",
			"timestamp": time.Now().Format(time.RFC3339),
			"network":   "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
		})
	})

	// Protected Permit2 direct endpoint - standard settle (no gas sponsoring)
	mux.HandleFunc("GET /exact/evm/permit2", func(w http.ResponseWriter, r *http.Request) {
		if shutdownRequested {
			writeJSON(w, http.StatusServiceUnavailable, map[string]interface{}{
				"error": "Server shutting down",
			})
			return
		}

		writeJSON(w, http.StatusOK, map[string]interface{}{
			"message":   "Permit2 endpoint accessed successfully",
			"timestamp": time.Now().Format(time.RFC3339),
			"method":    "permit2",
		})
	})

	// Protected Permit2 EIP-2612 endpoint - Permit2 with gas sponsoring
	mux.HandleFunc("GET /exact/evm/permit2-eip2612GasSponsoring", func(w http.ResponseWriter, r *http.Request) {
		if shutdownRequested {
			writeJSON(w, http.StatusServiceUnavailable, map[string]interface{}{
				"error": "Server shutting down",
			})
			return
		}

		writeJSON(w, http.StatusOK, map[string]interface{}{
			"message":   "Permit2 EIP-2612 endpoint accessed successfully",
			"timestamp": time.Now().Format(time.RFC3339),
			"method":    "permit2-eip2612",
		})
	})

	// Protected Permit2 ERC-20 approval endpoint
	mux.HandleFunc("GET /exact/evm/permit2-erc20ApprovalGasSponsoring", func(w http.ResponseWriter, r *http.Request) {
		if shutdownRequested {
			writeJSON(w, http.StatusServiceUnavailable, map[string]interface{}{
				"error": "Server shutting down",
			})
			return
		}

		writeJSON(w, http.StatusOK, map[string]interface{}{
			"message":   "Permit2 ERC-20 approval endpoint accessed successfully",
			"timestamp": time.Now().Format(time.RFC3339),
			"method":    "permit2-erc20-approval",
		})
	})

	mux.HandleFunc("GET /upto/evm/permit2", func(w http.ResponseWriter, r *http.Request) {
		if shutdownRequested {
			writeJSON(w, http.StatusServiceUnavailable, map[string]interface{}{
				"error": "Server shutting down",
			})
			return
		}

		nethttpmw.SetSettlementOverrides(w, &x402.SettlementOverrides{Amount: "1000"})

		writeJSON(w, http.StatusOK, map[string]interface{}{
			"message":   "Upto Permit2 endpoint accessed successfully",
			"timestamp": time.Now().Format(time.RFC3339),
			"method":    "upto-permit2",
		})
	})

	// Batch-settlement endpoints. Mirror express's batch-settlement routes:
	// the harness drives deposit + voucher + recovery + refund inline via
	// BATCH_SETTLEMENT_PHASE; the server only needs to register the scheme
	// and respond once payment is verified.
	batchHandler := func(method string) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			if shutdownRequested {
				writeJSON(w, http.StatusServiceUnavailable, map[string]interface{}{"error": "Server shutting down"})
				return
			}
			writeJSON(w, http.StatusOK, map[string]interface{}{
				"message":   "Batch-settlement endpoint accessed successfully",
				"timestamp": time.Now().Format(time.RFC3339),
				"method":    method,
			})
		}
	}
	mux.HandleFunc("GET /batch-settlement/evm/eip3009", batchHandler("batch-settlement-eip3009"))
	mux.HandleFunc("GET /batch-settlement/evm/permit2", batchHandler("batch-settlement-permit2"))
	mux.HandleFunc("GET /batch-settlement/evm/permit2-eip2612GasSponsoring", batchHandler("batch-settlement-permit2-eip2612"))
	mux.HandleFunc("GET /batch-settlement/evm/permit2-erc20ApprovalGasSponsoring", batchHandler("batch-settlement-permit2-erc20-approval"))

	// Health check endpoint - no payment required
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"status":      "ok",
			"version":     "2.0.0",
			"evm_network": string(cfg.EVMNetwork),
			"evm_payee":   cfg.EVMPayeeAddress,
			"svm_network": string(cfg.SVMNetwork),
			"svm_payee":   cfg.SVMPayeeAddress,
		})
	})

	// Shutdown endpoint - used by e2e tests
	mux.HandleFunc("POST /close", func(w http.ResponseWriter, r *http.Request) {
		shutdownRequested = true

		writeJSON(w, http.StatusOK, map[string]interface{}{
			"message": "Server shutting down gracefully",
		})
		fmt.Println("Received shutdown request")

		// Schedule server shutdown after response
		go func() {
			time.Sleep(100 * time.Millisecond)
			os.Exit(0)
		}()
	})

	// Apply payment middleware with detailed error logging
	handler := nethttpmw.X402Payment(nethttpmw.Config{
		Routes:      routes,
		Facilitator: facilitatorClient,
		Schemes: []nethttpmw.SchemeConfig{
			{Network: cfg.EVMNetwork, Server: schemes.ExactEVM},
			{Network: cfg.EVMNetwork, Server: schemes.UptoEVM},
			{Network: cfg.EVMNetwork, Server: schemes.BatchSettlement},
			{Network: cfg.SVMNetwork, Server: schemes.ExactSVM},
		},
		SyncFacilitatorOnStart: true,
		Timeout:                30 * time.Second,
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			// Log detailed error information for debugging
			fmt.Printf("❌ [E2E SERVER ERROR] Payment error occurred\n")
			fmt.Printf("   Path: %s\n", r.URL.Path)
			fmt.Printf("   Method: %s\n", r.Method)
			fmt.Printf("   Error: %v\n", err)
			fmt.Printf("   Headers: %v\n", r.Header)

			// Default error response
			writeJSON(w, http.StatusPaymentRequired, map[string]interface{}{
				"error": err.Error(),
			})
		},
		SettlementHandler: func(w http.ResponseWriter, r *http.Request, settleResp *x402.SettleResponse) {
			// Log successful settlement
			fmt.Printf("✅ [E2E SERVER SUCCESS] Payment settled\n")
			fmt.Printf("   Path: %s\n", r.URL.Path)
			fmt.Printf("   Transaction: %s\n", settleResp.Transaction)
			fmt.Printf("   Network: %s\n", settleResp.Network)
			fmt.Printf("   Payer: %s\n", settleResp.Payer)
		},
	})(mux)

	// Set up graceful shutdown
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)

	go func() {
		<-quit
		fmt.Println("Received shutdown signal, exiting...")
		os.Exit(0)
	}()

	// Print startup banner
	fmt.Printf(`
╔════════════════════════════════════════════════════════╗
║           x402 net/http E2E Test Server                ║
╠════════════════════════════════════════════════════════╣
║  Server:     http://localhost:%-29s ║
║  EVM Network: %-40s ║
║  EVM Payee:   %-40s ║
║  SVM Network: %-40s ║
║  SVM Payee:   %-40s ║
║                                                        ║
║  Endpoints:                                            ║
║  • GET  /exact/evm/eip3009                    (EVM EIP-3009)  ║
║  • GET  /exact/evm/permit2                    (Permit2)       ║
║  • GET  /exact/evm/permit2-eip2612GasSponsoring               ║
║  • GET  /exact/evm/permit2-erc20ApprovalGasSponsoring         ║
║  • GET  /exact/svm                            (SVM)           ║
║  • GET  /health                 (no payment required)  ║
║  • POST /close                  (shutdown server)      ║
╚════════════════════════════════════════════════════════╝
`, cfg.Port, cfg.EVMNetwork, cfg.EVMPayeeAddress, cfg.SVMNetwork, cfg.SVMPayeeAddress)

	server := &http.Server{
		Addr:    ":" + cfg.Port,
		Handler: handler,
	}

	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		fmt.Printf("Error starting server: %v\n", err)
		os.Exit(1)
	}
}

// writeJSON is a helper to write JSON responses.
func writeJSON(w http.ResponseWriter, status int, data interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(data)
}
