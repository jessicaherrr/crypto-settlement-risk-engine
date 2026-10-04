package chain

import (
	"context"
	"errors"
	"fmt"
	"math/big"
	"testing"
	"time"

	"github.com/ethereum/go-ethereum"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
)

// fakeRaw is a minimal rawClient test double: each method call counts
// against failUntil successive errors before it starts succeeding, so
// tests can assert retry/backoff behavior without a live RPC endpoint.
type fakeRaw struct {
	calls     int
	failUntil int // number of calls that should fail before succeeding
	closed    bool
}

func (f *fakeRaw) nextErr() error {
	f.calls++
	if f.calls <= f.failUntil {
		return errors.New("transient rpc error")
	}
	return nil
}

func (f *fakeRaw) ChainID(ctx context.Context) (*big.Int, error) {
	if err := f.nextErr(); err != nil {
		return nil, err
	}
	return big.NewInt(1337), nil
}

func (f *fakeRaw) BlockNumber(ctx context.Context) (uint64, error) {
	if err := f.nextErr(); err != nil {
		return 0, err
	}
	return 100, nil
}

func (f *fakeRaw) FilterLogs(ctx context.Context, q ethereum.FilterQuery) ([]types.Log, error) {
	if err := f.nextErr(); err != nil {
		return nil, err
	}
	return []types.Log{}, nil
}

func (f *fakeRaw) TransactionReceipt(ctx context.Context, txHash common.Hash) (*types.Receipt, error) {
	if err := f.nextErr(); err != nil {
		return nil, err
	}
	return &types.Receipt{}, nil
}

func (f *fakeRaw) CodeAt(ctx context.Context, account common.Address, blockNumber *big.Int) ([]byte, error) {
	if err := f.nextErr(); err != nil {
		return nil, err
	}
	return []byte{0x60, 0x80}, nil
}

func (f *fakeRaw) Close() { f.closed = true }

// fakeRPCClient is a blockHashFetcher test double standing in for the raw
// *rpc.Client used only by BlockHashByNumber.
type fakeRPCClient struct {
	calls     int
	failUntil int
	hash      common.Hash
}

func (f *fakeRPCClient) CallContext(ctx context.Context, result interface{}, method string, args ...interface{}) error {
	f.calls++
	if f.calls <= f.failUntil {
		return errors.New("transient rpc error")
	}
	out, ok := result.(*rawBlockHeader)
	if !ok {
		return fmt.Errorf("unexpected result type %T", result)
	}
	h := f.hash
	if h == (common.Hash{}) {
		h = common.HexToHash("0xaaaa")
	}
	out.Hash = h
	return nil
}

func fastRetry() RetryConfig {
	return RetryConfig{MaxAttempts: 4, BaseDelay: time.Millisecond, MaxDelay: 5 * time.Millisecond}
}

func TestRetryingClient_SucceedsAfterTransientFailures(t *testing.T) {
	raw := &fakeRaw{failUntil: 2}
	c := &retryingClient{eth: raw, retry: fastRetry()}

	n, err := c.BlockNumber(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if n != 100 {
		t.Errorf("BlockNumber = %d, want 100", n)
	}
	if raw.calls != 3 {
		t.Errorf("calls = %d, want 3 (2 failures + 1 success)", raw.calls)
	}
}

func TestRetryingClient_GivesUpAfterMaxAttempts(t *testing.T) {
	raw := &fakeRaw{failUntil: 100} // always fails
	retry := fastRetry()
	c := &retryingClient{eth: raw, retry: retry}

	_, err := c.BlockNumber(context.Background())
	if err == nil {
		t.Fatal("expected error after exhausting retries")
	}
	if raw.calls != retry.MaxAttempts {
		t.Errorf("calls = %d, want MaxAttempts=%d", raw.calls, retry.MaxAttempts)
	}
}

func TestRetryingClient_StopsImmediatelyOnContextCancel(t *testing.T) {
	raw := &fakeRaw{failUntil: 100}
	// Large backoff so the test would hang if cancellation weren't honored.
	retry := RetryConfig{MaxAttempts: 10, BaseDelay: 10 * time.Second, MaxDelay: 10 * time.Second}
	c := &retryingClient{eth: raw, retry: retry}

	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	done := make(chan error, 1)
	go func() {
		_, err := c.BlockNumber(ctx)
		done <- err
	}()

	select {
	case err := <-done:
		if err == nil {
			t.Fatal("expected error from canceled context")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("withRetry did not respect context cancellation")
	}
}

func TestRetryingClient_AllMethodsDelegate(t *testing.T) {
	raw := &fakeRaw{}
	c := &retryingClient{eth: raw, rpc: &fakeRPCClient{}, retry: fastRetry()}
	ctx := context.Background()

	if _, err := c.ChainID(ctx); err != nil {
		t.Errorf("ChainID: %v", err)
	}
	if _, err := c.BlockHashByNumber(ctx, big.NewInt(1)); err != nil {
		t.Errorf("BlockHashByNumber: %v", err)
	}
	if _, err := c.FilterLogs(ctx, ethereum.FilterQuery{}); err != nil {
		t.Errorf("FilterLogs: %v", err)
	}
	if _, err := c.TransactionReceipt(ctx, common.Hash{}); err != nil {
		t.Errorf("TransactionReceipt: %v", err)
	}
	if _, err := c.CodeAt(ctx, common.Address{}, nil); err != nil {
		t.Errorf("CodeAt: %v", err)
	}
	c.Close()
	if !raw.closed {
		t.Error("Close() did not propagate to underlying rawClient")
	}
}

func TestRetryingClient_BlockHashByNumber_RetriesAndReturnsServerReportedHash(t *testing.T) {
	want := common.HexToHash("0xfeedface")
	rpcFake := &fakeRPCClient{failUntil: 2, hash: want}
	c := &retryingClient{eth: &fakeRaw{}, rpc: rpcFake, retry: fastRetry()}

	got, err := c.BlockHashByNumber(context.Background(), big.NewInt(42))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got != want {
		t.Errorf("BlockHashByNumber = %s, want %s", got.Hex(), want.Hex())
	}
	if rpcFake.calls != 3 {
		t.Errorf("calls = %d, want 3 (2 failures + 1 success)", rpcFake.calls)
	}
}

func TestBackoffDelay_NeverExceedsMax(t *testing.T) {
	retry := RetryConfig{MaxAttempts: 10, BaseDelay: time.Second, MaxDelay: 3 * time.Second}
	for attempt := 1; attempt <= 10; attempt++ {
		d := backoffDelay(retry, attempt)
		if d > retry.MaxDelay {
			t.Errorf("attempt %d: backoffDelay = %v, exceeds MaxDelay %v", attempt, d, retry.MaxDelay)
		}
		if d < 0 {
			t.Errorf("attempt %d: backoffDelay = %v, want >= 0", attempt, d)
		}
	}
}

// --- ValidateChainID / ValidateContract ---

type stubClient struct {
	chainID *big.Int
	code    []byte
	err     error
}

func (s stubClient) ChainID(ctx context.Context) (*big.Int, error) { return s.chainID, s.err }
func (s stubClient) BlockNumber(ctx context.Context) (uint64, error) {
	return 0, errors.New("unused")
}
func (s stubClient) BlockHashByNumber(ctx context.Context, number *big.Int) (common.Hash, error) {
	return common.Hash{}, errors.New("unused")
}
func (s stubClient) FilterLogs(ctx context.Context, q ethereum.FilterQuery) ([]types.Log, error) {
	return nil, errors.New("unused")
}
func (s stubClient) TransactionReceipt(ctx context.Context, txHash common.Hash) (*types.Receipt, error) {
	return nil, errors.New("unused")
}
func (s stubClient) CodeAt(ctx context.Context, account common.Address, blockNumber *big.Int) ([]byte, error) {
	return s.code, s.err
}
func (s stubClient) Close() {}

func TestValidateChainID_Match(t *testing.T) {
	c := stubClient{chainID: big.NewInt(80002)}
	if err := ValidateChainID(context.Background(), c, 80002); err != nil {
		t.Errorf("unexpected error: %v", err)
	}
}

func TestValidateChainID_Mismatch(t *testing.T) {
	c := stubClient{chainID: big.NewInt(80002)}
	if err := ValidateChainID(context.Background(), c, 1); err == nil {
		t.Fatal("expected error for chain ID mismatch")
	}
}

func TestValidateContract_HasCode(t *testing.T) {
	c := stubClient{code: []byte{0x60, 0x80}}
	if err := ValidateContract(context.Background(), c, common.HexToAddress("0x1")); err != nil {
		t.Errorf("unexpected error: %v", err)
	}
}

func TestValidateContract_NoCode(t *testing.T) {
	c := stubClient{code: nil}
	err := ValidateContract(context.Background(), c, common.HexToAddress("0x1"))
	if err == nil {
		t.Fatal("expected error for empty contract code")
	}
	if !errors.Is(err, ErrContractCodeEmpty) {
		t.Errorf("error = %v, want wrapping ErrContractCodeEmpty", err)
	}
}
