import { mkdirSync, writeFileSync } from 'node:fs';
import { readSavingsBalance } from '../tests/fixtures/readSavingsBalance.ts';
import { parseArtifactOrThrow } from '../src/artifact/index.ts';

const artifact = parseArtifactOrThrow(readSavingsBalance);
mkdirSync('artifacts', { recursive: true });
const path = 'artifacts/meridian.member.read-savings-balance.json';
writeFileSync(path, `${JSON.stringify(artifact, null, 2)}\n`);
console.log(`wrote ${path}`);
