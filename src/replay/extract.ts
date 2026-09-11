/**
 * Producing the declared outputs.
 *
 * Extraction is where a capability stops being "did the clicks work" and
 * becomes "here is the answer the caller asked for", so the failure mode that
 * matters is a *silent* one: returning a plausible value that came from the
 * wrong place. Three things guard against it.
 *
 * A required output that cannot be extracted is a hard failure, not a null.
 * Handing an agent `{ savingsBalance: undefined }` when it is about to quote a
 * balance to a member is worse than handing it an error.
 *
 * Transforms are a closed list applied in a declared order, so the same
 * artifact produces the same string on every run and on every machine. No
 * locale-dependent parsing, and currency stays a decimal string rather than
 * becoming a float somewhere in the middle.
 *
 * And extraction runs against the same redacted observation everything else
 * sees, so an output cannot be a back door around the perception boundary.
 */

import type { ExtractionRule, OutputSpec, Transform } from '../artifact/schema.js';
import type { OutputValue, Outputs } from '../artifact/result.js';
import { matchPath } from '../artifact/canonical.js';
import { resolveTarget, describeTarget } from './resolve.js';
import type { Observation } from '../surface/types.js';

export interface ExtractionContext {
  observation: Observation;
  path: string;
  /**
   * Templates to try when an extraction reads a value out of the location.
   * Collected from the artifact's navigate steps and location checkpoints.
   */
  pathTemplates: string[];
}

export type ExtractOutcome =
  | { ok: true; value: string }
  | { ok: false; reason: string };

export function extractValue(rule: ExtractionRule, ctx: ExtractionContext): ExtractOutcome {
  switch (rule.kind) {
    case 'node-text': {
      const resolved = resolveTarget(rule.target, ctx.observation);
      if (!resolved.ok) {
        return { ok: false, reason: `${describeTarget(rule.target)}: ${resolved.message}` };
      }
      // A control's value takes precedence over its name: for an input the
      // value is the data and the name is the label, and reading the label back
      // as an answer is the exact silent-wrong-value failure to avoid.
      const raw = resolved.node.value ?? resolved.node.name;
      if (!raw) return { ok: false, reason: `${describeTarget(rule.target)} resolved but is empty.` };
      return { ok: true, value: applyTransforms(raw, rule.transforms) };
    }

    case 'text-pattern': {
      let regex: RegExp;
      try {
        regex = new RegExp(rule.pattern);
      } catch (err) {
        return { ok: false, reason: `Pattern did not compile: ${err instanceof Error ? err.message : String(err)}` };
      }
      const match = regex.exec(ctx.observation.text);
      if (!match) return { ok: false, reason: `Pattern /${rule.pattern}/ found nothing on screen.` };

      const captured = match[rule.group];
      if (captured === undefined) {
        return { ok: false, reason: `Pattern /${rule.pattern}/ matched but has no group ${rule.group}.` };
      }
      return { ok: true, value: applyTransforms(captured, rule.transforms) };
    }

    case 'location-param': {
      for (const template of ctx.pathTemplates) {
        const values = matchPath(template, ctx.path);
        if (values && values[rule.param] !== undefined) {
          return { ok: true, value: applyTransforms(values[rule.param]!, rule.transforms) };
        }
      }
      return {
        ok: false,
        reason: `No known path template matches "${ctx.path}" with a "${rule.param}" segment.`,
      };
    }
  }
}

export interface ExtractAllResult {
  outputs: Outputs;
  /** Required outputs that could not be produced. Empty means success. */
  missing: Array<{ name: string; reason: string }>;
}

export function extractOutputs(specs: OutputSpec[], ctx: ExtractionContext): ExtractAllResult {
  const outputs: Outputs = {};
  const missing: ExtractAllResult['missing'] = [];

  for (const spec of specs) {
    const result = extractValue(spec.extract, ctx);

    if (!result.ok) {
      // An optional output that is absent is information, not a problem: the
      // member simply has no certificate account.
      if (spec.required) missing.push({ name: spec.name, reason: result.reason });
      continue;
    }

    const value: OutputValue = {
      name: spec.name,
      type: spec.type,
      value: result.value,
      sensitivity: spec.sensitivity,
    };
    outputs[spec.name] = value;
  }

  return { outputs, missing };
}

const TRANSFORMS: Record<Transform, (s: string) => string> = {
  trim: (s) => s.trim(),
  'collapse-whitespace': (s) => s.replace(/\s+/g, ' ').trim(),
  // Strips currency symbols, thousands separators and surrounding whitespace,
  // and normalises a trailing-minus or parenthesised negative into a leading
  // minus. Legacy screens render negatives all three ways.
  'strip-currency': (s) => {
    const negative = /^\(.*\)$/.test(s.trim()) || /-\s*$/.test(s.trim());
    const digits = s.replace(/[^\d.]/g, '');
    return negative && digits ? `-${digits}` : digits;
  },
  'digits-only': (s) => s.replace(/\D/g, ''),
  uppercase: (s) => s.toUpperCase(),
  lowercase: (s) => s.toLowerCase(),
};

function applyTransforms(value: string, transforms: Transform[]): string {
  return transforms.reduce((acc, name) => TRANSFORMS[name](acc), value);
}
