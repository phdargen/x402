package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/joho/godotenv"
	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/extensions/buildercode"
	batchsettlement "github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement"
	batchedfac "github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement/facilitator"
	channelstorage "github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement/storage"
)

const defaultPort = "4022"

func main() {
	_ = godotenv.Load()

	port := envOr("PORT", defaultPort)
	voucherStoreEnabled := envFlag("VOUCHER_STORE")
	voucherStoreDir := strings.TrimSpace(os.Getenv("VOUCHER_STORE_DIR"))
	voucherStoreWithdrawDelay := 900
	if v := strings.TrimSpace(os.Getenv("VOUCHER_STORE_WITHDRAW_DELAY_SECONDS")); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			voucherStoreWithdrawDelay = n
		}
	}

	evmPrivateKey := os.Getenv("EVM_PRIVATE_KEY")
	if evmPrivateKey == "" {
		fmt.Println("EVM_PRIVATE_KEY environment variable is required")
		os.Exit(1)
	}

	rpcURL := envOr("EVM_RPC_URL", "https://sepolia.base.org")

	evmSigner, err := newFacilitatorEvmSigner(evmPrivateKey, rpcURL)
	if err != nil {
		fmt.Printf("Failed to create EVM signer: %v\n", err)
		os.Exit(1)
	}

	authKey := strings.TrimSpace(os.Getenv("EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY"))
	var authorizer batchsettlement.AuthorizerSigner
	if authKey != "" {
		authorizer, err = newAuthorizerSigner(authKey)
		if err != nil {
			fmt.Printf("Failed to create authorizer signer: %v\n", err)
			os.Exit(1)
		}
	}

	if voucherStoreEnabled && authorizer == nil {
		fmt.Println("VOUCHER_STORE requires EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY (facilitator-managed custody)")
		os.Exit(1)
	}

	fmt.Printf("EVM Facilitator account: %s\n", evmSigner.GetAddresses()[0])
	if authorizer != nil {
		fmt.Printf("EVM Receiver Authorizer: %s\n", authorizer.Address())
	} else {
		fmt.Println("EVM Receiver Authorizer: not configured")
	}
	if voucherStoreEnabled {
		backend := "in-memory"
		if voucherStoreDir != "" {
			backend = fmt.Sprintf("file (%s)", voucherStoreDir)
		}
		fmt.Printf(
			"Facilitator voucher store: enabled (%s, withdrawDelay %ds)\n",
			backend,
			voucherStoreWithdrawDelay,
		)
	} else {
		fmt.Println("Facilitator voucher store: disabled (self-managed server custody)")
	}

	facilitator := x402.Newx402Facilitator()

	var fctx *x402.FacilitatorContext
	if builderCode := strings.TrimSpace(os.Getenv("FACILITATOR_BUILDER_CODE")); builderCode != "" {
		ext := &buildercode.BuilderCodeFacilitatorExtension{BuilderCode: builderCode}
		facilitator.RegisterExtension(ext)
		fctx = x402.NewFacilitatorContext(map[string]x402.FacilitatorExtension{
			ext.Key(): ext,
		})
		fmt.Printf("Facilitator builder code: %s\n", builderCode)
	}

	var batchScheme *batchedfac.BatchSettlementEvmScheme
	if voucherStoreEnabled {
		var store channelstorage.ChannelStorage[*batchedfac.FacilitatorChannel]
		if voucherStoreDir != "" {
			store = batchedfac.NewFileChannelStorage(batchsettlement.FileChannelStorageOptions{
				Directory: voucherStoreDir,
			})
		} else {
			store = channelstorage.NewInMemoryChannelStorage[*batchedfac.FacilitatorChannel]()
		}
		batchScheme, err = batchedfac.NewBatchSettlementEvmSchemeWithConfig(evmSigner, authorizer, &batchedfac.BatchSettlementEvmSchemeConfig{
			VoucherStore: &batchedfac.VoucherStoreConfig{
				Storage:             store,
				WithdrawDelay:       voucherStoreWithdrawDelay,
				SettleTargetStorage: channelstorage.NewInMemorySettleTargetStorage(),
			},
		})
		if err != nil {
			fmt.Printf("Failed to create batch-settlement scheme: %v\n", err)
			os.Exit(1)
		}
	} else {
		batchScheme = batchedfac.NewBatchSettlementEvmScheme(evmSigner, authorizer)
	}

	facilitator.Register(
		[]x402.Network{"eip155:84532"},
		batchScheme,
	)

	var channelManager *batchedfac.FacilitatorChannelManager
	if voucherStoreEnabled {
		channelManager, err = batchScheme.CreateChannelManager(fctx)
		if err != nil {
			fmt.Printf("Failed to create voucher-store channel manager: %v\n", err)
			os.Exit(1)
		}
		claimSecs, settleSecs, refundSecs, refundIdle := 60, 120, 180, 180
		channelManager.Start(batchedfac.FacilitatorAutoConfig{
			ClaimIntervalSecs:  &claimSecs,
			SettleIntervalSecs: &settleSecs,
			RefundIntervalSecs: &refundSecs,
			RefundIdleSecs:     &refundIdle,
			MaxClaimsPerBatch:  100,
			OnClaim: func(r batchedfac.FacilitatorClaimResult) {
				fmt.Printf("[voucher store] Claimed %d vouchers (tx: %s)\n", r.Vouchers, r.Transaction)
				go func() {
					ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
					defer cancel()
					logClaimAttestation(ctx, r, evmSigner)
				}()
			},
			OnSettle: func(r batchedfac.FacilitatorSettleResult) {
				fmt.Printf("[voucher store] Settled %s (tx: %s)\n", r.Receiver, r.Transaction)
			},
			OnRefund: func(r batchedfac.FacilitatorRefundResult) {
				fmt.Printf("[voucher store] Refunded channel %s (tx: %s)\n", r.Channel, r.Transaction)
				go func() {
					ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
					defer cancel()
					logRefundSettlementAttestation(ctx, r, evmSigner)
				}()
			},
			OnError: func(e error) {
				fmt.Printf("[voucher store] Settlement error: %v\n", e)
			},
		})
	}

	facilitator.OnAfterVerify(func(ctx x402.FacilitatorVerifyResultContext) error {
		fmt.Printf("Payment verified\n")
		return nil
	})
	facilitator.OnAfterSettle(func(ctx x402.FacilitatorSettleResultContext) error {
		fmt.Printf("Payment settled: %s\n", ctx.Result.Transaction)
		return nil
	})

	mux := http.NewServeMux()

	mux.HandleFunc("GET /supported", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, facilitator.GetSupported())
	})

	mux.HandleFunc("POST /verify", func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
		defer cancel()

		payload, requirements, err := readVerifyBody(r)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		result, err := facilitator.Verify(ctx, payload, requirements)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, result)
	})

	mux.HandleFunc("POST /settle", func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
		defer cancel()

		payload, requirements, err := readVerifyBody(r)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		result, err := facilitator.Settle(ctx, payload, requirements)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, result)
	})

	server := &http.Server{Addr: ":" + port, Handler: mux}
	go func() {
		fmt.Printf("Facilitator listening on http://localhost:%s\n", port)
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			fmt.Printf("Server error: %v\n", err)
			os.Exit(1)
		}
	}()

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	<-sigCh

	if channelManager != nil {
		fmt.Println("Shutting down — flushing voucher-store claims…")
		ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		defer cancel()
		if err := channelManager.Stop(ctx, true); err != nil {
			fmt.Printf("Channel manager stop: %v\n", err)
		}
	}
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = server.Shutdown(shutdownCtx)
}

func envFlag(name string) bool {
	raw := strings.TrimSpace(strings.ToLower(os.Getenv(name)))
	return raw == "1" || raw == "true" || raw == "yes"
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func readVerifyBody(r *http.Request) (json.RawMessage, json.RawMessage, error) {
	var body struct {
		PaymentPayload      json.RawMessage `json:"paymentPayload"`
		PaymentRequirements json.RawMessage `json:"paymentRequirements"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		return nil, nil, fmt.Errorf("invalid JSON body: %w", err)
	}
	if len(body.PaymentPayload) == 0 || len(body.PaymentRequirements) == 0 {
		return nil, nil, fmt.Errorf("missing paymentPayload or paymentRequirements")
	}
	return body.PaymentPayload, body.PaymentRequirements, nil
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
