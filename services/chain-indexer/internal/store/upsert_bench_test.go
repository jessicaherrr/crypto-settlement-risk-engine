package store

import (
	"context"
	"fmt"
	"os"
	"testing"

	"github.com/jessicaherrr/crypto-settlement-risk-engine/services/chain-indexer/internal/events"
)

// BenchmarkUpsertObservedEvent measures persistence throughput against a
// real local PostgreSQL instance (not a live RPC - that part is measured
// separately in internal/events). This is the indexer's actual bottleneck
// in practice: one round trip per event. Skips like the rest of this
// package's tests if TEST_DATABASE_URL isn't set. See
// benchmarks/go_indexer/README.md for how this number is reported -
// against localhost Postgres on the machine that ran it, not a hosted
// instance, and not a substitute for measuring against the real target
// deployment.
func BenchmarkUpsertObservedEvent(b *testing.B) {
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		b.Skip("TEST_DATABASE_URL not set; skipping store benchmark")
	}
	ctx := context.Background()

	s, err := New(ctx, url)
	if err != nil {
		b.Fatalf("store.New: %v", err)
	}
	defer s.Close()
	if _, err := s.Pool().Exec(ctx, `TRUNCATE escrow_events RESTART IDENTITY`); err != nil {
		b.Fatalf("truncate: %v", err)
	}

	ev := sampleCreated(1)
	decoded := ev.ToDecodedMap()

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		raw := RawEvent{
			ChainID:         testChainID,
			ContractAddress: testContract,
			BlockNumber:     uint64(i + 1),
			BlockHash:       "0xbench",
			TxHash:          fmt.Sprintf("0xbench%d", i),
			TxIndex:         0,
			LogIndex:        0,
			EventName:       events.EventRiskEscrowCreated,
			Decoded:         decoded,
		}
		if _, err := s.UpsertObservedEvent(ctx, raw); err != nil {
			b.Fatalf("UpsertObservedEvent: %v", err)
		}
	}
}
