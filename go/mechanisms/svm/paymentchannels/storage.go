package paymentchannels

import (
	"context"
	"sync"
	"time"
)

// PaymentChannelRecord holds the stored payment-channel facts used by
// facilitator rent cleanup.
//
// Only stores what the channel account refetch does not provide: PayTo
// (distribution preimage), TokenProgram, abandon-policy FirstSeenAt and
// LastActivityAt, voucher ExpiresAt, and Network. Payer, payee, mint,
// openSlot, and status are read live before acting.
type PaymentChannelRecord struct {
	ChannelID string
	// PayTo is the distribution recipient sealed at open (requirements.payTo).
	PayTo        string
	TokenProgram string
	// FirstSeenAt is when the facilitator first stored this channel.
	FirstSeenAt time.Time
	// ExpiresAt is the client voucher expiry (Unix seconds). It never shrinks
	// on a later upsert.
	ExpiresAt int64
	// LastActivityAt is the last facilitator-visible lifecycle activity on the
	// channel: an open, top-up, claim, or distribution the facilitator
	// processed. It drives the idle abandon-close of non-expiring
	// (ExpiresAt == 0) channels. It never moves backwards.
	LastActivityAt time.Time
	Network        string
}

// PaymentChannelStorage is pluggable storage of channels the facilitator sponsors rent for.
type PaymentChannelStorage interface {
	Get(ctx context.Context, channelID string) (*PaymentChannelRecord, error)
	// List returns every stored record, in any order. The rent cleanup manager
	// sorts by channel id before scanning, so implementations do not have to.
	List(ctx context.Context) ([]PaymentChannelRecord, error)
	Upsert(ctx context.Context, record PaymentChannelRecord) error
	Delete(ctx context.Context, channelID string) error
}

// InMemoryPaymentChannelStorage is an in-memory PaymentChannelStorage. It
// preserves FirstSeenAt and the maximum ExpiresAt and LastActivityAt across
// upserts of the same channel.
type InMemoryPaymentChannelStorage struct {
	mu       sync.RWMutex
	channels map[string]PaymentChannelRecord
}

// NewInMemoryPaymentChannelStorage creates an empty in-memory channel store.
func NewInMemoryPaymentChannelStorage() *InMemoryPaymentChannelStorage {
	return &InMemoryPaymentChannelStorage{channels: make(map[string]PaymentChannelRecord)}
}

// Get returns a stored channel, or nil when the channel is not tracked.
func (s *InMemoryPaymentChannelStorage) Get(_ context.Context, channelID string) (*PaymentChannelRecord, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	record, ok := s.channels[channelID]
	if !ok {
		return nil, nil
	}
	return &record, nil
}

// List returns every stored channel record.
func (s *InMemoryPaymentChannelStorage) List(context.Context) ([]PaymentChannelRecord, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	records := make([]PaymentChannelRecord, 0, len(s.channels))
	for _, record := range s.channels {
		records = append(records, record)
	}
	return records, nil
}

// Upsert inserts or replaces a record, keeping the earlier FirstSeenAt and the
// later ExpiresAt and LastActivityAt when the channel was already stored.
func (s *InMemoryPaymentChannelStorage) Upsert(_ context.Context, record PaymentChannelRecord) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if existing, ok := s.channels[record.ChannelID]; ok {
		record.FirstSeenAt = existing.FirstSeenAt
		if existing.ExpiresAt > record.ExpiresAt {
			record.ExpiresAt = existing.ExpiresAt
		}
		if existing.LastActivityAt.After(record.LastActivityAt) {
			record.LastActivityAt = existing.LastActivityAt
		}
	}
	s.channels[record.ChannelID] = record
	return nil
}

// Delete removes a channel from storage.
func (s *InMemoryPaymentChannelStorage) Delete(_ context.Context, channelID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.channels, channelID)
	return nil
}
