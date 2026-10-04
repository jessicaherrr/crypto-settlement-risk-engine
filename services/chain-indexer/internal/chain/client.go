// Package chain provides a small, retrying abstraction over an EVM JSON-RPC
// endpoint. It never holds or needs a private key: the indexer only reads
// chain state (block numbers, headers, logs, receipts) - it never signs or
// sends a transaction.
package chain

import (
	"context"
	"errors"
	"fmt"
	"math/big"
	"math/rand"
	"time"

	"github.com/ethereum/go-ethereum"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/common/hexutil"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/ethclient"
	"github.com/ethereum/go-ethereum/rpc"
)

// Client is the set of read-only chain operations the indexer depends on.
// Defined as an interface so workers/store code can be tested against an
// in-memory fake instead of a live RPC endpoint.
//
// BlockHashByNumber deliberately returns the hash exactly as the server
// reports it for that block, rather than a hash recomputed client-side
// from a fetched header's RLP encoding (as go-ethereum's own
// types.Header.Hash() does). The two are not interchangeable in practice:
// a locally recomputed hash depends on every header field round-tripping
// through JSON exactly as the chain's consensus rules intend, and
// real-world dev chains (Hardhat's included) don't always encode optional
// header fields (baseFee, withdrawals/blob fields, etc.) in a way that
// reproduces their own reported hash. Since logs (types.Log.BlockHash) are
// also taken as-is from the server, comparing like-for-like - both
// server-reported - is what makes reorg detection (internal/workers)
// actually reliable here, not just theoretically correct against a
// reference implementation.
type Client interface {
	ChainID(ctx context.Context) (*big.Int, error)
	BlockNumber(ctx context.Context) (uint64, error)
	BlockHashByNumber(ctx context.Context, number *big.Int) (common.Hash, error)
	FilterLogs(ctx context.Context, q ethereum.FilterQuery) ([]types.Log, error)
	TransactionReceipt(ctx context.Context, txHash common.Hash) (*types.Receipt, error)
	CodeAt(ctx context.Context, account common.Address, blockNumber *big.Int) ([]byte, error)
	Close()
}

// RetryConfig controls the retry/backoff behavior applied to every RPC
// call. Configurable rather than hard-coded so tests can use near-zero
// delays.
type RetryConfig struct {
	MaxAttempts int
	BaseDelay   time.Duration
	MaxDelay    time.Duration
}

// DefaultRetryConfig is a reasonable production default: up to 5 attempts,
// exponential backoff from 250ms up to 5s, with jitter.
func DefaultRetryConfig() RetryConfig {
	return RetryConfig{MaxAttempts: 5, BaseDelay: 250 * time.Millisecond, MaxDelay: 5 * time.Second}
}

// rawClient is the subset of *ethclient.Client's methods retryingClient
// retries. Defined as an interface (rather than embedding *ethclient.Client
// directly) so tests can exercise the retry/backoff logic against a fake
// without a live RPC endpoint.
type rawClient interface {
	ChainID(ctx context.Context) (*big.Int, error)
	BlockNumber(ctx context.Context) (uint64, error)
	FilterLogs(ctx context.Context, q ethereum.FilterQuery) ([]types.Log, error)
	TransactionReceipt(ctx context.Context, txHash common.Hash) (*types.Receipt, error)
	CodeAt(ctx context.Context, account common.Address, blockNumber *big.Int) ([]byte, error)
	Close()
}

// rawBlockHeader is the minimal shape read out of a raw eth_getBlockByNumber
// response: just the server's own "hash" field, deliberately not decoded
// into go-ethereum's types.Header (see the Client doc comment above).
type rawBlockHeader struct {
	Hash common.Hash `json:"hash"`
}

// blockHashFetcher is implemented by the raw *rpc.Client, kept as its own
// tiny interface so tests can fake just this one call.
type blockHashFetcher interface {
	CallContext(ctx context.Context, result interface{}, method string, args ...interface{}) error
}

// retryingClient wraps a rawClient, retrying each call on transient
// failure with exponential backoff + jitter. It stops retrying immediately
// if ctx is canceled.
type retryingClient struct {
	eth   rawClient
	rpc   blockHashFetcher
	retry RetryConfig
}

// Dial connects to rpcURL and wraps the resulting client with retry
// behavior. The RPC URL and all other configuration come from Config
// (internal/config); no secret or private key is ever read here.
func Dial(ctx context.Context, rpcURL string, retry RetryConfig) (Client, error) {
	var eth *ethclient.Client
	var rpcClient *rpc.Client
	err := withRetry(ctx, retry, "dial", func() error {
		c, dialErr := ethclient.DialContext(ctx, rpcURL)
		if dialErr != nil {
			return dialErr
		}
		eth = c
		rpcClient = c.Client()
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("chain: dial %s: %w", rpcURL, err)
	}
	return &retryingClient{eth: eth, rpc: rpcClient, retry: retry}, nil
}

func (c *retryingClient) ChainID(ctx context.Context) (*big.Int, error) {
	var out *big.Int
	err := withRetry(ctx, c.retry, "ChainID", func() error {
		v, err := c.eth.ChainID(ctx)
		if err != nil {
			return err
		}
		out = v
		return nil
	})
	return out, err
}

func (c *retryingClient) BlockNumber(ctx context.Context) (uint64, error) {
	var out uint64
	err := withRetry(ctx, c.retry, "BlockNumber", func() error {
		v, err := c.eth.BlockNumber(ctx)
		if err != nil {
			return err
		}
		out = v
		return nil
	})
	return out, err
}

func (c *retryingClient) BlockHashByNumber(ctx context.Context, number *big.Int) (common.Hash, error) {
	var out common.Hash
	err := withRetry(ctx, c.retry, "BlockHashByNumber", func() error {
		var raw rawBlockHeader
		if err := c.rpc.CallContext(ctx, &raw, "eth_getBlockByNumber", hexutil.EncodeBig(number), false); err != nil {
			return err
		}
		if raw.Hash == (common.Hash{}) {
			return fmt.Errorf("block %s not found", number.String())
		}
		out = raw.Hash
		return nil
	})
	return out, err
}

func (c *retryingClient) FilterLogs(ctx context.Context, q ethereum.FilterQuery) ([]types.Log, error) {
	var out []types.Log
	err := withRetry(ctx, c.retry, "FilterLogs", func() error {
		v, err := c.eth.FilterLogs(ctx, q)
		if err != nil {
			return err
		}
		out = v
		return nil
	})
	return out, err
}

func (c *retryingClient) TransactionReceipt(ctx context.Context, txHash common.Hash) (*types.Receipt, error) {
	var out *types.Receipt
	err := withRetry(ctx, c.retry, "TransactionReceipt", func() error {
		v, err := c.eth.TransactionReceipt(ctx, txHash)
		if err != nil {
			return err
		}
		out = v
		return nil
	})
	return out, err
}

func (c *retryingClient) CodeAt(ctx context.Context, account common.Address, blockNumber *big.Int) ([]byte, error) {
	var out []byte
	err := withRetry(ctx, c.retry, "CodeAt", func() error {
		v, err := c.eth.CodeAt(ctx, account, blockNumber)
		if err != nil {
			return err
		}
		out = v
		return nil
	})
	return out, err
}

func (c *retryingClient) Close() {
	c.eth.Close()
}

// withRetry runs fn, retrying on error up to retry.MaxAttempts times with
// exponential backoff and jitter, stopping immediately if ctx is done.
// Exported indirectly via Dial/the Client methods, not called directly by
// other packages.
func withRetry(ctx context.Context, retry RetryConfig, op string, fn func() error) error {
	maxAttempts := retry.MaxAttempts
	if maxAttempts <= 0 {
		maxAttempts = 1
	}

	var lastErr error
	for attempt := 1; attempt <= maxAttempts; attempt++ {
		if err := ctx.Err(); err != nil {
			return err
		}

		lastErr = fn()
		if lastErr == nil {
			return nil
		}

		if attempt == maxAttempts {
			break
		}

		delay := backoffDelay(retry, attempt)
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(delay):
		}
	}
	return fmt.Errorf("chain: %s failed after %d attempts: %w", op, maxAttempts, lastErr)
}

func backoffDelay(retry RetryConfig, attempt int) time.Duration {
	base := retry.BaseDelay
	if base <= 0 {
		base = 100 * time.Millisecond
	}
	max := retry.MaxDelay
	if max <= 0 {
		max = 10 * time.Second
	}

	delay := base * time.Duration(1<<uint(attempt-1))
	if delay > max {
		delay = max
	}
	// Full jitter: uniform random in [0, delay].
	if delay > 0 {
		delay = time.Duration(rand.Int63n(int64(delay) + 1))
	}
	return delay
}

// ErrContractCodeEmpty is returned by ValidateContract when no contract
// code exists at the configured address - a strong signal of a wrong
// address or wrong network.
var ErrContractCodeEmpty = errors.New("chain: no contract code at configured RiskEscrow address")

// ValidateChainID fetches the chain's actual ID and compares it against
// the configured one, failing fast on a RPC_URL/CHAIN_ID mismatch rather
// than silently indexing the wrong network.
func ValidateChainID(ctx context.Context, c Client, configured uint64) error {
	actual, err := c.ChainID(ctx)
	if err != nil {
		return fmt.Errorf("chain: fetching chain ID for validation: %w", err)
	}
	if actual.Cmp(new(big.Int).SetUint64(configured)) != 0 {
		return fmt.Errorf("chain: configured CHAIN_ID=%d does not match RPC_URL's actual chain ID %s", configured, actual.String())
	}
	return nil
}

// ValidateContract checks that the configured RiskEscrow address actually
// has contract code deployed on-chain, failing fast on a misconfigured or
// not-yet-deployed address.
func ValidateContract(ctx context.Context, c Client, address common.Address) error {
	code, err := c.CodeAt(ctx, address, nil)
	if err != nil {
		return fmt.Errorf("chain: fetching contract code for validation: %w", err)
	}
	if len(code) == 0 {
		return fmt.Errorf("%w: %s", ErrContractCodeEmpty, address.Hex())
	}
	return nil
}
