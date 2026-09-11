/**
 * Walking the locator ladder.
 *
 * Given a TargetDescriptor and an observation, find the one node it means --
 * or say precisely why not.
 *
 * Two rules do most of the work here.
 *
 * A match must be **unique**. If a rung matches three nodes, that rung has not
 * resolved anything; it has produced a guess. Clicking the first of three
 * candidates is how UI automation ends up doing the wrong thing quietly, which
 * in this domain means acting on the wrong account. So a multi-match falls
 * through to the next rung -- a weaker strategy is often *more specific*, which
 * is exactly the case anchor-relative targeting exists for when twenty buttons
 * are all named "Select" -- and if no rung resolves uniquely, the run fails
 * with TARGET_AMBIGUOUS rather than proceeding.
 *
 * Which rung resolved is **recorded**. A ladder that silently succeeds tells
 * you nothing. A ladder that reports it dropped from `role-name` to
 * `structural` is drift detection: the run still worked, and something about
 * the screen has changed. Aggregated across tenants, that is how you find out
 * an institution upgraded their vendor product before the automation breaks.
 */

import type { TargetDescriptor, TargetStrategy } from '../artifact/schema.js';
import type { Resolution } from '../artifact/result.js';
import type { Observation, UiNode } from '../surface/types.js';

export type ResolveOutcome =
  | { ok: true; node: UiNode; resolution: Resolution }
  | { ok: false; code: 'TARGET_NOT_FOUND' | 'TARGET_AMBIGUOUS'; message: string; candidates: number };

export function resolveTarget(target: TargetDescriptor, observation: Observation): ResolveOutcome {
  const { scope, frameWidened } = scopeToFrame(target, observation.nodes);

  let bestAmbiguity = 0;

  for (const [rank, strategy] of target.strategies.entries()) {
    const matches = scope.filter((node) => matchesStrategy(node, strategy));

    if (matches.length === 1) {
      return {
        ok: true,
        node: matches[0]!,
        resolution: {
          strategyKind: strategy.kind,
          rank,
          // Widening past a missing frame counts as degradation even at rank 0:
          // the frame the recording named is not there, which is worth knowing
          // even though the control was found anyway.
          degraded: rank > 0 || frameWidened,
          candidates: 1,
        },
      };
    }

    bestAmbiguity = Math.max(bestAmbiguity, matches.length);
  }

  if (bestAmbiguity > 1) {
    return {
      ok: false,
      code: 'TARGET_AMBIGUOUS',
      message:
        `${describeTarget(target)} matched ${bestAmbiguity} controls and no strategy narrowed it to one. ` +
        `Refusing to guess.`,
      candidates: bestAmbiguity,
    };
  }

  return {
    ok: false,
    code: 'TARGET_NOT_FOUND',
    message: `${describeTarget(target)} matched nothing on this screen.`,
    candidates: 0,
  };
}

/**
 * Restricts the search to the frame the target names.
 *
 * Frame path is part of a control's identity -- "the Search button" is
 * ambiguous across two frames that both have one. But a frame that has been
 * renamed should degrade rather than fail outright, so if the named frame
 * holds no nodes at all we widen to the whole observation and flag it.
 */
function scopeToFrame(
  target: TargetDescriptor,
  nodes: UiNode[],
): { scope: UiNode[]; frameWidened: boolean } {
  if (!target.framePath.length) {
    // A target recorded at top level still searches everywhere: frames are an
    // implementation detail of the screen, and a recording that omitted the
    // path should not be stricter than one that included it.
    return { scope: nodes, frameWidened: false };
  }

  const wanted = target.framePath.join('/');
  const inFrame = nodes.filter((n) => n.framePath.join('/') === wanted);

  return inFrame.length ? { scope: inFrame, frameWidened: false } : { scope: nodes, frameWidened: true };
}

function matchesStrategy(node: UiNode, strategy: TargetStrategy): boolean {
  if (!node.visible) return false;

  switch (strategy.kind) {
    case 'role-name':
      return node.role === strategy.role && textMatches(node.name, strategy.name, strategy.match);

    case 'anchor': {
      if (node.role !== strategy.role) return false;
      const { precedingText, rowText, sectionText, namePattern } = strategy;
      // Every anchor the descriptor states must hold. Anchors are conjunctive
      // because that is what makes them able to disambiguate: "the textbox in
      // the Savings row" is only useful if both halves are required.
      if (precedingText !== undefined && !textMatches(node.anchors.precedingText ?? '', precedingText, strategy.match))
        return false;
      if (rowText !== undefined && !textMatches(node.anchors.rowText ?? '', rowText, strategy.match)) return false;
      if (sectionText !== undefined && !textMatches(node.anchors.sectionText ?? '', sectionText, strategy.match))
        return false;
      if (namePattern !== undefined && !safeTest(namePattern, node.name)) return false;

      // At least one positive constraint is required. An anchor strategy with
      // nothing set would match every node of that role, which is not a
      // targeting strategy but a way to fail the uniqueness check.
      return (
        precedingText !== undefined ||
        rowText !== undefined ||
        sectionText !== undefined ||
        namePattern !== undefined
      );
    }

    case 'structural': {
      if (node.role !== strategy.role) return false;
      if (strategy.sectionText !== undefined && (node.anchors.sectionText ?? '') !== strategy.sectionText) return false;
      return node.anchors.ordinalInRole === strategy.ordinalInRole;
    }

    case 'coordinates': {
      // Overlap, not equality: a recorded box and a live box are never
      // identical, and a strict comparison would make this rung useless rather
      // than merely weak. Requiring the recorded centre to fall inside the live
      // node keeps it from matching half the screen.
      const cx = strategy.x + strategy.width / 2;
      const cy = strategy.y + strategy.height / 2;
      const b = node.bbox;
      return cx >= b.x && cx <= b.x + b.width && cy >= b.y && cy <= b.y + b.height;
    }
  }
}

/**
 * Whitespace is normalised before comparison; case is not.
 *
 * Normalising whitespace is safe -- rendered HTML collapses it arbitrarily and
 * no label means something different with two spaces in it. Normalising case
 * is not: "Post" and "POST" being interchangeable is a judgement about a
 * specific application, and the mechanism for wording that varies between
 * institutions is the tenant overlay, where it is visible and reviewed.
 */
function textMatches(actual: string, expected: string, mode: 'exact' | 'contains' | 'regex'): boolean {
  const a = actual.replace(/\s+/g, ' ').trim();
  const e = expected.replace(/\s+/g, ' ').trim();

  switch (mode) {
    case 'exact':
      return a === e;
    case 'contains':
      return a.includes(e);
    case 'regex':
      try {
        return new RegExp(expected).test(actual);
      } catch {
        // Validation compiles every pattern at load time, so reaching here means
        // an artifact bypassed validation. Failing to match is the safe answer.
        return false;
      }
  }
}

function safeTest(pattern: string, value: string): boolean {
  try {
    return new RegExp(pattern).test(value);
  } catch {
    return false;
  }
}

export function describeTarget(target: TargetDescriptor): string {
  const where = target.framePath.length ? ` in frame ${target.framePath.join('/')}` : '';
  return `"${target.description}"${where}`;
}
