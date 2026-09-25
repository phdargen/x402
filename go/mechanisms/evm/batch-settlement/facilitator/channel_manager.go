package facilitator

import (
	"context"
	"errors"
	"fmt"
	"log"
	"math/big"
	"strings"

	"sync"
	"time"

	"github.com/ethereum/go-ethereum/common"

	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/evm"
	batchsettlement "github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement"
	"github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement/storage"
	"github.com/x402-foundation/x402/go/v2/types"
)

const (
	defaultSettleQueryPageSize = 100
)

// FacilitatorRetention controls when managed voucher rows are removed from storage.
type FacilitatorRetention string

const (
	RetentionWhenUnused FacilitatorRetention = "when-unused"
	RetentionForever    FacilitatorRetention = "forever"
)

// NormalizeRetention applies the default policy when retention is unset.
func NormalizeRetention(retention FacilitatorRetention) FacilitatorRetention {
	if retention == "" {
		return RetentionWhenUnused
	}
	return retention
}

// ParseFacilitatorRetention validates a configured retention string.
func ParseFacilitatorRetention(raw string) (FacilitatorRetention, error) {
	switch FacilitatorRetention(raw) {
	case RetentionWhenUnused, RetentionForever, "":
		return NormalizeRetention(FacilitatorRetention(raw)), nil
	default:
		return "", fmt.Errorf("invalid facilitator retention %q (want when-unused or forever)", raw)
	}
}

// IsChannelFinished reports whether this channel has no remaining claim, refund, or withdraw work.
func IsChannelFinished(held bool, channel *FacilitatorChannel, chargeCount int) bool {
	if held || chargeCount != 0 || channel == nil {
		return false
	}
	if uintCmp(channel.ChargedCumulativeAmount, channel.TotalClaimed) > 0 {
		return false
	}
	return uintCmp(channel.Balance, channel.TotalClaimed) <= 0
}

// ShouldDeleteNeverClaimedRefundRow deletes a finished idle-refund row that never claimed on-chain.
func ShouldDeleteNeverClaimedRefundRow(
	retention FacilitatorRetention,
	held bool,
	channel *FacilitatorChannel,
	chargeCount int,
	appliedTotalClaimed string,
) bool {
	if NormalizeRetention(retention) != RetentionWhenUnused || held {
		return false
	}
	if !IsChannelFinished(held, channel, chargeCount) {
		return false
	}
	claimed, ok := storage.ParseUint256(appliedTotalClaimed)
	return ok && claimed.Sign() == 0
}

// ShouldDeleteFinishedChannelAtSettle deletes a claimed finished row after receiver pending hits zero.
func ShouldDeleteFinishedChannelAtSettle(
	retention FacilitatorRetention,
	held bool,
	channel *FacilitatorChannel,
	chargeCount int,
) bool {
	if NormalizeRetention(retention) != RetentionWhenUnused || held {
		return false
	}
	return IsChannelFinished(held, channel, chargeCount)
}

// FacilitatorChannelManagerConfig is storage, signers, submit mode, and retention.
type FacilitatorChannelManagerConfig struct {
	Storage             storage.ChannelStorage[*FacilitatorChannel]
	LockStorage         storage.ChannelLockStorage
	Signer              evm.FacilitatorEvmSigner
	AuthorizerSigner    batchsettlement.AuthorizerSigner
	AuthorizerSubmitter evm.FacilitatorEvmSigner
	SubmitMode          SubmitMode
	Retention           FacilitatorRetention
	Context             *x402.FacilitatorContext
	DelegatedAuthStore  storage.DelegatedAuthStore
	// SettleTargetStorage caches claimed-but-unsettled (network, receiver, token) pairs.
	// Nil defaults to an in-memory cache.
	SettleTargetStorage storage.SettleTargetStorage
}

// FacilitatorClaimOptions is optional batching and idle filter for Claim.
type FacilitatorClaimOptions struct {
	MaxClaimsPerBatch int
	IdleSecs          *int
	// MinUnclaimed is an optional decimal uint256 threshold. Nil keeps the
	// default any-positive-unclaimed behavior.
	MinUnclaimed *string
	// UnclaimedDesc sorts claimable rows highest-unclaimed first.
	UnclaimedDesc bool
	// MaxTxsPerRun caps claim transactions per run. With OldestFirst, the query
	// limit is MaxTxsPerRun * MaxClaimsPerBatch and overflow re-queries UnclaimedDesc.
	MaxTxsPerRun int
	// OldestFirst selects claimable rows oldest lastRequestTimestamp first.
	OldestFirst bool
	// OnError receives a batch failure. channelID is empty for a batch-level
	// failure and set for a row isolated by bisect. Nil logs the error.
	OnError func(err error, channelID string)
}

// FacilitatorSettleOptions is optional batching and pending filters for Settle.
type FacilitatorSettleOptions struct {
	// MinPending skips receivers whose on-chain pending (totalClaimed-totalSettled)
	// is at or below this decimal uint256 threshold.
	MinPending          *string
	MaxSettlesPerTx     int
	MaxTxsPerRun        int
	SettleQueryPageSize int
	// OnError receives a batch failure. target is nil for a batch-level failure.
	// Nil logs the error.
	OnError func(err error, target *storage.SettleTarget)
}

// FacilitatorAutoConfig is interval, idle-refund, and callback configuration.
type FacilitatorAutoConfig struct {
	ClaimIntervalSecs  *int
	SettleIntervalSecs *int
	RefundIntervalSecs *int
	RefundIdleSecs     *int
	MaxClaimsPerBatch  int
	OnClaim            func(FacilitatorClaimResult)
	OnSettle           func(FacilitatorSettleResult)
	OnRefund           func(FacilitatorRefundResult)
	OnError            func(error)
}

// FacilitatorClaimResult is one submitted claim batch.
type FacilitatorClaimResult struct {
	Network     string
	Vouchers    int
	Transaction string
}

// FacilitatorSettleResult is one settle transaction.
type FacilitatorSettleResult struct {
	Network     string
	Receiver    string
	Token       string
	Transaction string
}

// FacilitatorRefundResult is one refunded or claim-only channel.
type FacilitatorRefundResult struct {
	Network     string
	Channel     string
	Transaction string
}

type autoJob string

const (
	autoJobClaim  autoJob = "claim"
	autoJobSettle autoJob = "settle"
	autoJobRefund autoJob = "refund"
)

var autoJobPriority = []autoJob{autoJobClaim, autoJobSettle, autoJobRefund}

func formatFailure(operation string, response *x402.SettleResponse) string {
	reason := "unknown"
	msg := ""
	if response != nil {
		if response.ErrorReason != "" {
			reason = response.ErrorReason
		}
		msg = response.ErrorMessage
	}
	return fmt.Sprintf("%s failed: %s — %s", operation, reason, msg)
}

func channelIsHeld(ctx context.Context, lock storage.ChannelLockStorage, channelId string) bool {
	held, err := lock.IsHeld(ctx, channelId, "")
	if err != nil {
		return false
	}
	return held
}

// AfterClaim applies claimed totals, subtracts attested chargeCount, and upserts settle targets.
// Call only after a successful onchain claim. known may be nil; missing rows are loaded.
func AfterClaim(
	ctx context.Context,
	store storage.ChannelStorage[*FacilitatorChannel],
	lockStorage storage.ChannelLockStorage,
	claims []batchsettlement.BatchSettlementVoucherClaim,
	network string,
	attested map[string]int,
	authStore storage.DelegatedAuthStore,
	retention FacilitatorRetention,
	targetStore storage.SettleTargetStorage,
) error {
	_ = lockStorage
	_ = authStore
	_ = NormalizeRetention(retention)
	return afterClaim(ctx, store, claims, network, attested, targetStore, nil)
}

// afterClaim upserts aggregated settle-target deltas, then one channel CAS each.
// known rows supply the pre-claim TotalClaimed; a missing row is loaded.
func afterClaim(
	ctx context.Context,
	store storage.ChannelStorage[*FacilitatorChannel],
	claims []batchsettlement.BatchSettlementVoucherClaim,
	network string,
	attested map[string]int,
	targetStore storage.SettleTargetStorage,
	known []*FacilitatorChannel,
) error {
	deltas, err := settleTargetClaimDeltas(ctx, store, claims, network, known)
	if err != nil {
		return err
	}
	if len(deltas) > 0 {
		if targetStore == nil {
			return fmt.Errorf("settle target storage is required")
		}
		for _, delta := range deltas {
			if err := targetStore.ApplySettleTargetClaimDelta(ctx, delta); err != nil {
				return err
			}
		}
	}
	for _, claim := range claims {
		channelID, err := batchsettlement.ComputeChannelId(claim.Voucher.Channel, network)
		if err != nil {
			return err
		}
		snapshot := attested[strings.ToLower(channelID)]
		claimed := claim.TotalClaimed
		if _, err := store.UpdateChannel(ctx, channelID, func(current *FacilitatorChannel) *FacilitatorChannel {
			if current == nil {
				return current
			}
			next := current.Clone()
			changed := false
			if merged := storageMaxUint(current.TotalClaimed, claimed); merged != current.TotalClaimed {
				next.TotalClaimed = merged
				changed = true
			}
			chargeCount := current.ChargeCount - snapshot
			if chargeCount < 0 {
				chargeCount = 0
			}
			if chargeCount != current.ChargeCount {
				next.ChargeCount = chargeCount
				changed = true
			}
			if !changed {
				return current
			}
			return next
		}); err != nil {
			return err
		}
	}
	return nil
}

func settleTargetClaimDeltas(
	ctx context.Context,
	store storage.ChannelStorage[*FacilitatorChannel],
	claims []batchsettlement.BatchSettlementVoucherClaim,
	network string,
	known []*FacilitatorChannel,
) ([]storage.SettleTargetClaimDelta, error) {
	rows := make(map[string]*FacilitatorChannel, len(known))
	for _, row := range known {
		if row != nil {
			rows[strings.ToLower(row.ChannelId)] = row
		}
	}
	type aggregated struct {
		receiver string
		token    string
		amount   *big.Int
	}
	byPair := make(map[string]*aggregated)
	order := make([]string, 0)
	for _, claim := range claims {
		channelID, err := batchsettlement.ComputeChannelId(claim.Voucher.Channel, network)
		if err != nil {
			return nil, err
		}
		key := strings.ToLower(channelID)
		stored := rows[key]
		if stored == nil {
			stored, err = store.Get(ctx, channelID)
			if err != nil {
				return nil, err
			}
		}
		oldClaimed := "0"
		if stored != nil {
			oldClaimed = stored.TotalClaimed
		}
		delta := claimDeltaAmount(claim.TotalClaimed, oldClaimed)
		if delta == nil {
			continue
		}
		pairKey := strings.ToLower(claim.Voucher.Channel.Receiver) + "\x00" + strings.ToLower(claim.Voucher.Channel.Token)
		slot := byPair[pairKey]
		if slot == nil {
			slot = &aggregated{
				receiver: claim.Voucher.Channel.Receiver,
				token:    claim.Voucher.Channel.Token,
				amount:   new(big.Int),
			}
			byPair[pairKey] = slot
			order = append(order, pairKey)
		}
		slot.amount.Add(slot.amount, delta)
	}
	out := make([]storage.SettleTargetClaimDelta, 0, len(order))
	for _, pairKey := range order {
		slot := byPair[pairKey]
		out = append(out, storage.SettleTargetClaimDelta{
			Network:  network,
			Receiver: slot.receiver,
			Token:    slot.token,
			Amount:   slot.amount,
		})
	}
	return out, nil
}

// claimDeltaAmount is newClaimed - oldClaimed when the claim moved the watermark forward.
func claimDeltaAmount(newClaimed, oldClaimed string) *big.Int {
	next, ok := storage.ParseUint256(newClaimed)
	if !ok || next.Sign() <= 0 {
		return nil
	}
	prev := new(big.Int)
	if parsed, ok := storage.ParseUint256(oldClaimed); ok {
		prev = parsed
	}
	if next.Cmp(prev) <= 0 {
		return nil
	}
	return new(big.Int).Sub(next, prev)
}

func applyClaimedSettleDelta(
	ctx context.Context,
	targets storage.SettleTargetStorage,
	network, receiver, token, newClaimed, oldClaimed string,
) error {
	delta := claimDeltaAmount(newClaimed, oldClaimed)
	if delta == nil {
		return nil
	}
	if targets == nil {
		return fmt.Errorf("settle target storage is required")
	}
	return targets.ApplySettleTargetClaimDelta(ctx, storage.SettleTargetClaimDelta{
		Network:  network,
		Receiver: receiver,
		Token:    token,
		Amount:   delta,
	})
}

func refundClaimedTotal(
	stored string,
	claims []batchsettlement.BatchSettlementVoucherClaim,
	extra map[string]interface{},
) string {
	if extra != nil {
		if claimed, ok := extra["totalClaimed"].(string); ok && claimed != "" {
			return claimed
		}
	}
	best := stored
	for _, claim := range claims {
		if uintCmp(claim.TotalClaimed, best) > 0 {
			best = claim.TotalClaimed
		}
	}
	return best
}

// SnapshotClaimChargeCounts snapshots each claim row's unattested chargeCount in batch order.
func SnapshotClaimChargeCounts(
	ctx context.Context,
	store storage.ChannelStorage[*FacilitatorChannel],
	claims []batchsettlement.BatchSettlementVoucherClaim,
	network string,
	known []*FacilitatorChannel,
) (counts []uint64, attested map[string]int, err error) {
	attested = make(map[string]int)
	rows := make(map[string]*FacilitatorChannel, len(known))
	for _, row := range known {
		if row != nil {
			rows[strings.ToLower(row.ChannelId)] = row
		}
	}
	for _, claim := range claims {
		channelId, err := batchsettlement.ComputeChannelId(claim.Voucher.Channel, network)
		if err != nil {
			return nil, nil, err
		}
		key := strings.ToLower(channelId)
		stored := rows[key]
		if stored == nil {
			stored, err = store.Get(ctx, channelId)
			if err != nil {
				return nil, nil, err
			}
		}
		count := 0
		if stored != nil {
			count = stored.ChargeCount
		}
		counts = append(counts, uint64(count))
		attested[key] = count
	}
	return counts, attested, nil
}

// FacilitatorChannelManager is the facilitator-side claim / settle / idle-refund scheduler.
type FacilitatorChannelManager struct {
	storage             storage.ChannelStorage[*FacilitatorChannel]
	lockStorage         storage.ChannelLockStorage
	signer              evm.FacilitatorEvmSigner
	authorizerSigner    batchsettlement.AuthorizerSigner
	authorizerSubmitter evm.FacilitatorEvmSigner
	submitMode          SubmitMode
	retention           FacilitatorRetention
	context             *x402.FacilitatorContext
	delegatedAuthStore  storage.DelegatedAuthStore
	settleTargetStorage storage.SettleTargetStorage

	mu            sync.Mutex
	timers        map[autoJob]*time.Ticker
	stopChans     map[autoJob]chan struct{}
	running       bool
	pendingJobs   map[autoJob]struct{}
	drainingJobs  bool
	autoConfig    FacilitatorAutoConfig
	pendingSettle bool
}

// NewFacilitatorChannelManager creates a facilitator channel manager.
func NewFacilitatorChannelManager(config FacilitatorChannelManagerConfig) (*FacilitatorChannelManager, error) {
	if err := AssertDirectAuthorizerSubmitter(config.SubmitMode, config.AuthorizerSigner, config.AuthorizerSubmitter); err != nil {
		return nil, err
	}
	lockStorage := config.LockStorage
	if lockStorage == nil && storage.IsChannelLockStorage(config.Storage) {
		lockStorage = config.Storage.(storage.ChannelLockStorage)
	}
	retention := NormalizeRetention(config.Retention)
	submitMode := config.SubmitMode
	if submitMode == "" {
		submitMode = SubmitModeRelay
	}
	settleTargets := config.SettleTargetStorage
	if settleTargets == nil {
		settleTargets = storage.NewInMemorySettleTargetStorage()
	}
	return &FacilitatorChannelManager{
		storage:             config.Storage,
		lockStorage:         lockStorage,
		signer:              config.Signer,
		authorizerSigner:    config.AuthorizerSigner,
		authorizerSubmitter: config.AuthorizerSubmitter,
		submitMode:          submitMode,
		retention:           retention,
		context:             config.Context,
		delegatedAuthStore:  config.DelegatedAuthStore,
		settleTargetStorage: settleTargets,
		timers:              make(map[autoJob]*time.Ticker),
		stopChans:           make(map[autoJob]chan struct{}),
		pendingJobs:         make(map[autoJob]struct{}),
	}, nil
}

// Claim claims eligible vouchers, grouped by network, withdraw-pending first.
// A failed batch is reported through OnError and skipped. Successful batches
// are still applied. The error is set only for a query failure or a canceled context.
func (m *FacilitatorChannelManager) Claim(ctx context.Context, opts *FacilitatorClaimOptions) ([]FacilitatorClaimResult, error) {
	maxClaimsPerBatch := 100
	if opts != nil && opts.MaxClaimsPerBatch > 0 {
		maxClaimsPerBatch = opts.MaxClaimsPerBatch
	}
	rows, err := m.loadClaimRows(ctx, opts, maxClaimsPerBatch)
	if err != nil {
		return nil, err
	}
	maxTxsPerRun := 0
	if opts != nil && opts.MaxTxsPerRun > 0 {
		maxTxsPerRun = opts.MaxTxsPerRun
	}
	byNetwork, order := groupByNetwork(rows)
	results := make([]FacilitatorClaimResult, 0)

	for _, network := range order {
		group := byNetwork[network]
		claims := storage.SelectClaimableVouchers(channelBases(group), &storage.SelectClaimableOptions{Now: time.Now().UnixMilli()})
		if len(claims) == 0 {
			continue
		}
		txCount := 0
		for i := 0; i < len(claims); i += maxClaimsPerBatch {
			if err := ctx.Err(); err != nil {
				return m.finishClaim(results, err)
			}
			if maxTxsPerRun > 0 && txCount >= maxTxsPerRun {
				break
			}
			end := i + maxClaimsPerBatch
			if end > len(claims) {
				end = len(claims)
			}
			batchResults, err := m.claimSlice(ctx, network, claims[i:end], group, opts)
			if err != nil {
				if ctx.Err() != nil {
					return m.finishClaim(results, ctx.Err())
				}
				var batchErr *batchClaimError
				if errors.As(err, &batchErr) {
					reportClaimError(opts, batchErr.err, "")
					txCount++
					continue
				}
				return m.finishClaim(results, err)
			}
			if len(batchResults) == 0 {
				continue
			}
			txCount += len(batchResults)
			results = append(results, batchResults...)
		}
	}
	return m.finishClaim(results, nil)
}

func (m *FacilitatorChannelManager) finishClaim(results []FacilitatorClaimResult, err error) ([]FacilitatorClaimResult, error) {
	if len(results) > 0 {
		m.mu.Lock()
		m.pendingSettle = true
		m.mu.Unlock()
	}
	return results, err
}

// Settle settles eligible receiver pairs and cleans up when pending reaches zero.
func (m *FacilitatorChannelManager) Settle(ctx context.Context, opts *FacilitatorSettleOptions) ([]FacilitatorSettleResult, error) {
	return m.runSettlePass(ctx, opts)
}

type receiverPendingRead struct {
	target  storage.SettleTarget
	pending *big.Int
}

func (m *FacilitatorChannelManager) runSettlePass(
	ctx context.Context,
	opts *FacilitatorSettleOptions,
) ([]FacilitatorSettleResult, error) {
	maxSettlesPerTx, maxTxsPerRun, pageSize, minPending := settlePassLimits(opts)
	receiverBudget := maxSettlesPerTx * maxTxsPerRun
	targets, err := m.collectSettleTargetPages(ctx, pageSize, receiverBudget, minPending)
	if err != nil {
		return nil, err
	}
	if len(targets) == 0 {
		m.clearPendingSettle()
		return nil, nil
	}

	reads, err := m.readReceiverPending(ctx, targets)
	if err != nil {
		return nil, err
	}
	toSettle := make([]storage.SettleTarget, 0, receiverBudget)
	now := time.Now().UnixMilli()
	stamp := make([]storage.SettleTarget, 0, len(reads))
	for _, row := range reads {
		stamp = append(stamp, row.target)
		if row.pending.Sign() == 0 {
			if err := m.cleanupSettledPair(ctx, row.target); err != nil {
				target := row.target
				reportSettleError(opts, err, &target)
			}
			continue
		}
		if minPending != nil && row.pending.Cmp(minPending) <= 0 {
			m.syncSettleTarget(ctx, row.target, row.pending)
			continue
		}
		toSettle = append(toSettle, row.target)
		if len(toSettle) >= receiverBudget {
			break
		}
	}
	if m.settleTargetStorage != nil && len(stamp) > 0 {
		if err := m.settleTargetStorage.StampSettleTargetAttempts(ctx, stamp, now); err != nil {
			log.Printf("batch-settlement: stamp settle targets: %v", err)
		}
	}
	if len(toSettle) == 0 {
		m.clearPendingSettle()
		return nil, nil
	}

	byNetwork := make(map[string][]storage.SettleTarget)
	networkOrder := make([]string, 0)
	for _, target := range toSettle {
		if _, ok := byNetwork[target.Network]; !ok {
			networkOrder = append(networkOrder, target.Network)
		}
		byNetwork[target.Network] = append(byNetwork[target.Network], target)
	}

	results := make([]FacilitatorSettleResult, 0)
	settledTargets := make([]storage.SettleTarget, 0)
	for _, network := range networkOrder {
		group := byNetwork[network]
		txCount := 0
		for i := 0; i < len(group) && txCount < maxTxsPerRun; i += maxSettlesPerTx {
			end := i + maxSettlesPerTx
			if end > len(group) {
				end = len(group)
			}
			if err := ctx.Err(); err != nil {
				return results, err
			}
			batch := group[i:end]
			payload := &batchsettlement.BatchSettlementSettlePayload{
				Type:     "settle",
				Receiver: batch[0].Receiver,
				Token:    batch[0].Token,
			}
			dataSuffix, err := m.resolveBuilderSuffix(network, payload.ToMap(), batch[0].Token, batch[0].Receiver)
			if err != nil {
				if ctx.Err() != nil {
					return results, ctx.Err()
				}
				reportSettleError(opts, err, nil)
				continue
			}
			submissions, skipped, err := submitSettleMulticall(ctx, m.signer, x402.Network(network), batch, dataSuffix)
			for _, skip := range skipped {
				target := skip.target
				if opts != nil && opts.OnError != nil {
					opts.OnError(skip.err, &target)
				}
			}
			batchResults, landed := settleResultsFromSubmissions(string(network), submissions)
			results = append(results, batchResults...)
			settledTargets = append(settledTargets, landed...)
			if err != nil {
				if ctx.Err() != nil {
					return results, ctx.Err()
				}
				reportSettleError(opts, err, nil)
				continue
			}
			if len(submissions) > 0 {
				txCount++
			}
		}
	}

	confirm, err := m.readReceiverPending(ctx, settledTargets)
	if err != nil {
		return results, err
	}
	for _, row := range confirm {
		if row.pending.Sign() != 0 {
			m.syncSettleTarget(ctx, row.target, row.pending)
			continue
		}
		if err := m.cleanupSettledPair(ctx, row.target); err != nil {
			target := row.target
			reportSettleError(opts, err, &target)
		}
	}
	m.clearPendingSettle()
	return results, nil
}

func settlePassLimits(opts *FacilitatorSettleOptions) (maxSettlesPerTx, maxTxsPerRun, pageSize int, minPending *big.Int) {
	maxSettlesPerTx = 100
	maxTxsPerRun = 100
	pageSize = defaultSettleQueryPageSize
	if opts != nil {
		if opts.MaxSettlesPerTx > 0 {
			maxSettlesPerTx = opts.MaxSettlesPerTx
		}
		if opts.MaxTxsPerRun > 0 {
			maxTxsPerRun = opts.MaxTxsPerRun
		}
		if opts.SettleQueryPageSize > 0 {
			pageSize = opts.SettleQueryPageSize
		}
		if opts.MinPending != nil {
			parsed, ok := storage.ParseUint256(*opts.MinPending)
			if ok {
				minPending = parsed
			}
		}
	}
	return maxSettlesPerTx, maxTxsPerRun, pageSize, minPending
}

func (m *FacilitatorChannelManager) syncSettleTarget(ctx context.Context, target storage.SettleTarget, pending *big.Int) {
	if m.settleTargetStorage == nil {
		log.Printf("batch-settlement: settle target storage missing during sync")
		return
	}
	if err := m.settleTargetStorage.SyncSettleTargetFromChain(ctx, target, pending); err != nil {
		log.Printf("batch-settlement: sync settle target: %v", err)
	}
}

func (m *FacilitatorChannelManager) collectSettleTargetPages(
	ctx context.Context,
	pageSize int,
	budget int,
	minPending *big.Int,
) ([]storage.SettleTarget, error) {
	if budget <= 0 {
		return nil, nil
	}
	if m.settleTargetStorage == nil {
		return nil, fmt.Errorf("settle target storage is required")
	}
	out := make([]storage.SettleTarget, 0, budget)
	cursor := ""
	for len(out) < budget {
		limit := pageSize
		if budget-len(out) < limit {
			limit = budget - len(out)
		}
		page, err := m.settleTargetStorage.SettleQuery(ctx, storage.SettleQuery{
			Limit:      &limit,
			Cursor:     cursor,
			MinPending: minPending,
		})
		if err != nil {
			return nil, err
		}
		if page == nil || len(page.Items) == 0 {
			break
		}
		out = append(out, page.Items...)
		if page.Cursor == "" || len(out) >= budget {
			break
		}
		cursor = page.Cursor
	}
	return out, nil
}

func (m *FacilitatorChannelManager) readReceiverPending(
	ctx context.Context,
	targets []storage.SettleTarget,
) ([]receiverPendingRead, error) {
	if len(targets) == 0 {
		return nil, nil
	}
	network := targets[0].Network
	calls := make([]evm.MulticallCall, 0, len(targets))
	for _, target := range targets {
		calls = append(calls, evm.MulticallCall{
			Address:      batchsettlement.BatchSettlementAddress,
			ABI:          batchsettlement.BatchSettlementReceiversABI,
			FunctionName: "receivers",
			Args:         []interface{}{common.HexToAddress(target.Receiver), common.HexToAddress(target.Token)},
		})
	}
	results, err := m.readMulticall(ctx, network, calls)
	if err != nil {
		return nil, err
	}
	out := make([]receiverPendingRead, 0, len(targets))
	for i, target := range targets {
		if !results[i].Success() {
			log.Printf("batch-settlement: settle receiver read failed for %s %s on %s", target.Receiver, target.Token, target.Network)
			continue
		}
		totalClaimed, totalSettled, parseErr := parseReceiversMulticallResult(results[i].Result)
		if parseErr != nil {
			log.Printf("batch-settlement: settle receiver read failed for %s %s on %s", target.Receiver, target.Token, target.Network)
			continue
		}
		pending := new(big.Int).Sub(totalClaimed, totalSettled)
		if pending.Sign() < 0 {
			pending = new(big.Int)
		}
		out = append(out, receiverPendingRead{target: target, pending: pending})
	}
	return out, nil
}

func parseReceiversMulticallResult(raw interface{}) (*big.Int, *big.Int, error) {
	outputs, ok := raw.([]interface{})
	if !ok || len(outputs) < 2 {
		return nil, nil, fmt.Errorf("receivers returned %T, want two uint128 values", raw)
	}
	totalClaimed, ok := outputs[0].(*big.Int)
	if !ok {
		return nil, nil, fmt.Errorf("receivers totalClaimed returned %T, want *big.Int", outputs[0])
	}
	totalSettled, ok := outputs[1].(*big.Int)
	if !ok {
		return nil, nil, fmt.Errorf("receivers totalSettled returned %T, want *big.Int", outputs[1])
	}
	return totalClaimed, totalSettled, nil
}

func (m *FacilitatorChannelManager) cleanupSettledPair(
	ctx context.Context,
	target storage.SettleTarget,
) error {
	if m.settleTargetStorage != nil {
		if err := m.settleTargetStorage.DeleteSettleTarget(ctx, target); err != nil {
			return err
		}
	}
	if NormalizeRetention(m.retention) != RetentionWhenUnused {
		return nil
	}
	rows, err := storage.QueryChannelsByReceiverToken(ctx, m.storage, target.Network, target.Receiver, target.Token)
	if err != nil {
		return err
	}
	for _, row := range rows {
		if row == nil {
			continue
		}
		channelId := row.ChannelId
		held := m.lockStorage != nil && channelIsHeld(ctx, m.lockStorage, channelId)
		result, err := m.storage.UpdateChannel(ctx, channelId, func(current *FacilitatorChannel) *FacilitatorChannel {
			if current == nil {
				return current
			}
			if !ShouldDeleteFinishedChannelAtSettle(m.retention, held, current, current.ChargeCount) {
				return current
			}
			return nil
		})
		if err != nil {
			return err
		}
		if result != nil && result.Status == storage.ChannelDeleted && m.delegatedAuthStore != nil {
			_ = m.delegatedAuthStore.Delete(ctx, channelId, target.Network)
		}
	}
	return nil
}

func (m *FacilitatorChannelManager) clearPendingSettle() {
	m.mu.Lock()
	m.pendingSettle = false
	m.mu.Unlock()
}

// ClaimAndSettle claims eligible vouchers then settles.
func (m *FacilitatorChannelManager) ClaimAndSettle(ctx context.Context, opts *FacilitatorClaimOptions) (claims []FacilitatorClaimResult, settle []FacilitatorSettleResult, err error) {
	claims, claimErr := m.Claim(ctx, opts)
	if len(claims) > 0 {
		var settleErr error
		settle, settleErr = m.Settle(ctx, nil)
		if settleErr != nil {
			return claims, nil, errors.Join(claimErr, settleErr)
		}
	}
	return claims, settle, claimErr
}

// Refund cooperatively refunds stored channels with remaining escrow.
func (m *FacilitatorChannelManager) Refund(ctx context.Context) ([]FacilitatorRefundResult, error) {
	refundLimit := 100
	page, err := storage.QueryChannels(ctx, m.storage, storage.ChannelQuery{Kind: storage.QueryKindIdleRefundable, Limit: &refundLimit}, nil)
	if err != nil {
		return nil, err
	}
	return m.refundChannels(ctx, page.Items)
}

// RefundIdleChannels refunds idle channels with a remaining escrow balance.
func (m *FacilitatorChannelManager) RefundIdleChannels(ctx context.Context, idleSecs int) ([]FacilitatorRefundResult, error) {
	channels, err := m.getIdleChannelsForRefund(ctx, idleSecs)
	if err != nil {
		return nil, err
	}
	return m.refundChannels(ctx, channels)
}

// Start starts claim, settle, and refund interval jobs.
func (m *FacilitatorChannelManager) Start(config FacilitatorAutoConfig) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.running {
		return
	}
	m.running = true
	m.autoConfig = config
	m.startAutoTimerLocked(autoJobClaim, config.ClaimIntervalSecs)
	m.startAutoTimerLocked(autoJobSettle, config.SettleIntervalSecs)
	m.startAutoTimerLocked(autoJobRefund, config.RefundIntervalSecs)
}

// Stop stops the interval loop. When flush is true, run ClaimAndSettle before returning.
func (m *FacilitatorChannelManager) Stop(ctx context.Context, flush bool) error {
	m.mu.Lock()
	m.running = false
	for _, ticker := range m.timers {
		ticker.Stop()
	}
	for _, ch := range m.stopChans {
		close(ch)
	}
	m.timers = make(map[autoJob]*time.Ticker)
	m.stopChans = make(map[autoJob]chan struct{})
	m.pendingJobs = make(map[autoJob]struct{})
	cfg := m.autoConfig
	m.mu.Unlock()
	if flush {
		opts := &FacilitatorClaimOptions{}
		if cfg.MaxClaimsPerBatch > 0 {
			opts.MaxClaimsPerBatch = cfg.MaxClaimsPerBatch
		}
		_, _, err := m.ClaimAndSettle(ctx, opts)
		return err
	}
	return nil
}

func (m *FacilitatorChannelManager) refundChannels(ctx context.Context, channels []*FacilitatorChannel) ([]FacilitatorRefundResult, error) {
	results := make([]FacilitatorRefundResult, 0)
	for _, channel := range channels {
		if m.lockStorage != nil && channelIsHeld(ctx, m.lockStorage, channel.ChannelId) {
			continue
		}
		result, err := m.refundChannel(ctx, channel)
		if err != nil {
			return nil, err
		}
		if result != nil {
			results = append(results, *result)
		}
	}
	return results, nil
}

func (m *FacilitatorChannelManager) refundChannel(ctx context.Context, target *FacilitatorChannel) (*FacilitatorRefundResult, error) {
	claims := m.buildRefundClaims(target)
	bal, _ := new(big.Int).SetString(target.Balance, 10)
	charged, _ := new(big.Int).SetString(target.ChargedCumulativeAmount, 10)
	if bal == nil {
		bal = new(big.Int)
	}
	if charged == nil {
		charged = new(big.Int)
	}
	refundAmount := new(big.Int).Sub(bal, charged)

	if refundAmount.Sign() <= 0 && len(claims) == 0 {
		return nil, nil
	}
	if refundAmount.Sign() <= 0 {
		results, err := m.claimSlice(ctx, target.Network, claims, []*FacilitatorChannel{target}, nil)
		if err != nil {
			return nil, err
		}
		if len(results) == 0 {
			return nil, nil
		}
		return &FacilitatorRefundResult{
			Network:     target.Network,
			Channel:     target.ChannelId,
			Transaction: results[0].Transaction,
		}, nil
	}

	payload := &batchsettlement.BatchSettlementEnrichedRefundPayload{
		Type:          "refund",
		ChannelConfig: target.ChannelConfig,
		Voucher: batchsettlement.BatchSettlementVoucherFields{
			ChannelId:          target.ChannelId,
			MaxClaimableAmount: target.SignedMaxClaimable,
			Signature:          target.Signature,
		},
		Amount:      refundAmount.String(),
		RefundNonce: fmt.Sprintf("%d", target.RefundNonce),
		Claims:      claims,
	}
	dataSuffix, err := m.resolveBuilderSuffix(target.Network, payload.ToMap(), target.ChannelConfig.Token, target.ChannelConfig.Receiver)
	if err != nil {
		return nil, err
	}
	var claimSuffix []byte
	if len(claims) > 0 {
		claimSuffix, err = batchsettlement.EncodeChargeCountsSuffix([]uint64{uint64(target.ChargeCount)})
		if err != nil {
			return nil, err
		}
	}
	response, err := SubmitRefund(ctx, SubmitRefundInput{
		Network:         target.Network,
		Payload:         payload,
		DataSuffix:      dataSuffix,
		ClaimDataSuffix: claimSuffix,
	}, m.submitContext())
	if err != nil {
		return nil, err
	}
	if !response.Success {
		return nil, fmt.Errorf("%s", formatFailure("Refund", response))
	}
	if err := m.afterRefund(ctx, target, claims, response); err != nil {
		return nil, err
	}
	return &FacilitatorRefundResult{
		Network:     target.Network,
		Channel:     target.ChannelId,
		Transaction: response.Transaction,
	}, nil
}

func (m *FacilitatorChannelManager) afterRefund(
	ctx context.Context,
	target *FacilitatorChannel,
	claims []batchsettlement.BatchSettlementVoucherClaim,
	response *x402.SettleResponse,
) error {
	var refunded map[string]interface{}
	if response != nil && response.Extra != nil {
		refunded, _ = response.Extra["channelState"].(map[string]interface{})
	}
	if len(claims) > 0 {
		newClaimed := refundClaimedTotal(target.TotalClaimed, claims, refunded)
		if err := applyClaimedSettleDelta(ctx, m.settleTargetStorage, target.Network, target.ChannelConfig.Receiver, target.ChannelConfig.Token, newClaimed, target.TotalClaimed); err != nil {
			return err
		}
		attested := target.ChargeCount
		if err := storage.ApplyClaimedTotals(ctx, m.storage, claims, target.Network); err != nil {
			return err
		}
		if _, err := m.storage.UpdateChannel(ctx, target.ChannelId, func(current *FacilitatorChannel) *FacilitatorChannel {
			if current == nil {
				return current
			}
			next := current.Clone()
			next.ChargeCount = current.ChargeCount - attested
			if next.ChargeCount < 0 {
				next.ChargeCount = 0
			}
			return next
		}); err != nil {
			return err
		}
	}

	if _, err := m.storage.UpdateChannel(ctx, target.ChannelId, func(current *FacilitatorChannel) *FacilitatorChannel {
		if current == nil {
			return current
		}
		next := current.Clone()
		if refunded != nil {
			if v, ok := refunded["balance"].(string); ok {
				next.Balance = v
			}
			if v, ok := refunded["totalClaimed"].(string); ok {
				next.TotalClaimed = v
			}
			if v, ok := refunded["refundNonce"].(string); ok {
				if n, ok := extraNumber(v); ok {
					next.RefundNonce = n
				}
			} else if n, ok := extraNumber(refunded["refundNonce"]); ok {
				next.RefundNonce = n
			} else {
				next.RefundNonce = current.RefundNonce + 1
			}
			if n, ok := extraNumber(refunded["withdrawRequestedAt"]); ok {
				next.WithdrawRequestedAt = n
			}
		}
		return next
	}); err != nil {
		return err
	}

	held := m.lockStorage != nil && channelIsHeld(ctx, m.lockStorage, target.ChannelId)
	result, err := m.storage.UpdateChannel(ctx, target.ChannelId, func(current *FacilitatorChannel) *FacilitatorChannel {
		if current == nil {
			return current
		}
		appliedTotalClaimed := current.TotalClaimed
		if refunded != nil {
			if v, ok := refunded["totalClaimed"].(string); ok {
				appliedTotalClaimed = v
			}
		}
		if ShouldDeleteNeverClaimedRefundRow(m.retention, held, current, current.ChargeCount, appliedTotalClaimed) {
			return nil
		}
		return current
	})
	if err != nil {
		return err
	}
	if result != nil && result.Status == storage.ChannelDeleted && m.delegatedAuthStore != nil {
		_ = m.delegatedAuthStore.Delete(ctx, target.ChannelId, target.Network)
	}
	return nil
}

func (m *FacilitatorChannelManager) buildRefundClaims(channel *FacilitatorChannel) []batchsettlement.BatchSettlementVoucherClaim {
	if channel == nil {
		return nil
	}
	if _, ok := parseManagedUint(channel.ChargedCumulativeAmount); !ok {
		return nil
	}
	if _, ok := parseManagedUint(channel.TotalClaimed); !ok {
		return nil
	}
	if uintCmp(channel.ChargedCumulativeAmount, channel.TotalClaimed) <= 0 {
		return nil
	}
	claim := batchsettlement.BatchSettlementVoucherClaim{
		Signature:    channel.Signature,
		TotalClaimed: channel.ChargedCumulativeAmount,
	}
	claim.Voucher.Channel = channel.ChannelConfig
	claim.Voucher.MaxClaimableAmount = channel.SignedMaxClaimable
	return []batchsettlement.BatchSettlementVoucherClaim{claim}
}

func (m *FacilitatorChannelManager) getIdleChannelsForRefund(ctx context.Context, idleSecs int) ([]*FacilitatorChannel, error) {
	idleAt := time.Now().UnixMilli() - int64(idleSecs)*1000
	refundLimit := 100
	page, err := storage.QueryChannels(ctx, m.storage, storage.ChannelQuery{
		Kind:           storage.QueryKindIdleRefundable,
		IdleAtOrBefore: &idleAt,
		Limit:          &refundLimit,
	}, nil)
	if err != nil {
		return nil, err
	}
	if m.lockStorage == nil {
		return page.Items, nil
	}
	out := make([]*FacilitatorChannel, 0, len(page.Items))
	for _, channel := range page.Items {
		if !channelIsHeld(ctx, m.lockStorage, channel.ChannelId) {
			out = append(out, channel)
		}
	}
	return out, nil
}

func (m *FacilitatorChannelManager) startAutoTimerLocked(job autoJob, intervalSecs *int) {
	if intervalSecs == nil {
		return
	}
	ticker := time.NewTicker(time.Duration(*intervalSecs) * time.Second)
	stop := make(chan struct{})
	m.timers[job] = ticker
	m.stopChans[job] = stop
	go func() {
		for {
			select {
			case <-ticker.C:
				m.enqueueJob(job)
			case <-stop:
				return
			}
		}
	}()
}

func (m *FacilitatorChannelManager) enqueueJob(job autoJob) {
	m.mu.Lock()
	if !m.running {
		m.mu.Unlock()
		return
	}
	m.pendingJobs[job] = struct{}{}
	draining := m.drainingJobs
	m.mu.Unlock()
	if !draining {
		go m.drainJobs()
	}
}

func (m *FacilitatorChannelManager) drainJobs() {
	m.mu.Lock()
	if m.drainingJobs {
		m.mu.Unlock()
		return
	}
	m.drainingJobs = true
	m.mu.Unlock()
	defer func() {
		m.mu.Lock()
		m.drainingJobs = false
		m.mu.Unlock()
	}()

	for {
		m.mu.Lock()
		if !m.running || len(m.pendingJobs) == 0 {
			m.mu.Unlock()
			return
		}
		job := m.nextPendingJobLocked()
		if job == "" {
			m.mu.Unlock()
			return
		}
		delete(m.pendingJobs, job)
		m.mu.Unlock()
		m.runAutoJob(job)
	}
}

func (m *FacilitatorChannelManager) nextPendingJobLocked() autoJob {
	for _, job := range autoJobPriority {
		if _, ok := m.pendingJobs[job]; ok {
			return job
		}
	}
	return ""
}

func (m *FacilitatorChannelManager) runAutoJob(job autoJob) {
	switch job {
	case autoJobClaim:
		m.runClaimJob()
	case autoJobSettle:
		m.runSettleJob()
	case autoJobRefund:
		m.runRefundJob()
	default:
		panic("unhandled auto job: " + string(job))
	}
}

func (m *FacilitatorChannelManager) runClaimJob() {
	m.mu.Lock()
	cfg := m.autoConfig
	m.mu.Unlock()
	opts := &FacilitatorClaimOptions{}
	if cfg.MaxClaimsPerBatch > 0 {
		opts.MaxClaimsPerBatch = cfg.MaxClaimsPerBatch
	}
	if cfg.OnError != nil {
		onErr := cfg.OnError
		opts.OnError = func(err error, _ string) { onErr(err) }
	}
	results, err := m.Claim(context.Background(), opts)
	if cfg.OnClaim != nil {
		for _, result := range results {
			cfg.OnClaim(result)
		}
	}
	if err != nil && cfg.OnError != nil {
		cfg.OnError(err)
	}
}

func (m *FacilitatorChannelManager) runSettleJob() {
	m.mu.Lock()
	pending := m.pendingSettle
	cfg := m.autoConfig
	m.mu.Unlock()
	if !pending {
		return
	}
	opts := &FacilitatorSettleOptions{}
	if cfg.OnError != nil {
		onErr := cfg.OnError
		opts.OnError = func(err error, _ *storage.SettleTarget) { onErr(err) }
	}
	results, err := m.Settle(context.Background(), opts)
	if err != nil {
		if cfg.OnError != nil {
			cfg.OnError(err)
		}
		return
	}
	if cfg.OnSettle != nil {
		for _, result := range results {
			cfg.OnSettle(result)
		}
	}
}

func buildClaimQuery(opts *FacilitatorClaimOptions, maxClaimsPerBatch int) (storage.ChannelQuery, int) {
	filter := storage.ChannelQuery{Kind: storage.QueryKindClaimable}
	capacity := 0
	limit := maxClaimsPerBatch
	if opts != nil && opts.MaxTxsPerRun > 0 {
		capacity = opts.MaxTxsPerRun * maxClaimsPerBatch
		if opts.OldestFirst {
			probe := capacity + 1
			limit = probe
		} else {
			limit = capacity
		}
	}
	filter.Limit = &limit
	if opts != nil {
		if opts.IdleSecs != nil {
			idleAt := time.Now().UnixMilli() - int64(*opts.IdleSecs)*1000
			filter.IdleAtOrBefore = &idleAt
		}
		filter.MinUnclaimed = opts.MinUnclaimed
		filter.UnclaimedDesc = opts.UnclaimedDesc
		if opts.OldestFirst && opts.MaxTxsPerRun > 0 {
			filter.OldestFirst = true
			filter.UnclaimedDesc = false
		}
	}
	return filter, capacity
}

func (m *FacilitatorChannelManager) runRefundJob() {
	m.mu.Lock()
	cfg := m.autoConfig
	m.mu.Unlock()
	var (
		results []FacilitatorRefundResult
		err     error
	)
	if cfg.RefundIdleSecs != nil {
		results, err = m.RefundIdleChannels(context.Background(), *cfg.RefundIdleSecs)
	} else {
		results, err = m.Refund(context.Background())
	}
	if err != nil {
		if cfg.OnError != nil {
			cfg.OnError(err)
		}
		return
	}
	if cfg.OnRefund != nil {
		for _, result := range results {
			cfg.OnRefund(result)
		}
	}
}

func (m *FacilitatorChannelManager) resolveBuilderSuffix(
	network string,
	payload map[string]interface{},
	asset string,
	payTo string,
) ([]byte, error) {
	return evm.ResolveDataSuffix(m.context, scheduledSuffixContext(network, payload, asset, payTo))
}

func (m *FacilitatorChannelManager) submitContext() SubmitContext {
	return SubmitContext{
		SubmitMode:          m.submitMode,
		Signer:              m.signer,
		AuthorizerSigner:    m.authorizerSigner,
		AuthorizerSubmitter: m.authorizerSubmitter,
	}
}

func scheduledSuffixContext(network string, payload map[string]interface{}, asset, payTo string) evm.DataSuffixContext {
	accepted := types.PaymentRequirements{
		Scheme:            batchsettlement.SchemeBatched,
		Network:           network,
		Asset:             asset,
		Amount:            "0",
		PayTo:             payTo,
		MaxTimeoutSeconds: 0,
		Extra:             map[string]interface{}{},
	}
	return evm.DataSuffixContext{
		Payload: types.PaymentPayload{
			X402Version: 2,
			Accepted:    accepted,
			Payload:     payload,
		},
		Requirements: accepted,
	}
}

func groupByNetwork(channels []*FacilitatorChannel) (map[string][]*FacilitatorChannel, []string) {
	groups := make(map[string][]*FacilitatorChannel)
	order := make([]string, 0)
	for _, channel := range channels {
		if _, ok := groups[channel.Network]; !ok {
			order = append(order, channel.Network)
		}
		groups[channel.Network] = append(groups[channel.Network], channel)
	}
	return groups, order
}

func channelBases(channels []*FacilitatorChannel) []*storage.Channel {
	out := make([]*storage.Channel, 0, len(channels))
	for _, ch := range channels {
		if ch != nil {
			out = append(out, ch.Base())
		}
	}
	return out
}
