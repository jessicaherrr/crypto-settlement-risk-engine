// Package metrics provides minimal operational visibility into the
// indexer: current chain head, scan/confirmation lag, and counters for
// events processed, duplicates ignored, retries and reorgs. Deliberately
// not a full observability platform - one struct of atomic counters and a
// JSON health endpoint, per the phase's "lightweight health endpoint...
// is enough" guidance.
package metrics

import (
	"encoding/json"
	"net/http"
	"sync"
	"sync/atomic"
	"time"
)

// Health holds the indexer's live operational counters. All fields are
// safe for concurrent use from the scan loop and the HTTP handler.
type Health struct {
	// Static identity of what this instance indexes, set once at
	// construction and never mutated - included in Snapshot so a dashboard
	// polling the health endpoint can confirm it's looking at the instance
	// it thinks it is.
	chainID           uint64
	contractAddress   string
	confirmationDepth uint64

	chainHead            atomic.Uint64
	lastScannedBlock     atomic.Uint64
	lastConfirmedBlock   atomic.Uint64
	lastSuccessfulRPCNS  atomic.Int64
	lastSuccessfulDBNS   atomic.Int64
	totalEventsProcessed atomic.Uint64
	duplicatesIgnored    atomic.Uint64
	retryCount           atomic.Uint64
	reorgCount           atomic.Uint64

	mu        sync.RWMutex
	lastErr   string
	startedAt time.Time
}

// New returns a Health tracker with its start time recorded, identified by
// the chain/contract/confirmation-depth it was configured to index.
func New(chainID uint64, contractAddress string, confirmationDepth uint64) *Health {
	return &Health{
		chainID:           chainID,
		contractAddress:   contractAddress,
		confirmationDepth: confirmationDepth,
		startedAt:         time.Now().UTC(),
	}
}

func (h *Health) SetChainHead(n uint64)          { h.chainHead.Store(n) }
func (h *Health) SetLastScannedBlock(n uint64)   { h.lastScannedBlock.Store(n) }
func (h *Health) SetLastConfirmedBlock(n uint64) { h.lastConfirmedBlock.Store(n) }

func (h *Health) MarkSuccessfulRPCCall() { h.lastSuccessfulRPCNS.Store(time.Now().UnixNano()) }
func (h *Health) MarkSuccessfulDBWrite() { h.lastSuccessfulDBNS.Store(time.Now().UnixNano()) }

func (h *Health) AddEventsProcessed(n uint64)   { h.totalEventsProcessed.Add(n) }
func (h *Health) AddDuplicatesIgnored(n uint64) { h.duplicatesIgnored.Add(n) }
func (h *Health) AddRetry(n uint64)             { h.retryCount.Add(n) }
func (h *Health) AddReorg(n uint64)             { h.reorgCount.Add(n) }

// SetLastError records the most recent scan-loop error for display. Pass
// "" to clear it once a subsequent cycle succeeds.
func (h *Health) SetLastError(msg string) {
	h.mu.Lock()
	h.lastErr = msg
	h.mu.Unlock()
}

// Snapshot is the JSON-serializable view of Health returned by the health
// endpoint.
type Snapshot struct {
	ChainID           uint64 `json:"chain_id"`
	ContractAddress   string `json:"contract_address"`
	ConfirmationDepth uint64 `json:"confirmation_depth"`

	StartedAt              time.Time  `json:"started_at"`
	ChainHead              uint64     `json:"chain_head"`
	LastScannedBlock       uint64     `json:"last_scanned_block"`
	LastConfirmedBlock     uint64     `json:"last_confirmed_block"`
	ConfirmedLagBlocks     int64      `json:"confirmed_lag_blocks"`
	LastSuccessfulRPCCall  *time.Time `json:"last_successful_rpc_call,omitempty"`
	LastSuccessfulDBWrite  *time.Time `json:"last_successful_db_write,omitempty"`
	TotalEventsProcessed   uint64     `json:"total_events_processed"`
	DuplicateEventsIgnored uint64     `json:"duplicate_events_ignored"`
	RetryCount             uint64     `json:"retry_count"`
	ReorgCount             uint64     `json:"reorg_count"`
	LastError              string     `json:"last_error,omitempty"`
}

// Snapshot returns a point-in-time copy of all counters.
func (h *Health) Snapshot() Snapshot {
	h.mu.RLock()
	lastErr := h.lastErr
	h.mu.RUnlock()

	chainHead := h.chainHead.Load()
	lastConfirmed := h.lastConfirmedBlock.Load()

	s := Snapshot{
		ChainID:                h.chainID,
		ContractAddress:        h.contractAddress,
		ConfirmationDepth:      h.confirmationDepth,
		StartedAt:              h.startedAt,
		ChainHead:              chainHead,
		LastScannedBlock:       h.lastScannedBlock.Load(),
		LastConfirmedBlock:     lastConfirmed,
		ConfirmedLagBlocks:     int64(chainHead) - int64(lastConfirmed),
		TotalEventsProcessed:   h.totalEventsProcessed.Load(),
		DuplicateEventsIgnored: h.duplicatesIgnored.Load(),
		RetryCount:             h.retryCount.Load(),
		ReorgCount:             h.reorgCount.Load(),
		LastError:              lastErr,
	}
	if ns := h.lastSuccessfulRPCNS.Load(); ns != 0 {
		t := time.Unix(0, ns).UTC()
		s.LastSuccessfulRPCCall = &t
	}
	if ns := h.lastSuccessfulDBNS.Load(); ns != 0 {
		t := time.Unix(0, ns).UTC()
		s.LastSuccessfulDBWrite = &t
	}
	return s
}

// Handler returns an http.Handler serving the current Snapshot as JSON on
// GET requests (any path - intended to be mounted at the service's health
// endpoint root).
func (h *Health) Handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(h.Snapshot()); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
		}
	})
}
