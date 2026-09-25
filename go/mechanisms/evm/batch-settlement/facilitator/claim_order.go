package facilitator

import (
	"context"
	"errors"
	"log"
	"math/big"
	"sort"
	"strings"

	"github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement/storage"
)

type claimSortClass int

const (
	claimSortWithdraw claimSortClass = iota
	claimSortReserved
	claimSortUnclaimed
)

type claimSortKey struct {
	class      claimSortClass
	withdrawAt int
	unclaimed  *big.Int
}

func reportClaimError(opts *FacilitatorClaimOptions, err error, channelID string) {
	if err == nil || errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return
	}
	if opts != nil && opts.OnError != nil {
		opts.OnError(err, channelID)
		return
	}
	if channelID != "" {
		log.Printf("batch-settlement: claim channel %s: %v", channelID, err)
		return
	}
	log.Printf("batch-settlement: claim: %v", err)
}

func reportSettleError(opts *FacilitatorSettleOptions, err error, target *storage.SettleTarget) {
	if err == nil || errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return
	}
	if opts != nil && opts.OnError != nil {
		opts.OnError(err, target)
		return
	}
	if target != nil {
		log.Printf("batch-settlement: settle %s %s: %v", target.Receiver, target.Token, err)
		return
	}
	log.Printf("batch-settlement: settle: %v", err)
}

// sortClaimRows orders withdraw-pending rows first (earliest request), then
// reserved idle rows, then highest unclaimed. Keys are computed before the sort.
func sortClaimRows(rows []*FacilitatorChannel, reserved map[string]struct{}) {
	type keyed struct {
		row *FacilitatorChannel
		key claimSortKey
	}
	keyedRows := make([]keyed, len(rows))
	for i, row := range rows {
		keyedRows[i] = keyed{row: row, key: claimSortKeyFor(row, reserved)}
	}
	sort.SliceStable(keyedRows, func(i, j int) bool {
		return claimSortLess(keyedRows[i].key, keyedRows[j].key)
	})
	for i := range keyedRows {
		rows[i] = keyedRows[i].row
	}
}

func claimSortKeyFor(row *FacilitatorChannel, reserved map[string]struct{}) claimSortKey {
	if row != nil && row.WithdrawRequestedAt > 0 {
		return claimSortKey{class: claimSortWithdraw, withdrawAt: row.WithdrawRequestedAt}
	}
	if row != nil && reserved != nil {
		if _, ok := reserved[strings.ToLower(row.ChannelId)]; ok {
			return claimSortKey{class: claimSortReserved}
		}
	}
	unclaimed := new(big.Int)
	if row != nil {
		charged, chargedOk := storage.ParseUint256(row.ChargedCumulativeAmount)
		claimed, claimedOk := storage.ParseUint256(row.TotalClaimed)
		if chargedOk && claimedOk && charged.Cmp(claimed) > 0 {
			unclaimed = new(big.Int).Sub(charged, claimed)
		}
	}
	return claimSortKey{class: claimSortUnclaimed, unclaimed: unclaimed}
}

func claimSortLess(a, b claimSortKey) bool {
	if a.class != b.class {
		return a.class < b.class
	}
	if a.class == claimSortWithdraw && a.withdrawAt != b.withdrawAt {
		return a.withdrawAt < b.withdrawAt
	}
	if a.class == claimSortUnclaimed {
		if a.unclaimed == nil || b.unclaimed == nil {
			return false
		}
		return a.unclaimed.Cmp(b.unclaimed) > 0
	}
	return false
}

func (m *FacilitatorChannelManager) loadClaimRows(
	ctx context.Context,
	opts *FacilitatorClaimOptions,
	maxClaimsPerBatch int,
) ([]*FacilitatorChannel, error) {
	filter, capacity := buildClaimQuery(opts, maxClaimsPerBatch)
	page, err := storage.QueryChannels(ctx, m.storage, filter, nil)
	if err != nil {
		return nil, err
	}
	items := page.Items
	reserved := map[string]struct{}{}
	if capacity > 0 && len(items) > capacity {
		if opts != nil && opts.OldestFirst {
			items, reserved, err = m.fillClaimOverflow(ctx, filter, items, capacity)
			if err != nil {
				return nil, err
			}
		} else {
			items = items[:capacity]
		}
	}
	sortClaimRows(items, reserved)
	return items, nil
}

// fillClaimOverflow keeps every withdraw-pending row, reserves capacity/5 of the
// oldest idle rows from the probe, and fills the rest from an unclaimed-desc query.
func (m *FacilitatorChannelManager) fillClaimOverflow(
	ctx context.Context,
	filter storage.ChannelQuery,
	probe []*FacilitatorChannel,
	capacity int,
) ([]*FacilitatorChannel, map[string]struct{}, error) {
	pending := make([]*FacilitatorChannel, 0)
	idle := make([]*FacilitatorChannel, 0)
	for _, row := range probe {
		if row == nil {
			continue
		}
		if row.WithdrawRequestedAt > 0 {
			pending = append(pending, row)
			continue
		}
		idle = append(idle, row)
	}
	sort.SliceStable(idle, func(i, j int) bool {
		return idle[i].LastRequestTimestamp < idle[j].LastRequestTimestamp
	})
	reserveN := capacity / 5
	if reserveN > len(idle) {
		reserveN = len(idle)
	}
	reservedRows := idle[:reserveN]
	reserved := make(map[string]struct{}, reserveN)
	selected := make([]*FacilitatorChannel, 0, capacity)
	seen := make(map[string]struct{}, capacity)
	for _, row := range pending {
		id := strings.ToLower(row.ChannelId)
		if _, ok := seen[id]; ok {
			continue
		}
		seen[id] = struct{}{}
		selected = append(selected, row)
	}
	for _, row := range reservedRows {
		id := strings.ToLower(row.ChannelId)
		reserved[id] = struct{}{}
		if _, ok := seen[id]; ok {
			continue
		}
		seen[id] = struct{}{}
		selected = append(selected, row)
	}
	fill := capacity - len(selected)
	if fill <= 0 {
		return selected, reserved, nil
	}
	filter.UnclaimedDesc = true
	filter.OldestFirst = false
	limit := capacity
	filter.Limit = &limit
	page, err := storage.QueryChannels(ctx, m.storage, filter, nil)
	if err != nil {
		return nil, nil, err
	}
	if page == nil {
		return selected, reserved, nil
	}
	for _, row := range page.Items {
		if row == nil {
			continue
		}
		id := strings.ToLower(row.ChannelId)
		if _, ok := seen[id]; ok {
			continue
		}
		seen[id] = struct{}{}
		selected = append(selected, row)
		fill--
		if fill == 0 {
			break
		}
	}
	return selected, reserved, nil
}
