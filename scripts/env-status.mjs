#!/usr/bin/env node
/**
 * Reports which provider credentials are configured, and optionally proves one
 * of them actually works.
 *
 * Answers the question a reviewer asks first -- "am I set up?" -- without ever
 * printing a key. Presence is reported as a length and a four-character prefix,
 * which is enough to tell a real key from an empty line or a stray quote and
 * not enough to be worth anything if it lands in a log.
 *
 *   node scripts/env-status.mjs          what is configured
 *   node scripts/env-status.mjs --ping   also call the provider to confirm the
 *                                        key is live and the model is available
 */

import { readFileSync, existsSync } from 'node:fs';

const PROVIDERS = [
  { key: 'GROQ_API_KEY', label: 'Groq', prefix: 'gsk_' },
  { key: 'ANTHROPIC_API_KEY', label: 'Anthropic', prefix: 'sk-ant-' },
  { key: 'OPENAI_API_KEY', label: 'OpenAI', prefix: 'sk-' },
  { key: 'GEMINI_API_KEY', label: 'Google Gemini', prefix: 'AIza' },
];

function loadEnvFile(path) {
  if (!existsSync(path)) return {};
  const out = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    // Strip an inline comment, then surrounding quotes -- both are things
    // people leave behind when pasting, and both produce a key that looks
    // present and fails at the API with an unhelpful 401.
    const value = trimmed
      .slice(eq + 1)
      .replace(/\s+#.*$/, '')
      .trim()
      .replace(/^['"]|['"]$/g, '');
    out[trimmed.slice(0, eq).trim()] = value;
  }
  return out;
}

const env = { ...loadEnvFile('.env'), ...process.env };

if (!existsSync('.env')) {
  console.log('No .env file. Run:  cp .env.example .env  then  npm run set-key\n');
}

console.log('Provider credentials');
let configured = 0;
for (const p of PROVIDERS) {
  const value = env[p.key] ?? '';
  if (!value) {
    console.log(`  ${p.label.padEnd(15)} not set`);
    continue;
  }
  configured += 1;
  const shapeOk = value.startsWith(p.prefix);
  console.log(
    `  ${p.label.padEnd(15)} set  (${value.length} chars, starts "${value.slice(0, 4)}")` +
      (shapeOk ? '' : `  <-- expected it to start "${p.prefix}"`),
  );
}

console.log(`\nLLM_PROVIDER  ${env.LLM_PROVIDER ?? '(unset)'}`);
console.log(`LLM_MODEL     ${env.LLM_MODEL ?? '(unset)'}`);

if (!configured) {
  console.log('\nNo provider key configured. Replay and the test suite still work without one.');
  process.exit(0);
}

if (!process.argv.includes('--ping')) {
  console.log('\nAdd --ping to confirm the key is live.');
  process.exit(0);
}

// ---- live check -----------------------------------------------------------

const provider = (env.LLM_PROVIDER ?? 'groq').toLowerCase();
if (provider !== 'groq') {
  console.log(`\n--ping currently only knows how to check Groq; LLM_PROVIDER is "${provider}".`);
  process.exit(0);
}

const baseUrl = (env.GROQ_BASE_URL ?? 'https://api.groq.com/openai/v1').replace(/\/$/, '');
const model = env.LLM_MODEL ?? '';

console.log(`\nCalling ${baseUrl}/models ...`);

let response;
try {
  response = await fetch(`${baseUrl}/models`, {
    headers: { authorization: `Bearer ${env.GROQ_API_KEY}` },
  });
} catch (err) {
  console.error(`  network error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

if (!response.ok) {
  console.error(`  HTTP ${response.status} ${response.statusText}`);
  if (response.status === 401) console.error('  The key was rejected. Check it was pasted whole, with no quotes.');
  process.exit(1);
}

const body = await response.json();
const ids = (body.data ?? []).map((m) => m.id).sort();

console.log(`  key accepted. ${ids.length} models available.`);

if (model && ids.includes(model)) {
  console.log(`  configured model "${model}" is available.`);
} else if (model) {
  // A wrong model id fails at the first real call with a 404 that reads like a
  // bug in our code, so it is worth catching here where the fix is obvious.
  console.error(`\n  configured model "${model}" is NOT in the list.`);
  const toolCapable = ids.filter((id) => /llama|gpt-oss|qwen|kimi|minimax/i.test(id));
  console.error(`  candidates that support tool calling:\n    ${toolCapable.slice(0, 12).join('\n    ')}`);
  process.exit(1);
}
