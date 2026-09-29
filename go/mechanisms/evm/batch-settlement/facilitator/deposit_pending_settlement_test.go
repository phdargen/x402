package facilitator

import (
	"context"
	"errors"
	"math/big"
	"strings"
	"testing"

	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/evm"
	batchsettlement "github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement"
	"github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement/storage"
	"github.com/x402-foundation/x402/go/v2/types"
)

// Exercises the PendingSettlementStore fast path wired into SettleDeposit (see
// deposit.go): a settle attempt whose receipt wait fails must populate the
// store keyed by the deposit authorization signature; a subsequent settle for
// the identical payload must hit that entry, skip verify/broadcast entirely,
// and reconcile against the already-broadcast transaction via
// reconcilePendingDeposit. Mirrors the TS/Python batch-settlement deposit
// pending-settlement test suites.

func pendingDepositPayload(t *testing.T) (string, *batchsettlement.BatchSettlementDepositPayload, types.PaymentRequirements) {
	t.Helper()
	payload, reqs := signedErc3009Deposit(t, testNetwork, "100", "100")
	return payload.Deposit.Authorization.Erc3009Authorization.Signature, payload, reqs
}

// depositConfirmedChannelStateReader reports an empty channel pre-broadcast and
// a balance reflecting the deposit amount once broadcast (tracked via
// writeSeen), so finishDepositSettle's post-receipt poll (see deposit.go)
// observes the expected balance on its first read instead of spinning until
// channelStatePollDeadline. Reconciliation (reconcilePendingDeposit) has no
// pre-broadcast snapshot of its own and exits its poll on the first
// successful read regardless of balance, so this also satisfies that path.
func depositConfirmedChannelStateReader(t *testing.T, writeSeen *bool) func(functionName string, _ ...interface{}) (interface{}, error) {
	return func(functionName string, _ ...interface{}) (interface{}, error) {
		if functionName == "deposit" {
			return nil, nil
		}
		if functionName != evm.FunctionTryAggregate {
			return nil, errors.New("unexpected rpc")
		}
		balance := big.NewInt(0)
		if writeSeen == nil || *writeSeen {
			balance = big.NewInt(100)
		}
		return multicallChannelStateResult(t, balance, big.NewInt(0), 0, big.NewInt(0)), nil
	}
}

func TestSettleDeposit_PendingSettlementStore_CacheMissSuccessLeavesNoEntry(t *testing.T) {
	sig, payload, reqs := pendingDepositPayload(t)
	store := x402.NewInMemoryPendingSettlementStore()
	writeSeen := false
	signer := &fakeFacilitatorSigner{
		addresses:    []string{"0xfacilitator"},
		readContract: depositConfirmedChannelStateReader(t, &writeSeen),
		writeContract: func(string, ...interface{}) (string, error) {
			writeSeen = true
			return "0x" + strings.Repeat("ab", 32), nil
		},
		waitForReceipt: func(txHash string) (*evm.TransactionReceipt, error) {
			return &evm.TransactionReceipt{Status: evm.TxStatusSuccess, TxHash: txHash}, nil
		},
	}
	signer.getBalance = func(string, string) (*big.Int, error) { return big.NewInt(1000), nil }

	resp, err := SettleDeposit(context.Background(), signer, payload, reqs, nil, nil, nil, nil, store, nil, "")
	if err != nil {
		t.Fatalf("SettleDeposit: %v", err)
	}
	if !resp.Success {
		t.Fatalf("expected success, got %+v", resp)
	}

	if _, ok, _ := store.Get(context.Background(), sig); ok {
		t.Error("successful settlement must not leave a pending entry")
	}
}

func TestSettleDeposit_PendingSettlementStore_CacheMissReceiptFailurePopulatesStore(t *testing.T) {
	sig, payload, reqs := pendingDepositPayload(t)
	store := x402.NewInMemoryPendingSettlementStore()
	wantTxHash := "0x" + strings.Repeat("ab", 32)
	signer := &fakeFacilitatorSigner{
		addresses:     []string{"0xfacilitator"},
		readContract:  depositConfirmedChannelStateReader(t, nil),
		writeContract: func(string, ...interface{}) (string, error) { return wantTxHash, nil },
		waitForReceipt: func(string) (*evm.TransactionReceipt, error) {
			return nil, errors.New("rpc: timeout waiting for receipt")
		},
	}
	signer.getBalance = func(string, string) (*big.Int, error) { return big.NewInt(1000), nil }

	_, err := SettleDeposit(context.Background(), signer, payload, reqs, nil, nil, nil, nil, store, nil, "")
	var se *x402.SettleError
	if !errors.As(err, &se) || se.ErrorReason != ErrSettlementPending {
		t.Fatalf("got err = %v, want settlement_pending", err)
	}
	if se.Transaction != wantTxHash {
		t.Fatalf("transaction = %q, want %q", se.Transaction, wantTxHash)
	}

	txHash, ok, _ := store.Get(context.Background(), sig)
	if !ok {
		t.Fatal("receipt-wait failure must populate the pending-settlement store")
	}
	if txHash != wantTxHash {
		t.Errorf("stored tx hash = %q, want %q", txHash, wantTxHash)
	}
}

func TestSettleDeposit_PendingSettlementStore_CacheHitReconcilesWithoutRebroadcast(t *testing.T) {
	sig, payload, reqs := pendingDepositPayload(t)
	store := x402.NewInMemoryPendingSettlementStore()
	priorTxHash := "0x" + strings.Repeat("ab", 32)
	if err := store.Set(context.Background(), sig, priorTxHash); err != nil {
		t.Fatalf("store.Set: %v", err)
	}
	signer := &fakeFacilitatorSigner{
		addresses:    []string{"0xfacilitator"},
		readContract: depositConfirmedChannelStateReader(t, nil),
		waitForReceipt: func(txHash string) (*evm.TransactionReceipt, error) {
			return &evm.TransactionReceipt{Status: evm.TxStatusSuccess, TxHash: txHash}, nil
		},
	}

	resp, err := SettleDeposit(context.Background(), signer, payload, reqs, nil, nil, nil, nil, store, nil, "")
	if err != nil {
		t.Fatalf("SettleDeposit: %v", err)
	}
	if !resp.Success || resp.Transaction != priorTxHash {
		t.Fatalf("expected reconciled success with tx %q, got %+v", priorTxHash, resp)
	}
	if signer.writeCalls != 0 {
		t.Errorf("reconciliation fast path must never re-broadcast, got %d WriteContract calls", signer.writeCalls)
	}

	if _, ok, _ := store.Get(context.Background(), sig); ok {
		t.Error("successful reconciliation must clear the pending entry")
	}
}

func TestSettleDeposit_PendingSettlementStore_CacheHitStillPendingReturnsAgainWithoutRebroadcast(t *testing.T) {
	sig, payload, reqs := pendingDepositPayload(t)
	store := x402.NewInMemoryPendingSettlementStore()
	priorTxHash := "0x" + strings.Repeat("ab", 32)
	if err := store.Set(context.Background(), sig, priorTxHash); err != nil {
		t.Fatalf("store.Set: %v", err)
	}
	signer := &fakeFacilitatorSigner{
		addresses:      []string{"0xfacilitator"},
		readContract:   depositConfirmedChannelStateReader(t, nil),
		waitForReceipt: func(string) (*evm.TransactionReceipt, error) { return nil, errors.New("rpc: still pending") },
	}

	_, err := SettleDeposit(context.Background(), signer, payload, reqs, nil, nil, nil, nil, store, nil, "")
	var se *x402.SettleError
	if !errors.As(err, &se) || se.ErrorReason != ErrSettlementPending {
		t.Fatalf("got err = %v, want settlement_pending", err)
	}
	if se.Transaction != priorTxHash {
		t.Fatalf("transaction = %q, want %q", se.Transaction, priorTxHash)
	}
	if signer.writeCalls != 0 {
		t.Errorf("reconciliation fast path must never re-broadcast, got %d WriteContract calls", signer.writeCalls)
	}

	txHash, ok, _ := store.Get(context.Background(), sig)
	if !ok || txHash != priorTxHash {
		t.Errorf("expected pending entry to persist with tx %q, got ok=%v tx=%q", priorTxHash, ok, txHash)
	}
}

func TestSettleDeposit_PendingSettlementStore_NilStoreDisablesFastPath(t *testing.T) {
	_, payload, reqs := pendingDepositPayload(t)
	writeSeen := false
	signer := &fakeFacilitatorSigner{
		addresses:    []string{"0xfacilitator"},
		readContract: depositConfirmedChannelStateReader(t, &writeSeen),
		writeContract: func(string, ...interface{}) (string, error) {
			writeSeen = true
			return "0x" + strings.Repeat("ab", 32), nil
		},
		waitForReceipt: func(txHash string) (*evm.TransactionReceipt, error) {
			return &evm.TransactionReceipt{Status: evm.TxStatusSuccess, TxHash: txHash}, nil
		},
	}
	signer.getBalance = func(string, string) (*big.Int, error) { return big.NewInt(1000), nil }

	resp, err := SettleDeposit(context.Background(), signer, payload, reqs, nil, nil, nil, nil, nil, nil, "")
	if err != nil {
		t.Fatalf("SettleDeposit: %v", err)
	}
	if !resp.Success {
		t.Errorf("expected success, got %+v", resp)
	}
}

type errDelegatedAuth struct{ err error }

func (s errDelegatedAuth) Bind(context.Context, storage.DelegatedAuthBinding) (bool, error) {
	return false, s.err
}
func (s errDelegatedAuth) Get(context.Context, string, string) (*storage.DelegatedAuthBinding, error) {
	return nil, nil
}
func (s errDelegatedAuth) Delete(context.Context, string, string) error { return nil }

type failSetPendingStore struct{ inner x402.PendingSettlementStore }

func (s failSetPendingStore) Get(ctx context.Context, key string) (string, bool, error) {
	return s.inner.Get(ctx, key)
}
func (s failSetPendingStore) Set(context.Context, string, string) error {
	return errors.New("store down")
}
func (s failSetPendingStore) Delete(ctx context.Context, key string) error {
	return s.inner.Delete(ctx, key)
}

func delegatedDepositSigner(t *testing.T, write func(string, ...interface{}) (string, error), wait func(string) (*evm.TransactionReceipt, error)) *fakeFacilitatorSigner {
	t.Helper()
	return &fakeFacilitatorSigner{
		addresses: []string{"0xfacilitator"},
		getBalance: func(string, string) (*big.Int, error) {
			return big.NewInt(1000), nil
		},
		readContract:   depositConfirmedChannelStateReader(t, nil),
		writeContract:  write,
		waitForReceipt: wait,
	}
}

func requireDelegatedBinding(t *testing.T, store storage.DelegatedAuthStore, channelId, identity string) {
	t.Helper()
	got, err := store.Get(context.Background(), channelId, testNetwork)
	if err != nil {
		t.Fatal(err)
	}
	if identity == "" {
		if got != nil {
			t.Fatalf("binding = %+v, want none", got)
		}
		return
	}
	if got == nil || got.CallerIdentity != identity {
		t.Fatalf("binding = %+v, want %s", got, identity)
	}
}

func TestSettleDeposit_DelegatedBindErrorDoesNotBroadcast(t *testing.T) {
	_, payload, reqs := pendingDepositPayload(t)
	signer := delegatedDepositSigner(t,
		func(string, ...interface{}) (string, error) { return "0x" + strings.Repeat("ab", 32), nil },
		func(string) (*evm.TransactionReceipt, error) { return nil, errors.New("unused") },
	)
	_, err := SettleDeposit(context.Background(), signer, payload, reqs, nil, nil, nil, nil, nil,
		errDelegatedAuth{err: errors.New("mongo down")}, "svc")
	var se *x402.SettleError
	if !errors.As(err, &se) || se.ErrorReason != ErrVoucherStoreUnavailable {
		t.Fatalf("got err = %v, want store unavailable", err)
	}
	if signer.writeCalls != 0 || signer.sendCalls != 0 {
		t.Fatalf("bind error must not broadcast, writes=%d sends=%d", signer.writeCalls, signer.sendCalls)
	}
}

func TestSettleDeposit_BroadcastFailureDeletesInsertedBinding(t *testing.T) {
	_, payload, reqs := pendingDepositPayload(t)
	auth := storage.NewInMemoryDelegatedAuthStore()
	signer := delegatedDepositSigner(t,
		func(string, ...interface{}) (string, error) { return "", errors.New("rpc down") },
		nil,
	)
	_, err := SettleDeposit(context.Background(), signer, payload, reqs, nil, nil, nil, nil, nil, auth, "svc")
	var se *x402.SettleError
	if !errors.As(err, &se) || se.ErrorReason != ErrDepositTransactionFailed {
		t.Fatalf("got err = %v", err)
	}
	requireDelegatedBinding(t, auth, payload.Voucher.ChannelId, "")
}

func TestSettleDeposit_IdempotentRebindFailureKeepsExistingBinding(t *testing.T) {
	_, payload, reqs := pendingDepositPayload(t)
	auth := storage.NewInMemoryDelegatedAuthStore()
	if _, err := auth.Bind(context.Background(), storage.DelegatedAuthBinding{
		ChannelId: payload.Voucher.ChannelId, Network: testNetwork, CallerIdentity: "svc",
	}); err != nil {
		t.Fatal(err)
	}
	signer := delegatedDepositSigner(t,
		func(string, ...interface{}) (string, error) { return "", errors.New("rpc down") },
		nil,
	)
	_, err := SettleDeposit(context.Background(), signer, payload, reqs, nil, nil, nil, nil, nil, auth, "svc")
	var se *x402.SettleError
	if !errors.As(err, &se) || se.ErrorReason != ErrDepositTransactionFailed {
		t.Fatalf("got err = %v", err)
	}
	requireDelegatedBinding(t, auth, payload.Voucher.ChannelId, "svc")
}

func TestSettleDeposit_SettlementPendingKeepsInsertedBinding(t *testing.T) {
	sig, payload, reqs := pendingDepositPayload(t)
	auth := storage.NewInMemoryDelegatedAuthStore()
	pending := x402.NewInMemoryPendingSettlementStore()
	txHash := "0x" + strings.Repeat("ab", 32)
	signer := delegatedDepositSigner(t,
		func(string, ...interface{}) (string, error) { return txHash, nil },
		func(string) (*evm.TransactionReceipt, error) { return nil, errors.New("rpc: timeout") },
	)
	_, err := SettleDeposit(context.Background(), signer, payload, reqs, nil, nil, nil, nil, pending, auth, "svc")
	var se *x402.SettleError
	if !errors.As(err, &se) || se.ErrorReason != ErrSettlementPending {
		t.Fatalf("got err = %v, want settlement_pending", err)
	}
	requireDelegatedBinding(t, auth, payload.Voucher.ChannelId, "svc")
	if _, ok, _ := pending.Get(context.Background(), delegatedAuthInsertedMarker(sig)); !ok {
		t.Fatal("pending settle must keep the inserted-binding marker")
	}
}

func TestSettleDeposit_ReconcileTerminalFailureDeletesInsertedBinding(t *testing.T) {
	sig, payload, reqs := pendingDepositPayload(t)
	auth := storage.NewInMemoryDelegatedAuthStore()
	pending := x402.NewInMemoryPendingSettlementStore()
	txHash := "0x" + strings.Repeat("ab", 32)
	waits := 0
	signer := delegatedDepositSigner(t,
		func(string, ...interface{}) (string, error) { return txHash, nil },
		func(hash string) (*evm.TransactionReceipt, error) {
			waits++
			if waits == 1 {
				return nil, errors.New("rpc: timeout")
			}
			return &evm.TransactionReceipt{Status: evm.TxStatusFailed, TxHash: hash}, nil
		},
	)
	_, err := SettleDeposit(context.Background(), signer, payload, reqs, nil, nil, nil, nil, pending, auth, "svc")
	var se *x402.SettleError
	if !errors.As(err, &se) || se.ErrorReason != ErrSettlementPending {
		t.Fatalf("first settle err = %v", err)
	}

	_, err = SettleDeposit(context.Background(), signer, payload, reqs, nil, nil, nil, nil, pending, auth, "svc")
	if !errors.As(err, &se) || se.ErrorReason != ErrTransactionReverted {
		t.Fatalf("reconcile err = %v", err)
	}
	if signer.writeCalls != 1 {
		t.Fatalf("reconcile writes = %d, want 1", signer.writeCalls)
	}
	requireDelegatedBinding(t, auth, payload.Voucher.ChannelId, "")
	if _, ok, _ := pending.Get(context.Background(), delegatedAuthInsertedMarker(sig)); ok {
		t.Fatal("terminal reconcile must drop the inserted-binding marker")
	}
}

func TestSettleDeposit_SuccessKeepsBindingAndDropsMarker(t *testing.T) {
	sig, payload, reqs := pendingDepositPayload(t)
	auth := storage.NewInMemoryDelegatedAuthStore()
	pending := x402.NewInMemoryPendingSettlementStore()
	writeSeen := false
	signer := &fakeFacilitatorSigner{
		addresses:    []string{"0xfacilitator"},
		readContract: depositConfirmedChannelStateReader(t, &writeSeen),
		writeContract: func(string, ...interface{}) (string, error) {
			writeSeen = true
			return "0x" + strings.Repeat("ab", 32), nil
		},
		waitForReceipt: func(txHash string) (*evm.TransactionReceipt, error) {
			return &evm.TransactionReceipt{Status: evm.TxStatusSuccess, TxHash: txHash}, nil
		},
	}
	signer.getBalance = func(string, string) (*big.Int, error) { return big.NewInt(1000), nil }
	resp, err := SettleDeposit(context.Background(), signer, payload, reqs, nil, nil, nil, nil, pending, auth, "svc")
	if err != nil || !resp.Success {
		t.Fatalf("got resp=%+v err=%v", resp, err)
	}
	requireDelegatedBinding(t, auth, payload.Voucher.ChannelId, "svc")
	if _, ok, _ := pending.Get(context.Background(), delegatedAuthInsertedMarker(sig)); ok {
		t.Fatal("success must drop the inserted-binding marker")
	}
}

func TestSettleDeposit_MarkerSetFailureDeletesBindingWithoutBroadcast(t *testing.T) {
	_, payload, reqs := pendingDepositPayload(t)
	auth := storage.NewInMemoryDelegatedAuthStore()
	signer := delegatedDepositSigner(t,
		func(string, ...interface{}) (string, error) { return "0x" + strings.Repeat("ab", 32), nil },
		nil,
	)
	_, err := SettleDeposit(context.Background(), signer, payload, reqs, nil, nil, nil, nil,
		failSetPendingStore{inner: x402.NewInMemoryPendingSettlementStore()}, auth, "svc")
	var se *x402.SettleError
	if !errors.As(err, &se) || se.ErrorReason != ErrVoucherStoreUnavailable {
		t.Fatalf("got err = %v", err)
	}
	if signer.writeCalls != 0 {
		t.Fatalf("marker failure must not broadcast, writes=%d", signer.writeCalls)
	}
	requireDelegatedBinding(t, auth, payload.Voucher.ChannelId, "")
}

func TestSettleDeposit_InvalidVerifyDoesNotBindOrBroadcast(t *testing.T) {
	_, payload, reqs := pendingDepositPayload(t)
	payload.Voucher.Signature = "0x" + strings.Repeat("11", 65)
	auth := storage.NewInMemoryDelegatedAuthStore()
	signer := delegatedDepositSigner(t,
		func(string, ...interface{}) (string, error) { return "0x" + strings.Repeat("ab", 32), nil },
		nil,
	)
	_, err := SettleDeposit(context.Background(), signer, payload, reqs, nil, nil, nil, nil, nil, auth, "svc")
	var se *x402.SettleError
	if !errors.As(err, &se) {
		t.Fatalf("got err = %v, want settle error", err)
	}
	if signer.writeCalls != 0 || signer.sendCalls != 0 {
		t.Fatalf("invalid deposit must not broadcast, writes=%d sends=%d", signer.writeCalls, signer.sendCalls)
	}
	requireDelegatedBinding(t, auth, payload.Voucher.ChannelId, "")
}
