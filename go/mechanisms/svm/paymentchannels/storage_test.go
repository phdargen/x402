package paymentchannels

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestInMemoryStorageKeepsForwardOnlyExpiryAndActivity(t *testing.T) {
	storage := NewInMemoryPaymentChannelStorage()
	ctx := context.Background()
	network := "solana:devnet"
	first := PaymentChannelRecord{
		ChannelID:      "chan-a",
		ExpiresAt:      50,
		LastActivityAt: time.Unix(10, 0),
		Network:        network,
		PayTo:          "pay",
		TokenProgram:   "token",
	}
	_, err := storage.RecordOpen(ctx, first)
	require.NoError(t, err)
	_, err = storage.RecordOpen(ctx, PaymentChannelRecord{
		ChannelID:      "chan-a",
		ExpiresAt:      40,
		LastActivityAt: time.Unix(30, 0),
		Network:        network,
	})
	require.NoError(t, err)
	require.NoError(t, storage.RecordActivity(ctx, PaymentChannelRecord{
		ChannelID:      "chan-a",
		LastActivityAt: time.Unix(15, 0),
		Network:        network,
	}))

	got, err := storage.Get(ctx, network, "chan-a")
	require.NoError(t, err)
	require.NotNil(t, got)
	require.Equal(t, int64(50), got.ExpiresAt)
	require.True(t, got.LastActivityAt.Equal(time.Unix(30, 0)))
}

func TestInMemoryStorageRevertOpen(t *testing.T) {
	storage := NewInMemoryPaymentChannelStorage()
	ctx := context.Background()
	network := "solana:devnet"
	write, err := storage.RecordOpen(ctx, PaymentChannelRecord{
		ChannelID:      "chan-b",
		Network:        network,
		LastActivityAt: time.Unix(1, 0),
	})
	require.NoError(t, err)
	require.NotEmpty(t, write.RevertToken)

	require.NoError(t, storage.RevertOpen(ctx, write))
	got, err := storage.Get(ctx, network, "chan-b")
	require.NoError(t, err)
	require.Nil(t, got)
}
