#!/usr/bin/env node
// Generates apps/web/lib/contracts/riskEscrowAbi.ts from the real Hardhat
// build artifact, so the frontend's ABI (including every event) can
// never silently drift from what RiskEscrow.sol actually compiles to -
// unlike the hand-maintained partial ABI it replaces, which had no event
// entries at all.
//
// Run after `npm run compile`. `--check` verifies the generated file is
// up to date (and that the Go indexer's trimmed event-only ABI is still a
// subset of the real contract's events) without writing anything -
// wired into `npm run abi:export:check`, part of `test:all`.

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const ARTIFACT_PATH = path.join(REPO_ROOT, 'artifacts/contracts/RiskEscrow.sol/RiskEscrow.json');
const OUTPUT_PATH = path.join(REPO_ROOT, 'apps/web/lib/contracts/riskEscrowAbi.ts');
const INDEXER_ABI_PATH = path.join(
  REPO_ROOT,
  'services/chain-indexer/internal/events/abi/risk_escrow.json'
);

function renderGeneratedFile(abi) {
  return `// GENERATED FILE - do not edit by hand.
// Source: artifacts/contracts/RiskEscrow.sol/RiskEscrow.json (npm run compile)
// Regenerate with: npm run abi:export
//
// The full compiled ABI, not a hand-maintained subset - includes every
// event (RiskEscrowCreated/Settled/Refunded, oracle/fee/wallet config
// updates) alongside the functions, so a frontend watching contract
// events or calling a newly added view function never silently drifts
// from what RiskEscrow.sol actually exposes.

export const riskEscrowAbi = ${JSON.stringify(abi, null, 2)} as const;
`;
}

// Cross-checks that the Go indexer's trimmed event-only ABI
// (services/chain-indexer/internal/events/abi/risk_escrow.json) only
// references events that really exist on the compiled contract - catches
// the two drifting apart if RiskEscrow.sol's events ever change without
// the Go side being updated to match.
function checkIndexerAbiEvents(fullAbi) {
  if (!fs.existsSync(INDEXER_ABI_PATH)) {
    console.warn(
      `warning: ${path.relative(REPO_ROOT, INDEXER_ABI_PATH)} not found, skipping cross-check.`
    );
    return;
  }
  const indexerAbi = JSON.parse(fs.readFileSync(INDEXER_ABI_PATH, 'utf8'));
  const fullEventNames = new Set(fullAbi.filter((e) => e.type === 'event').map((e) => e.name));
  const missing = indexerAbi.filter((e) => e.type === 'event' && !fullEventNames.has(e.name));
  if (missing.length > 0) {
    console.error(
      `error: services/chain-indexer's event ABI references events not found on the compiled ` +
        `contract: ${missing.map((e) => e.name).join(', ')}`
    );
    process.exit(1);
  }
}

function main() {
  const checkOnly = process.argv.includes('--check');

  if (!fs.existsSync(ARTIFACT_PATH)) {
    console.error(`error: ${path.relative(REPO_ROOT, ARTIFACT_PATH)} not found - run \`npm run compile\` first.`);
    process.exit(1);
  }
  const artifact = JSON.parse(fs.readFileSync(ARTIFACT_PATH, 'utf8'));
  const generated = renderGeneratedFile(artifact.abi);

  if (checkOnly) {
    const current = fs.existsSync(OUTPUT_PATH) ? fs.readFileSync(OUTPUT_PATH, 'utf8') : '';
    if (current !== generated) {
      console.error(
        `error: ${path.relative(REPO_ROOT, OUTPUT_PATH)} is out of date - run \`npm run abi:export\`.`
      );
      process.exit(1);
    }
    checkIndexerAbiEvents(artifact.abi);
    console.log('ABI is up to date.');
    return;
  }

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, generated);
  console.log(`Wrote ${path.relative(REPO_ROOT, OUTPUT_PATH)}`);
  checkIndexerAbiEvents(artifact.abi);
}

main();
