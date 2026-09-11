/**
 * Evaluating checkpoints.
 *
 * Two functions, and the second one is why this file is worth its own module.
 *
 * `evaluate` answers whether a predicate holds. `explain` answers *which part*
 * did not, which is the difference between a failure report that says
 * "checkpoint failed" and one that says "expected text 'Share Accounts' to be
 * present". The brief asks for failures with enough detail to debug -- what
 * step, what was expected, what was observed -- and for a composite predicate
 * that means pinpointing the failing leaf rather than restating the whole tree.
 *
 * Nothing here can call a model, reach the network, or execute anything from
 * the artifact. A checkpoint is data (D11), so evaluating one is a pure
 * function of the observation.
 */

import type { Checkpoint } from '../artifact/schema.js';
import { matchPath } from '../artifact/canonical.js';
import { resolveTarget, describeTarget } from './resolve.js';
import type { Observation } from '../surface/types.js';

export interface CheckpointContext {
  observation: Observation;
  /** Path portion of the current location, without origin or query. */
  path: string;
}

export function evaluate(checkpoint: Checkpoint, ctx: CheckpointContext): boolean {
  switch (checkpoint.kind) {
    case 'text-present':
      return textFound(checkpoint.text, checkpoint.match, ctx);
    case 'text-absent':
      return !textFound(checkpoint.text, checkpoint.match, ctx);
    case 'node-present':
      return resolveTarget(checkpoint.target, ctx.observation).ok;
    case 'node-absent':
      return !resolveTarget(checkpoint.target, ctx.observation).ok;
    case 'location-matches':
      return matchPath(checkpoint.pathTemplate, ctx.path) !== undefined;
    case 'all':
      return checkpoint.of.every((c) => evaluate(c, ctx));
    case 'any':
      return checkpoint.of.some((c) => evaluate(c, ctx));
    case 'not':
      return !evaluate(checkpoint.of, ctx);
  }
}

/**
 * The narrowest true statement about why a predicate failed.
 *
 * For `all`, that is the first failing branch -- reporting the whole
 * conjunction when one clause failed buries the answer. For `any`, no single
 * branch is at fault, so the honest report is that none of them held.
 */
export function explain(checkpoint: Checkpoint, ctx: CheckpointContext): string {
  if (evaluate(checkpoint, ctx)) return `${describe(checkpoint)} (held)`;

  switch (checkpoint.kind) {
    case 'all': {
      const failing = checkpoint.of.find((c) => !evaluate(c, ctx));
      return failing ? explain(failing, ctx) : describe(checkpoint);
    }
    case 'any':
      return `none of: ${checkpoint.of.map(describe).join(' | ')}`;
    default:
      return describe(checkpoint);
  }
}

/** A human-readable rendering, used in reports and the operator console. */
export function describe(checkpoint: Checkpoint): string {
  switch (checkpoint.kind) {
    case 'text-present':
      return `text ${quote(checkpoint.text, checkpoint.match)} present on screen`;
    case 'text-absent':
      return `text ${quote(checkpoint.text, checkpoint.match)} absent from screen`;
    case 'node-present':
      return `control ${describeTarget(checkpoint.target)} present`;
    case 'node-absent':
      return `control ${describeTarget(checkpoint.target)} absent`;
    case 'location-matches':
      return `location matches "${checkpoint.pathTemplate}"`;
    case 'all':
      return `all of: ${checkpoint.of.map(describe).join(' AND ')}`;
    case 'any':
      return `any of: ${checkpoint.of.map(describe).join(' OR ')}`;
    case 'not':
      return `not (${describe(checkpoint.of)})`;
  }
}

function quote(text: string, match: 'contains' | 'regex' | undefined): string {
  return match === 'regex' ? `matching /${text}/` : `"${text}"`;
}

function textFound(text: string, match: 'contains' | 'regex' | undefined, ctx: CheckpointContext): boolean {
  const haystack = ctx.observation.text;

  if (match === 'regex') {
    try {
      return new RegExp(text).test(haystack);
    } catch {
      return false;
    }
  }

  // Whitespace-normalised on both sides for the same reason target matching is:
  // rendered text collapses whitespace unpredictably, and a checkpoint that
  // fails because a table cell wrapped is a false alarm, not a finding.
  return normalise(haystack).includes(normalise(text));
}

function normalise(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * A short summary of what was on screen, for the `observed` half of a failure
 * report. Deliberately truncated: the full observation goes to evidence, and a
 * result object that inlines 20kB of screen text is one nobody reads.
 */
export function summariseScreen(ctx: CheckpointContext): string {
  const title = ctx.observation.title ? `"${ctx.observation.title}" ` : '';
  return `${title}at ${ctx.path} -- ${normalise(ctx.observation.text).slice(0, 400)}`;
}
