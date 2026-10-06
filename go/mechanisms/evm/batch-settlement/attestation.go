package batchsettlement

import (
	"math/big"
	"reflect"
	"strings"

	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
	goethtypes "github.com/ethereum/go-ethereum/core/types"
)

// ClaimAttestationRow is one claim row joined to its onchain Claimed event.
// A row without the event was a no-op: Claimed is false and the other fields are empty.
type ClaimAttestationRow struct {
	ChannelId       string
	Claimed         bool
	ClaimAmount     string
	NewTotalClaimed string
	// ChargeCount is the attested charge-count delta. It is empty when the row was not
	// claimed or when `m` carries no valid counts for this calldata.
	ChargeCount string
}

// ClaimAttestation is the decoded attestation for a settlement transaction.
// Channels is nil when the transaction carries no claim row. FunctionName is
// "unknown" when the outer calldata cannot be decoded.
type ClaimAttestation struct {
	FunctionName string
	// ChargeCounts are the deltas from m.x402ChargeCounts in claim-row order, set only when
	// their length equals the number of claim rows.
	ChargeCounts []uint64
	Channels     []ClaimAttestationRow
}

// ReceiptLog is the subset of an Ethereum receipt log needed to join Claimed events.
// Address is the emitter; only logs emitted by x402BatchSettlement count.
type ReceiptLog struct {
	Address common.Address
	Topics  []common.Hash
	Data    []byte
}

type claimedLog struct {
	ClaimAmount     *big.Int
	NewTotalClaimed *big.Int
}

var (
	claimedEvent     abi.Event
	batchCallMethods map[string]abi.Method
)

func init() {
	parsed, err := abi.JSON(strings.NewReader(string(BatchSettlementClaimedEventABI)))
	if err != nil {
		panic("Claimed event ABI: " + err.Error())
	}
	claimedEvent = parsed.Events["Claimed"]

	batchCallMethods = make(map[string]abi.Method)
	registerMethods(BatchSettlementClaimABI)
	registerMethods(BatchSettlementClaimWithSignatureABI)
	registerMethods(BatchSettlementMulticallABI)
	registerMethods(BatchSettlementRefundABI)
	registerMethods(BatchSettlementRefundWithSignatureABI)
	registerMethods(BatchSettlementSettleABI)
	registerMethods(BatchSettlementDepositABI)
}

func registerMethods(abiJSON []byte) {
	parsed, err := abi.JSON(strings.NewReader(string(abiJSON)))
	if err != nil {
		panic("batch-settlement ABI: " + err.Error())
	}
	for _, method := range parsed.Methods {
		batchCallMethods[string(method.ID)] = method
	}
}

type decodedBatchCall struct {
	Name   string
	Method abi.Method
	Args   []interface{}
}

func decodeBatchCall(calldata []byte) (decodedBatchCall, bool) {
	if len(calldata) < 4 {
		return decodedBatchCall{}, false
	}
	method, ok := batchCallMethods[string(calldata[:4])]
	if !ok {
		return decodedBatchCall{}, false
	}
	args, err := method.Inputs.Unpack(calldata[4:])
	if err != nil {
		return decodedBatchCall{}, false
	}
	return decodedBatchCall{Name: method.Name, Method: method, Args: args}, true
}

// collectClaimConfigs collects the channel configs of the claim rows of a transaction in call
// order. It handles a direct claim / claimWithSignature call and a (possibly nested)
// multicall(bytes[]); non-claim legs such as refund contribute no rows. The second result is
// false when any leg cannot be ABI-decoded.
func collectClaimConfigs(calldata []byte) ([]ChannelConfig, bool) {
	decoded, ok := decodeBatchCall(calldata)
	if !ok {
		return nil, false
	}
	switch decoded.Name {
	case "claim", "claimWithSignature":
		configs := channelConfigsFromClaimArgs(decoded.Args)
		if configs == nil {
			return nil, false
		}
		return configs, true
	case "multicall":
		if len(decoded.Args) == 0 {
			return nil, false
		}
		var out []ChannelConfig
		for _, inner := range bytesSliceArg(decoded.Args[0]) {
			configs, ok := collectClaimConfigs(inner)
			if !ok {
				return nil, false
			}
			out = append(out, configs...)
		}
		return out, true
	default:
		return nil, true
	}
}

// readClaimedEvents reads the Claimed events emitted by the x402BatchSettlement contract,
// keyed by lowercase channelId. Logs from other emitters are ignored, so an unrelated contract
// in the same transaction cannot forge a Claimed for a channel.
func readClaimedEvents(logs []ReceiptLog) map[string]claimedLog {
	out := make(map[string]claimedLog)
	contract := common.HexToAddress(BatchSettlementAddress)
	for _, log := range logs {
		if log.Address != contract || len(log.Topics) < 3 || log.Topics[0] != claimedEvent.ID {
			continue
		}
		values, err := claimedEvent.Inputs.NonIndexed().Unpack(log.Data)
		if err != nil || len(values) < 2 {
			continue
		}
		entry := claimedLog{}
		if n, ok := values[0].(*big.Int); ok {
			entry.ClaimAmount = n
		}
		if n, ok := values[1].(*big.Int); ok {
			entry.NewTotalClaimed = n
		}
		out[strings.ToLower(log.Topics[1].Hex())] = entry
	}
	return out
}

// ReceiptLogsFromEvm converts go-ethereum receipt logs to ReceiptLog values.
func ReceiptLogsFromEvm(logs []*goethtypes.Log) []ReceiptLog {
	out := make([]ReceiptLog, 0, len(logs))
	for _, log := range logs {
		if log == nil {
			continue
		}
		out = append(out, ReceiptLog{Address: log.Address, Topics: log.Topics, Data: log.Data})
	}
	return out
}

// ClaimedChannelIds returns the lowercase channelIds that emitted Claimed from
// x402BatchSettlement in a receipt. The result is never nil.
//
// Facilitators use it to subtract an attested chargeCount only for rows that were actually
// claimed.
func ClaimedChannelIds(logs []*goethtypes.Log) map[string]struct{} {
	events := readClaimedEvents(ReceiptLogsFromEvm(logs))
	out := make(map[string]struct{}, len(events))
	for channelId := range events {
		out[channelId] = struct{}{}
	}
	return out
}

// DecodeClaimAttestation decodes claim attestation from full transaction input, the parsed
// ERC-8021 `m` metadata, and receipt logs.
//
// It handles standalone claim / claimWithSignature transactions and bundled
// multicall([claim, refund]) transactions. metadata is the `m` field of the suffix on the
// top-level input (for example buildercode.ParseBuilderCodeSuffixFromCalldata(input).M). No
// builder code is needed: a suffix carrying only `m` is enough.
//
// Rows are joined to Claimed events by channelId, never by position. A row without a Claimed
// event was a no-op and attests nothing. Counts whose length differs from the number of claim
// rows are ignored.
//
// It never returns an error: undecodable input yields FunctionName "unknown" and a nil Channels
// slice, and unparseable receipt logs yield rows with Claimed false.
func DecodeClaimAttestation(calldata []byte, receiptLogs []ReceiptLog, network string, metadata map[string]any) ClaimAttestation {
	outer, ok := decodeBatchCall(calldata)
	if !ok {
		return ClaimAttestation{FunctionName: "unknown"}
	}

	configs, ok := collectClaimConfigs(calldata)
	if !ok || len(configs) == 0 {
		return ClaimAttestation{FunctionName: outer.Name}
	}

	var chargeCounts []uint64
	if parsed := ParseChargeCountsMetadata(metadata); len(parsed) == len(configs) {
		chargeCounts = parsed
	}
	claimed := readClaimedEvents(receiptLogs)

	channels := make([]ClaimAttestationRow, len(configs))
	for i, cfg := range configs {
		channelId, err := ComputeChannelId(cfg, network)
		if err != nil {
			channelId = ""
		}
		row := ClaimAttestationRow{ChannelId: channelId}
		if event, ok := claimed[strings.ToLower(channelId)]; ok && channelId != "" {
			row.Claimed = true
			if event.ClaimAmount != nil {
				row.ClaimAmount = event.ClaimAmount.String()
			}
			if event.NewTotalClaimed != nil {
				row.NewTotalClaimed = event.NewTotalClaimed.String()
			}
			if chargeCounts != nil {
				row.ChargeCount = new(big.Int).SetUint64(chargeCounts[i]).String()
			}
		}
		channels[i] = row
	}

	return ClaimAttestation{FunctionName: outer.Name, ChargeCounts: chargeCounts, Channels: channels}
}

func bytesSliceArg(v interface{}) [][]byte {
	switch x := v.(type) {
	case [][]byte:
		return x
	case []interface{}:
		out := make([][]byte, 0, len(x))
		for _, item := range x {
			b, ok := item.([]byte)
			if !ok {
				return nil
			}
			out = append(out, b)
		}
		return out
	default:
		return nil
	}
}

func channelConfigsFromClaimArgs(args []interface{}) []ChannelConfig {
	if len(args) == 0 {
		return nil
	}
	return channelConfigsFromValue(args[0])
}

func channelConfigsFromValue(v interface{}) []ChannelConfig {
	switch claims := v.(type) {
	case []struct {
		Voucher struct {
			Channel            contractChannelTuple
			MaxClaimableAmount *big.Int
		}
		Signature    []byte
		TotalClaimed *big.Int
	}:
		out := make([]ChannelConfig, len(claims))
		for i, c := range claims {
			out[i] = channelConfigFromTuple(c.Voucher.Channel)
		}
		return out
	case []interface{}:
		out := make([]ChannelConfig, 0, len(claims))
		for _, item := range claims {
			cfg, ok := channelConfigFromClaim(item)
			if !ok {
				return nil
			}
			out = append(out, cfg)
		}
		return out
	default:
		return channelConfigsFromReflectedClaims(v)
	}
}

type contractChannelTuple struct {
	Payer              common.Address
	PayerAuthorizer    common.Address
	Receiver           common.Address
	ReceiverAuthorizer common.Address
	Token              common.Address
	WithdrawDelay      *big.Int
	Salt               [32]byte
}

func channelConfigFromTuple(c contractChannelTuple) ChannelConfig {
	delay := 0
	if c.WithdrawDelay != nil {
		delay = int(c.WithdrawDelay.Int64())
	}
	return ChannelConfig{
		Payer:              c.Payer.Hex(),
		PayerAuthorizer:    c.PayerAuthorizer.Hex(),
		Receiver:           c.Receiver.Hex(),
		ReceiverAuthorizer: c.ReceiverAuthorizer.Hex(),
		Token:              c.Token.Hex(),
		WithdrawDelay:      delay,
		Salt:               "0x" + common.Bytes2Hex(c.Salt[:]),
	}
}

func channelConfigFromClaim(item interface{}) (ChannelConfig, bool) {
	fields, ok := structFields(item)
	if !ok {
		return ChannelConfig{}, false
	}
	voucher, ok := fields["voucher"]
	if !ok {
		return ChannelConfig{}, false
	}
	voucherFields, ok := structFields(voucher)
	if !ok {
		return ChannelConfig{}, false
	}
	channel, ok := voucherFields["channel"]
	if !ok {
		return ChannelConfig{}, false
	}
	return channelConfigFromUnpacked(channel)
}

func channelConfigFromUnpacked(v interface{}) (ChannelConfig, bool) {
	if t, ok := v.(contractChannelTuple); ok {
		return channelConfigFromTuple(t), true
	}
	fields, ok := structFields(v)
	if !ok {
		return ChannelConfig{}, false
	}
	payer := addressField(fields, "payer")
	payerAuth := addressField(fields, "payerAuthorizer")
	receiver := addressField(fields, "receiver")
	receiverAuth := addressField(fields, "receiverAuthorizer")
	token := addressField(fields, "token")
	delay := 0
	if raw, ok := fields["withdrawDelay"]; ok {
		switch n := raw.(type) {
		case *big.Int:
			if n != nil {
				delay = int(n.Int64())
			}
		case uint64:
			delay = int(n)
		}
	}
	salt := ""
	if raw, ok := fields["salt"]; ok {
		switch s := raw.(type) {
		case [32]byte:
			salt = "0x" + common.Bytes2Hex(s[:])
		case []byte:
			salt = "0x" + common.Bytes2Hex(s)
		case common.Hash:
			salt = s.Hex()
		}
	}
	if payer == "" || receiver == "" || token == "" || salt == "" {
		return ChannelConfig{}, false
	}
	return ChannelConfig{
		Payer:              payer,
		PayerAuthorizer:    payerAuth,
		Receiver:           receiver,
		ReceiverAuthorizer: receiverAuth,
		Token:              token,
		WithdrawDelay:      delay,
		Salt:               salt,
	}, true
}

func channelConfigsFromReflectedClaims(v interface{}) []ChannelConfig {
	rv := reflect.ValueOf(v)
	if rv.Kind() != reflect.Slice {
		return nil
	}
	out := make([]ChannelConfig, 0, rv.Len())
	for i := 0; i < rv.Len(); i++ {
		cfg, ok := channelConfigFromClaim(rv.Index(i).Interface())
		if !ok {
			return nil
		}
		out = append(out, cfg)
	}
	return out
}

func structFields(v interface{}) (map[string]interface{}, bool) {
	switch x := v.(type) {
	case map[string]interface{}:
		return x, true
	case []interface{}:
		// ABI tuple as positional values: payer, payerAuthorizer, receiver,
		// receiverAuthorizer, token, withdrawDelay, salt.
		if len(x) >= 7 {
			return map[string]interface{}{
				"payer":              x[0],
				"payerAuthorizer":    x[1],
				"receiver":           x[2],
				"receiverAuthorizer": x[3],
				"token":              x[4],
				"withdrawDelay":      x[5],
				"salt":               x[6],
			}, true
		}
		// voucher claim as [voucher, signature, totalClaimed]
		if len(x) >= 1 {
			return map[string]interface{}{"voucher": x[0]}, true
		}
		return nil, false
	default:
		return reflectedStructFields(v)
	}
}

func reflectedStructFields(v interface{}) (map[string]interface{}, bool) {
	rv := reflect.ValueOf(v)
	if rv.Kind() == reflect.Pointer {
		if rv.IsNil() {
			return nil, false
		}
		rv = rv.Elem()
	}
	if rv.Kind() != reflect.Struct {
		return nil, false
	}
	rt := rv.Type()
	out := make(map[string]interface{}, rt.NumField())
	for i := 0; i < rt.NumField(); i++ {
		field := rt.Field(i)
		if field.PkgPath != "" {
			continue
		}
		name := field.Name
		if tag := field.Tag.Get("abi"); tag != "" {
			name = tag
		}
		out[lowerFirst(name)] = rv.Field(i).Interface()
		out[name] = rv.Field(i).Interface()
	}
	return out, true
}

func lowerFirst(s string) string {
	if s == "" {
		return s
	}
	return strings.ToLower(s[:1]) + s[1:]
}

func addressField(fields map[string]interface{}, key string) string {
	raw, ok := fields[key]
	if !ok {
		return ""
	}
	switch a := raw.(type) {
	case common.Address:
		return a.Hex()
	case string:
		return a
	default:
		return ""
	}
}
