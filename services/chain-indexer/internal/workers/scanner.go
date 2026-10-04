// Package workers contains the indexer's scan/confirm pipeline: fetching
// and decoding logs for a block range (this file), and orchestrating
// checkpointing, confirmation depth and reorg handling (indexer.go).
package workers

import (
	"context"
	"fmt"
	"math/big"
	"sort"
	"sync"

	"github.com/ethereum/go-ethereum"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"

	"github.com/jessicaherrr/crypto-settlement-risk-engine/services/chain-indexer/internal/chain"
	"github.com/jessicaherrr/crypto-settlement-risk-engine/services/chain-indexer/internal/events"
	"github.com/jessicaherrr/crypto-settlement-risk-engine/services/chain-indexer/internal/store"
)

// DecodeLog converts a raw log into a store.RawEvent, or ok=false if the
// log's topic0 doesn't match one of the six indexed RiskEscrow events
// (should not normally happen, since FilterLogs is scoped to the
// configured contract address, but a defensive check costs nothing).
func DecodeLog(chainID uint64, log types.Log) (store.RawEvent, bool, error) {
	name, ok := events.EventNameForLog(log)
	if !ok {
		return store.RawEvent{}, false, nil
	}

	var decoded map[string]string
	var dealID *uint64

	switch name {
	case events.EventRiskEscrowCreated:
		ev, err := events.DecodeRiskEscrowCreated(log)
		if err != nil {
			return store.RawEvent{}, false, err
		}
		decoded = ev.ToDecodedMap()
		id := ev.DealId.Uint64()
		dealID = &id

	case events.EventRiskEscrowSettled:
		ev, err := events.DecodeRiskEscrowSettled(log)
		if err != nil {
			return store.RawEvent{}, false, err
		}
		decoded = ev.ToDecodedMap()
		id := ev.DealId.Uint64()
		dealID = &id

	case events.EventRiskEscrowRefunded:
		ev, err := events.DecodeRiskEscrowRefunded(log)
		if err != nil {
			return store.RawEvent{}, false, err
		}
		decoded = ev.ToDecodedMap()
		id := ev.DealId.Uint64()
		dealID = &id

	case events.EventRiskOracleUpdated:
		ev, err := events.DecodeRiskOracleUpdated(log)
		if err != nil {
			return store.RawEvent{}, false, err
		}
		decoded = ev.ToDecodedMap()

	case events.EventPlatformFeeUpdated:
		ev, err := events.DecodePlatformFeeUpdated(log)
		if err != nil {
			return store.RawEvent{}, false, err
		}
		decoded = ev.ToDecodedMap()

	case events.EventPlatformWalletUpdated:
		ev, err := events.DecodePlatformWalletUpdated(log)
		if err != nil {
			return store.RawEvent{}, false, err
		}
		decoded = ev.ToDecodedMap()

	default:
		return store.RawEvent{}, false, nil
	}

	return store.RawEvent{
		ChainID:         chainID,
		ContractAddress: log.Address.Hex(),
		BlockNumber:     log.BlockNumber,
		BlockHash:       log.BlockHash.Hex(),
		TxHash:          log.TxHash.Hex(),
		TxIndex:         log.TxIndex,
		LogIndex:        log.Index,
		EventName:       name,
		DealID:          dealID,
		Decoded:         decoded,
	}, true, nil
}

// blockRange is an inclusive [From, To] range of block numbers.
type blockRange struct {
	From, To uint64
}

// splitRange divides [from, to] into contiguous, non-overlapping
// sub-ranges of at most maxBlockRange blocks each, for concurrent
// fetching. Splitting a large backfill range this way is the indexer's
// one deliberate use of concurrency for throughput: RPC log fetches are
// the bottleneck, not decoding, and ordering is restored by the caller
// (ScanRange) before anything is persisted. How many of these run at once
// is capped separately, by ScanRange's semaphore.
func splitRange(from, to, maxBlockRange uint64) []blockRange {
	if from > to {
		return nil
	}
	if maxBlockRange == 0 {
		maxBlockRange = 1
	}

	var chunks []blockRange
	for start := from; start <= to; {
		end := start + maxBlockRange - 1
		if end > to {
			end = to
		}
		chunks = append(chunks, blockRange{From: start, To: end})
		if end == to {
			break
		}
		start = end + 1
	}
	return chunks
}

// ScanRange fetches and decodes every indexed RiskEscrow log in [from, to]
// (inclusive), using up to maxConcurrent goroutines to fetch different
// sub-ranges of at most maxBlockRange blocks each in parallel. Results are
// returned sorted by (BlockNumber, TxIndex, LogIndex) regardless of fetch
// order or concurrency, since event-ordering constraints matter even
// though the fetch itself does not need to be ordered.
func ScanRange(ctx context.Context, client chain.Client, contract common.Address, chainID uint64, from, to, maxBlockRange uint64, maxConcurrent int) ([]store.RawEvent, error) {
	chunks := splitRange(from, to, maxBlockRange)
	if len(chunks) == 0 {
		return nil, nil
	}
	if maxConcurrent <= 0 {
		maxConcurrent = 1
	}

	var (
		mu       sync.Mutex
		all      []store.RawEvent
		firstErr error
		wg       sync.WaitGroup
		sem      = make(chan struct{}, maxConcurrent)
	)

	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	for _, c := range chunks {
		if ctx.Err() != nil {
			break
		}

		wg.Add(1)
		sem <- struct{}{}
		go func(c blockRange) {
			defer wg.Done()
			defer func() { <-sem }()

			logs, err := client.FilterLogs(ctx, ethereum.FilterQuery{
				FromBlock: new(big.Int).SetUint64(c.From),
				ToBlock:   new(big.Int).SetUint64(c.To),
				Addresses: []common.Address{contract},
			})
			if err != nil {
				mu.Lock()
				if firstErr == nil {
					firstErr = fmt.Errorf("scan range [%d,%d]: %w", c.From, c.To, err)
				}
				mu.Unlock()
				cancel()
				return
			}

			var decoded []store.RawEvent
			for _, log := range logs {
				ev, ok, err := DecodeLog(chainID, log)
				if err != nil {
					mu.Lock()
					if firstErr == nil {
						firstErr = fmt.Errorf("decode log tx=%s logIndex=%d: %w", log.TxHash.Hex(), log.Index, err)
					}
					mu.Unlock()
					cancel()
					return
				}
				if ok {
					decoded = append(decoded, ev)
				}
			}

			mu.Lock()
			all = append(all, decoded...)
			mu.Unlock()
		}(c)
	}

	wg.Wait()
	if firstErr != nil {
		return nil, firstErr
	}

	sort.Slice(all, func(i, j int) bool {
		if all[i].BlockNumber != all[j].BlockNumber {
			return all[i].BlockNumber < all[j].BlockNumber
		}
		if all[i].TxIndex != all[j].TxIndex {
			return all[i].TxIndex < all[j].TxIndex
		}
		return all[i].LogIndex < all[j].LogIndex
	})
	return all, nil
}
