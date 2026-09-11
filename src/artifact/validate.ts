/**
 * Validation beyond "does it parse".
 *
 * Zod gets the shape right. It cannot tell you that step `s3` types a value
 * from a parameter nobody declared, that an overlay overrides a step that does
 * not exist, or that a capability returns a field marked `secret`. Those are
 * the failures that survive review and then surface mid-run against live bank
 * software, so they are checked here and checked at load time -- before the
 * browser opens, not three steps in.
 *
 * Everything is reported as a list with a path, rather than thrown one at a
 * time. Someone fixing a hand-edited artifact should see all of what is wrong
 * in one pass.
 */

import { z } from 'zod';
import {
  CapabilityArtifact,
  SCHEMA_VERSION,
  type Checkpoint,
  type RecoveryRule,
  type Step,
  type ValueSpec,
} from './schema.js';

export interface ArtifactIssue {
  /** Dotted path into the artifact, e.g. `steps[2].action.value`. */
  path: string;
  message: string;
  severity: 'error' | 'warning';
}

export type ParseResult =
  | { ok: true; artifact: CapabilityArtifact; warnings: ArtifactIssue[] }
  | { ok: false; issues: ArtifactIssue[] };

/** Actions that address a control and therefore require a target. */
const NEEDS_TARGET = new Set(['click', 'type', 'select', 'read']);

/**
 * Actions that can move the screen, and therefore ought to assert where they
 * landed. Typing into a field and reading a value change nothing, so demanding
 * a checkpoint after them would train authors to write checkpoints that assert
 * the screen they were already on -- noise that makes the real ones easier to
 * skip.
 */
const SHOULD_ASSERT = new Set(['click', 'navigate', 'press', 'select']);

export function parseArtifact(input: unknown): ParseResult {
  const shape = CapabilityArtifact.safeParse(input);
  if (!shape.success) {
    return {
      ok: false,
      issues: shape.error.issues.map((i) => ({
        path: i.path.join('.') || '(root)',
        message: i.message,
        severity: 'error' as const,
      })),
    };
  }

  const artifact = shape.data;
  const issues = semanticIssues(artifact);
  const errors = issues.filter((i) => i.severity === 'error');

  if (errors.length) return { ok: false, issues };
  return { ok: true, artifact, warnings: issues };
}

/** Throwing variant, for call sites where a bad artifact is unrecoverable. */
export function parseArtifactOrThrow(input: unknown): CapabilityArtifact {
  const result = parseArtifact(input);
  if (result.ok) return result.artifact;
  throw new Error(
    `Invalid capability artifact:\n${result.issues.map((i) => `  [${i.severity}] ${i.path}: ${i.message}`).join('\n')}`,
  );
}

function semanticIssues(a: CapabilityArtifact): ArtifactIssue[] {
  const issues: ArtifactIssue[] = [];
  const error = (path: string, message: string) => issues.push({ path, message, severity: 'error' });
  const warn = (path: string, message: string) => issues.push({ path, message, severity: 'warning' });

  if (a.schemaVersion !== SCHEMA_VERSION) {
    warn(
      'schemaVersion',
      `Artifact is schema ${a.schemaVersion}, runtime is ${SCHEMA_VERSION}. Run it through migrate() first.`,
    );
  }

  // --- names and ids are unique -------------------------------------------
  duplicates(a.inputs.map((p) => p.name)).forEach((n) => error('inputs', `Duplicate input "${n}".`));
  duplicates(a.outputs.map((o) => o.name)).forEach((n) => error('outputs', `Duplicate output "${n}".`));
  duplicates(a.outcomes.map((o) => o.code)).forEach((c) => error('outcomes', `Duplicate outcome code "${c}".`));
  duplicates(a.steps.map((s) => s.id)).forEach((id) => error('steps', `Duplicate step id "${id}".`));

  // --- the call signature is self-consistent -------------------------------
  const declared = new Set(a.inputs.map((p) => p.name));

  a.inputs.forEach((p, i) => {
    if (p.type === 'enum' && !p.options?.length) {
      error(`inputs[${i}].options`, `Input "${p.name}" is an enum but declares no options.`);
    }
    if (p.pattern) assertRegex(p.pattern, `inputs[${i}].pattern`, error);
    if (p.example && (p.sensitivity === 'restricted' || p.sensitivity === 'secret')) {
      // An "example SSN" in a committed artifact is a leak with a friendly name.
      error(
        `inputs[${i}].example`,
        `Input "${p.name}" is ${p.sensitivity}; it must not carry an example value.`,
      );
    }
  });

  a.outputs.forEach((o, i) => {
    if (o.sensitivity === 'secret') {
      error(`outputs[${i}].sensitivity`, `Output "${o.name}" is marked secret. A capability never returns a secret.`);
    }
  });

  // --- every value reference resolves --------------------------------------
  forEachValueSpec(a, (spec, path) => {
    if (spec.from === 'param' && !declared.has(spec.param)) {
      error(path, `References undeclared input "${spec.param}".`);
    }
    if (spec.from === 'secret' && !spec.ref.trim()) {
      error(path, 'Secret reference is empty.');
    }
  });

  // --- steps ----------------------------------------------------------------
  a.steps.forEach((step, i) => {
    const at = `steps[${i}]`;

    if (NEEDS_TARGET.has(step.action.type) && !step.target) {
      error(`${at}.target`, `Step "${step.id}" is a ${step.action.type} but has no target.`);
    }
    if (!NEEDS_TARGET.has(step.action.type) && step.target) {
      warn(`${at}.target`, `Step "${step.id}" is a ${step.action.type}; its target is ignored.`);
    }
    if (!step.checkpoint && !step.optional && SHOULD_ASSERT.has(step.action.type)) {
      // A warning rather than an error: there are legitimate flows where an
      // intermediate click has nothing worth asserting. But a flow of unchecked
      // navigations reports success for having clicked rather than for having
      // worked, which is the failure checkpoints exist to prevent.
      warn(`${at}.checkpoint`, `Step "${step.id}" is a ${step.action.type} but asserts nothing afterwards.`);
    }
    if (step.action.type === 'navigate') {
      checkLocation(step, at, error);
    }

    step.recovery.forEach((rule, j) => checkRecovery(a, rule, `${at}.recovery[${j}]`, error));
  });

  a.recovery.forEach((rule, i) => checkRecovery(a, rule, `recovery[${i}]`, error));

  // --- predicates compile ---------------------------------------------------
  forEachCheckpoint(a, (cp, path) => {
    if ((cp.kind === 'text-present' || cp.kind === 'text-absent') && cp.match === 'regex') {
      assertRegex(cp.text, `${path}.text`, error);
    }
  });

  a.outputs.forEach((o, i) => {
    if (o.extract.kind === 'text-pattern') assertRegex(o.extract.pattern, `outputs[${i}].extract.pattern`, error);
  });

  // --- outcomes must be distinguishable from success ------------------------
  if (a.outcomes.length === 0) {
    warn(
      'outcomes',
      'No business outcomes declared. Any non-success result will be reported as a failure, which is usually wrong.',
    );
  }

  // --- overlays refer to real steps -----------------------------------------
  const stepIds = new Set(a.steps.map((s) => s.id));
  a.tenantOverlays.forEach((overlay, i) => {
    for (const id of Object.keys(overlay.steps)) {
      if (!stepIds.has(id)) {
        error(`tenantOverlays[${i}].steps.${id}`, `Overrides step "${id}", which does not exist.`);
      }
    }
  });
  duplicates(a.tenantOverlays.map((o) => o.tenantId)).forEach((t) =>
    error('tenantOverlays', `More than one overlay for tenant "${t}".`),
  );

  // --- risk and approval are coherent ---------------------------------------
  if (a.risk === 'irreversible' && a.approval.state === 'approved') {
    warn(
      'approval.state',
      'An irreversible capability is approved. It can still never run unattended -- policy denies that at the choke point -- but confirm the approval was meant.',
    );
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Traversal helpers
// ---------------------------------------------------------------------------

function checkRecovery(
  a: CapabilityArtifact,
  rule: RecoveryRule,
  at: string,
  error: (path: string, message: string) => void,
): void {
  if (rule.then.kind === 'run-capability' && rule.then.capabilityId === a.capability.id) {
    // A capability that re-authenticates by running itself is an infinite loop
    // that only reveals itself in production, at whatever rate sessions expire.
    error(`${at}.then.capabilityId`, 'A capability cannot recover by running itself.');
  }
}

function checkLocation(step: Step, at: string, error: (path: string, message: string) => void): void {
  if (step.action.type !== 'navigate') return;
  const { pathTemplate, params } = step.action.location;

  const placeholders = [...pathTemplate.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]!);
  for (const name of placeholders) {
    if (!(name in params)) {
      error(`${at}.action.location.params`, `Template "${pathTemplate}" needs "${name}", which is not supplied.`);
    }
  }
  for (const name of Object.keys(params)) {
    if (!placeholders.includes(name)) {
      error(`${at}.action.location.params.${name}`, `Supplied but "${pathTemplate}" has no such placeholder.`);
    }
  }
}

function assertRegex(source: string, path: string, error: (path: string, message: string) => void): void {
  try {
    new RegExp(source);
  } catch (err) {
    error(path, `Not a valid regular expression: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Visits every ValueSpec in the artifact, with a path for error reporting. */
function forEachValueSpec(a: CapabilityArtifact, visit: (spec: ValueSpec, path: string) => void): void {
  a.steps.forEach((step, i) => {
    const at = `steps[${i}].action`;
    switch (step.action.type) {
      case 'type':
        visit(step.action.value, `${at}.value`);
        break;
      case 'select':
        visit(step.action.option, `${at}.option`);
        break;
      case 'navigate':
        for (const [name, spec] of Object.entries(step.action.location.params)) {
          visit(spec, `${at}.location.params.${name}`);
        }
        break;
      default:
        break;
    }
  });
}

/** Visits every Checkpoint in the artifact, including nested composites. */
function forEachCheckpoint(a: CapabilityArtifact, visit: (cp: Checkpoint, path: string) => void): void {
  const walk = (cp: Checkpoint, path: string): void => {
    visit(cp, path);
    if (cp.kind === 'all' || cp.kind === 'any') cp.of.forEach((c, i) => walk(c, `${path}.of[${i}]`));
    if (cp.kind === 'not') walk(cp.of, `${path}.of`);
  };

  walk(a.successCheckpoint, 'successCheckpoint');
  a.steps.forEach((s, i) => {
    if (s.checkpoint) walk(s.checkpoint, `steps[${i}].checkpoint`);
    s.recovery.forEach((r, j) => walk(r.when, `steps[${i}].recovery[${j}].when`));
  });
  a.outcomes.forEach((o, i) => walk(o.detect, `outcomes[${i}].detect`));
  a.recovery.forEach((r, i) => walk(r.when, `recovery[${i}].when`));
}

function duplicates(values: string[]): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const v of values) {
    if (seen.has(v)) dupes.add(v);
    seen.add(v);
  }
  return [...dupes];
}

/** Re-exported so callers can render Zod issues the same way as ours. */
export type { z };
