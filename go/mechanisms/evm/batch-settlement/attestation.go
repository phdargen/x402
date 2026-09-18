package batchsettlement

import (
	"fmt"
	"math/big"
	"reflect"
	"strings"

	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
)

// ClaimAttestationRow is one attested voucherClaims row joined to its Claimed event.
type ClaimAttestationRow struct {
	ChannelId       string
	ChargeCount     string
	ClaimAmount     string
	NewTotalClaimed string
}

// ClaimAttestation is the decoded attestation for a settlement transaction.
// Channels is nil when the transaction carries no claim. FunctionName is
// "unknown" when the outer calldata cannot be decoded.
type ClaimAttestation struct {
	FunctionName      string
	ClaimFunctionName string
	ClaimCalldata     []byte
	ChargeCounts      []uint64
	Channels          []ClaimAttestationRow
}

// ReceiptLog is the subset of an Ethereum receipt log needed to join Claimed events.
type ReceiptLog struct {
	Topics []common.Hash
	Data   []byte
}

type claimedLog struct {
	ChannelId       string
	ClaimAmount     *big.Int
	NewTotalClaimed *big.Int
}

var claimedEvent abi.Event

func init() {
	parsed, err := abi.JSON(strings.NewReader(string(BatchSettlementClaimedEventABI)))
	if err != nil {
		panic("Claimed event ABI: " + err.Error())
	}
	claimedEvent = parsed.Events["Claimed"]
}

// DecodeClaimAttestation decodes claim attestation from full transaction input
// and receipt logs. It never returns an error: undecodable input yields
// functionName "unknown" and a nil Channels slice.
func DecodeClaimAttestation(calldata []byte, receiptLogs []ReceiptLog, network string) ClaimAttestation {
	outerName := "unknown"
	if outer, ok := decodeBatchCall(calldata); ok {
		outerName = outer.Name
	} else {
		return ClaimAttestation{FunctionName: outerName}
	}

	chargeCounts := ParseChargeCountsFromCalldata(calldata)
	claimCalldata := ExtractClaimCalldata(calldata)
	if claimCalldata == nil {
		return ClaimAttestation{FunctionName: outerName, ChargeCounts: chargeCounts}
	}

	decoded, ok := decodeBatchCall(claimCalldata)
	if !ok || (decoded.Name != "claim" && decoded.Name != "claimWithSignature") {
		return ClaimAttestation{FunctionName: outerName, ChargeCounts: chargeCounts}
	}

	configs := channelConfigsFromClaimArgs(decoded.Args)
	if configs == nil {
		return ClaimAttestation{FunctionName: outerName, ChargeCounts: chargeCounts}
	}

	claimed := parseClaimedLogs(receiptLogs)
	channels := make([]ClaimAttestationRow, len(configs))
	for i, cfg := range configs {
		channelId, err := ComputeChannelId(cfg, network)
		if err != nil {
			channelId = ""
		}
		row := ClaimAttestationRow{ChannelId: channelId}
		if i < len(chargeCounts) {
			row.ChargeCount = fmt.Sprintf("%d", chargeCounts[i])
		}
		for _, log := range claimed {
			if channelId != "" && strings.EqualFold(log.ChannelId, channelId) {
				if log.ClaimAmount != nil {
					row.ClaimAmount = log.ClaimAmount.String()
				}
				if log.NewTotalClaimed != nil {
					row.NewTotalClaimed = log.NewTotalClaimed.String()
				}
				break
			}
		}
		channels[i] = row
	}

	return ClaimAttestation{
		FunctionName:      outerName,
		ClaimFunctionName: decoded.Name,
		ClaimCalldata:     claimCalldata,
		ChargeCounts:      chargeCounts,
		Channels:          channels,
	}
}

func parseClaimedLogs(logs []ReceiptLog) []claimedLog {
	if len(logs) == 0 {
		return nil
	}
	out := make([]claimedLog, 0, len(logs))
	for _, log := range logs {
		if len(log.Topics) < 3 || log.Topics[0] != claimedEvent.ID {
			continue
		}
		values, err := claimedEvent.Inputs.NonIndexed().Unpack(log.Data)
		if err != nil || len(values) < 2 {
			continue
		}
		entry := claimedLog{ChannelId: log.Topics[1].Hex()}
		if n, ok := values[0].(*big.Int); ok {
			entry.ClaimAmount = n
		}
		if n, ok := values[1].(*big.Int); ok {
			entry.NewTotalClaimed = n
		}
		out = append(out, entry)
	}
	return out
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
