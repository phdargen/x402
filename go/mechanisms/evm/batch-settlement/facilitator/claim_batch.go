package facilitator

import (
	"context"
	"fmt"
	"log"
	"math/big"
	"strings"
	"time"

	"github.com/ethereum/go-ethereum/common"

	"github.com/x402-foundation/x402/go/v2/mechanisms/evm"
	batchsettlement "github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement"
	"github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement/storage"
)

const (
	multicallAttempts = 3
	multicallBackoff  = 100 * time.Millisecond
	// afterClaimTimeout bounds bookkeeping for a claim that already landed.
	afterClaimTimeout = 30 * time.Second
)

// claimSlice preflights one claim batch, then submits it.
// Simulation failure splits the batch. AfterClaim runs only for batches that land.
func (m *FacilitatorChannelManager) claimSlice(
	ctx context.Context,
	network string,
	claims []batchsettlement.BatchSettlementVoucherClaim,
	rows []*FacilitatorChannel,
	opts *FacilitatorClaimOptions,
) ([]FacilitatorClaimResult, error) {
	prepared, err := m.prepareClaimBatch(ctx, network, claims, rows)
	if err != nil {
		return nil, err
	}
	results, err := m.submitClaimLeaf(ctx, network, prepared, rows, opts)
	if err != nil && ctx.Err() == nil {
		return results, &batchClaimError{err: err}
	}
	return results, err
}

// batchClaimError is a per-batch submission failure. Claim reports it and continues.
// Query and preflight read failures stay unwrapped so Claim returns them.
type batchClaimError struct {
	err error
}

func (e *batchClaimError) Error() string { return e.err.Error() }

func (e *batchClaimError) Unwrap() error { return e.err }

func (m *FacilitatorChannelManager) prepareClaimBatch(
	ctx context.Context,
	network string,
	claims []batchsettlement.BatchSettlementVoucherClaim,
	rows []*FacilitatorChannel,
) ([]batchsettlement.BatchSettlementVoucherClaim, error) {
	filtered, skipped := m.filterClaimAuthorizer(claims)
	if skipped > 0 {
		log.Printf("batch-settlement: skipped %d claims on %s with a different receiverAuthorizer", skipped, network)
	}
	if len(filtered) == 0 {
		return nil, nil
	}
	views, err := m.readClaimChannels(ctx, network, filtered)
	if err != nil {
		return nil, err
	}
	kept := make([]batchsettlement.BatchSettlementVoucherClaim, 0, len(filtered))
	for _, claim := range filtered {
		channelID, err := batchsettlement.ComputeChannelId(claim.Voucher.Channel, network)
		if err != nil {
			return nil, err
		}
		view, ok := views[strings.ToLower(channelID)]
		if !ok {
			continue
		}
		charged, chargedOk := storage.ParseUint256(claim.TotalClaimed)
		if !chargedOk {
			continue
		}
		if view.totalClaimed.Cmp(charged) >= 0 {
			if err := m.applyPreflightSettleDelta(ctx, network, channelID, claim.Voucher.Channel.Receiver, claim.Voucher.Channel.Token, view.totalClaimed, rows); err != nil {
				return nil, err
			}
			if err := m.syncClaimMirror(ctx, channelID, nil, view.totalClaimed, 0, false); err != nil {
				return nil, err
			}
			continue
		}
		if view.balance.Cmp(view.totalClaimed) <= 0 {
			log.Printf("batch-settlement: drained channel %s on %s", channelID, network)
			if err := m.applyPreflightSettleDelta(ctx, network, channelID, claim.Voucher.Channel.Receiver, claim.Voucher.Channel.Token, view.totalClaimed, rows); err != nil {
				return nil, err
			}
			if err := m.syncClaimMirror(ctx, channelID, view.balance, view.totalClaimed, view.withdrawAt, true); err != nil {
				return nil, err
			}
			continue
		}
		amount := charged
		if view.balance.Cmp(amount) < 0 {
			amount = view.balance
		}
		claim.TotalClaimed = amount.String()
		kept = append(kept, claim)
	}
	return kept, nil
}

func (m *FacilitatorChannelManager) filterClaimAuthorizer(
	claims []batchsettlement.BatchSettlementVoucherClaim,
) ([]batchsettlement.BatchSettlementVoucherClaim, int) {
	if m.authorizerSigner == nil || m.authorizerSigner.Address() == "" {
		return claims, 0
	}
	want := m.authorizerSigner.Address()
	kept := make([]batchsettlement.BatchSettlementVoucherClaim, 0, len(claims))
	skipped := 0
	for _, claim := range claims {
		if !strings.EqualFold(claim.Voucher.Channel.ReceiverAuthorizer, want) {
			skipped++
			continue
		}
		kept = append(kept, claim)
	}
	return kept, skipped
}

type claimChannelView struct {
	balance      *big.Int
	totalClaimed *big.Int
	withdrawAt   int
}

// readClaimChannels reads channels and pendingWithdrawals for the batch in one multicall.
func (m *FacilitatorChannelManager) readClaimChannels(
	ctx context.Context,
	network string,
	claims []batchsettlement.BatchSettlementVoucherClaim,
) (map[string]claimChannelView, error) {
	type row struct {
		key string
		id  common.Hash
	}
	rows := make([]row, 0, len(claims))
	calls := make([]evm.MulticallCall, 0, len(claims)*2)
	for _, claim := range claims {
		channelID, err := batchsettlement.ComputeChannelId(claim.Voucher.Channel, network)
		if err != nil {
			return nil, err
		}
		id := common.HexToHash(channelID)
		rows = append(rows, row{key: strings.ToLower(channelID), id: id})
		calls = append(calls,
			evm.MulticallCall{
				Address:      batchsettlement.BatchSettlementAddress,
				ABI:          batchsettlement.BatchSettlementChannelsABI,
				FunctionName: "channels",
				Args:         []interface{}{id},
			},
			evm.MulticallCall{
				Address:      batchsettlement.BatchSettlementAddress,
				ABI:          batchsettlement.BatchSettlementPendingWithdrawalsABI,
				FunctionName: "pendingWithdrawals",
				Args:         []interface{}{id},
			},
		)
	}
	results, err := m.readMulticall(ctx, network, calls)
	if err != nil {
		return nil, err
	}
	out := make(map[string]claimChannelView, len(rows))
	for i, item := range rows {
		channelResult := results[i*2]
		withdrawResult := results[i*2+1]
		if !channelResult.Success() || !withdrawResult.Success() {
			log.Printf("batch-settlement: claim preflight failed for channel %s on %s", item.key, network)
			continue
		}
		balance, totalClaimed, err := parseChannelsResult(channelResult.Result)
		if err != nil {
			log.Printf("batch-settlement: claim preflight failed for channel %s on %s", item.key, network)
			continue
		}
		withdrawAt, err := parsePendingWithdrawAt(withdrawResult.Result)
		if err != nil {
			log.Printf("batch-settlement: claim preflight failed for channel %s on %s", item.key, network)
			continue
		}
		out[item.key] = claimChannelView{
			balance:      balance,
			totalClaimed: totalClaimed,
			withdrawAt:   withdrawAt,
		}
	}
	return out, nil
}

// readMulticall calls Multicall up to three times.
// Backoff is 100ms, then 200ms. A canceled context is not retried.
func (m *FacilitatorChannelManager) readMulticall(
	ctx context.Context,
	network string,
	calls []evm.MulticallCall,
) ([]evm.MulticallResult, error) {
	var last error
	for attempt := 0; attempt < multicallAttempts; attempt++ {
		if attempt > 0 {
			delay := multicallBackoff << (attempt - 1)
			timer := time.NewTimer(delay)
			select {
			case <-ctx.Done():
				timer.Stop()
				return nil, ctx.Err()
			case <-timer.C:
			}
		}
		results, err := evm.Multicall(ctx, m.signer, calls)
		if err == nil && len(results) == len(calls) {
			return results, nil
		}
		if err == nil {
			err = fmt.Errorf("multicall returned %d results, want %d", len(results), len(calls))
		}
		last = err
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		log.Printf("batch-settlement: multicall attempt %d failed on %s", attempt+1, network)
	}
	return nil, last
}

func parseChannelsResult(raw interface{}) (*big.Int, *big.Int, error) {
	outputs, ok := raw.([]interface{})
	if !ok || len(outputs) < 2 {
		return nil, nil, fmt.Errorf("channels returned %T, want balance and totalClaimed", raw)
	}
	balance, ok := outputs[0].(*big.Int)
	if !ok {
		return nil, nil, fmt.Errorf("channels balance returned %T, want *big.Int", outputs[0])
	}
	totalClaimed, ok := outputs[1].(*big.Int)
	if !ok {
		return nil, nil, fmt.Errorf("channels totalClaimed returned %T, want *big.Int", outputs[1])
	}
	return balance, totalClaimed, nil
}

func parsePendingWithdrawAt(raw interface{}) (int, error) {
	outputs, ok := raw.([]interface{})
	if !ok || len(outputs) < 2 {
		return 0, fmt.Errorf("pendingWithdrawals returned %T, want amount and initiatedAt", raw)
	}
	initiatedAt, ok := outputs[1].(*big.Int)
	if !ok {
		return 0, fmt.Errorf("pendingWithdrawals initiatedAt returned %T, want *big.Int", outputs[1])
	}
	return int(initiatedAt.Int64()), nil
}

func (m *FacilitatorChannelManager) submitClaimLeaf(
	ctx context.Context,
	network string,
	claims []batchsettlement.BatchSettlementVoucherClaim,
	rows []*FacilitatorChannel,
	opts *FacilitatorClaimOptions,
) ([]FacilitatorClaimResult, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if len(claims) == 0 {
		return nil, nil
	}
	counts, attested, err := SnapshotClaimChargeCounts(ctx, m.storage, claims, network, rows)
	if err != nil {
		return nil, err
	}
	asset := claims[0].Voucher.Channel.Token
	payTo := claims[0].Voucher.Channel.Receiver
	payload := &batchsettlement.BatchSettlementClaimPayload{Type: "claim", Claims: claims}
	builderSuffix, err := m.resolveBuilderSuffix(network, payload.ToMap(), asset, payTo)
	if err != nil {
		return nil, err
	}
	dataSuffix, err := batchsettlement.ComposeClaimDataSuffix(counts, builderSuffix)
	if err != nil {
		return nil, err
	}
	response, err := SubmitClaim(ctx, SubmitClaimInput{
		Network:    network,
		Claims:     claims,
		DataSuffix: dataSuffix,
	}, m.submitContext())
	if err != nil {
		return nil, err
	}
	if !response.Success {
		if response.ErrorReason != ErrClaimSimulationFailed {
			return nil, fmt.Errorf("%s", formatFailure("Claim", response))
		}
		if len(claims) == 1 {
			channelID, idErr := batchsettlement.ComputeChannelId(claims[0].Voucher.Channel, network)
			if idErr != nil {
				return nil, idErr
			}
			simErr := fmt.Errorf("claim simulation failed for channel %s on %s", channelID, network)
			reportClaimError(opts, simErr, channelID)
			if syncErr := m.resyncFailedClaim(ctx, channelID); syncErr != nil {
				return nil, syncErr
			}
			return nil, nil
		}
		mid := len(claims) / 2
		left, leftErr := m.submitClaimLeaf(ctx, network, claims[:mid], rows, opts)
		if leftErr != nil {
			return left, leftErr
		}
		right, rightErr := m.submitClaimLeaf(ctx, network, claims[mid:], rows, opts)
		return append(left, right...), rightErr
	}
	afterCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), afterClaimTimeout)
	defer cancel()
	if err := afterClaim(afterCtx, m.storage, claims, network, attested, m.settleTargetStorage, rows); err != nil {
		return nil, err
	}
	return []FacilitatorClaimResult{{
		Network:     network,
		Vouchers:    len(claims),
		Transaction: response.Transaction,
	}}, nil
}

func (m *FacilitatorChannelManager) resyncFailedClaim(ctx context.Context, channelID string) error {
	state, err := ReadChannelState(ctx, m.signer, channelID)
	if err != nil {
		return err
	}
	return m.syncClaimMirror(ctx, channelID, state.Balance, state.TotalClaimed, state.WithdrawRequestedAt, true)
}

// syncClaimMirror writes on-chain mirror fields. TotalClaimed only moves forward.
// full also overwrites Balance, WithdrawRequestedAt, and OnchainSyncedAt.
func (m *FacilitatorChannelManager) syncClaimMirror(
	ctx context.Context,
	channelID string,
	balance *big.Int,
	totalClaimed *big.Int,
	withdrawAt int,
	full bool,
) error {
	now := time.Now().UnixMilli()
	_, err := m.storage.UpdateChannel(ctx, channelID, func(current *FacilitatorChannel) *FacilitatorChannel {
		if current == nil {
			return current
		}
		next := current.Clone()
		changed := false
		if totalClaimed != nil {
			merged := storageMaxUint(current.TotalClaimed, totalClaimed.String())
			if merged != current.TotalClaimed {
				next.TotalClaimed = merged
				changed = true
			}
		}
		if full && balance != nil && next.Balance != balance.String() {
			next.Balance = balance.String()
			changed = true
		}
		if full && next.WithdrawRequestedAt != withdrawAt {
			next.WithdrawRequestedAt = withdrawAt
			changed = true
		}
		if !changed {
			return current
		}
		next.OnchainSyncedAt = now
		return next
	})
	return err
}

// applyPreflightSettleDelta records a claim that landed without AfterClaim.
// The delta is on-chain totalClaimed minus the stored watermark.
func (m *FacilitatorChannelManager) applyPreflightSettleDelta(
	ctx context.Context,
	network, channelID, receiver, token string,
	onchain *big.Int,
	rows []*FacilitatorChannel,
) error {
	if onchain == nil {
		return nil
	}
	storedClaimed := "0"
	var stored *FacilitatorChannel
	for _, row := range rows {
		if row != nil && strings.EqualFold(row.ChannelId, channelID) {
			stored = row
			break
		}
	}
	if stored == nil {
		loaded, err := m.storage.Get(ctx, channelID)
		if err != nil {
			return err
		}
		stored = loaded
	}
	if stored != nil && stored.TotalClaimed != "" {
		storedClaimed = stored.TotalClaimed
	}
	return applyClaimedSettleDelta(ctx, m.settleTargetStorage, network, receiver, token, onchain.String(), storedClaimed)
}

func storageMaxUint(current, next string) string {
	cmp, ok := storage.Uint256Cmp(current, next)
	if !ok || cmp >= 0 {
		return current
	}
	return next
}
