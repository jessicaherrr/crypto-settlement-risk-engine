import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

import { describe, expect, it } from 'vitest';

/**
 * Automates the "no secret environment variables are exposed through
 * NEXT_PUBLIC_*" security requirement, rather than leaving it to manual
 * review alone. Any `NEXT_PUBLIC_*` identifier - in source or in
 * `.env.example` - whose name looks like it holds a secret fails this
 * test. `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` is allowed: a
 * WalletConnect project ID is a public client identifier by design, not
 * a secret, the same way a Stripe *publishable* key or a Google Maps
 * browser key is meant to ship to the client.
 */

const SECRET_SHAPE = /(PRIVATE_KEY|SECRET|PASSWORD|DATABASE_URL|_TOKEN|API_KEY)/i;
const ALLOWED_PUBLIC_EXCEPTIONS = new Set(['NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID']);

const REPO_ROOT = join(__dirname, '../../../..');
const SCAN_ROOTS = [join(REPO_ROOT, 'apps/web'), join(REPO_ROOT, '.env.example')];
const SKIP_DIRS = new Set(['node_modules', '.next', '.git', 'coverage']);
const TEXT_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.json', '.md']);

function collectFiles(path: string): string[] {
  const stat = statSync(path);
  if (stat.isFile()) return [path];
  if (!stat.isDirectory()) return [];
  if (SKIP_DIRS.has(path.split('/').pop() ?? '')) return [];

  const files: string[] = [];
  for (const entry of readdirSync(path)) {
    if (SKIP_DIRS.has(entry)) continue;
    const fullPath = join(path, entry);
    const entryStat = statSync(fullPath);
    if (entryStat.isDirectory()) {
      files.push(...collectFiles(fullPath));
    } else if (TEXT_EXTENSIONS.has(entry.slice(entry.lastIndexOf('.')))) {
      files.push(fullPath);
    }
  }
  return files;
}

function findPublicIdentifiers(content: string): string[] {
  const matches = content.match(/NEXT_PUBLIC_[A-Z0-9_]+/g) ?? [];
  return Array.from(new Set(matches));
}

describe('no secret-shaped NEXT_PUBLIC_* environment variables', () => {
  const files = SCAN_ROOTS.flatMap(collectFiles);
  expect(files.length).toBeGreaterThan(0); // sanity: the scan actually found files

  for (const file of files) {
    it(`${file.replace(REPO_ROOT, '')} has no secret-shaped NEXT_PUBLIC_* names`, () => {
      const content = readFileSync(file, 'utf8');
      const offenders = findPublicIdentifiers(content).filter(
        (name) => SECRET_SHAPE.test(name) && !ALLOWED_PUBLIC_EXCEPTIONS.has(name)
      );
      expect(offenders).toEqual([]);
    });
  }
});
