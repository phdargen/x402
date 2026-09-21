package facilitator

import (
	"context"
	"fmt"
	"math/big"
	"strings"
	"sync"
	"time"

	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/evm"
	batchsettlement "github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement"
	"github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement/storage"
	"github.com/x402-foundation/x402/go/v2/types"
)

// FacilitatorRetention is the row retention policy after a channel closes.
type FacilitatorRetention string

const (
	RetentionUntilClosed FacilitatorRetention = "until-closed"
	RetentionForever     FacilitatorRetention = "forever"
)

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
}

// FacilitatorClaimOptions is optional batching and idle filter for Claim.
type FacilitatorClaimOptions struct {
	MaxClaimsPerBatch int
	IdleSecs          *int
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

// AfterClaim applies claimed totals, subtracts attested chargeCount, and deletes closed rows.
// Call only after a successful onchain claim.
func AfterClaim(
	ctx context.Context,
	store storage.ChannelStorage[*FacilitatorChannel],
	lockStorage storage.ChannelLockStorage,
	claims []batchsettlement.BatchSettlementVoucherClaim,
	network string,
	attested map[string]int,
	authStore storage.DelegatedAuthStore,
	retention FacilitatorRetention,
) error {
	if retention == "" {
		retention = RetentionUntilClosed
	}
	if err := storage.ApplyClaimedTotals(ctx, store, claims, network); err != nil {
		return err
	}
	for _, claim := range claims {
		channelId, err := batchsettlement.ComputeChannelId(claim.Voucher.Channel, network)
		if err != nil {
			return err
		}
		snapshot := attested[strings.ToLower(channelId)]
		deletable := retention != RetentionForever
		held := deletable && lockStorage != nil && channelIsHeld(ctx, lockStorage, channelId)
		result, err := store.UpdateChannel(ctx, channelId, func(current *FacilitatorChannel) *FacilitatorChannel {
			if current == nil {
				return current
			}
			chargeCount := current.ChargeCount - snapshot
			if chargeCount < 0 {
				chargeCount = 0
			}
			closed := deletable && !held && chargeCount == 0 && uintCmp(current.Balance, current.TotalClaimed) <= 0
			if closed {
				return nil
			}
			next := current.Clone()
			next.ChargeCount = chargeCount
			return next
		})
		if err != nil {
			return err
		}
		if result != nil && result.Status == storage.ChannelDeleted && authStore != nil {
			_ = authStore.Delete(ctx, channelId, network)
		}
	}
	return nil
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
	retention := config.Retention
	if retention == "" {
		retention = RetentionUntilClosed
	}
	submitMode := config.SubmitMode
	if submitMode == "" {
		submitMode = SubmitModeRelay
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
		timers:              make(map[autoJob]*time.Ticker),
		stopChans:           make(map[autoJob]chan struct{}),
		pendingJobs:         make(map[autoJob]struct{}),
	}, nil
}

// Claim claims eligible vouchers, grouped by network, withdraw-pending first.
func (m *FacilitatorChannelManager) Claim(ctx context.Context, opts *FacilitatorClaimOptions) ([]FacilitatorClaimResult, error) {
	filter := storage.ChannelQuery{Kind: storage.QueryKindClaimable}
	if opts != nil && opts.IdleSecs != nil {
		idleAt := time.Now().UnixMilli() - int64(*opts.IdleSecs)*1000
		filter.IdleAtOrBefore = &idleAt
	}
	page, err := storage.QueryChannels(ctx, m.storage, filter, nil)
	if err != nil {
		return nil, err
	}
	byNetwork, order := groupByNetwork(page.Items)
	results := make([]FacilitatorClaimResult, 0)
	maxClaimsPerBatch := 100
	if opts != nil && opts.MaxClaimsPerBatch > 0 {
		maxClaimsPerBatch = opts.MaxClaimsPerBatch
	}

	for _, network := range order {
		group := byNetwork[network]
		selectOpts := &storage.SelectClaimableOptions{Now: time.Now().UnixMilli()}
		if opts != nil && opts.IdleSecs != nil {
			selectOpts.IdleSecs = opts.IdleSecs
		}
		claims := storage.SelectClaimableVouchers(channelBases(group), selectOpts)
		if len(claims) == 0 {
			continue
		}
		for i := 0; i < len(claims); i += maxClaimsPerBatch {
			end := i + maxClaimsPerBatch
			if end > len(claims) {
				end = len(claims)
			}
			batch := claims[i:end]
			result, attested, err := m.submitClaimBatch(ctx, network, batch, group)
			if err != nil {
				return nil, err
			}
			results = append(results, result)
			if err := AfterClaim(ctx, m.storage, m.lockStorage, batch, network, attested, m.delegatedAuthStore, m.retention); err != nil {
				return nil, err
			}
		}
	}
	if len(results) > 0 {
		m.mu.Lock()
		m.pendingSettle = true
		m.mu.Unlock()
	}
	return results, nil
}

// Settle settles claimed-but-unsettled funds for each distinct (network, receiver, token).
func (m *FacilitatorChannelManager) Settle(ctx context.Context) ([]FacilitatorSettleResult, error) {
	page, err := storage.QuerySettleTargets(ctx, m.storage, storage.SettleQuery{}, nil)
	if err != nil {
		return nil, err
	}
	if len(page.Items) == 0 {
		m.mu.Lock()
		m.pendingSettle = false
		m.mu.Unlock()
		return nil, nil
	}

	results := make([]FacilitatorSettleResult, 0)
	for _, target := range page.Items {
		payload := &batchsettlement.BatchSettlementSettlePayload{
			Type:     "settle",
			Receiver: target.Receiver,
			Token:    target.Token,
		}
		dataSuffix, err := m.resolveBuilderSuffix(target.Network, payload.ToMap(), target.Token, target.Receiver)
		if err != nil {
			return nil, err
		}
		reqs := types.PaymentRequirements{Network: target.Network}
		response, err := ExecuteSettle(ctx, m.signer, payload, reqs, dataSuffix)
		if err != nil {
			return nil, err
		}
		if !response.Success {
			if response.ErrorReason == ErrNothingToSettle {
				continue
			}
			return nil, fmt.Errorf("%s", formatFailure("Settle", response))
		}
		results = append(results, FacilitatorSettleResult{
			Network:     target.Network,
			Receiver:    target.Receiver,
			Token:       target.Token,
			Transaction: response.Transaction,
		})
	}
	m.mu.Lock()
	m.pendingSettle = false
	m.mu.Unlock()
	return results, nil
}

// ClaimAndSettle claims eligible vouchers then settles.
func (m *FacilitatorChannelManager) ClaimAndSettle(ctx context.Context, opts *FacilitatorClaimOptions) (claims []FacilitatorClaimResult, settle []FacilitatorSettleResult, err error) {
	claims, err = m.Claim(ctx, opts)
	if err != nil {
		return nil, nil, err
	}
	if len(claims) > 0 {
		settle, err = m.Settle(ctx)
		if err != nil {
			return claims, nil, err
		}
	}
	return claims, settle, nil
}

// Refund cooperatively refunds stored channels with remaining escrow.
func (m *FacilitatorChannelManager) Refund(ctx context.Context) ([]FacilitatorRefundResult, error) {
	page, err := storage.QueryChannels(ctx, m.storage, storage.ChannelQuery{Kind: storage.QueryKindIdleRefundable}, nil)
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

func (m *FacilitatorChannelManager) submitClaimBatch(
	ctx context.Context,
	network string,
	claims []batchsettlement.BatchSettlementVoucherClaim,
	rows []*FacilitatorChannel,
) (FacilitatorClaimResult, map[string]int, error) {
	counts, attested, err := SnapshotClaimChargeCounts(ctx, m.storage, claims, network, rows)
	if err != nil {
		return FacilitatorClaimResult{}, nil, err
	}
	asset := "0x0000000000000000000000000000000000000000"
	payTo := "0x0000000000000000000000000000000000000000"
	if len(claims) > 0 {
		asset = claims[0].Voucher.Channel.Token
		payTo = claims[0].Voucher.Channel.Receiver
	}
	payload := &batchsettlement.BatchSettlementClaimPayload{Type: "claim", Claims: claims}
	builderSuffix, err := m.resolveBuilderSuffix(network, payload.ToMap(), asset, payTo)
	if err != nil {
		return FacilitatorClaimResult{}, nil, err
	}
	dataSuffix, err := batchsettlement.ComposeClaimDataSuffix(counts, builderSuffix)
	if err != nil {
		return FacilitatorClaimResult{}, nil, err
	}
	response, err := SubmitClaim(ctx, SubmitClaimInput{
		Network:    network,
		Claims:     claims,
		DataSuffix: dataSuffix,
	}, m.submitContext())
	if err != nil {
		return FacilitatorClaimResult{}, nil, err
	}
	if !response.Success {
		return FacilitatorClaimResult{}, nil, fmt.Errorf("%s", formatFailure("Claim", response))
	}
	return FacilitatorClaimResult{
		Network:     network,
		Vouchers:    len(claims),
		Transaction: response.Transaction,
	}, attested, nil
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
		result, attested, err := m.submitClaimBatch(ctx, target.Network, claims, []*FacilitatorChannel{target})
		if err != nil {
			return nil, err
		}
		if err := AfterClaim(ctx, m.storage, m.lockStorage, claims, target.Network, attested, m.delegatedAuthStore, m.retention); err != nil {
			return nil, err
		}
		return &FacilitatorRefundResult{
			Network:     target.Network,
			Channel:     target.ChannelId,
			Transaction: result.Transaction,
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
	if len(claims) > 0 {
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

	var refunded map[string]interface{}
	if response.Extra != nil {
		refunded, _ = response.Extra["channelState"].(map[string]interface{})
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

	if m.retention == RetentionForever {
		return nil
	}
	held := m.lockStorage != nil && channelIsHeld(ctx, m.lockStorage, target.ChannelId)
	result, err := m.storage.UpdateChannel(ctx, target.ChannelId, func(current *FacilitatorChannel) *FacilitatorChannel {
		if current == nil {
			return current
		}
		if !held && current.ChargeCount == 0 && uintCmp(current.Balance, current.TotalClaimed) <= 0 {
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
	page, err := storage.QueryChannels(ctx, m.storage, storage.ChannelQuery{
		Kind:           storage.QueryKindIdleRefundable,
		IdleAtOrBefore: &idleAt,
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
	results, err := m.Claim(context.Background(), opts)
	if err != nil {
		if cfg.OnError != nil {
			cfg.OnError(err)
		}
		return
	}
	if cfg.OnClaim != nil {
		for _, result := range results {
			cfg.OnClaim(result)
		}
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
	results, err := m.Settle(context.Background())
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
