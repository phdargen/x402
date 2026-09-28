package facilitator

import (
	"context"
	"errors"
	"fmt"

	"github.com/x402-foundation/x402/go/v2/mechanisms/svm"
	batchsettlement "github.com/x402-foundation/x402/go/v2/mechanisms/svm/batch-settlement"
	"github.com/x402-foundation/x402/go/v2/types"
)

// AssertBindingSource requires a store or an explicit history reader, and rejects a value that lacks its methods.
func AssertBindingSource(config BindingSourceConfig) error {
	if config.ReceiverAuthorizerStore != nil {
		if _, ok := config.ReceiverAuthorizerStore.(ReceiverAuthorizerStore); !ok {
			return errors.New("receiverAuthorizerStore must implement bind, get, and delete")
		}
	}
	if config.ReceiverBindingHistoryReader != nil {
		if _, ok := config.ReceiverBindingHistoryReader.(ReceiverBindingHistoryReader); !ok {
			return errors.New("receiverBindingHistoryReader must implement getSignaturesForAddress and getTransaction")
		}
	}
	if config.ReceiverAuthorizerStore == nil && config.ReceiverBindingHistoryReader == nil {
		return errors.New("BatchSvmScheme requires a receiverAuthorizerStore or a receiverBindingHistoryReader")
	}
	return nil
}

// AssertDelegatedReceiverAuth requires the delegated-auth callbacks when the option is set.
func AssertDelegatedReceiverAuth(delegated *DelegatedReceiverAuth) (*DelegatedReceiverAuth, error) {
	if delegated == nil {
		return nil, nil
	}
	if !svm.ValidateSolanaAddress(delegated.ReceiverAuthorizer) || delegated.ResolveCallerIdentity == nil {
		return nil, errors.New("delegatedReceiverAuth requires a receiverAuthorizer address and resolveCallerIdentity")
	}
	if _, ok := delegated.IdentityStore.(DelegatedAuthStore); !ok {
		return nil, errors.New("delegatedReceiverAuth.identityStore must implement bind, get, and delete")
	}
	return delegated, nil
}

// ReadReceiverAuthorizer returns the receiver authorizer bound to a channel.
// A store hit is not re-read. A history read is written back when a store is configured.
func ReadReceiverAuthorizer(
	ctx context.Context,
	store ReceiverAuthorizerStore,
	history ReceiverBindingHistoryReader,
	network, channelID string,
) (string, error) {
	if store != nil {
		stored, err := store.Get(ctx, network, channelID)
		if err != nil {
			return "", err
		}
		if stored != nil {
			return stored.ReceiverAuthorizer, nil
		}
	}
	if history == nil {
		return "", nil
	}
	fromHistory, err := readBindingFromHistory(ctx, history, network, channelID)
	if err != nil || fromHistory == "" {
		return "", err
	}
	if store != nil {
		err := store.Bind(ctx, ReceiverAuthorizerBinding{
			Network:            network,
			ChannelID:          channelID,
			ReceiverAuthorizer: fromHistory,
		})
		if err != nil {
			if errors.Is(err, ErrReceiverAuthorizerConflict) {
				return "", fmt.Errorf("%s: %s", batchsettlement.ErrReceiverAuthorizerMismatch, err.Error())
			}
			return "", err
		}
	}
	return fromHistory, nil
}

// DelegatedIdentityForOpen returns the caller identity required before a delegated open is broadcast.
func DelegatedIdentityForOpen(
	ctx context.Context,
	delegated *DelegatedReceiverAuth,
	receiverAuthorizer, channelID, payer string,
	requirements types.PaymentRequirements,
	facilitatorContext any,
) (string, error) {
	if delegated == nil || receiverAuthorizer != delegated.ReceiverAuthorizer {
		return "", nil
	}
	identity, err := ResolveDelegatedIdentity(ctx, delegated, DelegatedSettleContext{
		Step:               DelegatedStepDeposit,
		ChannelID:          channelID,
		Network:            requirements.Network,
		Payer:              payer,
		FacilitatorContext: facilitatorContext,
	})
	if err != nil {
		return "", err
	}
	if identity == "" {
		return "", fmt.Errorf("%s: caller identity is required to open a delegated channel", batchsettlement.ErrDelegatedUnauthenticated)
	}
	return identity, nil
}

// IsDelegatedAuthorizer reports whether bound is the key this facilitator advertises for delegated closes.
func IsDelegatedAuthorizer(delegated *DelegatedReceiverAuth, bound string) bool {
	return delegated != nil && delegated.ReceiverAuthorizer == bound
}

// ResolveDelegatedIdentity resolves a delegated settle's caller identity.
// An error or an empty result is unauthenticated.
func ResolveDelegatedIdentity(ctx context.Context, delegated *DelegatedReceiverAuth, settle DelegatedSettleContext) (string, error) {
	if delegated == nil || delegated.ResolveCallerIdentity == nil {
		return "", nil
	}
	identity, err := delegated.ResolveCallerIdentity(ctx, settle)
	if err != nil || identity == "" {
		return "", nil //nolint:nilerr // an identity error is unauthenticated, not a transport failure
	}
	return identity, nil
}

// StoredDelegatedIdentity returns the identity recorded for a delegated channel.
func StoredDelegatedIdentity(ctx context.Context, delegated *DelegatedReceiverAuth, network, channelID string) (string, error) {
	if delegated == nil {
		return "", nil
	}
	store, ok := delegated.IdentityStore.(DelegatedAuthStore)
	if !ok || store == nil {
		return "", nil
	}
	stored, err := store.Get(ctx, network, channelID)
	if err != nil || stored == nil {
		return "", err
	}
	return stored.CallerIdentity, nil
}

// CalculateDistributionAmount sums the still-undistributed settled amount across channels.
func CalculateDistributionAmount(channels []struct{ PayoutWatermark, Settled uint64 }) (uint64, error) {
	var total uint64
	for _, channel := range channels {
		if channel.PayoutWatermark > channel.Settled {
			return 0, fmt.Errorf("%s: payout watermark exceeds settled amount", batchsettlement.ErrChannelState)
		}
		total += channel.Settled - channel.PayoutWatermark
	}
	return total, nil
}

func readBindingFromHistory(
	ctx context.Context,
	history ReceiverBindingHistoryReader,
	network, channelID string,
) (string, error) {
	limit := BindingHistoryPageLimit
	var pages [][]ReceiverBindingHistorySignature
	var before *string
	for {
		page, err := history.GetSignaturesForAddress(ctx, network, channelID, before, &limit)
		if err != nil {
			return "", err
		}
		if len(page) == 0 {
			break
		}
		pages = append(pages, page)
		oldest := page[len(page)-1]
		if len(page) < BindingHistoryPageLimit {
			break
		}
		before = &oldest.Signature
	}
	for pageIndex := len(pages) - 1; pageIndex >= 0; pageIndex-- {
		page := pages[pageIndex]
		for index := len(page) - 1; index >= 0; index-- {
			item := page[index]
			if item.Err != nil {
				continue
			}
			wire, err := history.GetTransaction(ctx, network, item.Signature)
			if err != nil {
				return "", err
			}
			if wire == "" {
				continue
			}
			bound, ok := batchsettlement.ReadReceiverBindingFromOpen(wire, channelID)
			if ok {
				return bound, nil
			}
		}
	}
	return "", nil
}
