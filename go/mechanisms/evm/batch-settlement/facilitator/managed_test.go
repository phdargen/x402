package facilitator

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math/big"
	"strings"
	"testing"
	"time"

	"github.com/ethereum/go-ethereum/crypto"

	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/evm"
	batchsettlement "github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement"
	"github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement/storage"
	"github.com/x402-foundation/x402/go/v2/types"
)

const (
	managedNetwork     = "eip155:84532"
	managedPayer       = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"
	managedReceiver    = "0x9876543210987654321098765432109876543210"
	managedToken       = "0x036CbD53842c5426634e7929541eC2318f3dCF7e"
	managedFacilitator = "0xFAC11174700123456789012345678901234aBCDe"
	managedAuthKeyHex  = "59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"
	dummySig           = "0xfeedface"
	successTxHash      = "0xabababababababababababababababababababababababababababababababab"
)

func managedSalt(suffix string) string {
	if suffix == "" {
		suffix = "00"
	}
	if len(suffix) == 1 {
		suffix = "0" + suffix
	}
	return "0x" + strings.Repeat("00", 31) + suffix
}

func managedAuthorizer() *fakeAuthorizerSigner {
	key, err := crypto.HexToECDSA(managedAuthKeyHex)
	if err != nil {
		panic(err)
	}
	return &fakeAuthorizerSigner{addr: crypto.PubkeyToAddress(key.PublicKey).Hex()}
}

func managedConfig(authorizer string, saltSuffix string) batchsettlement.ChannelConfig {
	if saltSuffix == "" {
		saltSuffix = "00"
	}
	return batchsettlement.ChannelConfig{
		Payer:              managedPayer,
		PayerAuthorizer:    zeroAddress,
		Receiver:           managedReceiver,
		ReceiverAuthorizer: authorizer,
		Token:              managedToken,
		WithdrawDelay:      900,
		Salt:               managedSalt(saltSuffix),
	}
}

func mustChannelId(t *testing.T, cfg batchsettlement.ChannelConfig) string {
	t.Helper()
	id, err := batchsettlement.ComputeChannelId(cfg, managedNetwork)
	if err != nil {
		t.Fatalf("channel id: %v", err)
	}
	return id
}

func managedRequirements(authorizer string) types.PaymentRequirements {
	return types.PaymentRequirements{
		Scheme:            batchsettlement.SchemeBatched,
		Network:           managedNetwork,
		Amount:            "1000",
		Asset:             managedToken,
		PayTo:             managedReceiver,
		MaxTimeoutSeconds: 3600,
		Extra: map[string]interface{}{
			"name":                "USDC",
			"version":             "2",
			"receiverAuthorizer":  authorizer,
			"assetTransferMethod": "eip3009",
			"withdrawDelay":       900,
			"voucherStore":        true,
		},
	}
}

func managedEnvelope(payload map[string]interface{}) types.PaymentPayload {
	return types.PaymentPayload{
		X402Version: 2,
		Payload:     payload,
		Accepted: types.PaymentRequirements{
			Scheme:  batchsettlement.SchemeBatched,
			Network: managedNetwork,
		},
	}
}

func voucherEnvelope(cfg batchsettlement.ChannelConfig, voucher batchsettlement.BatchSettlementVoucherFields, pendingId string) types.PaymentPayload {
	p := &batchsettlement.BatchSettlementVoucherPayload{
		Type:          "voucher",
		ChannelConfig: cfg,
		Voucher:       voucher,
		PendingId:     pendingId,
	}
	return managedEnvelope(p.ToMap())
}

func refundEnvelope(cfg batchsettlement.ChannelConfig, voucher batchsettlement.BatchSettlementVoucherFields, amount, pendingId, refundSig string) types.PaymentPayload {
	p := &batchsettlement.BatchSettlementRefundPayload{
		Type:          "refund",
		ChannelConfig: cfg,
		Voucher:       voucher,
		Amount:        amount,
		PendingId:     pendingId,
	}
	m := p.ToMap()
	if refundSig != "" {
		m["refundAuthorizerSignature"] = refundSig
	}
	return managedEnvelope(m)
}

func cancelEnvelope(cfg batchsettlement.ChannelConfig, voucher batchsettlement.BatchSettlementVoucherFields, pendingId string) types.PaymentPayload {
	m := voucherEnvelope(cfg, voucher, pendingId).Payload
	m["cancel"] = true
	return managedEnvelope(m)
}

func seedManagedChannel(t *testing.T, store *storage.InMemoryChannelStorage[*FacilitatorChannel], channel *FacilitatorChannel) {
	t.Helper()
	if _, err := store.UpdateChannel(context.Background(), channel.ChannelId, func(*FacilitatorChannel) *FacilitatorChannel {
		return channel.Clone()
	}); err != nil {
		t.Fatalf("seed: %v", err)
	}
}

func bindManagedIdentity(t *testing.T, store storage.DelegatedAuthStore, channelId, identity string) {
	t.Helper()
	if _, err := store.Bind(context.Background(), storage.DelegatedAuthBinding{
		ChannelId: channelId, Network: managedNetwork, CallerIdentity: identity,
	}); err != nil {
		t.Fatal(err)
	}
}

type channelFields struct {
	ChargedCumulativeAmount string
	SignedMaxClaimable      string
	Signature               string
	Balance                 string
	TotalClaimed            string
	WithdrawRequestedAt     int
	RefundNonce             int
	LastRequestTimestamp    int64
	OnchainSyncedAt         int64
	Network                 string
	ChargeCount             int
}

func storedManagedChannel(cfg batchsettlement.ChannelConfig, channelId string, overrides *channelFields) *FacilitatorChannel {
	ch := &FacilitatorChannel{
		Channel: storage.Channel{
			ChannelId:               channelId,
			ChannelConfig:           cfg,
			ChargedCumulativeAmount: "1000",
			SignedMaxClaimable:      "1000",
			Signature:               dummySig,
			Balance:                 "10000",
			TotalClaimed:            "0",
			LastRequestTimestamp:    time.Now().UnixMilli(),
			Network:                 managedNetwork,
		},
		ChargeCount: 0,
	}
	if overrides == nil {
		return ch
	}
	if overrides.ChargedCumulativeAmount != "" {
		ch.ChargedCumulativeAmount = overrides.ChargedCumulativeAmount
	}
	if overrides.SignedMaxClaimable != "" {
		ch.SignedMaxClaimable = overrides.SignedMaxClaimable
	}
	if overrides.Signature != "" {
		ch.Signature = overrides.Signature
	}
	if overrides.Balance != "" {
		ch.Balance = overrides.Balance
	}
	if overrides.TotalClaimed != "" {
		ch.TotalClaimed = overrides.TotalClaimed
	}
	if overrides.WithdrawRequestedAt != 0 {
		ch.WithdrawRequestedAt = overrides.WithdrawRequestedAt
	}
	if overrides.RefundNonce != 0 {
		ch.RefundNonce = overrides.RefundNonce
	}
	if overrides.LastRequestTimestamp != 0 {
		ch.LastRequestTimestamp = overrides.LastRequestTimestamp
	}
	if overrides.OnchainSyncedAt != 0 {
		ch.OnchainSyncedAt = overrides.OnchainSyncedAt
	}
	if overrides.Network != "" {
		ch.Network = overrides.Network
	}
	if overrides.ChargeCount != 0 {
		ch.ChargeCount = overrides.ChargeCount
	}
	return ch
}

func acquireBound(t *testing.T, store *storage.InMemoryChannelStorage[*FacilitatorChannel], pendingId string, voucher batchsettlement.BatchSettlementVoucherFields) {
	t.Helper()
	ok, err := store.Acquire(context.Background(), voucher.ChannelId, storage.AdmissionOwner(pendingId, voucher), 60_000)
	if err != nil || !ok {
		t.Fatalf("acquire bound: ok=%v err=%v", ok, err)
	}
}

func voucherFields(channelId, maxClaimable, signature string) batchsettlement.BatchSettlementVoucherFields {
	return batchsettlement.BatchSettlementVoucherFields{
		ChannelId:          channelId,
		MaxClaimableAmount: maxClaimable,
		Signature:          signature,
	}
}

type managedRPC struct {
	t               *testing.T
	balance         *big.Int
	totalClaimed    *big.Int
	refundNonce     *big.Int
	withdrawAt      int64
	receiverClaimed *big.Int
	receiverSettled *big.Int
	tryAggregate    int
	invalidSig      bool
	simFail         string
	readFail        bool
}

func newManagedSigner(t *testing.T, rpc *managedRPC) *fakeFacilitatorSigner {
	t.Helper()
	if rpc == nil {
		rpc = &managedRPC{t: t}
	}
	rpc.t = t
	if rpc.balance == nil {
		rpc.balance = big.NewInt(10000)
	}
	if rpc.totalClaimed == nil {
		rpc.totalClaimed = big.NewInt(0)
	}
	if rpc.refundNonce == nil {
		rpc.refundNonce = big.NewInt(0)
	}
	if rpc.receiverClaimed == nil {
		rpc.receiverClaimed = big.NewInt(1000)
	}
	if rpc.receiverSettled == nil {
		rpc.receiverSettled = big.NewInt(0)
	}
	return &fakeFacilitatorSigner{
		addresses: []string{managedFacilitator},
		chainId:   big.NewInt(84532),
		getCode: func(string) ([]byte, error) {
			return []byte{0x60, 0x80, 0x60, 0x40, 0x52}, nil
		},
		readContract: func(functionName string, args ...interface{}) (interface{}, error) {
			if rpc.readFail {
				return nil, fmt.Errorf("rpc down")
			}
			if functionName == "isValidSignature" {
				if rpc.invalidSig {
					return [4]byte{0xff, 0xff, 0xff, 0xff}, nil
				}
				return [4]byte{0x16, 0x26, 0xba, 0x7e}, nil
			}
			if functionName == evm.FunctionTryAggregate {
				rpc.tryAggregate++
				return multicallTryAggregateStub(t, rpc, args...), nil
			}
			if functionName == "receivers" {
				return []interface{}{rpc.receiverClaimed, rpc.receiverSettled}, nil
			}
			if rpc.simFail != "" && functionName == rpc.simFail {
				return nil, fmt.Errorf("execution reverted")
			}
			return nil, nil
		},
		writeContract: func(functionName string, _ ...interface{}) (string, error) {
			if functionName == "refundWithSignature" || functionName == "refund" || functionName == "multicall" {
				if rpc.balance.Sign() > 0 && rpc.totalClaimed != nil {
					remain := new(big.Int).Sub(rpc.balance, rpc.totalClaimed)
					if remain.Sign() > 0 {
						rpc.balance = new(big.Int).Set(rpc.totalClaimed)
					}
				}
				rpc.refundNonce = new(big.Int).Add(rpc.refundNonce, big.NewInt(1))
			}
			if functionName == "claimWithSignature" || functionName == "claim" {
				rpc.receiverClaimed = new(big.Int).Set(rpc.receiverClaimed)
			}
			return successTxHash, nil
		},
		waitForReceipt: func(txHash string) (*evm.TransactionReceipt, error) {
			return &evm.TransactionReceipt{Status: evm.TxStatusSuccess, TxHash: txHash}, nil
		},
	}
}

func managedDeps(t *testing.T, store storage.ChannelStorage[*FacilitatorChannel], lock storage.ChannelLockStorage, authorizer *fakeAuthorizerSigner, signer evm.FacilitatorEvmSigner) VoucherStoreDeps {
	t.Helper()
	if signer == nil {
		signer = newManagedSigner(t, nil)
	}
	if lock == nil {
		if ls, ok := store.(storage.ChannelLockStorage); ok {
			lock = ls
		}
	}
	return VoucherStoreDeps{
		Signer:             signer,
		AuthorizerSigner:   authorizer,
		Storage:            store,
		LockStorage:        lock,
		WithdrawDelay:      900,
		PendingStore:       x402.NewInMemoryPendingSettlementStore(),
		DelegatedAuthStore: storage.NewInMemoryDelegatedAuthStore(),
	}
}

func pendingIdFrom(resp *x402.VerifyResponse) string {
	if resp == nil || resp.Extra == nil {
		return ""
	}
	id, _ := resp.Extra["pendingId"].(string)
	return id
}

func extraInt(resp *x402.SettleResponse, key string) int {
	if resp == nil || resp.Extra == nil {
		return 0
	}
	n, ok := extraNumber(resp.Extra[key])
	if !ok {
		return 0
	}
	return n
}

func extraString(m map[string]interface{}, key string) string {
	if m == nil {
		return ""
	}
	s, _ := m[key].(string)
	return s
}

func signRefundConsent(t *testing.T, channelId, amount, nonce, network string) (authorizer string, signature string) {
	t.Helper()
	key, err := crypto.HexToECDSA(managedAuthKeyHex)
	if err != nil {
		t.Fatal(err)
	}
	authorizer = crypto.PubkeyToAddress(key.PublicKey).Hex()
	chainID, err := evm.GetEvmChainId(network)
	if err != nil {
		t.Fatal(err)
	}
	refundAmount, ok := new(big.Int).SetString(amount, 10)
	if !ok {
		t.Fatalf("amount %s", amount)
	}
	refundNonce, ok := new(big.Int).SetString(nonce, 10)
	if !ok {
		t.Fatalf("nonce %s", nonce)
	}
	hash, err := evm.HashTypedData(
		batchsettlement.GetBatchSettlementEip712Domain(chainID),
		batchsettlement.RefundTypes,
		"Refund",
		map[string]interface{}{
			"channelId": channelId,
			"nonce":     refundNonce,
			"amount":    refundAmount,
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	sig, err := crypto.Sign(hash, key)
	if err != nil {
		t.Fatal(err)
	}
	sig[64] += 27
	return authorizer, "0x" + hex.EncodeToString(sig)
}

func eoaVoucherSignature(t *testing.T, channelId, maxClaimable, network string) string {
	t.Helper()
	key, err := crypto.HexToECDSA(managedAuthKeyHex)
	if err != nil {
		t.Fatal(err)
	}
	chainID, err := evm.GetEvmChainId(network)
	if err != nil {
		t.Fatal(err)
	}
	amt, ok := new(big.Int).SetString(maxClaimable, 10)
	if !ok {
		t.Fatalf("maxClaimable %s", maxClaimable)
	}
	hash, err := evm.HashTypedData(
		batchsettlement.GetBatchSettlementEip712Domain(chainID),
		batchsettlement.VoucherTypes,
		"Voucher",
		map[string]interface{}{
			"channelId":          channelId,
			"maxClaimableAmount": amt,
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	sig, err := crypto.Sign(hash, key)
	if err != nil {
		t.Fatal(err)
	}
	sig[64] += 27
	return "0x" + hex.EncodeToString(sig)
}

type hookStore struct {
	inner          *storage.InMemoryChannelStorage[*FacilitatorChannel]
	getErr         error
	acquireErr     error
	releaseErr     error
	isHeldErr      error
	updateErr      error
	updateConflict bool
	queryItems     []*FacilitatorChannel
	queryCalls     int
	queryFilter    storage.ChannelQuery
	useQuery       bool
}

func (s *hookStore) Get(ctx context.Context, channelId string) (*FacilitatorChannel, error) {
	if s.getErr != nil {
		return nil, s.getErr
	}
	return s.inner.Get(ctx, channelId)
}
func (s *hookStore) List(ctx context.Context) ([]*FacilitatorChannel, error) {
	return s.inner.List(ctx)
}
func (s *hookStore) UpdateChannel(ctx context.Context, channelId string, update func(*FacilitatorChannel) *FacilitatorChannel) (*storage.ChannelUpdateResult[*FacilitatorChannel], error) {
	if s.updateErr != nil {
		return nil, s.updateErr
	}
	if s.updateConflict {
		return &storage.ChannelUpdateResult[*FacilitatorChannel]{Status: storage.ChannelConflict}, nil
	}
	return s.inner.UpdateChannel(ctx, channelId, update)
}
func (s *hookStore) Acquire(ctx context.Context, channelId, pendingId string, ttlMs int64) (bool, error) {
	if s.acquireErr != nil {
		return false, s.acquireErr
	}
	return s.inner.Acquire(ctx, channelId, pendingId, ttlMs)
}
func (s *hookStore) Release(ctx context.Context, channelId, pendingId string) error {
	if s.releaseErr != nil {
		return s.releaseErr
	}
	return s.inner.Release(ctx, channelId, pendingId)
}
func (s *hookStore) IsHeld(ctx context.Context, channelId, pendingId string) (bool, error) {
	if s.isHeldErr != nil {
		return false, s.isHeldErr
	}
	return s.inner.IsHeld(ctx, channelId, pendingId)
}
func (s *hookStore) Query(ctx context.Context, filter storage.ChannelQuery, opts *storage.ChannelStoreOptions) (*storage.QueryPage[*FacilitatorChannel], error) {
	s.queryCalls++
	s.queryFilter = filter
	if !s.useQuery {
		return nil, nil
	}
	_ = filter
	_ = opts
	return &storage.QueryPage[*FacilitatorChannel]{Items: s.queryItems}, nil
}

type recordingSettleTargets struct {
	calls int
	items []storage.SettleTarget
}

func (s *recordingSettleTargets) SettleQuery(context.Context, storage.SettleQuery) (*storage.QueryPage[storage.SettleTarget], error) {
	s.calls++
	return &storage.QueryPage[storage.SettleTarget]{Items: s.items}, nil
}

func (s *recordingSettleTargets) ApplySettleTargetClaimDelta(context.Context, storage.SettleTargetClaimDelta) error {
	return nil
}

func (s *recordingSettleTargets) DeleteSettleTarget(context.Context, storage.SettleTarget) error {
	return nil
}

func (s *recordingSettleTargets) StampSettleTargetAttempts(context.Context, []storage.SettleTarget, int64) error {
	return nil
}

func (s *recordingSettleTargets) SyncSettleTargetFromChain(context.Context, storage.SettleTarget, *big.Int) error {
	return nil
}

type stubBuilderCode struct {
	suffix []byte
}

func (s *stubBuilderCode) Key() string { return evm.BuilderCodeKey }
func (s *stubBuilderCode) BuildDataSuffix(evm.DataSuffixContext) ([]byte, error) {
	return s.suffix, nil
}

func builderContext(suffix []byte) *x402.FacilitatorContext {
	return x402.NewFacilitatorContext(map[string]x402.FacilitatorExtension{
		evm.BuilderCodeKey: &stubBuilderCode{suffix: suffix},
	})
}

func syntaxLockErr() error {
	return &json.SyntaxError{Offset: 1}
}

func bigInt(n int64) *big.Int { return big.NewInt(n) }

var _ storage.ChannelQuerier[*FacilitatorChannel] = (*hookStore)(nil)
var _ storage.SettleTargetStorage = (*recordingSettleTargets)(nil)
var _ storage.ChannelLockStorage = (*hookStore)(nil)
var _ evm.BuilderCodeFacilitatorExtension = (*stubBuilderCode)(nil)
