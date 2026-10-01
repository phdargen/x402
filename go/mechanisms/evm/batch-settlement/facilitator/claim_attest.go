package facilitator

import (
	"context"
	"errors"
	"fmt"
	"math/big"
	"sync"
	"time"

	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/evm"
	"github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement/storage"
)

const (
	// pendingClaimResolveAge is the receipt-wait ceiling plus a five-minute margin.
	// Older markers with onchain totalClaimed still below ClaimedTo are dropped.
	pendingClaimResolveAge = 8 * time.Minute
	// pendingClaimReceiptLookup bounds a preflight receipt read.
	pendingClaimReceiptLookup = 2 * time.Second

	channelConflictAttempts = 4
	channelConflictBackoff  = 20 * time.Millisecond
	// channelUpdateParallelism bounds concurrent CAS writes on distinct channels.
	channelUpdateParallelism = 10
)

var errChannelConflict = errors.New("channel update conflict")

var errAttestedClaimBusy = errors.New("attested claim in progress")

// forEachChannel waits for every index. One call failing does not cancel the rest.
// A single item runs inline.
func forEachChannel(n int, fn func(int)) {
	if n <= 1 {
		if n == 1 {
			fn(0)
		}
		return
	}
	limit := channelUpdateParallelism
	if limit > n {
		limit = n
	}
	sem := make(chan struct{}, limit)
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		sem <- struct{}{}
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			defer func() { <-sem }()
			fn(i)
		}(i)
	}
	wg.Wait()
}

// attestedClaim is one channel whose charge count was written into a marker.
type attestedClaim struct {
	ChannelID string
	Count     int
	ClaimedTo string
	StartedAt int64
}

func updateChannelStrict(
	ctx context.Context,
	store storage.ChannelStorage[*FacilitatorChannel],
	channelID string,
	update func(*FacilitatorChannel) *FacilitatorChannel,
) error {
	res, err := store.UpdateChannel(ctx, channelID, update)
	if err != nil {
		return err
	}
	if res != nil && res.Status == storage.ChannelConflict {
		return fmt.Errorf("channel %s update conflict: %w", channelID, errChannelConflict)
	}
	return nil
}

func retryChannelUpdate(ctx context.Context, update func() error) error {
	var last error
	for attempt := 0; attempt < channelConflictAttempts; attempt++ {
		if err := ctx.Err(); err != nil {
			return err
		}
		err := update()
		if !errors.Is(err, errChannelConflict) {
			return err
		}
		last = err
		if attempt+1 == channelConflictAttempts {
			break
		}
		delay := channelConflictBackoff << attempt
		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-timer.C:
		}
	}
	return last
}

// beginAttestedClaim records the live charge count before a claim is sent.
// busy is true when a marker is already present; the caller must not attest again.
func beginAttestedClaim(
	ctx context.Context,
	store storage.ChannelStorage[*FacilitatorChannel],
	channelID, claimedTo string,
	now int64,
) (attestedClaim, bool, error) {
	res, err := store.UpdateChannel(ctx, channelID, func(current *FacilitatorChannel) *FacilitatorChannel {
		if current == nil || current.PendingClaim != nil {
			return current
		}
		next := current.Clone()
		count := current.ChargeCount
		if count < 0 {
			count = 0
		}
		next.PendingClaim = &PendingClaim{
			AttestedCount: count,
			ClaimedTo:     claimedTo,
			StartedAt:     now,
		}
		return next
	})
	if err != nil {
		return attestedClaim{}, false, err
	}
	if res != nil && res.Status == storage.ChannelConflict {
		return attestedClaim{}, false, fmt.Errorf("channel %s update conflict: %w", channelID, errChannelConflict)
	}
	if res == nil || res.Channel == nil || res.Channel.PendingClaim == nil {
		return attestedClaim{ChannelID: channelID, ClaimedTo: claimedTo}, false, nil
	}
	if res.Status == storage.ChannelUnchanged {
		return attestedClaim{}, true, nil
	}
	marker := res.Channel.PendingClaim
	return attestedClaim{
		ChannelID: channelID,
		Count:     marker.AttestedCount,
		ClaimedTo: marker.ClaimedTo,
		StartedAt: marker.StartedAt,
	}, false, nil
}

func abortAttestedClaims(ctx context.Context, store storage.ChannelStorage[*FacilitatorChannel], begun []attestedClaim) error {
	for _, item := range begun {
		if err := abortAttestedClaim(ctx, store, item); err != nil {
			return err
		}
	}
	return nil
}

func abortAttestedClaim(ctx context.Context, store storage.ChannelStorage[*FacilitatorChannel], item attestedClaim) error {
	if item.StartedAt == 0 || item.ChannelID == "" {
		return nil
	}
	return updateChannelStrict(ctx, store, item.ChannelID, func(current *FacilitatorChannel) *FacilitatorChannel {
		if !samePendingClaim(current, item) {
			return current
		}
		next := current.Clone()
		next.PendingClaim = nil
		return next
	})
}

func noteAttestedClaimTxs(ctx context.Context, store storage.ChannelStorage[*FacilitatorChannel], begun []attestedClaim, txHash string) error {
	if txHash == "" {
		return nil
	}
	errs := make([]error, len(begun))
	forEachChannel(len(begun), func(i int) {
		errs[i] = noteAttestedClaimTx(ctx, store, begun[i], txHash)
	})
	return errors.Join(errs...)
}

func noteAttestedClaimTx(ctx context.Context, store storage.ChannelStorage[*FacilitatorChannel], item attestedClaim, txHash string) error {
	if item.StartedAt == 0 || item.ChannelID == "" || txHash == "" {
		return nil
	}
	return updateChannelStrict(ctx, store, item.ChannelID, func(current *FacilitatorChannel) *FacilitatorChannel {
		if !samePendingClaim(current, item) || current.PendingClaim.TxHash == txHash {
			return current
		}
		next := current.Clone()
		pending := *current.PendingClaim
		pending.TxHash = txHash
		next.PendingClaim = &pending
		return next
	})
}

func samePendingClaim(current *FacilitatorChannel, item attestedClaim) bool {
	if current == nil || current.PendingClaim == nil {
		return false
	}
	marker := current.PendingClaim
	return marker.StartedAt == item.StartedAt && marker.AttestedCount == item.Count && marker.ClaimedTo == item.ClaimedTo
}

// finishAttestedClaim subtracts the marker, merges totalClaimed, and clears it.
// A missing marker only moves totalClaimed forward, so a replay does not subtract again.
func finishAttestedClaim(ctx context.Context, store storage.ChannelStorage[*FacilitatorChannel], channelID, claimed string) error {
	return updateChannelStrict(ctx, store, channelID, func(current *FacilitatorChannel) *FacilitatorChannel {
		if current == nil {
			return current
		}
		next := current.Clone()
		changed := false
		if merged := storageMaxUint(current.TotalClaimed, claimed); merged != current.TotalClaimed {
			next.TotalClaimed = merged
			changed = true
		}
		if current.PendingClaim != nil {
			count := current.ChargeCount - current.PendingClaim.AttestedCount
			if count < 0 {
				count = 0
			}
			if count != current.ChargeCount {
				next.ChargeCount = count
			}
			next.PendingClaim = nil
			changed = true
		}
		if !changed {
			return current
		}
		return next
	})
}

func chargeCountUint(count int) uint64 {
	if count < 0 {
		return 0
	}
	return uint64(count)
}

// releaseAttestedClaims records the tx hash on a sent claim and clears the marker when nothing was sent.
// landed is true only after a successful response.
func releaseAttestedClaims(
	ctx context.Context,
	store storage.ChannelStorage[*FacilitatorChannel],
	begun []attestedClaim,
	submitErr error,
	response *x402.SettleResponse,
) (bool, error) {
	landed := submitErr == nil && response != nil && response.Success
	if len(begun) == 0 {
		return landed, nil
	}
	hash := claimSubmitTxHash(submitErr, response)
	if landed {
		if hash == "" {
			return true, nil
		}
		return true, noteAttestedClaimTxs(ctx, store, begun, hash)
	}
	if hash != "" || submitErr != nil {
		if hash != "" {
			return false, noteAttestedClaimTxs(ctx, store, begun, hash)
		}
		return false, nil
	}
	return false, abortAttestedClaims(ctx, store, begun)
}

func claimSubmitTxHash(submitErr error, response *x402.SettleResponse) string {
	var settleErr *x402.SettleError
	if submitErr != nil && errors.As(submitErr, &settleErr) {
		return settleErr.Transaction
	}
	if response != nil {
		return response.Transaction
	}
	return ""
}

func (m *FacilitatorChannelManager) resolvePendingClaim(
	ctx context.Context,
	channelID string,
	stored *FacilitatorChannel,
	onchain *big.Int,
) (bool, error) {
	if stored == nil || stored.PendingClaim == nil {
		return false, nil
	}
	marker := stored.PendingClaim
	claimedTo, ok := storage.ParseUint256(marker.ClaimedTo)
	if !ok {
		claimedTo = new(big.Int)
	}
	if onchain == nil {
		onchain = new(big.Int)
	}
	landed := onchain.Cmp(claimedTo) >= 0
	reverted := false
	if !landed && marker.TxHash != "" {
		receipt, recErr := m.lookupClaimReceipt(ctx, marker.TxHash)
		switch {
		case recErr == nil && receipt != nil && receipt.Status == evm.TxStatusSuccess:
			landed = true
		case recErr == nil && receipt != nil && receipt.Status != evm.TxStatusSuccess:
			reverted = true
		}
	}
	item := attestedClaim{
		ChannelID: channelID,
		Count:     marker.AttestedCount,
		ClaimedTo: marker.ClaimedTo,
		StartedAt: marker.StartedAt,
	}
	if landed {
		claimed := storageMaxUint(marker.ClaimedTo, onchain.String())
		return false, finishAttestedClaim(ctx, m.storage, channelID, claimed)
	}
	aged := time.Now().UnixMilli()-marker.StartedAt >= pendingClaimResolveAge.Milliseconds()
	if reverted || (aged && onchain.Cmp(claimedTo) < 0) {
		return false, abortAttestedClaim(ctx, m.storage, item)
	}
	return true, nil
}

func (m *FacilitatorChannelManager) lookupClaimReceipt(ctx context.Context, txHash string) (*evm.TransactionReceipt, error) {
	if m.signer == nil || txHash == "" {
		return nil, errors.New("claim receipt unavailable")
	}
	lookupCtx, cancel := context.WithTimeout(ctx, pendingClaimReceiptLookup)
	defer cancel()
	return m.signer.WaitForTransactionReceipt(lookupCtx, txHash)
}

func unreconciledClaimDelta(stored *FacilitatorChannel, onchain *big.Int) bool {
	if onchain == nil || (stored != nil && stored.PendingClaim != nil) {
		return false
	}
	old := "0"
	if stored != nil && stored.TotalClaimed != "" {
		old = stored.TotalClaimed
	}
	return claimDeltaAmount(onchain.String(), old) != nil
}
