// This file implements the symmetric encode/decode pair between the typed
// event structs (above) and a map[string]string suitable for JSONB
// storage (escrow_events.decoded) and for later reconstruction.
//
// Every field is encoded as a string (hex for addresses/bytes32, decimal
// for integers) rather than a native JSON number, matching the rest of
// this repo's convention for 18-decimal fixed-point values (see
// apps/web/app/api/escrow/create/route.ts) - a bare JSON number
// loses precision for values this large in most non-Go consumers (e.g. a
// JS dashboard reading escrow_events for audit).
//
// This round trip matters beyond audit display: the confirmation pass
// (internal/store) reconstructs the typed event from exactly this map to
// apply derived state, specifically so that pass is restart-safe - it
// never depends on an in-memory copy of the originally decoded log.
package events

import (
	"encoding/hex"
	"fmt"
	"math/big"

	"github.com/ethereum/go-ethereum/common"
)

func hexBytes32(b [32]byte) string { return "0x" + hex.EncodeToString(b[:]) }

func parseBytes32(s string) ([32]byte, error) {
	var out [32]byte
	raw, err := hex.DecodeString(trim0x(s))
	if err != nil {
		return out, fmt.Errorf("invalid bytes32 hex %q: %w", s, err)
	}
	if len(raw) != 32 {
		return out, fmt.Errorf("invalid bytes32 length %q: got %d bytes, want 32", s, len(raw))
	}
	copy(out[:], raw)
	return out, nil
}

func trim0x(s string) string {
	if len(s) >= 2 && s[0] == '0' && (s[1] == 'x' || s[1] == 'X') {
		return s[2:]
	}
	return s
}

func parseBigInt(m map[string]string, key string) (*big.Int, error) {
	v, ok := m[key]
	if !ok {
		return nil, fmt.Errorf("missing field %q", key)
	}
	n, ok := new(big.Int).SetString(v, 10)
	if !ok {
		return nil, fmt.Errorf("field %q: invalid decimal integer %q", key, v)
	}
	return n, nil
}

func parseAddress(m map[string]string, key string) (common.Address, error) {
	v, ok := m[key]
	if !ok {
		return common.Address{}, fmt.Errorf("missing field %q", key)
	}
	if !common.IsHexAddress(v) {
		return common.Address{}, fmt.Errorf("field %q: invalid address %q", key, v)
	}
	return common.HexToAddress(v), nil
}

func parseBytes32Field(m map[string]string, key string) ([32]byte, error) {
	v, ok := m[key]
	if !ok {
		return [32]byte{}, fmt.Errorf("missing field %q", key)
	}
	return parseBytes32(v)
}

func parseStringField(m map[string]string, key string) (string, error) {
	v, ok := m[key]
	if !ok {
		return "", fmt.Errorf("missing field %q", key)
	}
	return v, nil
}

// ToDecodedMap / <Name>FromMap pairs, one per indexed event.

func (e RiskEscrowCreated) ToDecodedMap() map[string]string {
	return map[string]string{
		"dealId":             e.DealId.String(),
		"quoteId":            hexBytes32(e.QuoteId),
		"depositor":          e.Depositor.Hex(),
		"counterparty":       e.Counterparty.Hex(),
		"settlementAsset":    e.SettlementAsset.Hex(),
		"notional":           e.Notional.String(),
		"collateralLocked":   e.CollateralLocked.String(),
		"settlementDeadline": e.SettlementDeadline.String(),
		"modelVersion":       e.ModelVersion,
		"riskSnapshotHash":   hexBytes32(e.RiskSnapshotHash),
	}
}

// RiskEscrowCreatedFromMap reconstructs a RiskEscrowCreated from the map
// produced by ToDecodedMap. Used by the confirmation pass to apply derived
// state purely from what is durably stored, without relying on any
// in-memory state surviving a restart.
func RiskEscrowCreatedFromMap(m map[string]string) (RiskEscrowCreated, error) {
	var out RiskEscrowCreated
	var err error
	if out.DealId, err = parseBigInt(m, "dealId"); err != nil {
		return out, err
	}
	if out.QuoteId, err = parseBytes32Field(m, "quoteId"); err != nil {
		return out, err
	}
	if out.Depositor, err = parseAddress(m, "depositor"); err != nil {
		return out, err
	}
	if out.Counterparty, err = parseAddress(m, "counterparty"); err != nil {
		return out, err
	}
	if out.SettlementAsset, err = parseAddress(m, "settlementAsset"); err != nil {
		return out, err
	}
	if out.Notional, err = parseBigInt(m, "notional"); err != nil {
		return out, err
	}
	if out.CollateralLocked, err = parseBigInt(m, "collateralLocked"); err != nil {
		return out, err
	}
	if out.SettlementDeadline, err = parseBigInt(m, "settlementDeadline"); err != nil {
		return out, err
	}
	if out.ModelVersion, err = parseStringField(m, "modelVersion"); err != nil {
		return out, err
	}
	if out.RiskSnapshotHash, err = parseBytes32Field(m, "riskSnapshotHash"); err != nil {
		return out, err
	}
	return out, nil
}

func (e RiskEscrowSettled) ToDecodedMap() map[string]string {
	return map[string]string{
		"dealId":          e.DealId.String(),
		"counterparty":    e.Counterparty.Hex(),
		"payout":          e.Payout.String(),
		"platformFee":     e.PlatformFee.String(),
		"depositorRefund": e.DepositorRefund.String(),
	}
}

func RiskEscrowSettledFromMap(m map[string]string) (RiskEscrowSettled, error) {
	var out RiskEscrowSettled
	var err error
	if out.DealId, err = parseBigInt(m, "dealId"); err != nil {
		return out, err
	}
	if out.Counterparty, err = parseAddress(m, "counterparty"); err != nil {
		return out, err
	}
	if out.Payout, err = parseBigInt(m, "payout"); err != nil {
		return out, err
	}
	if out.PlatformFee, err = parseBigInt(m, "platformFee"); err != nil {
		return out, err
	}
	if out.DepositorRefund, err = parseBigInt(m, "depositorRefund"); err != nil {
		return out, err
	}
	return out, nil
}

func (e RiskEscrowRefunded) ToDecodedMap() map[string]string {
	return map[string]string{
		"dealId":    e.DealId.String(),
		"depositor": e.Depositor.Hex(),
		"amount":    e.Amount.String(),
	}
}

func RiskEscrowRefundedFromMap(m map[string]string) (RiskEscrowRefunded, error) {
	var out RiskEscrowRefunded
	var err error
	if out.DealId, err = parseBigInt(m, "dealId"); err != nil {
		return out, err
	}
	if out.Depositor, err = parseAddress(m, "depositor"); err != nil {
		return out, err
	}
	if out.Amount, err = parseBigInt(m, "amount"); err != nil {
		return out, err
	}
	return out, nil
}

func (e RiskOracleUpdated) ToDecodedMap() map[string]string {
	return map[string]string{
		"previousOracle": e.PreviousOracle.Hex(),
		"newOracle":      e.NewOracle.Hex(),
	}
}

func RiskOracleUpdatedFromMap(m map[string]string) (RiskOracleUpdated, error) {
	var out RiskOracleUpdated
	var err error
	if out.PreviousOracle, err = parseAddress(m, "previousOracle"); err != nil {
		return out, err
	}
	if out.NewOracle, err = parseAddress(m, "newOracle"); err != nil {
		return out, err
	}
	return out, nil
}

func (e PlatformFeeUpdated) ToDecodedMap() map[string]string {
	return map[string]string{
		"previousFeeBps": e.PreviousFeeBps.String(),
		"newFeeBps":      e.NewFeeBps.String(),
	}
}

func PlatformFeeUpdatedFromMap(m map[string]string) (PlatformFeeUpdated, error) {
	var out PlatformFeeUpdated
	var err error
	if out.PreviousFeeBps, err = parseBigInt(m, "previousFeeBps"); err != nil {
		return out, err
	}
	if out.NewFeeBps, err = parseBigInt(m, "newFeeBps"); err != nil {
		return out, err
	}
	return out, nil
}

func (e PlatformWalletUpdated) ToDecodedMap() map[string]string {
	return map[string]string{
		"previousWallet": e.PreviousWallet.Hex(),
		"newWallet":      e.NewWallet.Hex(),
	}
}

func PlatformWalletUpdatedFromMap(m map[string]string) (PlatformWalletUpdated, error) {
	var out PlatformWalletUpdated
	var err error
	if out.PreviousWallet, err = parseAddress(m, "previousWallet"); err != nil {
		return out, err
	}
	if out.NewWallet, err = parseAddress(m, "newWallet"); err != nil {
		return out, err
	}
	return out, nil
}

// DealIDFromLog extracts just the deal ID for logs that carry one, without
// fully decoding the event - used to populate escrow_events.deal_id
// (indexed, deal-scoped lookups) regardless of event type.
func DealIDFromLog(eventName string, decoded map[string]string) (uint64, bool) {
	switch eventName {
	case EventRiskEscrowCreated, EventRiskEscrowSettled, EventRiskEscrowRefunded:
		n, err := parseBigInt(decoded, "dealId")
		if err != nil {
			return 0, false
		}
		return n.Uint64(), true
	default:
		return 0, false
	}
}
