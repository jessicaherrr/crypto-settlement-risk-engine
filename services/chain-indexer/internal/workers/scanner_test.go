package workers

import (
	"context"
	"math/big"
	"testing"

	"github.com/ethereum/go-ethereum"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"

	"github.com/jessicaherrr/crypto-settlement-risk-engine/services/chain-indexer/internal/events"
)

func TestSplitRange_ExactMultiple(t *testing.T) {
	chunks := splitRange(1, 10, 5)
	want := []blockRange{{1, 5}, {6, 10}}
	if len(chunks) != len(want) {
		t.Fatalf("chunks = %+v, want %+v", chunks, want)
	}
	for i := range want {
		if chunks[i] != want[i] {
			t.Errorf("chunk %d = %+v, want %+v", i, chunks[i], want[i])
		}
	}
}

func TestSplitRange_RemainderLastChunkShorter(t *testing.T) {
	chunks := splitRange(1, 12, 5)
	want := []blockRange{{1, 5}, {6, 10}, {11, 12}}
	if len(chunks) != len(want) {
		t.Fatalf("chunks = %+v, want %+v", chunks, want)
	}
	for i := range want {
		if chunks[i] != want[i] {
			t.Errorf("chunk %d = %+v, want %+v", i, chunks[i], want[i])
		}
	}
}

func TestSplitRange_SingleBlock(t *testing.T) {
	chunks := splitRange(5, 5, 100)
	if len(chunks) != 1 || chunks[0] != (blockRange{5, 5}) {
		t.Errorf("chunks = %+v, want a single [5,5]", chunks)
	}
}

func TestSplitRange_FromAfterTo_ReturnsNil(t *testing.T) {
	if chunks := splitRange(10, 5, 5); chunks != nil {
		t.Errorf("chunks = %+v, want nil", chunks)
	}
}

// fakeChainClient is a chain.Client test double over an in-memory map of
// logs keyed by block range, and a map of block headers, so ScanRange and
// Indexer can be tested without a live RPC endpoint.
type fakeChainClient struct {
	logs      map[[2]uint64][]types.Log // [from,to] -> logs (test wires exact chunk ranges)
	allLogs   []types.Log               // used instead if logs map is nil: filters allLogs by range
	headers   map[uint64]*types.Header
	headBlock uint64
	err       error
}

func (f *fakeChainClient) ChainID(ctx context.Context) (*big.Int, error) {
	return big.NewInt(31337), f.err
}
func (f *fakeChainClient) BlockNumber(ctx context.Context) (uint64, error) {
	return f.headBlock, f.err
}

// BlockHashByNumber returns the hash of the fake header registered for
// this block number (see distinctHeader), or defaultHeaderForBlock's hash
// if none was registered - mirroring how the real chain.Client reads a
// server-reported hash rather than recomputing one (see
// internal/chain/client.go's doc comment on why that distinction matters).
func (f *fakeChainClient) BlockHashByNumber(ctx context.Context, number *big.Int) (common.Hash, error) {
	if f.err != nil {
		return common.Hash{}, f.err
	}
	h, ok := f.headers[number.Uint64()]
	if !ok {
		return defaultHeaderForBlock(number.Uint64()).Hash(), nil
	}
	return h.Hash(), nil
}
func (f *fakeChainClient) FilterLogs(ctx context.Context, q ethereum.FilterQuery) ([]types.Log, error) {
	if f.err != nil {
		return nil, f.err
	}
	from, to := q.FromBlock.Uint64(), q.ToBlock.Uint64()
	if f.logs != nil {
		return f.logs[[2]uint64{from, to}], nil
	}
	var out []types.Log
	for _, l := range f.allLogs {
		if l.BlockNumber >= from && l.BlockNumber <= to {
			out = append(out, l)
		}
	}
	return out, nil
}
func (f *fakeChainClient) TransactionReceipt(ctx context.Context, txHash common.Hash) (*types.Receipt, error) {
	return &types.Receipt{}, f.err
}
func (f *fakeChainClient) CodeAt(ctx context.Context, account common.Address, blockNumber *big.Int) ([]byte, error) {
	return []byte{0x60}, f.err
}
func (f *fakeChainClient) Close() {}

// defaultHeaderForBlock is what fakeChainClient.HeaderByNumber returns for
// any block number it has no explicit override for. Logs built by
// makeOracleUpdatedLog use this same header's hash as their BlockHash, so
// a test's confirmation-depth re-verification (which compares a stored
// log's BlockHash against a freshly fetched header's hash) matches by
// default, and a test can deliberately break that match (simulating a
// reorg) by registering an override in fakeChainClient.headers.
func defaultHeaderForBlock(blockNumber uint64) *types.Header {
	return &types.Header{Number: new(big.Int).SetUint64(blockNumber)}
}

func makeOracleUpdatedLog(blockNumber uint64, txHash string, logIndex uint) types.Log {
	ev := events.RiskOracleUpdated{PreviousOracle: common.HexToAddress("0x1"), NewOracle: common.HexToAddress("0x2")}
	id := events.ContractABI.Events[events.EventRiskOracleUpdated].ID
	prevTopic := common.BytesToHash(common.LeftPadBytes(ev.PreviousOracle.Bytes(), 32))
	newTopic := common.BytesToHash(common.LeftPadBytes(ev.NewOracle.Bytes(), 32))
	return types.Log{
		Address:     common.HexToAddress("0xcontract"),
		Topics:      []common.Hash{id, prevTopic, newTopic},
		Data:        nil,
		BlockNumber: blockNumber,
		BlockHash:   defaultHeaderForBlock(blockNumber).Hash(),
		TxHash:      common.HexToHash(txHash),
		TxIndex:     0,
		Index:       logIndex,
	}
}

func TestDecodeLog_RiskOracleUpdated(t *testing.T) {
	log := makeOracleUpdatedLog(1, "0x01", 0)
	ev, ok, err := DecodeLog(31337, log)
	if err != nil {
		t.Fatalf("DecodeLog: %v", err)
	}
	if !ok {
		t.Fatal("expected ok=true")
	}
	if ev.EventName != events.EventRiskOracleUpdated {
		t.Errorf("EventName = %q", ev.EventName)
	}
	if ev.DealID != nil {
		t.Errorf("DealID = %v, want nil for a non-deal-scoped event", ev.DealID)
	}
}

func TestDecodeLog_UnknownTopic_ReturnsNotOK(t *testing.T) {
	log := types.Log{Topics: []common.Hash{common.HexToHash("0xdead")}}
	_, ok, err := DecodeLog(31337, log)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if ok {
		t.Fatal("expected ok=false for an unrecognized topic")
	}
}

func TestScanRange_AcrossMultipleChunks_PreservesOrder(t *testing.T) {
	logA := makeOracleUpdatedLog(1, "0xaaa", 0)
	logB := makeOracleUpdatedLog(5, "0xbbb", 0)
	logC := makeOracleUpdatedLog(5, "0xbbb", 1) // same tx, second log
	logD := makeOracleUpdatedLog(10, "0xddd", 0)

	client := &fakeChainClient{allLogs: []types.Log{logD, logA, logC, logB}, headBlock: 10}

	got, err := ScanRange(context.Background(), client, common.HexToAddress("0xcontract"), 31337, 1, 10, 3, 2)
	if err != nil {
		t.Fatalf("ScanRange: %v", err)
	}
	if len(got) != 4 {
		t.Fatalf("len(got) = %d, want 4", len(got))
	}
	wantOrder := []uint64{1, 5, 5, 10}
	for i, want := range wantOrder {
		if got[i].BlockNumber != want {
			t.Errorf("got[%d].BlockNumber = %d, want %d (order not restored)", i, got[i].BlockNumber, want)
		}
	}
	// logB/logC share a block; ties broken by log index.
	if got[1].LogIndex != 0 || got[2].LogIndex != 1 {
		t.Errorf("same-block log ordering wrong: got[1].LogIndex=%d got[2].LogIndex=%d", got[1].LogIndex, got[2].LogIndex)
	}
}

func TestScanRange_PropagatesRPCError(t *testing.T) {
	client := &fakeChainClient{err: errSentinel, headBlock: 10}
	_, err := ScanRange(context.Background(), client, common.HexToAddress("0xcontract"), 31337, 1, 10, 5, 2)
	if err == nil {
		t.Fatal("expected error to propagate from a failing FilterLogs call")
	}
}

var errSentinel = fakeErr("sentinel rpc failure")

type fakeErr string

func (e fakeErr) Error() string { return string(e) }
