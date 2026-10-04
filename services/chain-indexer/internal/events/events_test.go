package events

import (
	"math/big"
	"testing"

	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
)

// buildLog ABI-encodes nonIndexed into Data (exactly how the EVM packs a
// log's data section) and left-pads indexedVals into Topics[1:], mirroring
// how solc compiles `event Foo(uint256 indexed a, address b)`. This gives
// unit tests a real ABI-encoded log to decode against without needing a
// live chain.
func buildLog(t testing.TB, eventName string, indexedVals []interface{}, nonIndexedVals []interface{}) types.Log {
	t.Helper()
	ev, ok := ContractABI.Events[eventName]
	if !ok {
		t.Fatalf("no such event in ABI: %s", eventName)
	}

	var indexedArgs, nonIndexedArgs abi.Arguments
	for _, arg := range ev.Inputs {
		if arg.Indexed {
			indexedArgs = append(indexedArgs, arg)
		} else {
			nonIndexedArgs = append(nonIndexedArgs, arg)
		}
	}
	if len(indexedArgs) != len(indexedVals) {
		t.Fatalf("%s: expected %d indexed args, got %d values", eventName, len(indexedArgs), len(indexedVals))
	}
	if len(nonIndexedArgs) != len(nonIndexedVals) {
		t.Fatalf("%s: expected %d non-indexed args, got %d values", eventName, len(nonIndexedArgs), len(nonIndexedVals))
	}

	data, err := nonIndexedArgs.Pack(nonIndexedVals...)
	if err != nil {
		t.Fatalf("%s: pack non-indexed data: %v", eventName, err)
	}

	topics := []common.Hash{ev.ID}
	for i, arg := range indexedArgs {
		topics = append(topics, topicFor(t, arg.Type, indexedVals[i]))
	}

	return types.Log{
		Address:     common.HexToAddress("0x000000000000000000000000000000000000Ab"),
		Topics:      topics,
		Data:        data,
		BlockNumber: 100,
		TxHash:      common.HexToHash("0x01"),
		TxIndex:     0,
		BlockHash:   common.HexToHash("0x02"),
		Index:       0,
	}
}

func mustBigInt(s string) *big.Int {
	n, ok := new(big.Int).SetString(s, 10)
	if !ok {
		panic("invalid big int literal: " + s)
	}
	return n
}

func topicFor(t testing.TB, typ abi.Type, val interface{}) common.Hash {
	t.Helper()
	switch v := val.(type) {
	case common.Address:
		return common.BytesToHash(common.LeftPadBytes(v.Bytes(), 32))
	case *big.Int:
		return common.BytesToHash(common.LeftPadBytes(v.Bytes(), 32))
	case [32]byte:
		return common.Hash(v)
	default:
		t.Fatalf("topicFor: unsupported indexed type %T for abi type %s", val, typ.String())
		return common.Hash{}
	}
}

func TestEventNameForLog(t *testing.T) {
	log := buildLog(t, EventRiskOracleUpdated,
		[]interface{}{common.HexToAddress("0x1"), common.HexToAddress("0x2")},
		[]interface{}{},
	)
	name, ok := EventNameForLog(log)
	if !ok || name != EventRiskOracleUpdated {
		t.Fatalf("EventNameForLog = (%q, %v), want (%q, true)", name, ok, EventRiskOracleUpdated)
	}
}

func TestEventNameForLog_UnknownTopic(t *testing.T) {
	log := types.Log{Topics: []common.Hash{common.HexToHash("0xdeadbeef")}}
	if _, ok := EventNameForLog(log); ok {
		t.Fatal("expected ok=false for an unrecognized topic0")
	}
}

func TestEventNameForLog_NoTopics(t *testing.T) {
	if _, ok := EventNameForLog(types.Log{}); ok {
		t.Fatal("expected ok=false for a log with no topics")
	}
}

func TestDecodeRiskEscrowCreated(t *testing.T) {
	dealID := big.NewInt(42)
	quoteID := [32]byte{0xaa}
	depositor := common.HexToAddress("0x1111111111111111111111111111111111111111")
	counterparty := common.HexToAddress("0x2222222222222222222222222222222222222222")
	settlementAsset := common.Address{} // native
	notional := mustBigInt("10000000000000000000")
	collateral := mustBigInt("12000000000000000000")
	deadline := big.NewInt(1_700_000_000)
	modelVersion := "garch-1.1.0"
	snapshotHash := [32]byte{0xbb}

	log := buildLog(t, EventRiskEscrowCreated,
		[]interface{}{dealID, quoteID, depositor},
		[]interface{}{counterparty, settlementAsset, notional, collateral, deadline, modelVersion, snapshotHash},
	)

	got, err := DecodeRiskEscrowCreated(log)
	if err != nil {
		t.Fatalf("DecodeRiskEscrowCreated: %v", err)
	}
	if got.DealId.Cmp(dealID) != 0 {
		t.Errorf("DealId = %v, want %v", got.DealId, dealID)
	}
	if got.QuoteId != quoteID {
		t.Errorf("QuoteId = %x, want %x", got.QuoteId, quoteID)
	}
	if got.Depositor != depositor {
		t.Errorf("Depositor = %v, want %v", got.Depositor, depositor)
	}
	if got.Counterparty != counterparty {
		t.Errorf("Counterparty = %v, want %v", got.Counterparty, counterparty)
	}
	if got.SettlementAsset != settlementAsset {
		t.Errorf("SettlementAsset = %v, want %v", got.SettlementAsset, settlementAsset)
	}
	if got.Notional.Cmp(notional) != 0 {
		t.Errorf("Notional = %v, want %v", got.Notional, notional)
	}
	if got.CollateralLocked.Cmp(collateral) != 0 {
		t.Errorf("CollateralLocked = %v, want %v", got.CollateralLocked, collateral)
	}
	if got.SettlementDeadline.Cmp(deadline) != 0 {
		t.Errorf("SettlementDeadline = %v, want %v", got.SettlementDeadline, deadline)
	}
	if got.ModelVersion != modelVersion {
		t.Errorf("ModelVersion = %q, want %q", got.ModelVersion, modelVersion)
	}
	if got.RiskSnapshotHash != snapshotHash {
		t.Errorf("RiskSnapshotHash = %x, want %x", got.RiskSnapshotHash, snapshotHash)
	}
}

func TestDecodeRiskEscrowSettled(t *testing.T) {
	dealID := big.NewInt(7)
	counterparty := common.HexToAddress("0x3333333333333333333333333333333333333333"[:42])
	payout := mustBigInt("9500000000000000000")
	fee := big.NewInt(500000000000000000)
	refund := big.NewInt(2_000000000000000000)

	log := buildLog(t, EventRiskEscrowSettled,
		[]interface{}{dealID, counterparty},
		[]interface{}{payout, fee, refund},
	)

	got, err := DecodeRiskEscrowSettled(log)
	if err != nil {
		t.Fatalf("DecodeRiskEscrowSettled: %v", err)
	}
	if got.DealId.Cmp(dealID) != 0 || got.Counterparty != counterparty ||
		got.Payout.Cmp(payout) != 0 || got.PlatformFee.Cmp(fee) != 0 || got.DepositorRefund.Cmp(refund) != 0 {
		t.Errorf("decoded = %+v", got)
	}
}

func TestDecodeRiskEscrowRefunded(t *testing.T) {
	dealID := big.NewInt(3)
	depositor := common.HexToAddress("0x4444444444444444444444444444444444444444"[:42])
	amount := mustBigInt("12000000000000000000")

	log := buildLog(t, EventRiskEscrowRefunded,
		[]interface{}{dealID, depositor},
		[]interface{}{amount},
	)

	got, err := DecodeRiskEscrowRefunded(log)
	if err != nil {
		t.Fatalf("DecodeRiskEscrowRefunded: %v", err)
	}
	if got.DealId.Cmp(dealID) != 0 || got.Depositor != depositor || got.Amount.Cmp(amount) != 0 {
		t.Errorf("decoded = %+v", got)
	}
}

func TestDecodePlatformFeeUpdated(t *testing.T) {
	log := buildLog(t, EventPlatformFeeUpdated, nil, []interface{}{big.NewInt(500), big.NewInt(750)})
	got, err := DecodePlatformFeeUpdated(log)
	if err != nil {
		t.Fatalf("DecodePlatformFeeUpdated: %v", err)
	}
	if got.PreviousFeeBps.Cmp(big.NewInt(500)) != 0 || got.NewFeeBps.Cmp(big.NewInt(750)) != 0 {
		t.Errorf("decoded = %+v", got)
	}
}

func TestDecodePlatformWalletUpdated(t *testing.T) {
	prev := common.HexToAddress("0x5555555555555555555555555555555555555555"[:42])
	next := common.HexToAddress("0x6666666666666666666666666666666666666666"[:42])
	log := buildLog(t, EventPlatformWalletUpdated, nil, []interface{}{prev, next})
	got, err := DecodePlatformWalletUpdated(log)
	if err != nil {
		t.Fatalf("DecodePlatformWalletUpdated: %v", err)
	}
	if got.PreviousWallet != prev || got.NewWallet != next {
		t.Errorf("decoded = %+v", got)
	}
}

func TestDecode_WrongEventName_Errors(t *testing.T) {
	log := buildLog(t, EventRiskOracleUpdated,
		[]interface{}{common.HexToAddress("0x1"), common.HexToAddress("0x2")},
		[]interface{}{},
	)
	if _, err := DecodeRiskEscrowCreated(log); err == nil {
		t.Fatal("expected error decoding a RiskOracleUpdated log as RiskEscrowCreated")
	}
}
