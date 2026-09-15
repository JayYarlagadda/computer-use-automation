/**
 * Turning "the node the model clicked" into a durable locator ladder.
 *
 * This is the part of compilation that decides whether an artifact is reusable
 * or is a recording of one afternoon. A discovery step addresses a control by
 * `nodeId`, which is valid for exactly one observation and meaningless a
 * second later. The artifact has to say the same thing the way a screen reader
 * would -- "the textbox labelled Member ID" -- and it has to say it in a way
 * that will still be true next month.
 *
 * Two rules do the work.
 *
 * **Every rung is verified before it is emitted.** Each candidate strategy is
 * run through the real replay resolver against the observation the model was
 * actually looking at, and it survives only if it resolves *uniquely* and
 * resolves to *the node that was acted on*. Uniqueness alone is not enough: a
 * strategy that confidently matches one wrong control is worse than one that
 * matches none, because the failure is silent and the wrong account gets
 * clicked. Without this check the compiler could emit a plausible-looking
 * ladder that never worked, and nobody would find out until replay.
 *
 * **No rung may embed instance data.** The balance cell on the recorded screen
 * has the accessible name "$4,182.55". A `role-name` rung quoting that would
 * verify perfectly against the recording and then fail for every other member
 * -- and fail by *not finding* the balance, which reads like a broken app
 * rather than a broken artifact. So values that came from the goal, secrets,
 * and anything shaped like an amount, a date or a record number are refused as
 * locator text, and a shape constraint (`^\$[\d,]+\.\d{2}$`) is offered in
 * their place. Shape survives the value changing; the value does not.
 *
 * What is deliberately not generated: a `coordinates` rung. The schema has one
 * for surfaces with no accessibility peer at all, but it is only meaningful
 * alongside the viewport it was captured at, and `Observation` does not carry
 * one. Emitting a box with a guessed viewport would be a rung that cannot
 * resolve honestly, so the compiler emits nothing rather than something
 * decorative.
 */

import type { TargetDescriptor, TargetStrategy } from '../artifact/schema.js';
import { resolveTarget } from '../replay/resolve.js';
import type { Observation, UiNode } from '../surface/types.js';

/** Beyond three rungs the ladder is no longer something a human reviews. */
const MAX_RUNGS = 3;

/**
 * What the locator is for, which changes what may be used to build it.
 *
 * `action` targets a control the flow operates: a button, a link, a field. The
 * control's own name is its best identifier and a wrong match usually fails
 * loudly -- the click does nothing and the step's checkpoint catches it.
 *
 * `extraction` targets a control the flow *reads*, and two rungs that are fine
 * for an action become incoherent here. Identifying a cell by its own text is
 * circular: the text is the value being extracted, so the locator only matches
 * when the answer is already the one recorded, and finds nothing the moment it
 * changes. And an ordinal rung, which merely fails for an action, silently
 * returns whatever now sits in that position -- a confidently wrong balance
 * handed to an agent that will act on it. A lookup that fails is recoverable;
 * a lookup that lies is not.
 *
 * So extraction keeps the rungs that describe *where* a value sits -- the
 * label beside it, the row around it -- and, where the value has a
 * recognisable form, a constraint on its shape. A shape is not the value:
 * `^\$[\d,]+\.\d{2}$` still identifies the balance after the balance changes.
 */
export type LadderPurpose = 'action' | 'extraction';

export interface LadderOptions {
  /**
   * Concrete values that must never appear in a locator: the goal's inputs and
   * any secret. Matching text is rejected with a reason rather than silently
   * dropped, so the report can say why a rung is missing.
   */
  avoid?: string[];
  purpose?: LadderPurpose;
  /** Overrides the generated human-readable description. */
  description?: string;
}

export interface RungReport {
  kind: TargetStrategy['kind'];
  /** How the strategy identifies the control, for the compile report. */
  summary: string;
  accepted: boolean;
  /** Why it was not accepted. Empty when it was. */
  reason: string;
}

export interface LadderResult {
  /** Absent when no candidate resolved uniquely to the recorded node. */
  target?: TargetDescriptor;
  /** Every candidate considered, in the order they were tried. */
  rungs: RungReport[];
}

/**
 * Builds and verifies a ladder for `node` as it appeared in `observation`.
 */
export function buildLadder(
  node: UiNode,
  observation: Observation,
  options: LadderOptions = {},
): LadderResult {
  const avoid = (options.avoid ?? []).filter((v) => v.trim().length > 0);
  const purpose = options.purpose ?? 'action';
  const description = options.description ?? describeNode(node, avoid);

  const rungs: RungReport[] = [];
  const accepted: TargetStrategy[] = [];

  // One rung per family. Within a family the variants are alternatives -- the
  // first that verifies wins and the rest are not tried -- because a ladder of
  // three near-identical anchors is not a ladder. Rungs are only worth having
  // when they fail independently of each other.
  for (const family of families(node, avoid, purpose)) {
    if (accepted.length >= MAX_RUNGS) break;

    for (const candidate of family) {
      if ('rejected' in candidate) {
        rungs.push({
          kind: candidate.kind,
          summary: candidate.summary,
          accepted: false,
          reason: candidate.rejected,
        });
        continue;
      }

      const verdict = verify(candidate.strategy, node, observation);
      rungs.push({
        kind: candidate.strategy.kind,
        summary: candidate.summary,
        accepted: verdict === '',
        reason: verdict,
      });
      if (verdict === '') {
        accepted.push(candidate.strategy);
        break;
      }
    }
  }

  if (!accepted.length) return { rungs };

  return {
    target: {
      description,
      framePath: node.framePath,
      strategies: accepted,
      notes: scrubAvoid(explainLadder(rungs), avoid),
    },
    rungs,
  };
}

/**
 * The single check that makes a ladder trustworthy.
 *
 * Runs the strategy through the production resolver against the recorded
 * screen. Anything other than a unique match on the node that was actually
 * acted on is a rejection, with the resolver's own wording so the report says
 * "matched 4 controls" rather than "failed".
 */
function verify(strategy: TargetStrategy, node: UiNode, observation: Observation): string {
  const probe: TargetDescriptor = {
    description: 'candidate',
    framePath: node.framePath,
    strategies: [strategy],
  };

  const outcome = resolveTarget(probe, observation);

  if (!outcome.ok) {
    return outcome.code === 'TARGET_AMBIGUOUS'
      ? `matched ${outcome.candidates} controls on the recorded screen`
      : 'matched nothing on the recorded screen';
  }
  if (outcome.node.nodeId !== node.nodeId) {
    // The dangerous case, and the reason uniqueness alone is not the test.
    return `resolved uniquely, but to a different control (${describeNode(outcome.node)})`;
  }
  return '';
}

// ---------------------------------------------------------------------------
// Candidate generation, strongest first
// ---------------------------------------------------------------------------

type Candidate =
  | { strategy: TargetStrategy; summary: string }
  | { kind: TargetStrategy['kind']; summary: string; rejected: string };

function families(node: UiNode, avoid: string[], purpose: LadderPurpose): Candidate[][] {
  const { precedingText, rowText, sectionText, ordinalInRole } = node.anchors;

  const extracting = purpose === 'extraction';
  const own = ownTextPattern(node.name, avoid);
  // Reading a value by its own text is circular; reading it by its shape is not.
  const namePattern = own && (own.kind === 'shape' || !extracting) ? own.pattern : undefined;
  const rowToken = stableToken(rowText, avoid);

  const out: Candidate[][] = [];

  // 1. What a screen reader announces. Strongest, and markup-independent --
  //    for a control the flow operates. For one it reads, it is the answer
  //    quoting itself.
  if (extracting) {
    out.push([
      {
        kind: 'role-name',
        summary: `role+name on ${node.role}`,
        rejected:
          'this control is being read, so its own text is the value -- a locator quoting it would ' +
          'only match the run it was recorded from',
      },
    ]);
  } else if (!node.name.trim()) {
    out.push([
      {
        kind: 'role-name',
        summary: `role+name on ${node.role}`,
        rejected: 'the control has no accessible name at all',
      },
    ]);
  } else if (unsafeText(node.name, avoid)) {
    out.push([
      {
        kind: 'role-name',
        summary: `role+name on ${node.role}`,
        rejected: 'the control\'s own text is rendered data rather than a label -- it changes between runs',
      },
    ]);
  } else {
    out.push([
      {
        strategy: { kind: 'role-name', role: node.role, name: node.name, match: 'exact' },
        summary: `role+name "${node.name}"`,
      },
    ]);
  }

  // 2. The label cell to the left. The norm on table-laid-out legacy screens,
  //    where inputs have no accessible name and this is the only handle a
  //    human has either. The shape-constrained variant is the fallback for a
  //    label that governs more than one control.
  if (usable(precedingText, avoid)) {
    const family: Candidate[] = [
      {
        strategy: { kind: 'anchor', role: node.role, precedingText: precedingText!, match: 'exact' },
        summary: `anchor: ${node.role} labelled "${precedingText}"`,
      },
    ];
    if (namePattern) {
      family.push({
        strategy: {
          kind: 'anchor',
          role: node.role,
          precedingText: precedingText!,
          match: 'exact',
          namePattern,
        },
        summary: `anchor: ${node.role} labelled "${precedingText}" matching ${namePattern}`,
      });
    }
    out.push(family);
  }

  // 3. Row-scoped. The row names the region; the shape constraint picks the
  //    cell out of it, because type, number, amount and status all share a row.
  if (rowToken) {
    const family: Candidate[] = [];
    if (namePattern) {
      family.push({
        strategy: { kind: 'anchor', role: node.role, rowText: rowToken, match: 'contains', namePattern },
        summary: `anchor: ${node.role} in the "${rowToken}" row matching ${namePattern}`,
      });
    }
    family.push({
      strategy: { kind: 'anchor', role: node.role, rowText: rowToken, match: 'contains' },
      summary: `anchor: ${node.role} in the "${rowToken}" row`,
    });
    out.push(family);
  }

  // 4. Section-scoped: the same idea one level out.
  if (usable(sectionText, avoid) && namePattern) {
    out.push([
      {
        strategy: {
          kind: 'anchor',
          role: node.role,
          sectionText: sectionText!,
          match: 'exact',
          namePattern,
        },
        summary: `anchor: ${node.role} under "${sectionText}" matching ${namePattern}`,
      },
    ]);
  }

  // 5. Position. Weak, and last, because resolving here is itself the signal
  //    that the screen has changed.
  if (extracting) {
    out.push([
      {
        kind: 'structural',
        summary: `structural: ${node.role} #${ordinalInRole}`,
        rejected:
          'ordinal rungs are not emitted for extraction -- a wrong position returns a wrong value silently',
      },
    ]);
    return out;
  }

  const structural: Candidate[] = [];
  if (usable(sectionText, avoid)) {
    structural.push({
      strategy: { kind: 'structural', role: node.role, sectionText: sectionText!, ordinalInRole },
      summary: `structural: ${node.role} #${ordinalInRole} under "${sectionText}"`,
    });
  }
  structural.push({
    strategy: { kind: 'structural', role: node.role, ordinalInRole },
    summary: `structural: ${node.role} #${ordinalInRole}`,
  });
  out.push(structural);

  return out;
}

// ---------------------------------------------------------------------------
// What may and may not be written into a locator
// ---------------------------------------------------------------------------

/** Amounts, dates, and bare digit runs: rendered data, never a stable label. */
const CURRENCY = /^[$£€]?\s*[\d,]+\.\d{2}$/;
const DATE = /^\d{1,4}[-/]\d{1,2}[-/]\d{1,4}$/;
const DIGITS = /^\d{3,}$/;
const REFERENCE = /^[A-Z]{2,}-?\d{3,}$/;

function unsafeText(text: string, avoid: string[]): boolean {
  const t = text.replace(/\s+/g, ' ').trim();
  if (!t) return true;
  if (avoid.some((value) => t.includes(value))) return true;
  return CURRENCY.test(t) || DATE.test(t) || DIGITS.test(t) || REFERENCE.test(t);
}

function usable(text: string | undefined, avoid: string[]): boolean {
  return text !== undefined && text.trim().length > 0 && !unsafeText(text, avoid);
}

/**
 * A constraint on the control's own text, and whether it describes the text's
 * shape or quotes it.
 *
 * The distinction is what makes the constraint safe to use on a value. For a
 * stable label the pattern is the label itself, which is a `literal`. For
 * something rendered -- an amount, a date, a reference -- it is the form the
 * value takes, which is a `shape` and stays true after the value changes.
 * "The currency-shaped cell in the Savings row" is the whole idea.
 */
function ownTextPattern(
  name: string,
  avoid: string[],
): { pattern: string; kind: 'shape' | 'literal' } | undefined {
  const t = name.replace(/\s+/g, ' ').trim();
  if (!t) return undefined;

  const shape = (pattern: string) => ({ pattern, kind: 'shape' as const });

  if (CURRENCY.test(t)) return shape('^[$£€]?\\s*[\\d,]+\\.\\d{2}$');
  if (DATE.test(t)) return shape('^\\d{1,4}[-/]\\d{1,2}[-/]\\d{1,4}$');
  if (REFERENCE.test(t)) return shape(`^${escapeRegex(t).replace(/\d/g, '\\d')}$`);
  if (DIGITS.test(t)) return shape(`^\\d{${t.length}}$`);

  // A concrete value from the goal must not reach the artifact even as a
  // pattern -- that is the same literal wearing a different hat.
  if (avoid.some((value) => t.includes(value))) return undefined;

  return { pattern: `^${escapeRegex(t)}$`, kind: 'literal' };
}

/**
 * The part of a row's text that identifies the row rather than its contents.
 *
 * A row reads "Savings SV-4471 $4,182.55 Active". Recording it whole would
 * bake in the amount; the first stable word is what a person would point at.
 */
function stableToken(rowText: string | undefined, avoid: string[]): string | undefined {
  if (!rowText) return undefined;
  const words = rowText.replace(/\s+/g, ' ').trim().split(' ');
  const token = words.find((word) => word.length > 2 && !unsafeText(word, avoid));
  return token;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// Prose for the reviewer
// ---------------------------------------------------------------------------

/**
 * The `notes` field on a target, which exists because the brief asks for the
 * reasoning about robustness to be part of the artifact rather than folklore.
 * Recording what was *rejected* is the useful half: it tells a reviewer that
 * the obvious strategy was tried and why it is not there.
 */
function explainLadder(rungs: RungReport[]): string {
  const kept = rungs.filter((r) => r.accepted);
  const dropped = rungs.filter((r) => !r.accepted);

  const lines = [
    `Verified against the recorded screen: ${kept.map((r) => r.summary).join('; then ')}.`,
  ];
  if (dropped.length) {
    lines.push(
      `Rejected: ${dropped.map((r) => `${r.summary} (${r.reason})`).join('; ')}.`,
    );
  }
  return lines.join(' ');
}

export function describeNode(node: UiNode, avoid: string[] = []): string {
  const { precedingText, rowText, sectionText } = node.anchors;
  // The accessible name is often the value itself on a table cell. Quoting it
  // in a description would put the recorded instance into a reviewed artifact.
  if (node.name.trim() && !unsafeText(node.name, avoid)) return `the ${node.role} "${node.name.trim()}"`;
  if (usable(precedingText, avoid)) return `the ${node.role} labelled "${precedingText}"`;
  const row = stableToken(rowText, avoid);
  if (row) return `the ${node.role} in the "${row}" row`;
  if (usable(sectionText, avoid)) return `the ${node.role} under "${sectionText}"`;
  return `the ${node.role} at position ${node.anchors.ordinalInRole}`;
}

function scrubAvoid(text: string, avoid: string[]): string {
  return [...avoid]
    .filter((value) => value.trim().length > 0)
    .sort((a, b) => b.length - a.length)
    .reduce((out, value) => out.split(value).join('[value]'), text);
}
