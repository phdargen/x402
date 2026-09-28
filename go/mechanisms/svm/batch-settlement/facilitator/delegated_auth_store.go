package facilitator

import (
	"context"
	"errors"
	"fmt"
	"sync"
)

// DelegatedSettleStep is the settle phase passed to ResolveCallerIdentity.
type DelegatedSettleStep string

const (
	DelegatedStepDeposit DelegatedSettleStep = "deposit"
	DelegatedStepSeal    DelegatedSettleStep = "seal"
	DelegatedStepRefund  DelegatedSettleStep = "refund"
)

// DelegatedSettleContext is passed to DelegatedReceiverAuth.ResolveCallerIdentity.
type DelegatedSettleContext struct {
	Step               DelegatedSettleStep
	ChannelID          string
	Network            string
	Payer              string
	FacilitatorContext any
}

// DelegatedReceiverAuth opts the facilitator into signing closes for a caller identity.
// The identity is not onchain. A lost row fails closed.
type DelegatedReceiverAuth struct {
	ReceiverAuthorizer    string
	IdentityStore         any
	ResolveCallerIdentity func(context.Context, DelegatedSettleContext) (string, error)
}

// DelegatedAuthBinding is the caller identity bound to a delegated channel at open.
type DelegatedAuthBinding struct {
	Network        string
	ChannelID      string
	CallerIdentity string
}

// ErrDelegatedAuthIdentityConflict is returned by Bind when a different identity already owns the channel.
var ErrDelegatedAuthIdentityConflict = errors.New("delegated auth binding already exists for a different identity")

// DelegatedAuthStore records delegated open/close caller-identity bindings.
// Bind is keyed by (network, channelID) and is first-writer-wins.
type DelegatedAuthStore interface {
	Bind(ctx context.Context, binding DelegatedAuthBinding) error
	Get(ctx context.Context, network, channelID string) (*DelegatedAuthBinding, error)
	Delete(ctx context.Context, network, channelID string) error
}

// InMemoryDelegatedAuthStore is a process-local DelegatedAuthStore.
// A multi-replica facilitator must inject a shared implementation.
type InMemoryDelegatedAuthStore struct {
	mu       sync.Mutex
	bindings map[string]DelegatedAuthBinding
}

// NewInMemoryDelegatedAuthStore creates an empty in-memory identity store.
func NewInMemoryDelegatedAuthStore() *InMemoryDelegatedAuthStore {
	return &InMemoryDelegatedAuthStore{bindings: make(map[string]DelegatedAuthBinding)}
}

func delegatedBindingKey(network, channelID string) string {
	return network + ":" + channelID
}

// Bind records the caller identity for a channel. First writer wins.
func (s *InMemoryDelegatedAuthStore) Bind(_ context.Context, binding DelegatedAuthBinding) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	key := delegatedBindingKey(binding.Network, binding.ChannelID)
	existing, ok := s.bindings[key]
	if ok {
		if existing.CallerIdentity == binding.CallerIdentity {
			return nil
		}
		return fmt.Errorf("%w", ErrDelegatedAuthIdentityConflict)
	}
	s.bindings[key] = binding
	return nil
}

// Get looks up a binding. A missing row returns (nil, nil).
func (s *InMemoryDelegatedAuthStore) Get(_ context.Context, network, channelID string) (*DelegatedAuthBinding, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	binding, ok := s.bindings[delegatedBindingKey(network, channelID)]
	if !ok {
		return nil, nil
	}
	copied := binding
	return &copied, nil
}

// Delete removes a binding.
func (s *InMemoryDelegatedAuthStore) Delete(_ context.Context, network, channelID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.bindings, delegatedBindingKey(network, channelID))
	return nil
}
