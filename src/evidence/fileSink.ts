/**
 * Evidence on disk.
 *
 * One directory per run, holding a JSONL log of everything that happened, the
 * screenshots and observations captured at the interesting moments, and
 * whatever artefacts the run produced. The layout is chosen so that a reviewer
 * who has never seen the codebase can open the directory and follow the run
 * top to bottom without being told how.
 *
 * Two things are deliberate.
 *
 * Every write goes through a **second** redaction pass. Observations are
 * already redacted at the perception boundary, and outputs are already redacted
 * by declared sensitivity, so this is belt and braces -- and it is worth having
 * precisely because it is redundant. The perception boundary protects data the
 * surface saw; it cannot protect a value the caller passed in, or a message a
 * future error path interpolates. Redacting again at the moment bytes hit disk
 * covers the paths nobody has written yet.
 *
 * And the log is **JSONL, appended synchronously in order**. A run that crashes
 * still leaves a readable log up to the crash, which is exactly the run whose
 * log matters most. A single JSON document written at the end does not.
 */

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { EvidenceEvent, EvidenceSink } from './types.js';
import type { Observation } from '../surface/types.js';

export interface FileSinkOptions {
  /** Root evidence directory. Defaults to `evidence/`. */
  root?: string;
  runId: string;
  kind: 'discovery' | 'replay';
  /** Short slug for the directory name, e.g. the capability id. */
  label?: string;
  /** Final redaction pass. Normally the policy's. */
  redact?: (text: string) => string;
  /** Overridable so evidence directory names are reproducible in tests. */
  now?: () => Date;
}

export function createFileSink(options: FileSinkOptions): EvidenceSink {
  const root = options.root ?? 'evidence';
  const redact = options.redact ?? ((s: string) => s);
  const at = (options.now ?? (() => new Date()))();

  // Sortable, filesystem-safe, and unique. A reviewer listing the directory
  // sees runs in the order they happened without reading any of them.
  const stamp = at.toISOString().replace(/[:.]/g, '-').replace('Z', '');
  const slug = (options.label ?? options.kind).replace(/[^a-zA-Z0-9._-]/g, '-');
  const dir = join(root, `${stamp}-${options.kind}-${slug}-${options.runId.slice(0, 8)}`);

  mkdirSync(join(dir, 'screenshots'), { recursive: true });
  mkdirSync(join(dir, 'observations'), { recursive: true });

  const logPath = join(dir, 'run.jsonl');
  let sequence = 0;

  /** Zero-padded so filenames sort in the order the run produced them. */
  const nextIndex = () => String(++sequence).padStart(3, '0');
  const safeName = (name: string) => name.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 60);

  return {
    path: dir,

    async event(event: EvidenceEvent) {
      appendFileSync(logPath, `${redact(JSON.stringify(event))}\n`, 'utf8');
    },

    async screenshot(name: string, bytes: Buffer) {
      const file = join('screenshots', `${nextIndex()}-${safeName(name)}.png`);
      writeFileSync(join(dir, file), bytes);
      return file;
    },

    async observation(name: string, observation: Observation) {
      const file = join('observations', `${nextIndex()}-${safeName(name)}.json`);

      // The screenshot buffer is dropped rather than base64'd into the JSON.
      // It is already on disk as a PNG, and inlining it makes the one file a
      // human might actually read unreadable.
      const { screenshot: _screenshot, ...rest } = observation;
      writeFileSync(join(dir, file), redact(JSON.stringify(rest, null, 2)), 'utf8');
      return file;
    },

    async file(name: string, contents: string | Buffer) {
      const file = safeName(name);
      writeFileSync(
        join(dir, file),
        typeof contents === 'string' ? redact(contents) : contents,
        typeof contents === 'string' ? 'utf8' : undefined,
      );
      return file;
    },
  };
}

/** Path of the evidence directory relative to the repo root, for reporting. */
export function relativeEvidencePath(sink: EvidenceSink): string {
  return sink.path ? relative(process.cwd(), sink.path).replaceAll('\\', '/') : '';
}
