#!/usr/bin/env node
// Ensures apps/web/.env.local exists, symlinked to the monorepo root's
// .env.local - idempotent, safe to run on every `dev`/`build`.
//
// Why this needs to exist at all: Next.js only auto-discovers .env*
// files inside the app's own directory (apps/web), but every env var
// this app uses lives in the repo root's .env.local (deploy.js, hardhat,
// and the Go indexer all read/write that one file, not a copy). A
// previous fix called `@next/env`'s `loadEnvConfig()` from
// next.config.js to load the root file manually - it set
// `process.env` correctly in the process that ran next.config.js, but
// Next's dev/build server hands requests to worker processes seeded
// from its own env-file discovery, which never knew about that file, so
// the values silently never reached a real request. A symlink makes
// Next's own discovery find the root file directly, which does get
// forwarded correctly - but a symlink can't be committed (.env* is
// gitignored for good reason), so this script recreates it on every
// dev/build instead of relying on it being there.
//
// Not a symlink is used as a fallback (falls back to copying the file's
// current contents) on platforms/git configs where symlinks don't work
// (actual symlink creation is what's attempted first and is already
// what's checked in on this machine) - note the fallback copy will go
// stale if the root file changes later and this script isn't re-run;
// `npm run dev`/`build` re-run it every time specifically so that
// doesn't happen in the normal workflow.

const fs = require('fs');
const path = require('path');

const ROOT_ENV = path.resolve(__dirname, '../.env.local');
const TARGET = path.resolve(__dirname, '../apps/web/.env.local');

function main() {
  if (!fs.existsSync(ROOT_ENV)) {
    console.log('No root .env.local yet - nothing to link (copy .env.example to get started).');
    return;
  }

  const stat = fs.lstatSync(TARGET, { throwIfNoEntry: false });
  if (stat?.isSymbolicLink() && fs.realpathSync(TARGET) === fs.realpathSync(ROOT_ENV)) {
    return; // already correctly linked
  }
  if (stat) fs.rmSync(TARGET);

  try {
    fs.symlinkSync(path.relative(path.dirname(TARGET), ROOT_ENV), TARGET);
  } catch (error) {
    console.warn(`Could not create a symlink (${error.message}); copying instead.`);
    fs.copyFileSync(ROOT_ENV, TARGET);
  }
}

main();
