package main

import (
	"context"

	"github.com/x402-foundation/x402/e2e/clients/goshared"
)

func main() {
	client := goshared.CreateClient()
	if client == nil {
		return
	}
	goshared.RunScenario(context.Background(), client)
}
