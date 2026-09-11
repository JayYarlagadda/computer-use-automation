/**
 * Deterministic replay, end to end against the live target.
 *
 * No model is involved in any of this, which is the point: the reference
 * artifact is a complete capability, so the entire production execution path
 * is exercisable with no API key. Every assertion here is about the *result
 * contract* rather than about the browser -- what a calling agent receives.
 *
 * The three categories the brief asks replay to distinguish each get their own
 * block, and they are genuinely distinguished rather than all arriving as
 * errors with different strings:
 *
 *   business outcomes   MEMBER_NOT_FOUND, PERMISSION_DENIED
 *   recoverable         a surprise interstitial, transient slowness
 *   hard failures       an app error screen, an ambiguous target, bad input
 */

import { afterEach, describe, expect, it } from 'vitest';
import { launchHarness, type Harness } from './helpers/harness.js';
import { readSavingsBalance } from './fixtures/readSavingsBalance.js';
import { replay, type ReplayOptions } from '../src/replay/index.js';
import { parseArtifactOrThrow } from '../src/artifact/index.js';
import type { ReplayResult } from '../src/artifact/result.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const SECRETS: Record<string, string> = {
  MERIDIAN_OPERATOR_ID: 'operator',
  MERIDIAN_OPERATOR_PASSWORD: 'demo1234',
};

/** An artifact identical to the reference one but cleared for unattended use. */
function approved() {
  const a = structuredClone(readSavingsBalance) as any;
  a.approval = { state: 'approved', approvedBy: 'test', approvedAt: '2026-09-10T00:00:00.000Z' };
  return a;
}

async function run(
  harness: Harness,
  overrides: Partial<ReplayOptions> & { memberId?: string } = {},
): Promise<ReplayResult> {
  const { memberId, ...rest } = overrides;

  return replay({
    artifact: readSavingsBalance,
    inputs: { memberId: memberId ?? '100245' },
    tenantId: 'a',
    baseUrl: harness.target.url,
    mode: 'attended',
    surface: harness.surface,
    secrets: (ref) => SECRETS[ref],
    timeoutMs: 60_000,
    ...rest,
  });
}

describe('the happy path', () => {
  it('completes the flow and returns the declared outputs', async () => {
    h = await launchHarness({ mode: 'attended' });
    const result = await run(h);

    if (result.status !== 'success') {
      throw new Error(`Expected success, got ${result.status}: ${JSON.stringify(result, null, 2)}`);
    }

    expect(result.outputs.memberName?.value).toBe('Dana Whitfield');
    expect(result.outputs.savingsBalance?.value).toBe('4182.55');
    expect(result.outputs.savingsAccountNumber?.value).toBe('SV-0044182');
  });

  it('returns currency as a decimal string, not a float', async () => {
    h = await launchHarness({ mode: 'attended' });
    const result = await run(h);

    expect(result.status).toBe('success');
    if (result.status !== 'success') return;
    expect(result.outputs.savingsBalance).toMatchObject({ type: 'currency', value: '4182.55' });
    expect(typeof result.outputs.savingsBalance!.value).toBe('string');
  });

  it('carries the declared sensitivity out with each value', async () => {
    h = await launchHarness({ mode: 'attended' });
    const result = await run(h);

    if (result.status !== 'success') return;
    // The caller is told which of the values it now holds are regulated.
    expect(result.outputs.memberName!.sensitivity).toBe('restricted');
    expect(result.outputs.savingsBalance!.sensitivity).toBe('internal');
  });

  it('reports which rung of the locator ladder resolved each step', async () => {
    h = await launchHarness({ mode: 'attended' });
    const result = await run(h);

    const resolved = result.steps.filter((s) => s.resolution);
    expect(resolved.length).toBeGreaterThan(0);
    // Every step should resolve at its strongest available strategy on the
    // screen it was recorded against. Anything else is drift on day one.
    expect(result.degradation.degradedSteps).toBe(0);
    expect(result.degradation.weakestRank).toBe(0);
  });

  it('skips the optional notice step on a tenant that does not show one', async () => {
    h = await launchHarness({ mode: 'attended' });
    const result = await run(h);

    const notice = result.steps.find((s) => s.stepId === 'dismiss-notice');
    expect(notice?.status).toBe('skipped');
  });

  it('is deterministic: two runs produce the same outputs and the same digest', async () => {
    h = await launchHarness({ mode: 'attended' });
    const first = await run(h);
    const second = await run(h);

    expect(first.artifactDigest).toBe(second.artifactDigest);
    if (first.status !== 'success' || second.status !== 'success') return;
    expect(first.outputs.savingsBalance!.value).toBe(second.outputs.savingsBalance!.value);
    expect(first.steps.map((s) => s.status)).toEqual(second.steps.map((s) => s.status));
  });
});

describe('business outcomes are answers, not errors', () => {
  it('reports a member that does not exist as MEMBER_NOT_FOUND', async () => {
    h = await launchHarness({ mode: 'attended' });
    const result = await run(h, { memberId: '999999' });

    expect(result.status).toBe('business-outcome');
    if (result.status !== 'business-outcome') return;
    expect(result.outcome.code).toBe('MEMBER_NOT_FOUND');
  });

  it('reports an entitlement failure as PERMISSION_DENIED rather than a crash', async () => {
    h = await launchHarness({ mode: 'attended' });
    const result = await run(h, { memberId: '100247' });

    expect(result.status).toBe('business-outcome');
    if (result.status !== 'business-outcome') return;
    expect(result.outcome.code).toBe('PERMISSION_DENIED');
  });

  it('still reports the steps it took, so an outcome is as debuggable as a failure', async () => {
    h = await launchHarness({ mode: 'attended' });
    const result = await run(h, { memberId: '999999' });

    expect(result.steps.length).toBeGreaterThan(0);
    expect(result.steps.every((s) => s.status !== 'failed')).toBe(true);
  });
});

describe('recoverable conditions', () => {
  it('dismisses a surprise interstitial and carries on', async () => {
    h = await launchHarness({ mode: 'attended' });
    // Scoped to the member screen so it lands mid-flow. Unscoped, it would hit
    // the first authenticated request and be absorbed by the optional
    // dismiss-notice step, which tests tenant configuration rather than
    // recovery from a surprise.
    h.target.faults.arm('interstitial', 1, { onPath: '/member/' });

    const result = await run(h);

    expect(result.status).toBe('success');
    const recovered = result.steps.filter((s) => s.status === 'recovered');
    expect(recovered.length).toBeGreaterThan(0);
    expect(recovered[0]!.recoveries.some((r) => r.ruleId === 'dismiss-unexpected-interstitial' && r.succeeded)).toBe(
      true,
    );
  });

  it('absorbs transient slowness by waiting rather than by sleeping a fixed amount', async () => {
    h = await launchHarness({ mode: 'attended' });
    h.target.faults.arm('slow', 1, { delayMs: 2500, onPath: '/member/' });

    const result = await run(h);

    expect(result.status).toBe('success');
  });
});

describe('hard failures stop and explain themselves', () => {
  it('reports an application error screen as APP_ERROR with evidence', async () => {
    h = await launchHarness({ mode: 'attended' });
    // Armed to fire more than once so the declared retry also lands on the
    // error screen. A fault that heals on retry would be testing recovery.
    h.target.faults.arm('app_error', 5, { onPath: '/member/' });

    const result = await run(h);

    expect(result.status).toBe('failed');
    if (result.status !== 'failed') return;
    expect(result.failure.code).toBe('APP_ERROR');
    expect(result.failure.stepId).toBeDefined();
    // "what step, what was expected, what was observed"
    expect(result.failure.expected).toBeTruthy();
    expect(result.failure.observed).toContain('Unexpected System Error');
  });

  it('escalates when recovery needs a capability the runtime cannot invoke', async () => {
    h = await launchHarness({ mode: 'attended' });
    h.target.faults.arm('session_expired', 1, { onPath: '/member/' });

    // No runCapability wired, so the declared re-authentication cannot run.
    const result = await run(h);

    expect(result.status).toBe('escalated');
    if (result.status !== 'escalated') return;
    expect(result.escalation.reason).toBe('RECOVERY_EXHAUSTED');
    expect(result.escalation.interventionId).toBeTruthy();
    expect(result.escalation.sessionId).toBeTruthy();
  });

  it('recovers instead of escalating when re-authentication is available', async () => {
    h = await launchHarness({ mode: 'attended' });
    h.target.faults.arm('session_expired', 1, { onPath: '/member/' });

    const result = await run(h, {
      // The seam: sign-on is its own capability, so re-authenticating is
      // composition rather than a branch hardcoded in the replay engine.
      runCapability: async (id) => {
        if (id !== 'meridian.auth.sign-on') return false;
        const inner = await replay({
          artifact: signOnOnly(),
          inputs: {},
          tenantId: 'a',
          baseUrl: h!.target.url,
          mode: 'attended',
          surface: h!.surface,
          secrets: (ref) => SECRETS[ref],
        });
        return inner.status === 'success';
      },
    });

    if (result.status !== 'success') {
      throw new Error(`Expected recovery to succeed, got ${result.status}: ${JSON.stringify(result, null, 2)}`);
    }
    // Recovery resumed from the declared restart point, so the member number
    // was retyped into the fresh session rather than the search running empty.
    expect(result.outputs.savingsBalance?.value).toBe('4182.55');
  });
});

describe('pre-flight refuses before touching the application', () => {
  it('rejects an input that does not satisfy its declared spec', async () => {
    h = await launchHarness({ mode: 'attended' });
    const result = await run(h, { memberId: '12' });

    expect(result.status).toBe('failed');
    if (result.status !== 'failed') return;
    // Not MEMBER_ID_INVALID: the application never saw it, so reporting the
    // application's validation would be telling the caller something untrue.
    expect(result.failure.code).toBe('INPUT_INVALID');
    expect(result.steps).toHaveLength(0);
  });

  it('refuses unattended replay of a capability that is still a draft', async () => {
    h = await launchHarness({ mode: 'unattended' });
    const result = await run(h, { mode: 'unattended' });

    expect(result.status).toBe('failed');
    if (result.status !== 'failed') return;
    expect(result.failure.code).toBe('NOT_APPROVED');
    expect(result.steps).toHaveLength(0);
  });

  it('allows unattended replay once the capability is approved', async () => {
    h = await launchHarness({ mode: 'unattended' });
    const result = await run(h, { mode: 'unattended', artifact: approved() });

    expect(result.status).toBe('success');
  });

  it('refuses when a declared secret is not available in this environment', async () => {
    h = await launchHarness({ mode: 'attended' });
    const result = await run(h, { secrets: () => undefined });

    expect(result.status).toBe('failed');
    if (result.status !== 'failed') return;
    expect(result.failure.code).toBe('INPUT_INVALID');
    expect(result.failure.message).toMatch(/MERIDIAN_OPERATOR_ID/);
    expect(result.steps).toHaveLength(0);
  });

  it('rejects a malformed artifact without opening anything', async () => {
    h = await launchHarness({ mode: 'attended' });
    const result = await run(h, { artifact: { schemaVersion: '1.0.0', capability: {} } });

    expect(result.status).toBe('failed');
    if (result.status !== 'failed') return;
    expect(result.failure.code).toBe('ARTIFACT_INVALID');
  });
});

describe('cross-tenant reuse', () => {
  it('replays the same artifact against a second institution via its overlay', async () => {
    // Tenant B is the same vendor product on a later version, with its own
    // wording and a notice screen after sign-on. Nothing is re-recorded.
    h = await launchHarness({ tenant: 'b', mode: 'attended' });

    const result = await run(h, { tenantId: 'b', productVersion: '7.4.03' });

    if (result.status !== 'success') {
      throw new Error(`Expected success on tenant b, got ${result.status}: ${JSON.stringify(result, null, 2)}`);
    }
    expect(result.outputs.savingsBalance?.value).toBe('4182.55');
    expect(result.tenantId).toBe('b');
  });

  it('runs the optional notice step on the tenant that shows one', async () => {
    h = await launchHarness({ tenant: 'b', mode: 'attended' });
    const result = await run(h, { tenantId: 'b' });

    const notice = result.steps.find((s) => s.stepId === 'dismiss-notice');
    expect(notice?.status).toBe('ok');
  });

  it('reports product version drift alongside the result', async () => {
    h = await launchHarness({ tenant: 'b', mode: 'attended' });
    const result = await run(h, { tenantId: 'b', productVersion: '7.4.03' });

    expect(result.degradation.productVersionDrift).toEqual({
      recordedAgainst: '7.2.11',
      ranAgainst: '7.4.03',
    });
  });
});

describe('the result contract', () => {
  it('identifies exactly which artifact ran', async () => {
    h = await launchHarness({ mode: 'attended' });
    const result = await run(h);

    const expected = parseArtifactOrThrow(readSavingsBalance);
    expect(result.capabilityId).toBe(expected.capability.id);
    expect(result.capabilityVersion).toBe(expected.capability.version);
    expect(result.artifactDigest).toHaveLength(16);
  });

  it('never puts a typed secret into the step reports', async () => {
    h = await launchHarness({ mode: 'attended' });
    const result = await run(h);

    expect(JSON.stringify(result)).not.toContain('demo1234');
  });
});

/** The sign-on prefix of the reference flow, as its own capability. */
function signOnOnly() {
  const a = structuredClone(readSavingsBalance) as any;
  a.capability.id = 'meridian.auth.sign-on';
  a.capability.title = 'Sign on to the servicing application';
  a.inputs = [];
  a.outputs = [];
  a.outcomes = [];
  a.recovery = [];
  a.tenantOverlays = [];
  a.steps = a.steps.filter((s: { id: string }) =>
    ['open-signon', 'enter-operator', 'enter-password', 'submit-signon', 'dismiss-notice'].includes(s.id),
  );
  a.successCheckpoint = { kind: 'text-absent', text: 'Operator Sign On', match: 'contains' };
  return a;
}
