package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/joho/godotenv"
	x402 "github.com/x402-foundation/x402/go"
	"github.com/x402-foundation/x402/go/extensions/buildercode"
	evm "github.com/x402-foundation/x402/go/mechanisms/evm/exact/facilitator"
)

const (
	DefaultPort = "4022"
)

func main(){
	_ = godotenv.Load()

	privKey := os.Getenv("EVM_PRIVATE_KEY_FAC")
	builderW := os.Getenv("BUILDER_CODE_W")

	if privKey == "" || builderW == "" {
		fmt.Println("EVM_PRIVATE_KEY_FAC and BUILDER_CODE_W are required")
		os.Exit(1)
}

	signer, err := newFacilitatorEvmSigner(privKey, DefaultEvmRPC)
	if err != nil {
		fmt.Printf("signer intit failed: %v\n", err)
		os.Exit(1)
	}

	facilitator := x402.Newx402Facilitator()

	evmNet := x402.Network("eip155:84532")
	facilitator.Register(
		[]x402.Network{evmNet},
		evm.NewExactEvmScheme(signer, &evm.ExactEvmSchemeConfig{
			DeployERC4337WithEIP6492: true,
		}),
	)

	bcExt, err := buildercode.NewFacilitatorExtension(buildercode.FacilitatorConfig{
		BuilderCode: builderW,
	})

	if err != nil {
		fmt.Printf("invalid BUILDER_CODE_W:: %v\n", err)
	}
	facilitator.RegisterExtension(bcExt)
	fmt.Printf("builder-code attribution: w=%s\n", builderW)

	facilitator.OnAfterSettle(func(ctx x402.FacilitatorSettleResultContext) error{
		fmt.Printf("settled tx=%s (w=%s in suffix)\n", ctx.Result.Transaction, builderW)
		return nil
	})


	gin.SetMode(gin.ReleaseMode)
	r := gin.New()
	r.Use(gin.Recovery())

	r.GET("/supported", func(c *gin.Context) {
					c.JSON(http.StatusOK, facilitator.GetSupported())
	})

	r.POST("/verify", func(c *gin.Context) {
					ctx, cancel := context.WithTimeout(c.Request.Context(), 30*time.Second)
					defer cancel()
					var body struct {
									PaymentPayload      json.RawMessage `json:"paymentPayload"`
									PaymentRequirements json.RawMessage `json:"paymentRequirements"`
					}
					if err := c.BindJSON(&body); err != nil {
									c.JSON(400, gin.H{"error": err.Error()})
									return
					}
					res, err := facilitator.Verify(ctx, body.PaymentPayload, body.PaymentRequirements)
					if err != nil {
									c.JSON(500, gin.H{"error": err.Error()})
									return
					}
					c.JSON(200, res)
	})

	r.POST("/settle", func(c *gin.Context) {
					ctx, cancel := context.WithTimeout(c.Request.Context(), 60*time.Second)
					defer cancel()
					var body struct {
									PaymentPayload      json.RawMessage `json:"paymentPayload"`
									PaymentRequirements json.RawMessage `json:"paymentRequirements"`
					}
					if err := c.BindJSON(&body); err != nil {
									c.JSON(400, gin.H{"error": err.Error()})
									return
					}
					res, err := facilitator.Settle(ctx, body.PaymentPayload, body.PaymentRequirements)
					if err != nil {
									c.JSON(500, gin.H{"error": err.Error()})
									return
					}
					c.JSON(200, res)
	})

	fmt.Printf("🚀 facilitator on :%s\n", DefaultPort)
	_ = r.Run(":" + DefaultPort)

}