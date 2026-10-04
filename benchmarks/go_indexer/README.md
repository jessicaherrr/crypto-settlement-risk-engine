# go_indexer benchmarks

Two `go test -bench` benchmarks. Both were run once, on the
development machine (Apple M4, local `brew`
PostgreSQL 16 on localhost) - they are a sanity check on where time goes
in this pipeline, not a production capacity claim. Re-run them yourself
(`go test ./internal/<pkg>/... -bench . -run '^$'`) before relying on any
number here for a real deployment target; network latency to a hosted
Supabase instance or a real Polygon RPC endpoint will dominate both
figures and this environment has neither.

## `internal/events` - BenchmarkDecodeRiskEscrowCreated / BenchmarkToDecodedMapAndBack

Pure CPU cost of decoding one log and of the full
`ToDecodedMap`/`FromMap` round trip used at observe- and confirm-time
(`internal/store`). No RPC or DB involved.

```
BenchmarkDecodeRiskEscrowCreated-10    396501    3047 ns/op   7888 B/op   73 allocs/op
BenchmarkToDecodedMapAndBack-10        494932    2477 ns/op   4706 B/op   50 allocs/op
```

≈330k decodes/sec single-threaded on this machine. Decoding is not the
indexer's bottleneck - see below.

## `internal/store` - BenchmarkUpsertObservedEvent

One `UpsertObservedEvent` call (the idempotent INSERT ... ON CONFLICT
that persists one observed log) against local Postgres over a Unix/TCP
loopback connection:

```
BenchmarkUpsertObservedEvent-10    200    196156 ns/op
```

≈196µs/write, ≈5,100 sequential writes/sec, *to a database on the same
machine*. This is the actual bottleneck relative to decoding (two orders
of magnitude slower per unit), and it is also the number most likely to
look nothing like a real deployment: a hosted Supabase/Postgres instance
over the network adds real round-trip latency this loopback measurement
can't see, and `ScanRange`'s concurrent RPC fetches (internal/workers)
are bounded separately from this sequential-write path. Treat this as
"writes are the thing to watch," not as a throughput SLA.

## Methodology notes

- Confirmation depth, reorg handling and checkpointing are correctness
  mechanisms with a fixed per-cycle cost (a handful of RPC calls), not
  per-event costs - they aren't benchmarked separately because they don't
  scale with event volume the way decode/persist do.
- No end-to-end "events indexed per second against a real Polygon RPC"
  number exists yet, because this environment has no funded Amoy/mainnet
  RPC access to measure it honestly against. Do not add one without
  actually running it against the real target network.
