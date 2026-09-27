package facilitator

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
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
	// SettleTargetStorage tracks claimed (network, receiver, token) pairs.
	// Nil derives pairs from channel rows with totalClaimed > 0.
	SettleTargetStorage storage.SettleTargetStorage
	// Logger receives facilitator events. Nil uses slog.Default().
	Logger *slog.Logger
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
	// MaxTxsPerRun caps claim transactions per run. The default selector reads
	// at most MaxTxsPerRun * MaxClaimsPerBatch rows.
	MaxTxsPerRun int
	// SelectClaimRows overrides claim selection. Nil queries up to capacity,
	// then orders withdraw-pending rows ahead of the highest unclaimed.
	SelectClaimRows func(ctx context.Context, query func(storage.ChannelQuery) ([]*FacilitatorChannel, error), capacity int) ([]*FacilitatorChannel, error)
	// OnError receives a batch failure. channelID is empty for a batch-level
	// failure and set for a row isolated by bisect. Nil logs the error.
	OnError func(err error, channelID string)
}

// FacilitatorRefundOptions bounds one idle-refund pass. IdleSecs must be > 0.
type FacilitatorRefundOptions struct {
	IdleSecs int
	Limit    int
	OnError  func(err error, channelID string)
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
	claims []batchsettlement.BatchSettlementVoucherClaim,
	network string,
	attested map[string]int,
	targetStore storage.SettleTargetStorage,
) error {
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
			if err := targetStore.RecordClaimed(ctx, delta); err != nil {
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

func rowLookup(
	ctx context.Context,
	store storage.ChannelStorage[*FacilitatorChannel],
	known []*FacilitatorChannel,
) func(channelID string) (*FacilitatorChannel, error) {
	rows := make(map[string]*FacilitatorChannel, len(known))
	for _, row := range known {
		if row != nil {
			rows[strings.ToLower(row.ChannelId)] = row
		}
	}
	return func(channelID string) (*FacilitatorChannel, error) {
		if row := rows[strings.ToLower(channelID)]; row != nil {
			return row, nil
		}
		return store.Get(ctx, channelID)
	}
}

func settleTargetClaimDeltas(
	ctx context.Context,
	store storage.ChannelStorage[*FacilitatorChannel],
	claims []batchsettlement.BatchSettlementVoucherClaim,
	network string,
	known []*FacilitatorChannel,
) ([]storage.SettleTargetClaimDelta, error) {
	lookup := rowLookup(ctx, store, known)
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
		stored, err := lookup(channelID)
		if err != nil {
			return nil, err
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
	return targets.RecordClaimed(ctx, storage.SettleTargetClaimDelta{
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
	lookup := rowLookup(ctx, store, known)
	for _, claim := range claims {
		channelId, err := batchsettlement.ComputeChannelId(claim.Voucher.Channel, network)
		if err != nil {
			return nil, nil, err
		}
		key := strings.ToLower(channelId)
		stored, err := lookup(channelId)
		if err != nil {
			return nil, nil, err
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
	logger              *slog.Logger

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
		settleTargets = storage.NewChannelSettleTargets(config.Storage)
	}
	logger := config.Logger
	if logger == nil {
		logger = slog.Default()
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
		logger:              logger,
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
				return results, err
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
					return results, ctx.Err()
				}
				var batchErr *batchClaimError
				if errors.As(err, &batchErr) {
					reportClaimError(m.logger, opts, batchErr.err, "")
					txCount++
					continue
				}
				return results, err
			}
			if len(batchResults) == 0 {
				continue
			}
			txCount += len(batchResults)
			results = append(results, batchResults...)
		}
	}
	return results, nil
}

type receiverPendingRead struct {
	target  storage.SettleTarget
	pending *big.Int
}

// Settle settles eligible receiver pairs and cleans up when pending reaches zero.
func (m *FacilitatorChannelManager) Settle(
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
		return nil, nil
	}

	reads, err := m.readReceiverPending(ctx, targets)
	if err != nil {
		return nil, err
	}
	toSettle := make([]storage.SettleTarget, 0, receiverBudget)
	now := time.Now().UnixMilli()
	visited := make([]receiverPendingRead, 0, len(reads))
	for _, row := range reads {
		visited = append(visited, row)
		if row.pending.Sign() == 0 {
			if err := m.cleanupSettledPair(ctx, row.target); err != nil {
				target := row.target
				reportSettleError(m.logger, opts, err, &target)
			}
			continue
		}
		if minPending != nil && row.pending.Cmp(minPending) <= 0 {
			continue
		}
		toSettle = append(toSettle, row.target)
		if len(toSettle) >= receiverBudget {
			break
		}
	}
	m.observeSettlePending(ctx, visited, now)
	if len(toSettle) == 0 {
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
				reportSettleError(m.logger, opts, err, nil)
				continue
			}
			submissions, skipped, err := submitSettleMulticall(ctx, m.logger, m.signer, x402.Network(network), batch, dataSuffix)
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
				reportSettleError(m.logger, opts, err, nil)
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
	m.observeSettlePending(ctx, confirm, time.Now().UnixMilli())
	for _, row := range confirm {
		if row.pending.Sign() != 0 {
			continue
		}
		if err := m.cleanupSettledPair(ctx, row.target); err != nil {
			target := row.target
			reportSettleError(m.logger, opts, err, &target)
		}
	}
	return results, nil
}

func (m *FacilitatorChannelManager) observeSettlePending(ctx context.Context, reads []receiverPendingRead, atMillis int64) {
	observer, ok := m.settleTargetStorage.(storage.SettleTargetObserver)
	if !ok || len(reads) == 0 {
		return
	}
	obs := make([]storage.SettleTargetObservation, 0, len(reads))
	for _, row := range reads {
		obs = append(obs, storage.SettleTargetObservation{
			Target:   row.target,
			Pending:  row.pending,
			AtMillis: atMillis,
		})
	}
	if err := observer.ObserveSettlePending(ctx, obs); err != nil {
		m.logger.Warn("batch-settlement: observe settle pending", "error", err)
	}
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

func (m *FacilitatorChannelManager) collectSettleTargetPages(
	ctx context.Context,
	pageSize int,
	budget int,
	minPending *big.Int,
) ([]storage.SettleTarget, error) {
	if budget <= 0 {
		return nil, nil
	}
	out := make([]storage.SettleTarget, 0, budget)
	cursor := ""
	for len(out) < budget {
		limit := pageSize
		if budget-len(out) < limit {
			limit = budget - len(out)
		}
		page, err := m.settleTargetStorage.ListSettleTargets(ctx, storage.SettleQuery{
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
			m.logger.Warn("batch-settlement: settle receiver read failed", "receiver", target.Receiver, "token", target.Token, "network", target.Network)
			continue
		}
		totalClaimed, totalSettled, parseErr := parseReceiversMulticallResult(results[i].Result)
		if parseErr != nil {
			m.logger.Warn("batch-settlement: settle receiver read failed", "receiver", target.Receiver, "token", target.Token, "network", target.Network, "error", parseErr)
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
	if err := m.settleTargetStorage.RemoveSettleTarget(ctx, target); err != nil {
		return err
	}
	if m.retention != RetentionWhenUnused {
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

// RefundIdleChannels refunds idle channels that still hold escrow.
// A failure on one channel is reported through OnError and the pass continues.
func (m *FacilitatorChannelManager) RefundIdleChannels(ctx context.Context, opts FacilitatorRefundOptions) ([]FacilitatorRefundResult, error) {
	if opts.IdleSecs <= 0 {
		return nil, fmt.Errorf("refund idleSecs must be greater than 0")
	}
	idleAt := time.Now().UnixMilli() - int64(opts.IdleSecs)*1000
	channels, err := m.queryRefundable(ctx, &idleAt, opts.Limit)
	if err != nil {
		return nil, err
	}
	return m.refundChannels(ctx, channels, opts.OnError)
}

func (m *FacilitatorChannelManager) queryRefundable(ctx context.Context, idleAt *int64, limit int) ([]*FacilitatorChannel, error) {
	if limit <= 0 {
		limit = 100
	}
	page, err := storage.QueryChannels(ctx, m.storage, storage.ChannelQuery{
		Kind:           storage.QueryKindIdleRefundable,
		IdleAtOrBefore: idleAt,
		Limit:          &limit,
	}, nil)
	if err != nil {
		return nil, err
	}
	return page.Items, nil
}

func (m *FacilitatorChannelManager) refundChannels(ctx context.Context, channels []*FacilitatorChannel, onError func(error, string)) ([]FacilitatorRefundResult, error) {
	results := make([]FacilitatorRefundResult, 0)
	for _, channel := range channels {
		if err := ctx.Err(); err != nil {
			return results, err
		}
		if channel == nil {
			continue
		}
		if m.lockStorage != nil && channelIsHeld(ctx, m.lockStorage, channel.ChannelId) {
			continue
		}
		result, err := m.refundChannel(ctx, channel)
		if err != nil {
			if ctx.Err() != nil {
				return results, ctx.Err()
			}
			reportRefundError(m.logger, onError, err, channel.ChannelId)
			continue
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
	attested := 0
	if len(claims) > 0 {
		newClaimed := refundClaimedTotal(target.TotalClaimed, claims, refunded)
		if err := applyClaimedSettleDelta(ctx, m.settleTargetStorage, target.Network, target.ChannelConfig.Receiver, target.ChannelConfig.Token, newClaimed, target.TotalClaimed); err != nil {
			return err
		}
		for _, claim := range claims {
			if _, err := batchsettlement.ComputeChannelId(claim.Voucher.Channel, target.Network); err != nil {
				return err
			}
		}
		attested = target.ChargeCount
	}

	held := m.lockStorage != nil && channelIsHeld(ctx, m.lockStorage, target.ChannelId)
	result, err := m.storage.UpdateChannel(ctx, target.ChannelId, func(current *FacilitatorChannel) *FacilitatorChannel {
		return applyRefundChannel(current, claims, attested, refunded, held, m.retention)
	})
	if err != nil {
		return err
	}
	if result != nil && result.Status == storage.ChannelDeleted && m.delegatedAuthStore != nil {
		_ = m.delegatedAuthStore.Delete(ctx, target.ChannelId, target.Network)
	}
	return nil
}

func applyRefundChannel(
	current *FacilitatorChannel,
	claims []batchsettlement.BatchSettlementVoucherClaim,
	attested int,
	refunded map[string]interface{},
	held bool,
	retention FacilitatorRetention,
) *FacilitatorChannel {
	if current == nil {
		return current
	}
	next := current.Clone()
	if len(claims) > 0 {
		for _, claim := range claims {
			applyClaimedAmount(next, claim.TotalClaimed)
		}
		next.ChargeCount = current.ChargeCount - attested
		if next.ChargeCount < 0 {
			next.ChargeCount = 0
		}
	}
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
	appliedTotalClaimed := next.TotalClaimed
	if refunded != nil {
		if v, ok := refunded["totalClaimed"].(string); ok {
			appliedTotalClaimed = v
		}
	}
	if ShouldDeleteNeverClaimedRefundRow(retention, held, next, next.ChargeCount, appliedTotalClaimed) {
		return nil
	}
	return next
}

func applyClaimedAmount(next *FacilitatorChannel, claimed string) {
	claimedAmount, ok := new(big.Int).SetString(claimed, 10)
	if !ok || claimedAmount.Sign() < 0 {
		return
	}
	currentClaimed, ok := new(big.Int).SetString(next.TotalClaimed, 10)
	if !ok || currentClaimed.Sign() < 0 {
		return
	}
	if claimedAmount.Cmp(currentClaimed) <= 0 {
		return
	}
	next.TotalClaimed = claimedAmount.String()
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
