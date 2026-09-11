/**
 * The evidence interface.
 *
 * Replay and discovery both need to record what happened; neither should know
 * whether that means a directory on disk, a bucket, or nothing at all. The
 * interface is deliberately narrow -- three verbs -- so that a test can pass a
 * no-op and a real run can pass a file writer without either one caring.
 *
 * Everything written here has already passed the redaction boundary in
 * `Surface.observe()`. That ordering is the point: evidence is a *consumer* of
 * already-safe data rather than another place where redaction has to be
 * remembered. The one exception is values the caller supplied, which the
 * surface never saw, so the sink redacts those by name on the way out.
 */

import type { Observation } from '../surface/types.js';

/** One line in the structured run log. */
export interface EvidenceEvent {
  at: string;
  kind: string;
  [field: string]: unknown;
}

export interface EvidenceSink {
  /** Absolute path of the directory this run's evidence lives in. */
  readonly path: string;

  /** Appends one JSONL record to the run log. */
  event(event: EvidenceEvent): Promise<void>;

  /**
   * Persists a screenshot and returns its path relative to `path`.
   * Sensitive regions are already masked -- the surface masks before the bytes
   * exist rather than blurring afterwards.
   */
  screenshot(name: string, bytes: Buffer): Promise<string>;

  /**
   * Persists a full observation, which is the richer signal on failure that
   * section 3.5 of the brief asks for: a screenshot shows what it looked like,
   * the observation shows what the system actually perceived, and when those
   * two disagree the disagreement is the bug.
   */
  observation(name: string, observation: Observation): Promise<string>;

  /**
   * Writes an arbitrary artefact of the run -- the compiled capability, the
   * final result, the model transcript. Returns its path relative to `path`.
   */
  file(name: string, contents: string | Buffer): Promise<string>;
}

/** Used by tests and by callers that genuinely do not want a record. */
export const NULL_SINK: EvidenceSink = {
  path: '',
  async event() {},
  async screenshot() {
    return '';
  },
  async observation() {
    return '';
  },
  async file() {
    return '';
  },
};
