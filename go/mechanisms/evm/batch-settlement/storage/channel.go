package storage

import (
	batchsettlement "github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement"
)

// Channel is the durable per-channel record shared by server and facilitator stores.
type Channel struct {
	ChannelId               string                        `json:"channelId"`
	ChannelConfig           batchsettlement.ChannelConfig `json:"channelConfig"`
	ChargedCumulativeAmount string                        `json:"chargedCumulativeAmount"`
	SignedMaxClaimable      string                        `json:"signedMaxClaimable"`
	Signature               string                        `json:"signature"`
	Balance                 string                        `json:"balance"`
	TotalClaimed            string                        `json:"totalClaimed"`
	WithdrawRequestedAt     int                           `json:"withdrawRequestedAt"`
	RefundNonce             int                           `json:"refundNonce"`
	LastRequestTimestamp    int64                         `json:"lastRequestTimestamp"`
	// OnchainSyncedAt is the wall-clock time (unix millis) when balance/totalClaimed/
	// withdrawRequestedAt/refundNonce were last refreshed from onchain state.
	OnchainSyncedAt int64 `json:"onchainSyncedAt,omitempty"`
}

// Base returns the channel itself so generic stores can read shared fields.
func (c *Channel) Base() *Channel { return c }

// Clone returns a shallow copy. A nil receiver yields nil so missing rows stay missing.
func (c *Channel) Clone() *Channel {
	if c == nil {
		return nil
	}
	cp := *c
	return &cp
}

// ChannelRecord is the constraint used by ChannelStorage: a record that exposes
// the shared Channel fields and can clone itself as T.
type ChannelRecord[T any] interface {
	Base() *Channel
	Clone() T
}

// ChannelUpdateStatus describes the outcome of an UpdateChannel call.
type ChannelUpdateStatus string

const (
	ChannelUpdated   ChannelUpdateStatus = "updated"
	ChannelUnchanged ChannelUpdateStatus = "unchanged"
	ChannelDeleted   ChannelUpdateStatus = "deleted"
	ChannelConflict  ChannelUpdateStatus = "conflict"
)

// ChannelUpdateResult is the result of an UpdateChannel call.
type ChannelUpdateResult[T ChannelRecord[T]] struct {
	Channel T
	Status  ChannelUpdateStatus
}

// ChannelStorage persists channel records of type T. Get returns the zero T
// (nil for pointer records) when the row is missing.
type ChannelStorage[T ChannelRecord[T]] interface {
	Get(channelId string) (T, error)
	Set(channelId string, session T) error
	Delete(channelId string) error
	List() ([]T, error)
	// CompareAndSet atomically updates a record only if the current
	// chargedCumulativeAmount matches expectedCharged.
	//
	// Deprecated: prefer UpdateChannel for richer atomic mutations.
	CompareAndSet(channelId string, expectedCharged string, session T) (bool, error)
	UpdateChannel(channelId string, update func(current T) T) (*ChannelUpdateResult[T], error)
}
