package storage

import (
	"context"
	"strings"
	"sync"
)

// DelegatedAuthBinding is a deposit-time caller identity bound to a channel
// so a later refund settle can be correlated to the same service.
type DelegatedAuthBinding struct {
	ChannelId      string
	Network        string
	CallerIdentity string
}

// DelegatedAuthIdentityConflictError is returned by Bind when a different
// identity already owns the (channelId, network) key.
type DelegatedAuthIdentityConflictError struct{}

func (e *DelegatedAuthIdentityConflictError) Error() string {
	return "delegated auth binding already exists for a different identity"
}

// DelegatedAuthStore persists delegated deposit/refund caller-identity bindings.
// Bind is durable; nil means a later Get sees the row. Do not broadcast before that.
type DelegatedAuthStore interface {
	// Bind is first-writer-wins. inserted is true only when this call created the row.
	// Same identity returns inserted == false; a different identity conflicts.
	Bind(ctx context.Context, binding DelegatedAuthBinding) (inserted bool, err error)
	Get(ctx context.Context, channelId string, network string) (*DelegatedAuthBinding, error)
	Delete(ctx context.Context, channelId string, network string) error
}

// InMemoryDelegatedAuthStore is a volatile DelegatedAuthStore. A multi-replica
// facilitator must inject a shared implementation; a lost binding fails closed.
type InMemoryDelegatedAuthStore struct {
	mu       sync.Mutex
	bindings map[string]DelegatedAuthBinding
}

var _ DelegatedAuthStore = (*InMemoryDelegatedAuthStore)(nil)

// NewInMemoryDelegatedAuthStore creates an empty in-memory binding store.
func NewInMemoryDelegatedAuthStore() *InMemoryDelegatedAuthStore {
	return &InMemoryDelegatedAuthStore{bindings: make(map[string]DelegatedAuthBinding)}
}

// Bind records the caller identity. inserted is true only for a new row.
func (s *InMemoryDelegatedAuthStore) Bind(_ context.Context, binding DelegatedAuthBinding) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	key := bindingKey(binding.ChannelId, binding.Network)
	existing, ok := s.bindings[key]
	if ok {
		if existing.CallerIdentity == binding.CallerIdentity {
			return false, nil
		}
		return false, &DelegatedAuthIdentityConflictError{}
	}
	s.bindings[key] = binding
	return true, nil
}

// Get looks up a binding. The returned value is a copy so callers cannot
// mutate the stored row.
func (s *InMemoryDelegatedAuthStore) Get(_ context.Context, channelId string, network string) (*DelegatedAuthBinding, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	binding, ok := s.bindings[bindingKey(channelId, network)]
	if !ok {
		return nil, nil
	}
	cp := binding
	return &cp, nil
}

// Delete removes a binding.
func (s *InMemoryDelegatedAuthStore) Delete(_ context.Context, channelId string, network string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.bindings, bindingKey(channelId, network))
	return nil
}

func bindingKey(channelId string, network string) string {
	return network + ":" + strings.ToLower(channelId)
}
