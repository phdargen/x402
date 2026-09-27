package paymentchannels

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestInMemoryStorageKeepsFirstSightingAndLatestActivity(t *testing.T) {
	storage := NewInMemoryPaymentChannelStorage()
	ctx := context.Background()
	first := PaymentChannelRecord{
		ChannelID:      "chan-a",
		ExpiresAt:      50,
		FirstSeenAt:    time.Unix(10, 0),
		LastActivityAt: time.Unix(10, 0),
		Network:        "solana:devnet",
		PayTo:          "pay",
		TokenProgram:   "token",
	}
	require.NoError(t, storage.Upsert(ctx, first))
	require.NoError(t, storage.Upsert(ctx, PaymentChannelRecord{
		ChannelID:      "chan-a",
		ExpiresAt:      40,
		FirstSeenAt:    time.Unix(20, 0),
		LastActivityAt: time.Unix(30, 0),
	}))
	require.NoError(t, storage.Upsert(ctx, PaymentChannelRecord{
		ChannelID:      "chan-a",
		FirstSeenAt:    time.Unix(25, 0),
		LastActivityAt: time.Unix(15, 0),
	}))

	got, err := storage.Get(ctx, "chan-a")
	require.NoError(t, err)
	require.NotNil(t, got)
	require.Equal(t, int64(50), got.ExpiresAt)
	require.True(t, got.FirstSeenAt.Equal(time.Unix(10, 0)))
	require.True(t, got.LastActivityAt.Equal(time.Unix(30, 0)))
}
