// Package config loads and validates the chain indexer's runtime
// configuration from the environment. The indexer never needs a wallet
// private key - it only observes the chain - so no signing key is ever
// read or accepted here.
package config

import (
	"fmt"
	"os"
	"strconv"
	"time"

	"github.com/ethereum/go-ethereum/common"
)

// Config is the fully validated runtime configuration for one indexer
// instance, scoped to a single (ChainID, RiskEscrowAddress) pair.
type Config struct {
	RPCURL             string
	ChainID            uint64
	RiskEscrowAddress  common.Address
	StartBlock         uint64
	ConfirmationDepth  uint64
	DatabaseURL        string
	PollInterval       time.Duration
	MaxBlockRange      uint64
	MaxConcurrentScans int
	HealthAddr         string
}

// Load reads configuration from the process environment and validates it.
// Required: RPC_URL, CHAIN_ID, RISK_ESCROW_ADDRESS, DATABASE_URL. Everything
// else has a sensible default (see Defaults below) but may be overridden.
func Load() (Config, error) {
	return FromEnv(os.Environ())
}

// Defaults applied when the corresponding env var is unset.
const (
	DefaultConfirmationDepth  = 5
	DefaultPollInterval       = 5 * time.Second
	DefaultMaxBlockRange      = 2000
	DefaultMaxConcurrentScans = 4
	DefaultHealthAddr         = ":8090"
)

// FromEnv builds a Config from a slice of "KEY=VALUE" strings (the same
// shape as os.Environ()), so tests can exercise env parsing without
// mutating process-global state.
func FromEnv(environ []string) (Config, error) {
	env := map[string]string{}
	for _, kv := range environ {
		for i := 0; i < len(kv); i++ {
			if kv[i] == '=' {
				env[kv[:i]] = kv[i+1:]
				break
			}
		}
	}

	cfg := Config{
		RPCURL:             env["RPC_URL"],
		DatabaseURL:        env["DATABASE_URL"],
		ConfirmationDepth:  DefaultConfirmationDepth,
		PollInterval:       DefaultPollInterval,
		MaxBlockRange:      DefaultMaxBlockRange,
		MaxConcurrentScans: DefaultMaxConcurrentScans,
		HealthAddr:         DefaultHealthAddr,
	}

	if v, ok := env["CHAIN_ID"]; ok && v != "" {
		id, err := strconv.ParseUint(v, 10, 64)
		if err != nil {
			return Config{}, fmt.Errorf("CHAIN_ID: invalid integer %q: %w", v, err)
		}
		cfg.ChainID = id
	}

	if v, ok := env["RISK_ESCROW_ADDRESS"]; ok && v != "" {
		if !common.IsHexAddress(v) {
			return Config{}, fmt.Errorf("RISK_ESCROW_ADDRESS: %q is not a valid EVM address", v)
		}
		cfg.RiskEscrowAddress = common.HexToAddress(v)
	}

	if v, ok := env["START_BLOCK"]; ok && v != "" {
		n, err := strconv.ParseUint(v, 10, 64)
		if err != nil {
			return Config{}, fmt.Errorf("START_BLOCK: invalid integer %q: %w", v, err)
		}
		cfg.StartBlock = n
	}

	if v, ok := env["CONFIRMATION_DEPTH"]; ok && v != "" {
		n, err := strconv.ParseUint(v, 10, 64)
		if err != nil {
			return Config{}, fmt.Errorf("CONFIRMATION_DEPTH: invalid integer %q: %w", v, err)
		}
		cfg.ConfirmationDepth = n
	}

	if v, ok := env["POLL_INTERVAL_SECONDS"]; ok && v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n <= 0 {
			return Config{}, fmt.Errorf("POLL_INTERVAL_SECONDS: invalid positive integer %q", v)
		}
		cfg.PollInterval = time.Duration(n) * time.Second
	}

	if v, ok := env["MAX_BLOCK_RANGE"]; ok && v != "" {
		n, err := strconv.ParseUint(v, 10, 64)
		if err != nil || n == 0 {
			return Config{}, fmt.Errorf("MAX_BLOCK_RANGE: invalid positive integer %q", v)
		}
		cfg.MaxBlockRange = n
	}

	if v, ok := env["MAX_CONCURRENT_SCANS"]; ok && v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n <= 0 {
			return Config{}, fmt.Errorf("MAX_CONCURRENT_SCANS: invalid positive integer %q", v)
		}
		cfg.MaxConcurrentScans = n
	}

	if v, ok := env["HEALTH_ADDR"]; ok && v != "" {
		cfg.HealthAddr = v
	}

	if err := cfg.Validate(); err != nil {
		return Config{}, err
	}
	return cfg, nil
}

// Validate checks that required fields are present and internally
// consistent. Called by FromEnv, but exported so callers constructing a
// Config directly (e.g. in tests) can reuse the same checks.
func (c Config) Validate() error {
	if c.RPCURL == "" {
		return fmt.Errorf("RPC_URL is required")
	}
	if c.ChainID == 0 {
		return fmt.Errorf("CHAIN_ID is required and must be nonzero")
	}
	if c.RiskEscrowAddress == (common.Address{}) {
		return fmt.Errorf("RISK_ESCROW_ADDRESS is required and must not be the zero address")
	}
	if c.DatabaseURL == "" {
		return fmt.Errorf("DATABASE_URL is required")
	}
	if c.MaxBlockRange == 0 {
		return fmt.Errorf("MAX_BLOCK_RANGE must be positive")
	}
	if c.MaxConcurrentScans <= 0 {
		return fmt.Errorf("MAX_CONCURRENT_SCANS must be positive")
	}
	if c.PollInterval <= 0 {
		return fmt.Errorf("POLL_INTERVAL_SECONDS must be positive")
	}
	return nil
}
