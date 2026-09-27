package facilitator

import "github.com/x402-foundation/x402/go/v2/mechanisms/svm/paymentchannels"

// UptoFacilitatorSigner is the payment-channel facilitator signer `upto` requires.
type UptoFacilitatorSigner = paymentchannels.PaymentChannelFacilitatorSigner

// SettlementSimulationError is returned when explicit settlement simulation
// fails. The transaction is never broadcast.
type SettlementSimulationError = paymentchannels.ChannelSimulationError

const (
	// DefaultChannelReadMaxAttempts is how many times a confirmed open is
	// re-read before the facilitator treats it as missing.
	DefaultChannelReadMaxAttempts = paymentchannels.DefaultChannelReadMaxAttempts
	// DefaultChannelReadBackoffStep is the linear delay added per attempt.
	DefaultChannelReadBackoffStep = paymentchannels.DefaultChannelReadBackoffStep

	// DefaultSettleComputeUnitLimit is the default SetComputeUnitLimit for
	// facilitator-submitted settlement transactions.
	DefaultSettleComputeUnitLimit = paymentchannels.DefaultSettleComputeUnitLimit

	// ReclaimComputeUnitBase is the base SetComputeUnitLimit for a reclaim batch.
	ReclaimComputeUnitBase = paymentchannels.ReclaimComputeUnitBase
	// ReclaimComputeUnitPerChannel is the additional compute units budgeted per
	// reclaim instruction.
	ReclaimComputeUnitPerChannel = paymentchannels.ReclaimComputeUnitPerChannel
)

// ReclaimComputeUnitLimit returns the SetComputeUnitLimit for a reclaim batch
// of channelCount channels, clamped to the per-transaction maximum.
func ReclaimComputeUnitLimit(channelCount int) uint32 {
	return paymentchannels.ReclaimComputeUnitLimit(channelCount)
}
