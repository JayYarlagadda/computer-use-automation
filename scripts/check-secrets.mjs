#!/usr/bin/env node
/**
 * Refuses to let a credential or regulated value into the repository.
 *
 * The brief says twice that secrets stay out of the repo and that artifacts and
 * logs never carry raw sensitive data. Both are easy to satisfy on purpose and
 * easy to break by accident -- the realistic failure is not malice, it is
 * pasting an API key into `.env.example` because that is the file already open,
 * or an evidence run capturing a screen before someone remembers to redact it.
 *
 * So this runs as a pre-commit hook *and* as part of `npm run verify`. A claim
 * in a README that we keep secrets out is worth nothing; a check that fails the
 * build is worth something.
 *
 * Two scopes, because they have different rules:
 *
 *   credentials   scanned across every tracked and staged file
 *   regulated PII scanned in evidence/ only -- the mock bank's fabricated SSNs
 *                 are committed on purpose, since redaction needs something to
 *                 redact, so a repo-wide SSN scan would fail on its own fixture
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = process.cwd();

const CREDENTIAL_PATTERNS = [
  { name: 'Groq API key', re: /\bgsk_[A-Za-z0-9]{20,}/ },
  { name: 'Anthropic API key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { name: 'OpenAI API key', re: /\bsk-(?:proj-)?[A-Za-z0-9]{32,}/ },
  { name: 'Google API key', re: /\bAIza[A-Za-z0-9_-]{30,}/ },
  { name: 'GitHub token', re: /\b(?:ghp|gho|ghs|ghu)_[A-Za-z0-9]{30,}/ },
  { name: 'GitHub fine-grained token', re: /\bgithub_pat_[A-Za-z0-9_]{30,}/ },
  { name: 'AWS access key id', re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/ },
  { name: 'private key block', re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
  {
    // The catch-all, kept narrow enough not to fire on config. Requires an
    // assignment to something long and random-looking, which `PORT=4173` and
    // `MERIDIAN_OPERATOR_PASSWORD=demo1234` are not.
    name: 'assigned credential',
    re: /\b(?:api[_-]?key|apikey|secret[_-]?key|access[_-]?token|auth[_-]?token)\b\s*[:=]\s*['"]?[A-Za-z0-9_\-]{24,}/i,
  },
];

const PII_PATTERNS = [
  { name: 'SSN-shaped value', re: /(?<!\d)\d{3}-\d{2}-\d{4}(?!\d)/ },
  { name: 'card-length digit run', re: /(?<!\d)\d{12,19}(?!\d)/ },
];

/** Binary and generated files: scanning them is noise, not signal. */
const SKIP_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.pdf', '.ico', '.woff', '.woff2', '.zip', '.gz',
]);
const SKIP_PATH = [
  `scripts${sep}check-secrets.mjs`, // holds the patterns themselves
  'package-lock.json',
  `node_modules${sep}`,
  `.git${sep}`,
];

function git(args) {
  try {
    return execFileSync('git', args, { encoding: 'utf8' }).split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

function filesToScan() {
  const staged = git(['diff', '--cached', '--name-only', '--diff-filter=ACM']);
  const tracked = git(['ls-files']);
  return [...new Set([...staged, ...tracked])].filter((f) => {
    if (SKIP_PATH.some((p) => f.replaceAll('/', sep).includes(p))) return false;
    const dot = f.lastIndexOf('.');
    return dot === -1 || !SKIP_EXT.has(f.slice(dot).toLowerCase());
  });
}

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(relative(ROOT, full));
  }
  return out;
}

const findings = [];

function scan(file, patterns, scopeLabel) {
  let text;
  try {
    text = readFileSync(join(ROOT, file), 'utf8');
  } catch {
    return;
  }

  text.split(/\r?\n/).forEach((line, i) => {
    for (const { name, re } of patterns) {
      if (re.test(line)) {
        // The finding never quotes the match. A leak report that prints the
        // leaked value into CI logs has moved the problem, not solved it.
        findings.push({ file, line: i + 1, name, scope: scopeLabel });
      }
    }
  });
}

for (const file of filesToScan()) scan(file, CREDENTIAL_PATTERNS, 'credential');

const evidenceFiles = walk(join(ROOT, 'evidence')).filter((f) => {
  const dot = f.lastIndexOf('.');
  return dot === -1 || !SKIP_EXT.has(f.slice(dot).toLowerCase());
});
for (const file of evidenceFiles) scan(file, [...CREDENTIAL_PATTERNS, ...PII_PATTERNS], 'evidence');

if (findings.length) {
  console.error('\nSecret scan FAILED. Nothing was committed.\n');
  for (const f of findings) {
    console.error(`  ${f.file}:${f.line}  ${f.name}  (${f.scope})`);
  }
  console.error(
    '\nIf this is a real credential: remove it, put it in .env (gitignored),\n' +
      'and rotate it -- assume anything written to a tracked file is compromised.\n',
  );
  process.exit(1);
}

console.log(`Secret scan clean (${filesToScan().length} tracked files, ${evidenceFiles.length} evidence files).`);
