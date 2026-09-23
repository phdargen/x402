package storage

import (
	"context"
	"fmt"
	"math"
	"math/big"
	"strings"
	"sync"
	"testing"
)

const settleTargetTestNetwork = "eip155:84532"

func TestInMemorySettleTargetStorage_ClaimDelta(t *testing.T) {
	store := NewInMemorySettleTargetStorage()
	recv, token := settleAddr(1), settleAddr(2)
	minPending := big.NewInt(10)
	applySettleDelta(t, store, recv, token, 4)
	if got := querySettleTargets(t, store, settleTargetTestNetwork, nil, minPending); len(got) != 0 {
		t.Fatalf("below min pending: %+v", got)
	}
	if got := querySettleTargets(t, store, settleTargetTestNetwork, nil, nil); len(got) != 1 {
		t.Fatalf("pending > 0: %+v", got)
	}
	applySettleDelta(t, store, recv, token, 7)
	got := querySettleTargets(t, store, settleTargetTestNetwork, nil, minPending)
	if len(got) != 1 || got[0].Receiver != strings.ToLower(recv) || got[0].Token != strings.ToLower(token) {
		t.Fatalf("after second delta: %+v", got)
	}

	huge := new(big.Int).Add(big.NewInt(math.MaxInt64), big.NewInt(1))
	over := NewInMemorySettleTargetStorage()
	applySettleDelta(t, over, settleAddr(3), settleAddr(4), math.MaxInt64)
	if got := querySettleTargets(t, over, settleTargetTestNetwork, nil, huge); len(got) != 0 {
		t.Fatalf("minPending above MaxInt64 must match nothing: %+v", got)
	}
}

func TestInMemorySettleTargetStorage_ConcurrentDeltas(t *testing.T) {
	const n = 40
	store := NewInMemorySettleTargetStorage()
	recv, token := settleAddr(5), settleAddr(6)
	minPending := big.NewInt(n)
	var wg sync.WaitGroup
	errCh := make(chan error, n)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			errCh <- store.ApplySettleTargetClaimDelta(context.Background(), SettleTargetClaimDelta{
				Network:  settleTargetTestNetwork,
				Receiver: recv,
				Token:    token,
				Amount:   big.NewInt(1),
			})
		}()
	}
	wg.Wait()
	close(errCh)
	for err := range errCh {
		if err != nil {
			t.Fatal(err)
		}
	}
	if got := querySettleTargets(t, store, settleTargetTestNetwork, nil, minPending); len(got) != 0 {
		t.Fatalf("pending == minPending must not match: %+v", got)
	}
	applySettleDelta(t, store, recv, token, 1)
	if got := querySettleTargets(t, store, settleTargetTestNetwork, nil, minPending); len(got) != 1 {
		t.Fatalf("pending == sum+1: %+v", got)
	}
}

func TestInMemorySettleTargetStorage_MixedCase(t *testing.T) {
	store := NewInMemorySettleTargetStorage()
	recv, token := settleAddr(7), settleAddr(8)
	applySettleDelta(t, store, strings.ToUpper(recv), token, 1)
	applySettleDelta(t, store, recv, strings.ToUpper(token), 1)
	got := querySettleTargets(t, store, settleTargetTestNetwork, nil, nil)
	if len(got) != 1 {
		t.Fatalf("mixed case rows = %d, want 1 (%+v)", len(got), got)
	}
	if got[0].Receiver != recv || got[0].Token != token {
		t.Fatalf("stored case = %+v", got[0])
	}
}

func TestInMemorySettleTargetStorage_SettleQuery(t *testing.T) {
	store := NewInMemorySettleTargetStorage()
	rows := []SettleTarget{
		{Network: settleTargetTestNetwork, Receiver: settleAddr(3), Token: settleAddr(1)},
		{Network: settleTargetTestNetwork, Receiver: settleAddr(1), Token: settleAddr(1)},
		{Network: settleTargetTestNetwork, Receiver: settleAddr(2), Token: settleAddr(1)},
	}
	for _, row := range rows {
		applySettleDelta(t, store, row.Receiver, row.Token, 1)
	}
	stampSettleTargets(t, store, []SettleTarget{rows[0]}, 300)
	stampSettleTargets(t, store, []SettleTarget{rows[1]}, 100)
	stampSettleTargets(t, store, []SettleTarget{rows[2]}, 200)

	limit := 2
	first := querySettleTargets(t, store, settleTargetTestNetwork, &limit, nil)
	if len(first) != 2 || first[0].Receiver != settleAddr(1) || first[1].Receiver != settleAddr(2) {
		t.Fatalf("first page = %+v", first)
	}
	page, err := store.SettleQuery(context.Background(), SettleQuery{Network: settleTargetTestNetwork, Limit: &limit})
	if err != nil {
		t.Fatal(err)
	}
	rest := querySettleTargetsCursor(t, store, &limit, page.Cursor)
	if len(rest) != 1 || rest[0].Receiver != settleAddr(3) {
		t.Fatalf("second page = %+v", rest)
	}

	for _, lim := range []*int{nil, settleIntPtr(0), settleIntPtr(-1)} {
		got := querySettleTargets(t, store, settleTargetTestNetwork, lim, nil)
		if len(got) != 3 {
			t.Fatalf("limit %v returned %d rows", lim, len(got))
		}
	}
	other := settleTargetTestNetwork + "-other"
	if got := querySettleTargets(t, store, other, nil, nil); len(got) != 0 {
		t.Fatalf("other network = %+v", got)
	}
	if err := store.ApplySettleTargetClaimDelta(context.Background(), SettleTargetClaimDelta{
		Network:  other,
		Receiver: settleAddr(9),
		Token:    settleAddr(9),
		Amount:   big.NewInt(1),
	}); err != nil {
		t.Fatal(err)
	}
	if got := querySettleTargets(t, store, settleTargetTestNetwork, nil, nil); len(got) != 3 {
		t.Fatalf("primary network after other write = %+v", got)
	}
	if got := querySettleTargets(t, store, other, nil, nil); len(got) != 1 {
		t.Fatalf("other network row = %+v", got)
	}

	wide := NewInMemorySettleTargetStorage()
	for i := 0; i < 101; i++ {
		applySettleDelta(t, wide, settleAddr(1000+i), settleAddr(9), 1)
	}
	got := querySettleTargets(t, wide, settleTargetTestNetwork, nil, nil)
	if len(got) != 100 {
		t.Fatalf("default page = %d, want 100", len(got))
	}
}

func TestInMemorySettleTargetStorage_Stamp(t *testing.T) {
	store := NewInMemorySettleTargetStorage()
	a := SettleTarget{Network: settleTargetTestNetwork, Receiver: settleAddr(1), Token: settleAddr(2)}
	b := SettleTarget{Network: settleTargetTestNetwork, Receiver: settleAddr(2), Token: settleAddr(2)}
	applySettleDelta(t, store, a.Receiver, a.Token, 1)
	applySettleDelta(t, store, b.Receiver, b.Token, 1)
	stampSettleTargets(t, store, []SettleTarget{a}, 200)
	stampSettleTargets(t, store, []SettleTarget{b}, 100)
	got := querySettleTargets(t, store, settleTargetTestNetwork, nil, nil)
	if len(got) != 2 || got[0].Receiver != b.Receiver {
		t.Fatalf("before reorder: %+v", got)
	}
	stampSettleTargets(t, store, []SettleTarget{{
		Network:  settleTargetTestNetwork + "-other",
		Receiver: a.Receiver,
		Token:    a.Token,
	}}, 1)
	got = querySettleTargets(t, store, settleTargetTestNetwork, nil, nil)
	if len(got) != 2 || got[0].Receiver != b.Receiver || got[1].Receiver != a.Receiver {
		t.Fatalf("other network stamp changed order: %+v", got)
	}
	stampSettleTargets(t, store, []SettleTarget{a}, 50)
	got = querySettleTargets(t, store, settleTargetTestNetwork, nil, nil)
	if len(got) != 2 || got[0].Receiver != a.Receiver {
		t.Fatalf("after reorder: %+v", got)
	}
}

func TestInMemorySettleTargetStorage_SyncFromChain(t *testing.T) {
	store := NewInMemorySettleTargetStorage()
	target := SettleTarget{Network: settleTargetTestNetwork, Receiver: settleAddr(4), Token: settleAddr(5)}
	syncSettleTarget(t, store, target, 5)
	if got := querySettleTargets(t, store, settleTargetTestNetwork, nil, nil); len(got) != 1 {
		t.Fatalf("sync insert: %+v", got)
	}
	syncSettleTarget(t, store, target, 1)
	if got := querySettleTargets(t, store, settleTargetTestNetwork, nil, big.NewInt(10)); len(got) != 0 {
		t.Fatalf("sync below min: %+v", got)
	}
	if got := querySettleTargets(t, store, settleTargetTestNetwork, nil, nil); len(got) != 1 {
		t.Fatalf("row kept below min: %+v", got)
	}
	syncSettleTarget(t, store, target, 20)
	if got := querySettleTargets(t, store, settleTargetTestNetwork, nil, big.NewInt(10)); len(got) != 1 {
		t.Fatalf("sync update: %+v", got)
	}
	syncSettleTarget(t, store, target, 0)
	if got := querySettleTargets(t, store, settleTargetTestNetwork, nil, nil); len(got) != 0 {
		t.Fatalf("sync delete: %+v", got)
	}
}

func TestInMemorySettleTargetStorage_DeleteMissing(t *testing.T) {
	store := NewInMemorySettleTargetStorage()
	if err := store.DeleteSettleTarget(context.Background(), SettleTarget{
		Network:  settleTargetTestNetwork,
		Receiver: settleAddr(1),
		Token:    settleAddr(2),
	}); err != nil {
		t.Fatal(err)
	}
}

func applySettleDelta(t *testing.T, store SettleTargetStorage, receiver, token string, amount int64) {
	t.Helper()
	if err := store.ApplySettleTargetClaimDelta(context.Background(), SettleTargetClaimDelta{
		Network:  settleTargetTestNetwork,
		Receiver: receiver,
		Token:    token,
		Amount:   big.NewInt(amount),
	}); err != nil {
		t.Fatal(err)
	}
}

func stampSettleTargets(t *testing.T, store SettleTargetStorage, targets []SettleTarget, at int64) {
	t.Helper()
	if err := store.StampSettleTargetAttempts(context.Background(), targets, at); err != nil {
		t.Fatal(err)
	}
}

func syncSettleTarget(t *testing.T, store SettleTargetStorage, target SettleTarget, pending int64) {
	t.Helper()
	if err := store.SyncSettleTargetFromChain(context.Background(), target, big.NewInt(pending)); err != nil {
		t.Fatal(err)
	}
}

func querySettleTargets(t *testing.T, store SettleTargetStorage, network string, limit *int, minPending *big.Int) []SettleTarget {
	t.Helper()
	page, err := store.SettleQuery(context.Background(), SettleQuery{
		Network:    network,
		Limit:      limit,
		MinPending: minPending,
	})
	if err != nil {
		t.Fatal(err)
	}
	if page == nil {
		t.Fatal("nil page")
	}
	return page.Items
}

func querySettleTargetsCursor(t *testing.T, store SettleTargetStorage, limit *int, cursor string) []SettleTarget {
	t.Helper()
	page, err := store.SettleQuery(context.Background(), SettleQuery{
		Network: settleTargetTestNetwork,
		Limit:   limit,
		Cursor:  cursor,
	})
	if err != nil {
		t.Fatal(err)
	}
	return page.Items
}

func settleAddr(n int) string {
	return fmt.Sprintf("0x%040x", n)
}

func settleIntPtr(v int) *int { return &v }
