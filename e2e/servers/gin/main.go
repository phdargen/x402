package main

import (
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	ginfw "github.com/gin-gonic/gin"
	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/e2e/servers/goshared"
	ginmw "github.com/x402-foundation/x402/go/v2/http/gin"
)

var shutdownRequested bool

// Gin E2E Test Server with x402 v2 Payment Middleware

func main() {
	cfg := goshared.LoadConfig()
	schemes := goshared.BuildSchemes(cfg)
	routes := goshared.BuildRoutes(cfg)
	facilitatorClient := goshared.NewFacilitatorClient(cfg)

	ginfw.SetMode(ginfw.ReleaseMode)
	r := ginfw.New()
	r.Use(ginfw.Recovery())

	r.Use(ginmw.X402Payment(ginmw.Config{
		Routes:      routes,
		Facilitator: facilitatorClient,
		Schemes: []ginmw.SchemeConfig{
			{Network: cfg.EVMNetwork, Server: schemes.ExactEVM},
			{Network: cfg.EVMNetwork, Server: schemes.UptoEVM},
			{Network: cfg.EVMNetwork, Server: schemes.BatchSettlement},
			{Network: cfg.SVMNetwork, Server: schemes.ExactSVM},
		},
		SyncFacilitatorOnStart: true,
		Timeout:                30 * time.Second,
		ErrorHandler: func(c *ginfw.Context, err error) {
			fmt.Printf("❌ [E2E SERVER ERROR] Payment error occurred\n")
			fmt.Printf("   Path: %s\n", c.Request.URL.Path)
			fmt.Printf("   Method: %s\n", c.Request.Method)
			fmt.Printf("   Error: %v\n", err)
			fmt.Printf("   Headers: %v\n", c.Request.Header)
			c.JSON(http.StatusPaymentRequired, ginfw.H{"error": err.Error()})
		},
		SettlementHandler: func(c *ginfw.Context, settleResp *x402.SettleResponse) {
			fmt.Printf("✅ [E2E SERVER SUCCESS] Payment settled\n")
			fmt.Printf("   Path: %s\n", c.Request.URL.Path)
			fmt.Printf("   Transaction: %s\n", settleResp.Transaction)
			fmt.Printf("   Network: %s\n", settleResp.Network)
			fmt.Printf("   Payer: %s\n", settleResp.Payer)
		},
	}))

	// Protected endpoint - requires payment to access
	//
	// This endpoint demonstrates a resource protected by x402 payment middleware.
	// Clients must provide a valid payment signature to access this endpoint.
	r.GET("/exact/evm/eip3009", func(c *ginfw.Context) {
		if shutdownRequested {
			c.JSON(http.StatusServiceUnavailable, ginfw.H{
				"error": "Server shutting down",
			})
			return
		}

		c.JSON(http.StatusOK, ginfw.H{
			"message":   "Protected endpoint accessed successfully (EVM)",
			"timestamp": time.Now().Format(time.RFC3339),
			"network":   "eip155:84532",
		})
	})

	// Protected SVM endpoint - requires payment to access
	//
	// This endpoint demonstrates a Solana payment protected resource.
	// Clients must provide a valid payment signature to access this endpoint.
	r.GET("/exact/svm", func(c *ginfw.Context) {
		if shutdownRequested {
			c.JSON(http.StatusServiceUnavailable, ginfw.H{
				"error": "Server shutting down",
			})
			return
		}

		c.JSON(http.StatusOK, ginfw.H{
			"message":   "Protected endpoint accessed successfully (SVM)",
			"timestamp": time.Now().Format(time.RFC3339),
			"network":   "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
		})
	})

	// Protected Permit2 direct endpoint - standard settle (no gas sponsoring)
	r.GET("/exact/evm/permit2", func(c *ginfw.Context) {
		if shutdownRequested {
			c.JSON(http.StatusServiceUnavailable, ginfw.H{
				"error": "Server shutting down",
			})
			return
		}

		c.JSON(http.StatusOK, ginfw.H{
			"message":   "Permit2 endpoint accessed successfully",
			"timestamp": time.Now().Format(time.RFC3339),
			"method":    "permit2",
		})
	})

	// Protected Permit2 EIP-2612 endpoint - requires payment via Permit2 with gas sponsoring.
	// Uses EIP-2612 permit atomically in settleWithPermit. No pre-approval needed.
	r.GET("/exact/evm/permit2-eip2612GasSponsoring", func(c *ginfw.Context) {
		if shutdownRequested {
			c.JSON(http.StatusServiceUnavailable, ginfw.H{
				"error": "Server shutting down",
			})
			return
		}

		c.JSON(http.StatusOK, ginfw.H{
			"message":   "Permit2 EIP-2612 endpoint accessed successfully",
			"timestamp": time.Now().Format(time.RFC3339),
			"method":    "permit2-eip2612",
		})
	})

	// Protected Permit2 ERC-20 approval endpoint - requires payment via Permit2 flow
	// using a generic ERC-20 token that does NOT support EIP-2612.
	// The facilitator sponsors the approve(Permit2, MaxUint256) transaction.
	r.GET("/exact/evm/permit2-erc20ApprovalGasSponsoring", func(c *ginfw.Context) {
		if shutdownRequested {
			c.JSON(http.StatusServiceUnavailable, ginfw.H{
				"error": "Server shutting down",
			})
			return
		}

		c.JSON(http.StatusOK, ginfw.H{
			"message":   "Permit2 ERC-20 approval endpoint accessed successfully",
			"timestamp": time.Now().Format(time.RFC3339),
			"method":    "permit2-erc20-approval",
		})
	})

	// Batch-settlement endpoints. Mirror nethttp's `batchHandler`: the harness
	// drives deposit + voucher + recovery + refund inline via BATCH_SETTLEMENT_PHASE;
	// the server just acknowledges once payment is verified.
	batchHandler := func(method string) ginfw.HandlerFunc {
		return func(c *ginfw.Context) {
			if shutdownRequested {
				c.JSON(http.StatusServiceUnavailable, ginfw.H{"error": "Server shutting down"})
				return
			}
			c.JSON(http.StatusOK, ginfw.H{
				"message":   "Batch-settlement endpoint accessed successfully",
				"timestamp": time.Now().Format(time.RFC3339),
				"method":    method,
			})
		}
	}
	r.GET("/batch-settlement/evm/eip3009", batchHandler("batch-settlement-eip3009"))
	r.GET("/batch-settlement/evm/permit2", batchHandler("batch-settlement-permit2"))
	r.GET("/batch-settlement/evm/permit2-eip2612GasSponsoring", batchHandler("batch-settlement-permit2-eip2612"))
	r.GET("/batch-settlement/evm/permit2-erc20ApprovalGasSponsoring", batchHandler("batch-settlement-permit2-erc20-approval"))

	// Upto Permit2 endpoint - settles with partial amount
	r.GET("/upto/evm/permit2", func(c *ginfw.Context) {
		if shutdownRequested {
			c.JSON(http.StatusServiceUnavailable, ginfw.H{
				"error": "Server shutting down",
			})
			return
		}

		// Settle with partial amount (for e2e tests)
		ginmw.SetSettlementOverrides(c, &x402.SettlementOverrides{
			Amount: "1000",
		})

		c.JSON(http.StatusOK, ginfw.H{
			"message":   "Upto Permit2 endpoint accessed successfully",
			"timestamp": time.Now().Format(time.RFC3339),
			"method":    "upto-permit2",
		})
	})

	// Health check endpoint - no payment required
	//
	// Used to verify the server is running and responsive.
	r.GET("/health", func(c *ginfw.Context) {
		c.JSON(http.StatusOK, ginfw.H{
			"status":      "ok",
			"version":     "2.0.0",
			"evm_network": string(cfg.EVMNetwork),
			"evm_payee":   cfg.EVMPayeeAddress,
			"svm_network": string(cfg.SVMNetwork),
			"svm_payee":   cfg.SVMPayeeAddress,
		})
	})

	// Shutdown endpoint - used by e2e tests
	//
	// Allows graceful shutdown of the server during testing.
	r.POST("/close", func(c *ginfw.Context) {
		shutdownRequested = true

		c.JSON(http.StatusOK, ginfw.H{
			"message": "Server shutting down gracefully",
		})
		fmt.Println("Received shutdown request")

		// Schedule server shutdown after response
		go func() {
			time.Sleep(100 * time.Millisecond)
			os.Exit(0)
		}()
	})

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
║           x402 Gin E2E Test Server                     ║
╠════════════════════════════════════════════════════════╣
║  Server:     http://localhost:%-29s ║
║  EVM Network: %-40s ║
║  EVM Payee:   %-40s ║
║  SVM Network: %-40s ║
║  SVM Payee:   %-40s ║
║                                                        ║
║  Endpoints:                                            ║
║  • GET  /exact/evm/eip3009                    (EVM EIP-3009)  ║
║  • GET  /batch-settlement/evm/eip3009         (Batch-settlement) ║
║  • GET  /batch-settlement/evm/permit2         (Batch Permit2) ║
║  • GET  /batch-settlement/evm/permit2-eip2612GasSponsoring    ║
║  • GET  /batch-settlement/evm/permit2-erc20ApprovalGasSponsoring ║
║  • GET  /exact/evm/permit2                    (Permit2)       ║
║  • GET  /exact/evm/permit2-eip2612GasSponsoring               ║
║  • GET  /exact/evm/permit2-erc20ApprovalGasSponsoring         ║
║  • GET  /upto/evm/permit2                     (Upto Permit2)  ║
║  • GET  /exact/svm                            (SVM)           ║
║  • GET  /health                 (no payment required)  ║
║  • POST /close                  (shutdown server)      ║
╚════════════════════════════════════════════════════════╝
`, cfg.Port, cfg.EVMNetwork, cfg.EVMPayeeAddress, cfg.SVMNetwork, cfg.SVMPayeeAddress)

	server := &http.Server{
		Addr:    ":" + cfg.Port,
		Handler: r,
	}

	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		fmt.Printf("Error starting server: %v\n", err)
		os.Exit(1)
	}
}
