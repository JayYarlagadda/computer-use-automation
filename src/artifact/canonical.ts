/**
 * Path canonicalisation and artifact digests.
 *
 * Canonicalisation is what turns one recorded run into a reusable capability.
 * Discovery observes `/member/100245`; the artifact must say `/member/{memberId}`
 * or it is a recording of one lookup rather than a lookup capability. It is
 * also the mechanism behind location checkpoints ("did we land on a member
 * detail page?" is a question about the template, not the instance) and behind
 * pulling values back out of a URL without parsing the screen.
 *
 * The digest exists so an artifact's identity is content-addressable: evidence
 * can name the exact capability it was produced by, and a reviewer can tell
 * whether the file they are approving is the one that was tested.
 */

import { createHash } from 'node:crypto';
import type { CapabilityArtifact } from './schema.js';

/** Escapes a literal for embedding in a regular expression. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Turns a concrete path into a template by replacing known values.
 *
 * Values are matched whole-segment only. Substring replacement would rewrite
 * `/branch/100245-north` into `/branch/{memberId}-north`, which happens to
 * look plausible and is wrong -- and wrong in a way that survives review
 * because the template still reads sensibly.
 */
export function canonicalisePath(path: string, values: Record<string, string>): string {
  const entries = Object.entries(values).filter(([, v]) => v !== '' && v !== undefined);

  return path
    .split('/')
    .map((segment) => {
      const hit = entries.find(([, value]) => segment === value);
      return hit ? `{${hit[0]}}` : segment;
    })
    .join('/');
}

/** `/member/{memberId}` + `{memberId: '100245'}` -> `/member/100245`. */
export function expandPath(template: string, values: Record<string, string>): string {
  return template.replace(/\{([^}]+)\}/g, (_, name: string) => {
    const value = values[name];
    if (value === undefined) {
      throw new Error(`Cannot expand "${template}": no value supplied for "${name}".`);
    }
    return encodeURIComponent(value);
  });
}

/**
 * Matches a concrete path against a template, returning the captured values.
 *
 * Returns undefined rather than throwing, because "this is not a member detail
 * page" is an ordinary answer during replay -- it is how a location checkpoint
 * fails and how a business outcome gets detected.
 */
export function matchPath(template: string, path: string): Record<string, string> | undefined {
  const names: string[] = [];
  const source = template
    .split('/')
    .map((segment) => {
      const placeholder = segment.match(/^\{([^}]+)\}$/);
      if (placeholder) {
        names.push(placeholder[1]!);
        return '([^/]+)';
      }
      return escapeRegex(segment);
    })
    .join('/');

  const match = new RegExp(`^${source}/?$`).exec(path);
  if (!match) return undefined;

  const values: Record<string, string> = {};
  names.forEach((name, i) => {
    values[name] = decodeURIComponent(match[i + 1]!);
  });
  return values;
}

/**
 * Deterministic JSON: object keys sorted at every depth, arrays left in order.
 *
 * Array order is meaningful throughout the schema -- steps are a sequence and
 * locator strategies are a ranking -- so sorting them would destroy the
 * document while making the digest stable, which is the worst combination.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, sortKeys(v)]),
    );
  }
  return value;
}

/**
 * Content hash of everything that defines behaviour.
 *
 * `approval` is excluded deliberately. Stability counters tick on every replay,
 * so including them would change the digest of a capability that nobody edited
 * -- and a digest that changes without an edit is a digest nobody trusts. What
 * the digest answers is "is this the same capability?", not "has it been run
 * since?".
 */
export function digest(artifact: CapabilityArtifact): string {
  const { approval: _approval, ...behaviour } = artifact;
  return createHash('sha256').update(canonicalJson(behaviour)).digest('hex').slice(0, 16);
}
