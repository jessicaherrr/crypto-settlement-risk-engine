// Command indexer is the entry point for the Crypto Settlement Risk Engine chain
// indexer: watches the RiskEscrow contract on Polygon (or any configured
// EVM RPC endpoint), decodes its lifecycle events, and keeps PostgreSQL in
// sync with confirmed on-chain state. See services/chain-indexer/README.md
// for configuration, the confirmation/reorg model, and known limitations.
package main

import (
	"context"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/jessicaherrr/crypto-settlement-risk-engine/services/chain-indexer/internal/chain"
	"github.com/jessicaherrr/crypto-settlement-risk-engine/services/chain-indexer/internal/config"
	"github.com/jessicaherrr/crypto-settlement-risk-engine/services/chain-indexer/internal/metrics"
	"github.com/jessicaherrr/crypto-settlement-risk-engine/services/chain-indexer/internal/store"
	"github.com/jessicaherrr/crypto-settlement-risk-engine/services/chain-indexer/internal/workers"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))

	cfg, err := config.Load()
	if err != nil {
		logger.Error("invalid configuration", "error", err)
		os.Exit(1)
	}
	// Never log DATABASE_URL (may embed credentials) or any secret - only
	// the non-sensitive fields that matter for understanding what this
	// instance is indexing.
	logger.Info("starting chain-indexer",
		"chain_id", cfg.ChainID,
		"risk_escrow_address", cfg.RiskEscrowAddress.Hex(),
		"start_block", cfg.StartBlock,
		"confirmation_depth", cfg.ConfirmationDepth,
		"poll_interval", cfg.PollInterval.String(),
	)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	client, err := chain.Dial(ctx, cfg.RPCURL, chain.DefaultRetryConfig())
	if err != nil {
		logger.Error("failed to connect to RPC endpoint", "error", err)
		os.Exit(1)
	}
	defer client.Close()

	db, err := store.New(ctx, cfg.DatabaseURL)
	if err != nil {
		logger.Error("failed to connect to database", "error", err)
		os.Exit(1)
	}
	defer db.Close()

	health := metrics.New(cfg.ChainID, cfg.RiskEscrowAddress.Hex(), cfg.ConfirmationDepth)
	ix := workers.New(client, db, cfg, health)

	validateCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	err = ix.Validate(validateCtx)
	cancel()
	if err != nil {
		logger.Error("startup validation failed", "error", err)
		os.Exit(1)
	}
	logger.Info("startup validation passed: RPC chain ID and RiskEscrow contract code confirmed")

	healthServer := &http.Server{Addr: cfg.HealthAddr, Handler: health.Handler()}
	go func() {
		if err := healthServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			logger.Error("health server stopped unexpectedly", "error", err)
		}
	}()

	runErr := ix.Run(ctx, func(cycleErr error) {
		if cycleErr != nil {
			logger.Error("scan cycle failed, will retry next cycle", "error", cycleErr)
			return
		}
		snap := health.Snapshot()
		logger.Info("scan cycle complete",
			"chain_head", snap.ChainHead,
			"last_scanned_block", snap.LastScannedBlock,
			"last_confirmed_block", snap.LastConfirmedBlock,
			"confirmed_lag_blocks", snap.ConfirmedLagBlocks,
			"total_events_processed", snap.TotalEventsProcessed,
			"duplicate_events_ignored", snap.DuplicateEventsIgnored,
			"reorg_count", snap.ReorgCount,
		)
	})

	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 5*time.Second)
	_ = healthServer.Shutdown(shutdownCtx)
	shutdownCancel()

	if runErr != nil {
		logger.Error("indexer stopped with error", "error", runErr)
		os.Exit(1)
	}
	logger.Info("chain-indexer shut down cleanly")
}
