#!/usr/bin/env node
/**
 * Writes a provider API key into .env, interactively.
 *
 * Exists because the obvious ways to do this by hand are both wrong in ways
 * that are hard to see. Editing whichever file is already open puts the key in
 * `.env.example`, which is tracked and public. Doing it from the shell with an
 * echo or a Read-Host leaves the key in terminal scrollback and in shell
 * history. This reads the key without echoing it, writes it to the one file
 * that is gitignored, and confirms by length and prefix only.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';

const FILE = '.env';
const VARS = {
  groq: { name: 'GROQ_API_KEY', prefix: 'gsk_', label: 'Groq' },
  anthropic: { name: 'ANTHROPIC_API_KEY', prefix: 'sk-ant-', label: 'Anthropic' },
  openai: { name: 'OPENAI_API_KEY', prefix: 'sk-', label: 'OpenAI' },
  gemini: { name: 'GEMINI_API_KEY', prefix: 'AIza', label: 'Google Gemini' },
};

const which = (process.argv[2] ?? 'groq').toLowerCase();
const target = VARS[which];

if (!target) {
  console.error(`Unknown provider "${which}". Try one of: ${Object.keys(VARS).join(', ')}`);
  process.exit(1);
}

if (!existsSync(FILE)) {
  console.error(`No ${FILE} found. Run:  cp .env.example .env`);
  process.exit(1);
}

/** Reads a line from the terminal without echoing what is typed. */
function askHidden(prompt) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });

    // Suppress echo for everything except the prompt itself, so a pasted key
    // never lands in scrollback or in a captured terminal log.
    let promptShown = false;
    rl._writeToOutput = (chunk) => {
      if (!promptShown && chunk.includes(prompt)) {
        rl.output.write(prompt);
        promptShown = true;
      }
    };

    rl.question(prompt, (answer) => {
      rl.output.write('\n');
      rl.close();
      resolve(answer.trim());
    });
  });
}

const key = await askHidden(`Paste your ${target.label} API key, then press Enter: `);

if (!key) {
  console.error('\nNothing entered. No changes made.');
  process.exit(1);
}

if (!key.startsWith(target.prefix)) {
  console.error(
    `\nThat does not look like a ${target.label} key -- they start with "${target.prefix}".\n` +
      'No changes made, in case something other than the key was pasted.',
  );
  process.exit(1);
}

const line = `${target.name}=${key}`;
const text = readFileSync(FILE, 'utf8');
const pattern = new RegExp(`^${target.name}=.*$`, 'm');

writeFileSync(FILE, pattern.test(text) ? text.replace(pattern, line) : `${text.trimEnd()}\n${line}\n`);

console.log(`\nSaved to ${FILE}.`);
console.log(`  ${target.name}: ${key.length} characters, starts "${key.slice(0, 4)}"`);
console.log(`\n${FILE} is gitignored, and the pre-commit hook will refuse it if that ever changes.`);
