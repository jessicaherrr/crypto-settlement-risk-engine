package events

import (
	"math/big"
	"testing"

	"github.com/ethereum/go-ethereum/common"
)

// BenchmarkDecodeRiskEscrowCreated measures the CPU cost of decoding one
// RiskEscrowCreated log - the indexer's hottest per-event path during a
// large historical backfill, where RPC round-trips are batched but
// decoding still happens once per log. See benchmarks/go_indexer/README.md
// for how this number is reported; nothing in docs claims an indexer-wide
// events/sec figure beyond what this benchmark actually measured.
func BenchmarkDecodeRiskEscrowCreated(b *testing.B) {
	log := buildLog(b, EventRiskEscrowCreated,
		[]interface{}{
			big.NewInt(42),
			[32]byte{0xaa},
			common.HexToAddress("0x1111111111111111111111111111111111111111"),
		},
		[]interface{}{
			common.HexToAddress("0x2222222222222222222222222222222222222222"),
			common.Address{},
			big.NewInt(10_000000000000000),
			big.NewInt(12_000000000000000),
			big.NewInt(1_700_000_000),
			"garch-1.1.0",
			[32]byte{0xbb},
		},
	)

	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		if _, err := DecodeRiskEscrowCreated(log); err != nil {
			b.Fatal(err)
		}
	}
}

// BenchmarkToDecodedMapAndBack measures the full observe-time encode +
// confirm-time decode round trip (ToDecodedMap -> FromMap), which is what
// actually runs for every event, twice (see internal/store).
func BenchmarkToDecodedMapAndBack(b *testing.B) {
	ev := RiskEscrowCreated{
		DealId:             big.NewInt(42),
		QuoteId:            [32]byte{0xaa},
		Depositor:          common.HexToAddress("0x1111111111111111111111111111111111111111"),
		Counterparty:       common.HexToAddress("0x2222222222222222222222222222222222222222"),
		SettlementAsset:    common.Address{},
		Notional:           big.NewInt(10_000000000000000),
		CollateralLocked:   big.NewInt(12_000000000000000),
		SettlementDeadline: big.NewInt(1_700_000_000),
		ModelVersion:       "garch-1.1.0",
		RiskSnapshotHash:   [32]byte{0xbb},
	}

	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		m := ev.ToDecodedMap()
		if _, err := RiskEscrowCreatedFromMap(m); err != nil {
			b.Fatal(err)
		}
	}
}
