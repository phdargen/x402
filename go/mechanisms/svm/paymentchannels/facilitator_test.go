package paymentchannels

import (
	"bytes"
	"crypto/sha256"
	"testing"

	solana "github.com/gagliardetto/solana-go"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestDistributionHashMatchesProgramPreimage(t *testing.T) {
	recipient := solana.MustPublicKeyFromBase58("11111111111111111111111111111112")

	hash, err := DistributionHash([]Split{{Recipient: recipient.String(), BPS: BasisPointsDenominator}})
	require.NoError(t, err)

	// sha256(u32le(1) || recipient || u16le(10000))
	preimage := append(u32LE(1), recipient.Bytes()...)
	preimage = append(preimage, u16LE(BasisPointsDenominator)...)
	assert.Equal(t, sha256.Sum256(preimage), hash)
}

// TestDistributionHashMatchesTheCrossLanguageGolden pins the same two-recipient
// vector the TypeScript SDK asserts, so a preimage that drifts from the program
// (or from the other SDK) fails here rather than onchain at distribute.
func TestDistributionHashMatchesTheCrossLanguageGolden(t *testing.T) {
	recipientOne := solana.PublicKeyFromBytes(bytes.Repeat([]byte{1}, 32))
	recipientTwo := solana.PublicKeyFromBytes(bytes.Repeat([]byte{2}, 32))

	hash, err := DistributionHash([]Split{
		{Recipient: recipientOne.String(), BPS: 7_500},
		{Recipient: recipientTwo.String(), BPS: 2_500},
	})
	require.NoError(t, err)

	assert.Equal(t, [32]byte{
		0x54, 0xc8, 0x97, 0x55, 0x87, 0x75, 0x0e, 0x88, 0x21, 0xe9, 0x3f, 0x5d, 0x4a, 0xf6, 0x07,
		0xd2, 0x0d, 0x55, 0xa5, 0x8b, 0xa1, 0xb9, 0xa4, 0xb4, 0x9f, 0x72, 0xa5, 0x42, 0xed, 0x87,
		0x4a, 0x3f,
	}, hash)
}
