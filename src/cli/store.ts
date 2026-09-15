/**
 * Artifacts on disk.
 *
 * A directory of JSON files, one per capability, is the whole store. A
 * database would add operational surface to a system whose interesting
 * properties are all about what a *single* artifact guarantees, and the brief
 * explicitly does not reward scaling infrastructure.
 *
 * The one rule: nothing is handed out unvalidated. `load` returns either a
 * parsed artifact or the list of reasons it is not one, so a hand-edited file
 * with a dangling parameter reference is refused here rather than three steps
 * into a signed-on session.
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArtifact, type ArtifactIssue, type CapabilityArtifact } from '../artifact/index.js';

export const DEFAULT_ARTIFACT_DIR = 'artifacts';

export type LoadResult =
  | { ok: true; path: string; artifact: CapabilityArtifact; warnings: ArtifactIssue[] }
  | { ok: false; path: string; issues: ArtifactIssue[] };

export function loadArtifact(path: string): LoadResult {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    return {
      ok: false,
      path,
      issues: [
        {
          path: '(file)',
          message: `Could not read it as JSON: ${error instanceof Error ? error.message : String(error)}`,
          severity: 'error',
        },
      ],
    };
  }

  const parsed = parseArtifact(raw);
  return parsed.ok
    ? { ok: true, path, artifact: parsed.artifact, warnings: parsed.warnings }
    : { ok: false, path, issues: parsed.issues };
}

/** Every `*.json` in the directory, in filename order. Missing dir is empty. */
export function loadAll(dir: string): LoadResult[] {
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith('.json')).sort();
  } catch {
    return [];
  }
  return names.map((name) => loadArtifact(join(dir, name)));
}

/** `meridian.member.read-savings-balance` -> `<dir>/meridian.member.read-savings-balance.json` */
export function artifactPath(dir: string, capabilityId: string): string {
  return join(dir, `${capabilityId}.json`);
}

export function saveArtifact(path: string, artifact: CapabilityArtifact): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
}
