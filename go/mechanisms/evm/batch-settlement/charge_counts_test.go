package batchsettlement

import (
	"bytes"
	"encoding/hex"
	"math/big"
	"strings"
	"testing"

	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"

	"github.com/x402-foundation/x402/go/v2/mechanisms/evm"
)

var zeroAddr = "0x0000000000000000000000000000000000000000"

var chargeCountChannel = ChannelConfig{
	Payer:              "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
	PayerAuthorizer:    zeroAddr,
	Receiver:           "0x9876543210987654321098765432109876543210",
	ReceiverAuthorizer: "0x1111111111111111111111111111111111111111",
	Token:              "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
	WithdrawDelay:      900,
	Salt:               "0x" + strings.Repeat("00", 32),
}

func TestChargeCountsMagic_EqualsBytes4Keccak(t *testing.T) {
	hash := crypto.Keccak256([]byte("x402ChargeCounts(uint64[])"))
	want := "0x" + hex.EncodeToString(hash[:4])
	if ChargeCountsMagic != want {
		t.Fatalf("ChargeCountsMagic = %q, want %q", ChargeCountsMagic, want)
	}
	if ChargeCountsMagic != "0x50b180c6" {
		t.Fatalf("ChargeCountsMagic = %q, want 0x50b180c6", ChargeCountsMagic)
	}
}

func TestEncodeParseChargeCountsSuffix_RoundTripNonEmpty(t *testing.T) {
	suffix, err := EncodeChargeCountsSuffix([]uint64{0, 4, 12})
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	if !bytes.HasPrefix(suffix, chargeCountsMagicBytes()) {
		t.Fatal("suffix missing magic")
	}
	got := ParseChargeCountsSuffix(suffix)
	if !uint64sEqual(got, []uint64{0, 4, 12}) {
		t.Fatalf("got %v", got)
	}
}

func TestEncodeParseChargeCountsSuffix_RoundTripEmpty(t *testing.T) {
	suffix, err := EncodeChargeCountsSuffix(nil)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	got := ParseChargeCountsSuffix(suffix)
	if got == nil || len(got) != 0 {
		t.Fatalf("got %v, want empty list", got)
	}
}

func TestParseChargeCountsSuffix_EmptyOrNoMagic(t *testing.T) {
	if ParseChargeCountsSuffix(nil) != nil {
		t.Fatal("empty leftover should be nil")
	}
	if ParseChargeCountsSuffix(common.FromHex("0xdeadbeef")) != nil {
		t.Fatal("no-magic leftover should be nil")
	}
}

func TestParseChargeCountsSuffix_TruncatedOrUnsafeLength(t *testing.T) {
	magic := chargeCountsMagicBytes()
	if ParseChargeCountsSuffix(append(append([]byte{}, magic...), bytes.Repeat([]byte{0x00}, 16)...)) != nil {
		t.Fatal("short header should be nil")
	}
	unsafe := append(append([]byte{}, magic...), bytes.Repeat([]byte{0x00}, 32)...)
	unsafe = append(unsafe, bytes.Repeat([]byte{0xff}, 32)...)
	if ParseChargeCountsSuffix(unsafe) != nil {
		t.Fatal("unsafe length should be nil")
	}
	one, err := EncodeChargeCountsSuffix([]uint64{1})
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	if ParseChargeCountsSuffix(one[:len(one)-1]) != nil {
		t.Fatal("one-byte-short suffix should be nil")
	}
}

func TestParseChargeCountsSuffix_UppercaseHexPrefix(t *testing.T) {
	suffix, err := EncodeChargeCountsSuffix([]uint64{8})
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	hexStr := "0X" + hex.EncodeToString(suffix)
	got := ParseChargeCountsSuffix(common.FromHex(hexStr))
	if !uint64sEqual(got, []uint64{8}) {
		t.Fatalf("got %v", got)
	}
}

func TestComposeClaimDataSuffix_PlacesChargeCountsBeforeBuilder(t *testing.T) {
	builder := common.FromHex("0x8021abcd")
	composed, err := ComposeClaimDataSuffix([]uint64{3, 7}, builder)
	if err != nil {
		t.Fatalf("compose: %v", err)
	}
	if !bytes.HasPrefix(composed, chargeCountsMagicBytes()) {
		t.Fatal("composed missing magic")
	}
	if !bytes.HasSuffix(composed, []byte{0x80, 0x21, 0xab, 0xcd}) {
		t.Fatalf("composed = %x", composed)
	}
	if !uint64sEqual(ParseChargeCountsSuffix(composed), []uint64{3, 7}) {
		t.Fatalf("parse composed = %v", ParseChargeCountsSuffix(composed))
	}
}

func TestParseChargeCountsFromCalldata_RoundTripClaimAndClaimWithSignature(t *testing.T) {
	suffix, err := EncodeChargeCountsSuffix([]uint64{2, 9})
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	for _, fn := range []string{"claim", "claimWithSignature"} {
		calldata := evm.AppendDataSuffix(mustClaimCalldata(t, fn), suffix)
		got := ParseChargeCountsFromCalldata(calldata)
		if !uint64sEqual(got, []uint64{2, 9}) {
			t.Fatalf("%s: got %v", fn, got)
		}
	}
}

func TestParseChargeCountsFromCalldata_EmptyLeftover(t *testing.T) {
	if ParseChargeCountsFromCalldata(mustClaimCalldata(t, "claim")) != nil {
		t.Fatal("expected nil when leftover is empty")
	}
}

func TestParseChargeCountsFromCalldata_LeftoverHasNoMagic(t *testing.T) {
	calldata := evm.AppendDataSuffix(mustClaimCalldata(t, "claim"), common.FromHex("0xdeadbeef"))
	if ParseChargeCountsFromCalldata(calldata) != nil {
		t.Fatal("expected nil when leftover has no magic")
	}
}

func TestParseChargeCountsFromCalldata_StopsBeforeTrailingBuilderCode(t *testing.T) {
	composed, err := ComposeClaimDataSuffix([]uint64{5}, common.FromHex("0x80218021802180218021802180218021"))
	if err != nil {
		t.Fatalf("compose: %v", err)
	}
	calldata := evm.AppendDataSuffix(mustClaimCalldata(t, "claimWithSignature"), composed)
	if !uint64sEqual(ParseChargeCountsFromCalldata(calldata), []uint64{5}) {
		t.Fatalf("got %v", ParseChargeCountsFromCalldata(calldata))
	}
}

func TestParseChargeCountsFromCalldata_NotAFunctionEncoding(t *testing.T) {
	if ParseChargeCountsFromCalldata(common.FromHex("0xabcd")) != nil {
		t.Fatal("expected nil")
	}
}

func TestParseChargeCountsFromCalldata_NonClaimFunction(t *testing.T) {
	settle := mustPack(t, BatchSettlementSettleABI, "settle",
		common.HexToAddress(chargeCountChannel.Receiver),
		common.HexToAddress(chargeCountChannel.Token),
	)
	suffix, err := EncodeChargeCountsSuffix([]uint64{1})
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	if ParseChargeCountsFromCalldata(evm.AppendDataSuffix(settle, suffix)) != nil {
		t.Fatal("expected nil for settle")
	}
}

func TestParseChargeCountsFromCalldata_UnwrapsMulticallClaimAndRefund(t *testing.T) {
	suffix, err := EncodeChargeCountsSuffix([]uint64{4})
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	innerClaim := evm.AppendDataSuffix(mustClaimCalldata(t, "claim"), suffix)
	refund := mustPack(t, BatchSettlementRefundABI, "refund", toContractChannelConfig(chargeCountChannel), big.NewInt(100))
	outer := mustPack(t, BatchSettlementMulticallABI, "multicall", [][]byte{innerClaim, refund})
	if !bytes.Equal(ExtractClaimCalldata(outer), innerClaim) {
		t.Fatalf("extract = %x, want %x", ExtractClaimCalldata(outer), innerClaim)
	}
	if !uint64sEqual(ParseChargeCountsFromCalldata(outer), []uint64{4}) {
		t.Fatalf("got %v", ParseChargeCountsFromCalldata(outer))
	}
}

func TestParseChargeCountsFromCalldata_UnwrapsMulticallWithOuterBuilderCode(t *testing.T) {
	suffix, err := EncodeChargeCountsSuffix([]uint64{4})
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	innerClaim := evm.AppendDataSuffix(mustClaimCalldata(t, "claimWithSignature"), suffix)
	refund := mustPack(t, BatchSettlementRefundABI, "refund", toContractChannelConfig(chargeCountChannel), big.NewInt(100))
	outer := evm.AppendDataSuffix(
		mustPack(t, BatchSettlementMulticallABI, "multicall", [][]byte{innerClaim, refund}),
		common.FromHex("0x8021abcd"),
	)
	if !uint64sEqual(ParseChargeCountsFromCalldata(outer), []uint64{4}) {
		t.Fatalf("got %v", ParseChargeCountsFromCalldata(outer))
	}
}

func TestParseChargeCountsFromCalldata_RefundOnlyAndNonClaimMulticall(t *testing.T) {
	refund := mustPack(t, BatchSettlementRefundABI, "refund", toContractChannelConfig(chargeCountChannel), big.NewInt(100))
	refundOnly := mustPack(t, BatchSettlementMulticallABI, "multicall", [][]byte{refund})
	if ExtractClaimCalldata(refundOnly) != nil {
		t.Fatal("expected no claim in refund-only multicall")
	}
	if ParseChargeCountsFromCalldata(refundOnly) != nil {
		t.Fatal("expected nil counts for refund-only multicall")
	}

	settle := mustPack(t, BatchSettlementSettleABI, "settle",
		common.HexToAddress(chargeCountChannel.Receiver),
		common.HexToAddress(chargeCountChannel.Token),
	)
	nonClaim := mustPack(t, BatchSettlementMulticallABI, "multicall", [][]byte{settle, refund})
	if ExtractClaimCalldata(nonClaim) != nil {
		t.Fatal("expected no claim in settle+refund multicall")
	}
	if ParseChargeCountsFromCalldata(nonClaim) != nil {
		t.Fatal("expected nil counts for non-claim multicall")
	}
}

func chargeCountsMagicBytes() []byte {
	return common.FromHex(ChargeCountsMagic)
}

func uint64sEqual(got, want []uint64) bool {
	if got == nil || len(got) != len(want) {
		return false
	}
	for i := range want {
		if got[i] != want[i] {
			return false
		}
	}
	return true
}

type contractChannelConfig struct {
	Payer              common.Address
	PayerAuthorizer    common.Address
	Receiver           common.Address
	ReceiverAuthorizer common.Address
	Token              common.Address
	WithdrawDelay      *big.Int
	Salt               [32]byte
}

type voucherClaimArg struct {
	Voucher struct {
		Channel            contractChannelConfig
		MaxClaimableAmount *big.Int
	}
	Signature    []byte
	TotalClaimed *big.Int
}

func toContractChannelConfig(c ChannelConfig) contractChannelConfig {
	var salt [32]byte
	copy(salt[:], common.FromHex(c.Salt))
	return contractChannelConfig{
		Payer:              common.HexToAddress(c.Payer),
		PayerAuthorizer:    common.HexToAddress(c.PayerAuthorizer),
		Receiver:           common.HexToAddress(c.Receiver),
		ReceiverAuthorizer: common.HexToAddress(c.ReceiverAuthorizer),
		Token:              common.HexToAddress(c.Token),
		WithdrawDelay:      big.NewInt(int64(c.WithdrawDelay)),
		Salt:               salt,
	}
}

func mustClaimCalldata(t *testing.T, functionName string) []byte {
	t.Helper()
	claim := voucherClaimArg{
		Signature:    common.FromHex("0xcafe"),
		TotalClaimed: big.NewInt(1000),
	}
	claim.Voucher.Channel = toContractChannelConfig(chargeCountChannel)
	claim.Voucher.MaxClaimableAmount = big.NewInt(1000)
	claims := []voucherClaimArg{claim}
	switch functionName {
	case "claim":
		return mustPack(t, BatchSettlementClaimABI, "claim", claims)
	case "claimWithSignature":
		return mustPack(t, BatchSettlementClaimWithSignatureABI, "claimWithSignature", claims, common.FromHex("0xdead"))
	default:
		t.Fatalf("unknown function %s", functionName)
		return nil
	}
}

func mustPack(t *testing.T, abiJSON []byte, name string, args ...interface{}) []byte {
	t.Helper()
	parsed, err := abi.JSON(strings.NewReader(string(abiJSON)))
	if err != nil {
		t.Fatalf("abi: %v", err)
	}
	data, err := parsed.Pack(name, args...)
	if err != nil {
		t.Fatalf("pack %s: %v", name, err)
	}
	return data
}
