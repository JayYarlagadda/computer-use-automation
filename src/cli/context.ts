/**
 * Everything a command needs to know about the world before it starts.
 *
 * Which institution, at which origin, with which guardrails, writing evidence
 * where, holding which credentials. Resolved in one place because `discover`
 * and `replay` must agree about all of it -- a capability recorded against one
 * allowlist and replayed against another would be a difference nobody sees
 * until a refusal in the middle of a run.
 *
 * The one thing worth calling out is that credentials are resolved *by name*
 * and the values never leave this module's return value. A secret reaches the
 * compiler so that typed text can be recognised and replaced by a reference,
 * and it reaches replay so the reference can be resolved again. Neither is
 * given a way to print one, and nothing here ever puts one in an argument the
 * shell would record in history.
 */

import { existsSync } from 'node:fs';
import { config as loadDotenv } from 'dotenv';
import { policyFor, type PolicyEngine } from '../policy/engine.js';
import type { ExecutionMode } from '../policy/types.js';
import { BrowserSurface } from '../surface/browserSurface.js';
import { createFileSink } from '../evidence/fileSink.js';
import type { EvidenceSink } from '../evidence/types.js';
import { TENANTS, tenantFor, type TenantConfig } from '../../targets/meridian/tenants.js';
import type { Args } from './args.js';
import { UsageError } from './args.js';
import { describeError, fatal, note } from './ui.js';

/**
 * Credential names the mock target needs, resolved from the environment when
 * they are set. Named here rather than discovered, because "which environment
 * variables are credentials" is a deployment fact and guessing at it is how a
 * harmless variable ends up being treated as a password.
 */
const DEFAULT_SECRET_NAMES = ['MERIDIAN_OPERATOR_ID', 'MERIDIAN_OPERATOR_PASSWORD'];

export interface TargetContext {
  tenantId: string;
  tenant: TenantConfig;
  baseUrl: string;
  policy: PolicyEngine;
  headless: boolean;
  /** Secret name -> value. Never logged, never written to an artifact. */
  secrets: Record<string, string>;
  evidenceRoot: string;
}

export function loadEnvironment(): void {
  if (existsSync('.env')) loadDotenv({ quiet: true });
}

/** Flags every target-facing command accepts. Kept in one list so help agrees. */
export const TARGET_FLAGS = ['tenant', 'base-url', 'headless', 'evidence-root', 'secret', 'fault'];

export function resolveTarget(args: Args): TargetContext {
  const tenantId = args.str('tenant', 'a').toLowerCase();
  if (!(tenantId in TENANTS)) {
    throw new UsageError(
      `Unknown tenant "${tenantId}". This target is configured for: ${Object.keys(TENANTS).join(', ')}.`,
    );
  }
  const tenant = tenantFor(tenantId);

  const baseUrl = (args.str('base-url') ?? defaultBaseUrl(tenantId)).replace(/\/$/, '');

  // Headed by default. The escalation story is a person taking the keyboard,
  // and they cannot do that to a browser they cannot see -- so the default is
  // the one that makes the demo honest, and `--headless` is the opt-out.
  const headless = args.bool('headless', process.env.HEADLESS === 'true');

  return {
    tenantId,
    tenant,
    baseUrl,
    policy: policyFor(baseUrl),
    headless,
    secrets: resolveSecrets(args),
    evidenceRoot: args.str('evidence-root', 'evidence'),
  };
}

function defaultBaseUrl(tenantId: string): string {
  const port =
    tenantId === 'b'
      ? (process.env.MERIDIAN_TENANT_B_PORT ?? '4174')
      : (process.env.MERIDIAN_PORT ?? '4173');
  return `http://127.0.0.1:${port}`;
}

/**
 * Names on the command line, values from the environment.
 *
 * `--secret MERIDIAN_OPERATOR_PASSWORD` rather than `--secret NAME=value`, so
 * a credential cannot end up in shell history, in a process listing, or in the
 * transcript of a demo.
 */
function resolveSecrets(args: Args): Record<string, string> {
  const names = args.list('secret');
  const wanted = names.length ? names : DEFAULT_SECRET_NAMES;
  const secrets: Record<string, string> = {};

  for (const name of wanted) {
    const value = process.env[name]?.trim();
    if (value) {
      secrets[name] = value;
    } else if (names.length) {
      // Only complain about names the caller asked for by hand. The defaults
      // are a convenience and a target that needs no sign-on is legitimate.
      throw new UsageError(`--secret ${name} was requested but ${name} is not set in the environment or .env.`);
    }
  }

  return secrets;
}

export function secretResolver(ctx: TargetContext): (ref: string) => string | undefined {
  return (ref) => ctx.secrets[ref] ?? process.env[ref]?.trim();
}

// ---------------------------------------------------------------------------
// The target application
// ---------------------------------------------------------------------------

/**
 * Fails early and legibly when the target is not running.
 *
 * Without this the first symptom is a Playwright navigation timeout thirty
 * seconds in, which reads like a bug in the surface layer rather than a
 * forgotten terminal.
 */
export async function requireTargetRunning(ctx: TargetContext): Promise<void> {
  try {
    const response = await fetch(`${ctx.baseUrl}/_admin/health`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  } catch (error) {
    fatal(
      `The target application is not answering at ${ctx.baseUrl} (${describeError(error)}).`,
      ctx.tenantId === 'b'
        ? 'Start it with:  npm run target:b'
        : 'Start it with:  npm run target',
    );
  }
}

/**
 * Arms a fault on the mock target, so each runtime condition the result
 * contract distinguishes can be produced on demand rather than waited for.
 *
 * `--fault session_expired` or `--fault session_expired:1:/member/`.
 */
export async function armFaults(ctx: TargetContext, specs: string[]): Promise<void> {
  for (const spec of specs) {
    const [kind, count, onPath] = spec.split(':');
    if (!kind) throw new UsageError(`--fault expects kind[:count][:path], got "${spec}".`);

    const response = await fetch(`${ctx.baseUrl}/_admin/faults`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        kind,
        count: count ? Number(count) : 1,
        ...(onPath ? { onPath } : {}),
      }),
    });

    if (!response.ok) {
      fatal(`The target refused to arm fault "${kind}" (HTTP ${response.status}).`);
    }
    note(`armed fault ${kind}${onPath ? ` on ${onPath}` : ''}`);
  }
}

// ---------------------------------------------------------------------------
// Surface and evidence
// ---------------------------------------------------------------------------

export async function openSurface(ctx: TargetContext, mode: ExecutionMode): Promise<BrowserSurface> {
  try {
    return await BrowserSurface.launch({
      headless: ctx.headless,
      policy: ctx.policy,
      mode,
      baseUrl: ctx.baseUrl,
    });
  } catch (error) {
    fatal(
      `Could not launch Chromium: ${describeError(error)}`,
      'Install the browser with:  npx playwright install chromium\n' +
        'Headless runs also need the chromium_headless_shell bundle.',
    );
  }
}

export function openEvidence(
  ctx: TargetContext,
  kind: 'discovery' | 'replay',
  runId: string,
  label: string,
): EvidenceSink {
  return createFileSink({
    root: ctx.evidenceRoot,
    runId,
    kind,
    label,
    // The last pass before bytes hit disk. Redundant with the perception
    // boundary by design; see the comment in evidence/fileSink.ts.
    redact: (text) => ctx.policy.redact(text),
  });
}
