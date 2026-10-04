package events

import (
	"math/big"
	"testing"

	"github.com/ethereum/go-ethereum/common"
)

func TestRiskEscrowCreated_RoundTrip(t *testing.T) {
	want := RiskEscrowCreated{
		DealId:             big.NewInt(42),
		QuoteId:            [32]byte{0xaa, 0x01},
		Depositor:          common.HexToAddress("0x1111111111111111111111111111111111111111"),
		Counterparty:       common.HexToAddress("0x2222222222222222222222222222222222222222"),
		SettlementAsset:    common.Address{},
		Notional:           mustBigInt("10000000000000000000"),
		CollateralLocked:   mustBigInt("12000000000000000000"),
		SettlementDeadline: big.NewInt(1_700_000_000),
		ModelVersion:       "garch-1.1.0",
		RiskSnapshotHash:   [32]byte{0xbb, 0x02},
	}

	m := want.ToDecodedMap()
	got, err := RiskEscrowCreatedFromMap(m)
	if err != nil {
		t.Fatalf("RiskEscrowCreatedFromMap: %v", err)
	}

	if got.DealId.Cmp(want.DealId) != 0 ||
		got.QuoteId != want.QuoteId ||
		got.Depositor != want.Depositor ||
		got.Counterparty != want.Counterparty ||
		got.SettlementAsset != want.SettlementAsset ||
		got.Notional.Cmp(want.Notional) != 0 ||
		got.CollateralLocked.Cmp(want.CollateralLocked) != 0 ||
		got.SettlementDeadline.Cmp(want.SettlementDeadline) != 0 ||
		got.ModelVersion != want.ModelVersion ||
		got.RiskSnapshotHash != want.RiskSnapshotHash {
		t.Errorf("round trip mismatch:\n got  = %+v\n want = %+v", got, want)
	}

	dealID, ok := DealIDFromLog(EventRiskEscrowCreated, m)
	if !ok || dealID != 42 {
		t.Errorf("DealIDFromLog = (%d, %v), want (42, true)", dealID, ok)
	}
}

func TestRiskEscrowSettled_RoundTrip(t *testing.T) {
	want := RiskEscrowSettled{
		DealId:          big.NewInt(7),
		Counterparty:    common.HexToAddress("0x3333333333333333333333333333333333333333"),
		Payout:          mustBigInt("9500000000000000000"),
		PlatformFee:     big.NewInt(500000000000000000),
		DepositorRefund: big.NewInt(2000000000000000000),
	}
	got, err := RiskEscrowSettledFromMap(want.ToDecodedMap())
	if err != nil {
		t.Fatalf("RiskEscrowSettledFromMap: %v", err)
	}
	if got.DealId.Cmp(want.DealId) != 0 || got.Counterparty != want.Counterparty ||
		got.Payout.Cmp(want.Payout) != 0 || got.PlatformFee.Cmp(want.PlatformFee) != 0 ||
		got.DepositorRefund.Cmp(want.DepositorRefund) != 0 {
		t.Errorf("round trip mismatch: got=%+v want=%+v", got, want)
	}
}

func TestRiskEscrowRefunded_RoundTrip(t *testing.T) {
	want := RiskEscrowRefunded{
		DealId:    big.NewInt(3),
		Depositor: common.HexToAddress("0x4444444444444444444444444444444444444444"),
		Amount:    mustBigInt("12000000000000000000"),
	}
	got, err := RiskEscrowRefundedFromMap(want.ToDecodedMap())
	if err != nil {
		t.Fatalf("RiskEscrowRefundedFromMap: %v", err)
	}
	if got.DealId.Cmp(want.DealId) != 0 || got.Depositor != want.Depositor || got.Amount.Cmp(want.Amount) != 0 {
		t.Errorf("round trip mismatch: got=%+v want=%+v", got, want)
	}
}

func TestRiskOracleUpdated_RoundTrip(t *testing.T) {
	want := RiskOracleUpdated{
		PreviousOracle: common.HexToAddress("0x1"),
		NewOracle:      common.HexToAddress("0x2"),
	}
	got, err := RiskOracleUpdatedFromMap(want.ToDecodedMap())
	if err != nil {
		t.Fatalf("RiskOracleUpdatedFromMap: %v", err)
	}
	if got != want {
		t.Errorf("round trip mismatch: got=%+v want=%+v", got, want)
	}
}

func TestPlatformFeeUpdated_RoundTrip(t *testing.T) {
	want := PlatformFeeUpdated{PreviousFeeBps: big.NewInt(500), NewFeeBps: big.NewInt(750)}
	got, err := PlatformFeeUpdatedFromMap(want.ToDecodedMap())
	if err != nil {
		t.Fatalf("PlatformFeeUpdatedFromMap: %v", err)
	}
	if got.PreviousFeeBps.Cmp(want.PreviousFeeBps) != 0 || got.NewFeeBps.Cmp(want.NewFeeBps) != 0 {
		t.Errorf("round trip mismatch: got=%+v want=%+v", got, want)
	}
}

func TestPlatformWalletUpdated_RoundTrip(t *testing.T) {
	want := PlatformWalletUpdated{PreviousWallet: common.HexToAddress("0x5"), NewWallet: common.HexToAddress("0x6")}
	got, err := PlatformWalletUpdatedFromMap(want.ToDecodedMap())
	if err != nil {
		t.Fatalf("PlatformWalletUpdatedFromMap: %v", err)
	}
	if got != want {
		t.Errorf("round trip mismatch: got=%+v want=%+v", got, want)
	}
}

func TestFromMap_MissingField_Errors(t *testing.T) {
	_, err := RiskEscrowCreatedFromMap(map[string]string{"dealId": "1"})
	if err == nil {
		t.Fatal("expected error for incomplete map")
	}
}

func TestFromMap_MalformedField_Errors(t *testing.T) {
	m := RiskEscrowCreated{
		DealId: big.NewInt(1), QuoteId: [32]byte{}, Depositor: common.Address{}, Counterparty: common.Address{},
		SettlementAsset: common.Address{}, Notional: big.NewInt(1), CollateralLocked: big.NewInt(1),
		SettlementDeadline: big.NewInt(1), ModelVersion: "v1", RiskSnapshotHash: [32]byte{},
	}.ToDecodedMap()
	m["notional"] = "not-a-number"
	if _, err := RiskEscrowCreatedFromMap(m); err == nil {
		t.Fatal("expected error for malformed notional field")
	}
}

func TestDealIDFromLog_NonDealScopedEvent(t *testing.T) {
	m := PlatformFeeUpdated{PreviousFeeBps: big.NewInt(1), NewFeeBps: big.NewInt(2)}.ToDecodedMap()
	if _, ok := DealIDFromLog(EventPlatformFeeUpdated, m); ok {
		t.Fatal("expected ok=false for a non-deal-scoped event")
	}
}
