package storage

import (
	"context"
	"errors"
	"testing"
)

const (
	delegatedNetwork   = "eip155:84532"
	delegatedChannelId = "0xabc1230000000000000000000000000000000000000000000000000000000001"
)

func TestInMemoryDelegatedAuthStore_BindAndGetCopy(t *testing.T) {
	store := NewInMemoryDelegatedAuthStore()
	inserted, err := store.Bind(context.Background(), DelegatedAuthBinding{
		ChannelId:      delegatedChannelId,
		Network:        delegatedNetwork,
		CallerIdentity: "tenant-a",
	})
	if err != nil || !inserted {
		t.Fatalf("Bind: inserted=%v err=%v", inserted, err)
	}
	row, err := store.Get(context.Background(), delegatedChannelId, delegatedNetwork)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if row == nil || row.CallerIdentity != "tenant-a" || row.ChannelId != delegatedChannelId || row.Network != delegatedNetwork {
		t.Fatalf("row = %+v", row)
	}
	row.CallerIdentity = "mutated"
	again, err := store.Get(context.Background(), delegatedChannelId, delegatedNetwork)
	if err != nil {
		t.Fatalf("Get after mutate: %v", err)
	}
	if again.CallerIdentity != "tenant-a" {
		t.Fatalf("stored row mutated: %q", again.CallerIdentity)
	}
}

func TestInMemoryDelegatedAuthStore_RepeatBindIsIdempotent(t *testing.T) {
	store := NewInMemoryDelegatedAuthStore()
	binding := DelegatedAuthBinding{ChannelId: delegatedChannelId, Network: delegatedNetwork, CallerIdentity: "tenant-a"}
	inserted, err := store.Bind(context.Background(), binding)
	if err != nil || !inserted {
		t.Fatalf("Bind: inserted=%v err=%v", inserted, err)
	}
	inserted, err = store.Bind(context.Background(), binding)
	if err != nil || inserted {
		t.Fatalf("repeat Bind: inserted=%v err=%v", inserted, err)
	}
}

func TestInMemoryDelegatedAuthStore_RejectsSecondIdentity(t *testing.T) {
	store := NewInMemoryDelegatedAuthStore()
	if _, err := store.Bind(context.Background(), DelegatedAuthBinding{ChannelId: delegatedChannelId, Network: delegatedNetwork, CallerIdentity: "tenant-a"}); err != nil {
		t.Fatalf("Bind: %v", err)
	}
	_, err := store.Bind(context.Background(), DelegatedAuthBinding{ChannelId: delegatedChannelId, Network: delegatedNetwork, CallerIdentity: "tenant-b"})
	var conflict *DelegatedAuthIdentityConflictError
	if !errors.As(err, &conflict) {
		t.Fatalf("err = %v, want DelegatedAuthIdentityConflictError", err)
	}
}

func TestInMemoryDelegatedAuthStore_DeleteAllowsRebind(t *testing.T) {
	store := NewInMemoryDelegatedAuthStore()
	if _, err := store.Bind(context.Background(), DelegatedAuthBinding{ChannelId: delegatedChannelId, Network: delegatedNetwork, CallerIdentity: "tenant-a"}); err != nil {
		t.Fatalf("Bind: %v", err)
	}
	if err := store.Delete(context.Background(), delegatedChannelId, delegatedNetwork); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	row, err := store.Get(context.Background(), delegatedChannelId, delegatedNetwork)
	if err != nil || row != nil {
		t.Fatalf("Get after delete: row=%+v err=%v", row, err)
	}
	if _, err := store.Bind(context.Background(), DelegatedAuthBinding{ChannelId: delegatedChannelId, Network: delegatedNetwork, CallerIdentity: "tenant-b"}); err != nil {
		t.Fatalf("rebind: %v", err)
	}
	row, err = store.Get(context.Background(), delegatedChannelId, delegatedNetwork)
	if err != nil || row == nil || row.CallerIdentity != "tenant-b" {
		t.Fatalf("row after rebind = %+v err=%v", row, err)
	}
}
