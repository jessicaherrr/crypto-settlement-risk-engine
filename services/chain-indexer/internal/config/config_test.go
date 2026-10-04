package config

import (
	"testing"
	"time"
)

func baseEnv(overrides map[string]string) []string {
	base := map[string]string{
		"RPC_URL":             "http://127.0.0.1:8545",
		"CHAIN_ID":            "31337",
		"RISK_ESCROW_ADDRESS": "0x8bdc85a2d12759F021809BaaAB1a60516165B7b7",
		"DATABASE_URL":        "postgres://askgene:askgene@localhost:5432/askgene_quantfi",
	}
	for k, v := range overrides {
		base[k] = v
	}
	var out []string
	for k, v := range base {
		if v == "" {
			continue
		}
		out = append(out, k+"="+v)
	}
	return out
}

func TestFromEnv_ValidMinimal_AppliesDefaults(t *testing.T) {
	cfg, err := FromEnv(baseEnv(nil))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.ChainID != 31337 {
		t.Errorf("ChainID = %d, want 31337", cfg.ChainID)
	}
	if cfg.ConfirmationDepth != DefaultConfirmationDepth {
		t.Errorf("ConfirmationDepth = %d, want default %d", cfg.ConfirmationDepth, DefaultConfirmationDepth)
	}
	if cfg.PollInterval != DefaultPollInterval {
		t.Errorf("PollInterval = %v, want default %v", cfg.PollInterval, DefaultPollInterval)
	}
	if cfg.MaxBlockRange != DefaultMaxBlockRange {
		t.Errorf("MaxBlockRange = %d, want default %d", cfg.MaxBlockRange, DefaultMaxBlockRange)
	}
	if cfg.HealthAddr != DefaultHealthAddr {
		t.Errorf("HealthAddr = %q, want default %q", cfg.HealthAddr, DefaultHealthAddr)
	}
}

func TestFromEnv_Overrides(t *testing.T) {
	cfg, err := FromEnv(baseEnv(map[string]string{
		"START_BLOCK":           "1000",
		"CONFIRMATION_DEPTH":    "12",
		"POLL_INTERVAL_SECONDS": "2",
		"MAX_BLOCK_RANGE":       "500",
		"MAX_CONCURRENT_SCANS":  "8",
		"HEALTH_ADDR":           ":9999",
	}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.StartBlock != 1000 {
		t.Errorf("StartBlock = %d, want 1000", cfg.StartBlock)
	}
	if cfg.ConfirmationDepth != 12 {
		t.Errorf("ConfirmationDepth = %d, want 12", cfg.ConfirmationDepth)
	}
	if cfg.PollInterval != 2*time.Second {
		t.Errorf("PollInterval = %v, want 2s", cfg.PollInterval)
	}
	if cfg.MaxBlockRange != 500 {
		t.Errorf("MaxBlockRange = %d, want 500", cfg.MaxBlockRange)
	}
	if cfg.MaxConcurrentScans != 8 {
		t.Errorf("MaxConcurrentScans = %d, want 8", cfg.MaxConcurrentScans)
	}
	if cfg.HealthAddr != ":9999" {
		t.Errorf("HealthAddr = %q, want :9999", cfg.HealthAddr)
	}
}

func TestFromEnv_MissingRequired(t *testing.T) {
	cases := []string{"RPC_URL", "CHAIN_ID", "RISK_ESCROW_ADDRESS", "DATABASE_URL"}
	for _, missing := range cases {
		t.Run(missing, func(t *testing.T) {
			_, err := FromEnv(baseEnv(map[string]string{missing: ""}))
			if err == nil {
				t.Fatalf("expected error when %s is missing", missing)
			}
		})
	}
}

func TestFromEnv_InvalidAddress(t *testing.T) {
	_, err := FromEnv(baseEnv(map[string]string{"RISK_ESCROW_ADDRESS": "not-an-address"}))
	if err == nil {
		t.Fatal("expected error for invalid RISK_ESCROW_ADDRESS")
	}
}

func TestFromEnv_InvalidChainID(t *testing.T) {
	_, err := FromEnv(baseEnv(map[string]string{"CHAIN_ID": "not-a-number"}))
	if err == nil {
		t.Fatal("expected error for non-numeric CHAIN_ID")
	}
}

func TestFromEnv_ZeroChainIDRejected(t *testing.T) {
	_, err := FromEnv(baseEnv(map[string]string{"CHAIN_ID": "0"}))
	if err == nil {
		t.Fatal("expected error for CHAIN_ID=0")
	}
}

func TestFromEnv_InvalidNumericOverridesRejected(t *testing.T) {
	cases := map[string]string{
		"START_BLOCK":           "abc",
		"CONFIRMATION_DEPTH":    "-1",
		"POLL_INTERVAL_SECONDS": "0",
		"MAX_BLOCK_RANGE":       "0",
		"MAX_CONCURRENT_SCANS":  "0",
	}
	for key, val := range cases {
		t.Run(key, func(t *testing.T) {
			_, err := FromEnv(baseEnv(map[string]string{key: val}))
			if err == nil {
				t.Fatalf("expected error for %s=%s", key, val)
			}
		})
	}
}

func TestConfig_Validate_NeverRequiresPrivateKey(t *testing.T) {
	// Documents the security property that the indexer never needs - and
	// Config has no field for - a wallet private key. If this ever grows
	// such a field, this test forces a conscious decision to remove it.
	cfg, err := FromEnv(baseEnv(nil))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if err := cfg.Validate(); err != nil {
		t.Fatalf("expected valid config, got error: %v", err)
	}
}
