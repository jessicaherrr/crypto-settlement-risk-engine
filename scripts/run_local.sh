#!/usr/bin/env bash
# Thin alias for the full local demo stack - see scripts/dev_stack.sh for
# what this actually does (Postgres -> migrate -> Hardhat -> deploy ->
# risk-oracle service -> chain indexer -> Next.js). Kept as a separate
# entry point since `npm run dev` / `make dev` (just the Next.js app) and
# "the whole stack" are different asks.
set -euo pipefail
exec "$(dirname "$0")/dev_stack.sh" "$@"
