/**
 * Binding an artifact to a tenant.
 *
 * The environment this is designed for has hundreds of institutions running
 * roughly twenty applications each, and many of them are running the *same
 * vendor product* with different branding, wording and version. Re-recording a
 * capability per tenant would mean thousands of near-identical artifacts, each
 * needing its own review and its own maintenance.
 *
 * So the reusable unit is (vendor, product) and the tenant is a binding applied
 * on top. The bet the design makes is that across tenants on one product, the
 * *flow* is identical and the *wording* differs: "Search" becomes "Find
 * Member", "Member ID" becomes "Member No.". If that bet holds, a tenant costs
 * a few lines of label mapping. Where it does not hold, step-level overrides
 * are the escape hatch -- and a tenant that needs many of them is a signal
 * worth acting on, not a cost to absorb quietly.
 *
 * Binding is a pure function producing a new artifact. Nothing is mutated,
 * because the base artifact is shared across every tenant that uses it and an
 * in-place edit would leak one institution's wording into another's run.
 */

import type {
  CapabilityArtifact,
  Checkpoint,
  Step,
  TargetDescriptor,
  TargetStrategy,
  TenantOverlay,
} from './schema.js';

export interface BindResult {
  artifact: CapabilityArtifact;
  /** Undefined when the tenant has no overlay and the base was used as-is. */
  overlay?: TenantOverlay;
  /**
   * Raised when the artifact is bound to a tenant running a different product
   * version than the one it was recorded against. Not fatal -- these products
   * change slowly and a minor version bump usually changes nothing -- but it is
   * the single most useful piece of context to have attached to a replay that
   * later fails, so it travels with the result rather than being logged and
   * lost.
   */
  versionDrift?: { recordedAgainst: string; bindingTo: string };
}

export function bindTenant(
  artifact: CapabilityArtifact,
  tenantId: string,
  opts: { productVersion?: string } = {},
): BindResult {
  const overlay = artifact.tenantOverlays.find((o) => o.tenantId === tenantId);

  const versionDrift =
    opts.productVersion && opts.productVersion !== artifact.app.productVersion
      ? { recordedAgainst: artifact.app.productVersion, bindingTo: opts.productVersion }
      : undefined;

  if (!overlay) {
    // No overlay is a legitimate and common case: a tenant whose wording
    // matches the base recording needs nothing at all.
    return { artifact, ...(versionDrift ? { versionDrift } : {}) };
  }

  const relabel = labelMapper(overlay.labels);

  const steps = artifact.steps
    .map((step) => applyStepOverride(step, overlay, relabel))
    .filter((step): step is Step => step !== undefined);

  return {
    artifact: {
      ...artifact,
      steps,
      successCheckpoint: mapCheckpoint(artifact.successCheckpoint, relabel),
      outcomes: artifact.outcomes.map((o) => ({ ...o, detect: mapCheckpoint(o.detect, relabel) })),
      recovery: artifact.recovery.map((r) => ({
        ...r,
        when: mapCheckpoint(r.when, relabel),
        then: r.then.kind === 'click' ? { ...r.then, target: mapTarget(r.then.target, relabel) } : r.then,
      })),
      app: { ...artifact.app, recordedOnTenant: artifact.app.recordedOnTenant },
    },
    overlay,
    ...(versionDrift ? { versionDrift } : {}),
  };
}

function applyStepOverride(
  step: Step,
  overlay: TenantOverlay,
  relabel: (s: string) => string,
): Step | undefined {
  const override = overlay.steps[step.id];
  if (override?.skip) return undefined;

  const target = override?.target ?? (step.target ? mapTarget(step.target, relabel) : undefined);
  const checkpoint = override?.checkpoint ?? (step.checkpoint ? mapCheckpoint(step.checkpoint, relabel) : undefined);

  return {
    ...step,
    ...(target ? { target } : {}),
    ...(checkpoint ? { checkpoint } : {}),
    recovery: step.recovery.map((r) => ({ ...r, when: mapCheckpoint(r.when, relabel) })),
  };
}

/**
 * Whole-string replacement only.
 *
 * Substring replacement was the alternative and is a trap: a tenant mapping
 * "Search" to "Find Member" would rewrite the checkpoint "Member Search" into
 * "Member Find Member", which is nonsense that still parses and still looks
 * like an honest label. Whole-string matching is predictable enough that a
 * reviewer can read an overlay and know exactly what it does; anything that
 * needs more than that should be an explicit step override, where it is
 * visible.
 */
function labelMapper(labels: Record<string, string>): (s: string) => string {
  return (s: string) => labels[s] ?? s;
}

function mapTarget(target: TargetDescriptor, relabel: (s: string) => string): TargetDescriptor {
  return { ...target, strategies: target.strategies.map((s) => mapStrategy(s, relabel)) };
}

function mapStrategy(strategy: TargetStrategy, relabel: (s: string) => string): TargetStrategy {
  switch (strategy.kind) {
    case 'role-name':
      return { ...strategy, name: relabel(strategy.name) };
    case 'anchor':
      return {
        ...strategy,
        ...(strategy.precedingText ? { precedingText: relabel(strategy.precedingText) } : {}),
        ...(strategy.rowText ? { rowText: relabel(strategy.rowText) } : {}),
        ...(strategy.sectionText ? { sectionText: relabel(strategy.sectionText) } : {}),
      };
    case 'structural':
      return {
        ...strategy,
        ...(strategy.sectionText ? { sectionText: relabel(strategy.sectionText) } : {}),
      };
    case 'coordinates':
      // Coordinates cannot be relabelled, and a tenant with different chrome
      // almost certainly has different coordinates. Reaching this rung after a
      // tenant bind is a strong signal the binding is wrong, which the replay
      // engine reports as degradation rather than silently accepting.
      return strategy;
  }
}

function mapCheckpoint(checkpoint: Checkpoint, relabel: (s: string) => string): Checkpoint {
  switch (checkpoint.kind) {
    case 'text-present':
    case 'text-absent':
      // A regex predicate is left alone: relabelling inside a pattern would
      // rewrite its syntax as often as its content.
      return checkpoint.match === 'regex' ? checkpoint : { ...checkpoint, text: relabel(checkpoint.text) };
    case 'node-present':
    case 'node-absent':
      return { ...checkpoint, target: mapTarget(checkpoint.target, relabel) };
    case 'location-matches':
      return checkpoint;
    case 'all':
    case 'any':
      return { ...checkpoint, of: checkpoint.of.map((c) => mapCheckpoint(c, relabel)) };
    case 'not':
      return { ...checkpoint, of: mapCheckpoint(checkpoint.of, relabel) };
  }
}
