#!/usr/bin/env node
/**
 * Installs the pre-commit secret scan.
 *
 * Hooks live in .git/hooks, which is not versioned, so a hook that only exists
 * on one machine protects only that machine. This writes it from a versioned
 * script and runs on `npm install`, so cloning the repo and committing to it
 * gets the same guard without anyone having to read the README first.
 */

import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

function gitDir() {
  try {
    return execFileSync('git', ['rev-parse', '--git-dir'], { encoding: 'utf8' }).trim();
  } catch {
    return undefined;
  }
}

const dir = gitDir();
if (!dir) {
  // Installed as a dependency, or no git. Not an error worth failing on.
  process.exit(0);
}

const hooksDir = join(dir, 'hooks');
mkdirSync(hooksDir, { recursive: true });

const hook = `#!/bin/sh
# Installed by scripts/install-hooks.mjs. Do not edit here; edit the script.
exec node scripts/check-secrets.mjs
`;

const path = join(hooksDir, 'pre-commit');
const existed = existsSync(path);
writeFileSync(path, hook, { mode: 0o755 });

console.log(`${existed ? 'Updated' : 'Installed'} pre-commit secret scan.`);
