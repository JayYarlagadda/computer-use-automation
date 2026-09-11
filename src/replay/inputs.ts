/**
 * Validating what the caller passed, before anything is driven.
 *
 * A bad input should fail as a bad input. If `memberId: "12"` is allowed
 * through, the run opens a browser, signs on, types "12", and comes back with
 * MEMBER_ID_INVALID -- which is a *business outcome*, meaning the caller is now
 * told the application rejected the number when really we never should have
 * asked. That is a slow, expensive, and actively misleading way to report a
 * typo, so the declared ParamSpecs are enforced here first.
 *
 * Every problem is collected rather than thrown on the first one, because a
 * caller fixing a call wants the whole list.
 */

import type { ParamSpec } from '../artifact/schema.js';

export interface InputProblem {
  param: string;
  message: string;
}

export type BoundInputs = Record<string, string>;

export type BindInputsResult =
  | { ok: true; values: BoundInputs }
  | { ok: false; problems: InputProblem[] };

export function bindInputs(specs: ParamSpec[], supplied: Record<string, unknown>): BindInputsResult {
  const problems: InputProblem[] = [];
  const values: BoundInputs = {};

  const declared = new Set(specs.map((s) => s.name));
  for (const name of Object.keys(supplied)) {
    if (!declared.has(name)) {
      // Not merely unhelpful: an undeclared argument is usually a misspelled
      // declared one, and silently ignoring it means the required parameter is
      // reported missing while the value the caller meant sits right there.
      problems.push({ param: name, message: `Not a declared input of this capability.` });
    }
  }

  for (const spec of specs) {
    const raw = supplied[spec.name];

    if (raw === undefined || raw === null || raw === '') {
      if (spec.required) problems.push({ param: spec.name, message: 'Required, but not supplied.' });
      continue;
    }

    const value = String(raw);
    const problem = checkValue(spec, value);
    if (problem) {
      problems.push({ param: spec.name, message: problem });
      continue;
    }

    values[spec.name] = value;
  }

  return problems.length ? { ok: false, problems } : { ok: true, values };
}

function checkValue(spec: ParamSpec, value: string): string | undefined {
  switch (spec.type) {
    case 'integer':
      if (!/^-?\d+$/.test(value)) return `Expected an integer, got "${redactForMessage(spec, value)}".`;
      break;
    case 'number':
      if (!Number.isFinite(Number(value))) return `Expected a number, got "${redactForMessage(spec, value)}".`;
      break;
    case 'currency':
      // A decimal string, not a float. Two places or fewer; no thousands
      // separators, because "1,234.56" is ambiguous across locales and this is
      // not the layer to guess in.
      if (!/^-?\d+(\.\d{1,2})?$/.test(value)) {
        return `Expected a decimal amount like "1234.56", got "${redactForMessage(spec, value)}".`;
      }
      break;
    case 'boolean':
      if (!['true', 'false'].includes(value)) return `Expected "true" or "false", got "${value}".`;
      break;
    case 'date':
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return `Expected an ISO date (YYYY-MM-DD), got "${value}".`;
      break;
    case 'enum':
      if (!spec.options?.includes(value)) {
        return `Expected one of ${spec.options?.map((o) => `"${o}"`).join(', ')}, got "${value}".`;
      }
      break;
    case 'string':
      break;
  }

  if (spec.pattern && !new RegExp(spec.pattern).test(value)) {
    return `Does not match the required format ${spec.pattern}.`;
  }
  if (spec.minLength !== undefined && value.length < spec.minLength) {
    return `Must be at least ${spec.minLength} characters.`;
  }
  if (spec.maxLength !== undefined && value.length > spec.maxLength) {
    return `Must be at most ${spec.maxLength} characters.`;
  }

  return undefined;
}

/**
 * Error messages are evidence too.
 *
 * "Expected an integer, got 412-88-0173" would put regulated data into a log
 * line by way of a validation failure -- a leak through the error path, which
 * is the path least likely to be reviewed.
 */
function redactForMessage(spec: ParamSpec, value: string): string {
  if (spec.sensitivity === 'restricted' || spec.sensitivity === 'secret') return '[REDACTED]';
  return value.length > 40 ? `${value.slice(0, 40)}...` : value;
}
