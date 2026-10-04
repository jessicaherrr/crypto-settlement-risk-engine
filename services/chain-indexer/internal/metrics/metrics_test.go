package metrics

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestSnapshot_ComputesLag(t *testing.T) {
	h := New(31337, "0x000000000000000000000000000000000000ab", 5)
	h.SetChainHead(100)
	h.SetLastConfirmedBlock(90)

	snap := h.Snapshot()
	if snap.ConfirmedLagBlocks != 10 {
		t.Errorf("ConfirmedLagBlocks = %d, want 10", snap.ConfirmedLagBlocks)
	}
}

func TestSnapshot_CountersAccumulate(t *testing.T) {
	h := New(31337, "0x000000000000000000000000000000000000ab", 5)
	h.AddEventsProcessed(5)
	h.AddEventsProcessed(3)
	h.AddDuplicatesIgnored(2)
	h.AddRetry(1)
	h.AddReorg(1)

	snap := h.Snapshot()
	if snap.TotalEventsProcessed != 8 {
		t.Errorf("TotalEventsProcessed = %d, want 8", snap.TotalEventsProcessed)
	}
	if snap.DuplicateEventsIgnored != 2 {
		t.Errorf("DuplicateEventsIgnored = %d, want 2", snap.DuplicateEventsIgnored)
	}
	if snap.RetryCount != 1 || snap.ReorgCount != 1 {
		t.Errorf("RetryCount/ReorgCount = %d/%d, want 1/1", snap.RetryCount, snap.ReorgCount)
	}
}

func TestSnapshot_LastErrorRoundTrips(t *testing.T) {
	h := New(31337, "0x000000000000000000000000000000000000ab", 5)
	h.SetLastError("boom")
	if got := h.Snapshot().LastError; got != "boom" {
		t.Errorf("LastError = %q, want %q", got, "boom")
	}
	h.SetLastError("")
	if got := h.Snapshot().LastError; got != "" {
		t.Errorf("LastError = %q, want empty after clearing", got)
	}
}

func TestSnapshot_TimestampsNilUntilSet(t *testing.T) {
	h := New(31337, "0x000000000000000000000000000000000000ab", 5)
	snap := h.Snapshot()
	if snap.LastSuccessfulRPCCall != nil || snap.LastSuccessfulDBWrite != nil {
		t.Fatal("expected nil timestamps before any success is recorded")
	}

	h.MarkSuccessfulRPCCall()
	h.MarkSuccessfulDBWrite()
	snap = h.Snapshot()
	if snap.LastSuccessfulRPCCall == nil || snap.LastSuccessfulDBWrite == nil {
		t.Fatal("expected non-nil timestamps after marking success")
	}
}

func TestHandler_ServesJSON(t *testing.T) {
	h := New(31337, "0x000000000000000000000000000000000000ab", 5)
	h.SetChainHead(42)

	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	rec := httptest.NewRecorder()
	h.Handler().ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var snap Snapshot
	if err := json.Unmarshal(rec.Body.Bytes(), &snap); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if snap.ChainHead != 42 {
		t.Errorf("ChainHead = %d, want 42", snap.ChainHead)
	}
	if snap.ChainID != 31337 || snap.ContractAddress != "0x000000000000000000000000000000000000ab" || snap.ConfirmationDepth != 5 {
		t.Errorf("identity fields = (%d, %q, %d), want (31337, %q, 5)", snap.ChainID, snap.ContractAddress, snap.ConfirmationDepth, "0x000000000000000000000000000000000000ab")
	}
}
