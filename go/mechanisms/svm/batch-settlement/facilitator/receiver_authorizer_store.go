package facilitator

import (
	"context"
	"errors"
	"fmt"
	"sync"

	batchsettlement "github.com/x402-foundation/x402/go/v2/mechanisms/svm/batch-settlement"
)

// ReceiverAuthorizerBinding is the receiver authorizer a channel was opened for.
type ReceiverAuthorizerBinding struct {
	Network            string
	ChannelID          string
	ReceiverAuthorizer string
}

// ErrReceiverAuthorizerConflict is returned by Bind when a different key already owns the channel.
var ErrReceiverAuthorizerConflict = errors.New("receiver authorizer binding already exists for a different key")

// ReceiverAuthorizerStore records channel receiver-authorizer bindings.
// Bind is keyed by (network, channelID) and is first-writer-wins.
type ReceiverAuthorizerStore interface {
	Bind(ctx context.Context, binding ReceiverAuthorizerBinding) error
	Get(ctx context.Context, network, channelID string) (*ReceiverAuthorizerBinding, error)
	Delete(ctx context.Context, network, channelID string) error
}

// InMemoryReceiverAuthorizerStore is an in-memory ReceiverAuthorizerStore.
// A multi-replica facilitator should inject a shared implementation.
type InMemoryReceiverAuthorizerStore struct {
	mu       sync.Mutex
	bindings map[string]ReceiverAuthorizerBinding
}

// NewInMemoryReceiverAuthorizerStore creates an empty in-memory binding store.
func NewInMemoryReceiverAuthorizerStore() *InMemoryReceiverAuthorizerStore {
	return &InMemoryReceiverAuthorizerStore{bindings: make(map[string]ReceiverAuthorizerBinding)}
}

func authorizerBindingKey(network, channelID string) string {
	return network + ":" + channelID
}

// Bind records the receiver authorizer for a channel. First writer wins.
func (s *InMemoryReceiverAuthorizerStore) Bind(_ context.Context, binding ReceiverAuthorizerBinding) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	key := authorizerBindingKey(binding.Network, binding.ChannelID)
	existing, ok := s.bindings[key]
	if ok {
		if existing.ReceiverAuthorizer == binding.ReceiverAuthorizer {
			return nil
		}
		return fmt.Errorf("%w", ErrReceiverAuthorizerConflict)
	}
	s.bindings[key] = binding
	return nil
}

// Get looks up a binding. A missing row returns (nil, nil).
func (s *InMemoryReceiverAuthorizerStore) Get(_ context.Context, network, channelID string) (*ReceiverAuthorizerBinding, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	binding, ok := s.bindings[authorizerBindingKey(network, channelID)]
	if !ok {
		return nil, nil
	}
	copied := binding
	return &copied, nil
}

// Delete removes a binding.
func (s *InMemoryReceiverAuthorizerStore) Delete(_ context.Context, network, channelID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.bindings, authorizerBindingKey(network, channelID))
	return nil
}

// RequireReceiverAuthorizer requires the stored binding to be the advertised key.
func RequireReceiverAuthorizer(bound, advertised, channelID string) (string, error) {
	if bound == "" {
		return "", fmt.Errorf("%s: no receiver authorizer is bound to %s", batchsettlement.ErrReceiverBindingUnavailable, channelID)
	}
	if bound != advertised {
		return "", fmt.Errorf("%s: advertised key is not the channel's binding", batchsettlement.ErrReceiverAuthorizerMismatch)
	}
	return bound, nil
}
