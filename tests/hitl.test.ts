/**
 * Handing the session to a person, and taking it back.
 *
 * The brief asks for escalation to a human who works in "the same live session
 * -- not a fresh one", and asks the design to have an answer for who is in
 * control. Both claims are easy to write in a README, so each one has a test
 * here that would fail if the mechanism were removed:
 *
 *   the automation cannot act while a person holds the session
 *   the person works on the very page the run stopped on
 *   the run resumes where it stopped rather than restarting
 *   the run does not take the person's word that they did the work
 *
 * The integration block drives a real browser against the real target, with no
 * model anywhere in it. The operator in those tests acts through Playwright on
 * the live page, which is what a human with the headed browser in front of
 * them is: their clicks do not pass through `Surface.act()` because the policy
 * choke point exists to constrain the agent, not the person whose authority
 * the escalation was raised to borrow.
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { Page } from 'playwright';
import { launchHarness, type Harness } from './helpers/harness.js';
import { readSavingsBalance } from './fixtures/readSavingsBalance.js';
import { replay, type ReplayOptions } from '../src/replay/index.js';
import { SessionBroker, controlledSurface, ControlError, NOT_IN_CONTROL } from '../src/hitl/index.js';
import type { Intervention } from '../src/hitl/index.js';
import type { Action, ActResult, Observation, Surface } from '../src/surface/types.js';
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

// ---------------------------------------------------------------------------
// The control state machine, on a surface that does nothing
// ---------------------------------------------------------------------------

/** Records what it was asked to do, so a test can assert on what got through. */
function stubSurface(): Surface & { performed: Action[] } {
  const performed: Action[] = [];

  const observation: Observation = {
    observedAt: new Date().toISOString(),
    location: 'https://meridian.test/app',
    title: 'Member Detail',
    text: 'Member Detail',
    nodes: [],
  };

  return {
    kind: 'browser',
    performed,
    async observe(): Promise<Observation> {
      return observation;
    },
    async act(action: Action): Promise<ActResult> {
      performed.push(action);
      return { ok: true };
    },
    async close(): Promise<void> {},
  };
}

function notice(overrides: Partial<Parameters<SessionBroker['raise']>[0]> = {}) {
  return {
    runId: 'run-1',
    capabilityId: 'meridian.member.read-savings-balance',
    reason: 'APPROVAL_REQUIRED' as const,
    message: 'Posting an adjustment moves money and needs a person.',
    stepId: 'post-adjustment',
    ...overrides,
  };
}

describe('who is in control', () => {
  it('lets the automation act while it holds the session', async () => {
    const surface = stubSurface();
    const broker = new SessionBroker({ surface });
    const automation = controlledSurface(surface, broker, broker.automationToken);

    const result = await automation.act({ type: 'click', nodeId: 'n1' });

    expect(result.ok).toBe(true);
    expect(broker.controlState).toBe('automation');
    expect(surface.performed).toHaveLength(1);
  });

  it('locks the automation out the moment it escalates, before anyone arrives', async () => {
    const surface = stubSurface();
    const broker = new SessionBroker({ surface });
    const automation = controlledSurface(surface, broker, broker.automationToken);

    await broker.raise(notice());

    // Not "once the operator attaches". The gap between deciding a human is
    // needed and a human being present is exactly when a stray retry would
    // act on a screen the system has admitted it does not understand.
    expect(broker.controlState).toBe('awaiting-operator');

    const result = await automation.act({ type: 'click', nodeId: 'n1' });

    expect(result.ok).toBe(false);
    expect(result.refusal?.code).toBe(NOT_IN_CONTROL);
    // The refusal is a typed value on the way out, not an exception, so the
    // caller carries on the same way it does after a policy denial.
    expect(result.refusal?.kind).toBe('denied');
    expect(surface.performed).toHaveLength(0);
  });

  it('refuses the automation while an operator is working, and restores it after', async () => {
    const surface = stubSurface();
    const broker = new SessionBroker({ surface });
    const automation = controlledSurface(surface, broker, broker.automationToken);

    const intervention = await broker.raise(notice());
    const operatorToken = await broker.attach(intervention.id, 'casey.n');
    const operator = controlledSurface(surface, broker, operatorToken);

    expect(broker.controlState).toBe('human');
    expect((await automation.act({ type: 'click', nodeId: 'n1' })).refusal?.code).toBe(NOT_IN_CONTROL);
    expect((await operator.act({ type: 'click', nodeId: 'n1' })).ok).toBe(true);

    await broker.resolve(intervention.id, 'completed', { note: 'Posted it by hand.' });

    expect(broker.controlState).toBe('automation');
    expect((await automation.act({ type: 'click', nodeId: 'n2' })).ok).toBe(true);
    // Their token is real but inert: handing back means handing back.
    expect((await operator.act({ type: 'click', nodeId: 'n2' })).refusal?.code).toBe(NOT_IN_CONTROL);
  });

  it('never gates observation, so the handover can be watched and verified', async () => {
    const surface = stubSurface();
    const broker = new SessionBroker({ surface });
    const automation = controlledSurface(surface, broker, broker.automationToken);

    const intervention = await broker.raise(notice());
    await broker.attach(intervention.id, 'casey.n');

    // Looking changes nothing, and this is precisely when looking matters:
    // evidence during the handover, and the re-check after it.
    await expect(automation.observe()).resolves.toMatchObject({ title: 'Member Detail' });
  });

  it('refuses a token minted for another session', async () => {
    const surface = stubSurface();
    const mine = new SessionBroker({ surface });
    const theirs = new SessionBroker({ surface });

    const smuggled = controlledSurface(surface, mine, theirs.automationToken);
    const result = await smuggled.act({ type: 'click', nodeId: 'n1' });

    expect(result.refusal?.code).toBe(NOT_IN_CONTROL);
    expect(result.error).toMatch(/different session/i);
  });

  it('will not let two people pick up the same intervention', async () => {
    const broker = new SessionBroker({ surface: stubSurface() });
    const intervention = await broker.raise(notice());

    await broker.attach(intervention.id, 'casey.n');

    await expect(broker.attach(intervention.id, 'dana.r')).rejects.toBeInstanceOf(ControlError);
  });

  it('closes the session for good when an operator abandons it', async () => {
    const surface = stubSurface();
    const broker = new SessionBroker({ surface });
    const automation = controlledSurface(surface, broker, broker.automationToken);

    const intervention = await broker.raise(notice());
    await broker.attach(intervention.id, 'casey.n');
    await broker.resolve(intervention.id, 'abandoned');

    expect(broker.controlState).toBe('closed');
    expect((await automation.act({ type: 'click', nodeId: 'n1' })).refusal?.code).toBe(NOT_IN_CONTROL);
  });
});

describe('waiting for a person', () => {
  it('blocks the run until somebody resolves it', async () => {
    const broker = new SessionBroker({ surface: stubSurface() });
    const intervention = await broker.raise(notice());

    const waiting = broker.waitForResolution(intervention.id, { timeoutMs: 5_000 });

    setTimeout(() => {
      void broker
        .attach(intervention.id, 'casey.n')
        .then(() => broker.resolve(intervention.id, 'completed', { note: 'Done.' }));
    }, 20);

    const resolution = await waiting;

    expect(resolution.disposition).toBe('completed');
    expect(resolution.operator).toBe('casey.n');
    expect(resolution.note).toBe('Done.');
  });

  it('expires rather than parking the run forever when nobody comes', async () => {
    const broker = new SessionBroker({ surface: stubSurface() });
    const intervention = await broker.raise(notice());

    const resolution = await broker.waitForResolution(intervention.id, { timeoutMs: 30 });

    // An ordinary disposition, not a thrown timeout: the executor has one path
    // for "a person dealt with this" and does not need a catch block to learn
    // that one did not.
    expect(resolution.disposition).toBe('expired');
    expect(broker.controlState).toBe('automation');
  });

  it('shows an operator console what is waiting and what is being worked', async () => {
    const broker = new SessionBroker({ surface: stubSurface() });
    const intervention = await broker.raise(notice());

    expect(broker.waiting().map((i) => i.state)).toEqual(['waiting']);

    await broker.attach(intervention.id, 'casey.n');
    expect(broker.waiting().map((i) => i.state)).toEqual(['attached']);

    await broker.resolve(intervention.id, 'rejected');
    expect(broker.waiting()).toHaveLength(0);
    expect(broker.all()).toHaveLength(1);
  });

  it('carries enough context for a person to act without reading the code', async () => {
    const broker = new SessionBroker({ surface: stubSurface() });

    const intervention = await broker.raise(notice({ intent: 'Post the balance adjustment' }));

    expect(intervention.message).toMatch(/needs a person/);
    expect(intervention.intent).toBe('Post the balance adjustment');
    expect(intervention.location).toBe('https://meridian.test/app');
    expect(intervention.title).toBe('Member Detail');
    expect(intervention.capabilityId).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// The whole round trip, against the live application
// ---------------------------------------------------------------------------

/** Everything a test's stand-in operator is given when it takes the session. */
interface Handover {
  page: Page;
  baseUrl: string;
  intervention: Intervention;
  broker: SessionBroker;
}

interface Session {
  broker: SessionBroker;
  result: ReplayResult;
  seen: Intervention[];
}

/**
 * Runs the reference capability with a broker in the escalation seam.
 *
 * `operator` is what the human does once they have the session; returning a
 * disposition of `rejected` is how a test declines to fix anything.
 */
async function runWithOperator(
  harness: Harness,
  operator: (handover: Handover) => Promise<'completed' | 'rejected'>,
  overrides: Partial<ReplayOptions> = {},
): Promise<Session> {
  const broker = new SessionBroker({ surface: harness.surface });
  const automation = controlledSurface(harness.surface, broker, broker.automationToken);
  const seen: Intervention[] = [];

  const result = await replay({
    artifact: readSavingsBalance,
    inputs: { memberId: '100245' },
    tenantId: 'a',
    baseUrl: harness.target.url,
    mode: 'attended',
    surface: automation,
    secrets: (ref) => SECRETS[ref],
    timeoutMs: 90_000,
    escalate: async (request) => {
      const intervention = await broker.raise({
        runId: request.runId,
        capabilityId: request.capabilityId,
        reason: request.reason,
        message: request.message,
        ...(request.stepId ? { stepId: request.stepId } : {}),
        ...(request.intent ? { intent: request.intent } : {}),
        ...(request.screenshotPath ? { screenshotPath: request.screenshotPath } : {}),
      });
      seen.push(intervention);

      await broker.attach(intervention.id, 'casey.n');

      const disposition = await operator({
        page: harness.surface.livePage,
        baseUrl: harness.target.url,
        intervention,
        broker,
      });

      const resolution = await broker.resolve(intervention.id, disposition, {
        note: disposition === 'completed' ? 'Signed on again by hand.' : 'Not proceeding.',
      });

      return {
        sessionId: resolution.sessionId,
        interventionId: resolution.interventionId,
        disposition: resolution.disposition,
        ...(resolution.operator ? { operator: resolution.operator } : {}),
        ...(resolution.note ? { note: resolution.note } : {}),
      };
    },
    ...overrides,
  });

  return { broker, result, seen };
}

/** What a person does when they find a signed-out session: sign back on. */
async function signOnByHand(page: Page, baseUrl: string, memberId: string): Promise<void> {
  await page.goto(`${baseUrl}/`, { waitUntil: 'domcontentloaded' });
  await page.fill('input[name="user"]', SECRETS.MERIDIAN_OPERATOR_ID!);
  await page.fill('input[name="pass"]', SECRETS.MERIDIAN_OPERATOR_PASSWORD!);
  await page.click('input[type="submit"]');
  await page.goto(`${baseUrl}/member/${memberId}`, { waitUntil: 'domcontentloaded' });
}

describe('a person rescues a stuck run', () => {
  it('resumes and completes after the operator signs the session back on', async () => {
    h = await launchHarness({ mode: 'attended' });
    // The session dies mid-flow and the declared re-authentication capability
    // is not wired, so there is nothing left but to ask a person.
    h.target.faults.arm('session_expired', 1, { onPath: '/member/' });

    const { result, seen } = await runWithOperator(h, async ({ page, baseUrl }) => {
      await signOnByHand(page, baseUrl, '100245');
      return 'completed';
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]!.reason).toBe('RECOVERY_EXHAUSTED');

    if (result.status !== 'success') {
      throw new Error(`Expected success, got ${result.status}: ${JSON.stringify(result, null, 2)}`);
    }
    // The run finished the job rather than reporting that a human had touched
    // it: the escalation is a pause in the capability, not the end of it.
    expect(result.outputs.savingsBalance?.value).toBe('4182.55');
  });

  it('works in the session the run stopped in rather than a fresh one', async () => {
    h = await launchHarness({ mode: 'attended' });
    h.target.faults.arm('session_expired', 1, { onPath: '/member/' });

    let sawExpiredScreen = false;
    let pageHandedOver: Page | undefined;

    await runWithOperator(h, async ({ page, baseUrl }) => {
      pageHandedOver = page;
      // The operator is looking at the actual dead session, with the target's
      // own expiry message on it. A fresh browser would have shown an ordinary
      // login page and told them nothing about what went wrong. Read per frame
      // because the expiry landed in the content frame of a frameset, which is
      // also why `page.content()` alone would quietly miss it.
      const bodies = await Promise.all(page.frames().map((f) => f.content().catch(() => '')));
      sawExpiredScreen = bodies.some((body) => body.includes('session has expired'));
      await signOnByHand(page, baseUrl, '100245');
      return 'completed';
    });

    expect(sawExpiredScreen).toBe(true);
    expect(pageHandedOver).toBe(h.surface.livePage);
  });

  it('holds the automation out of the session while the operator has it', async () => {
    h = await launchHarness({ mode: 'attended' });
    h.target.faults.arm('session_expired', 1, { onPath: '/member/' });

    let stateDuring: string | undefined;
    let automationRefused: string | undefined;

    const { result } = await runWithOperator(h, async ({ page, baseUrl, broker }) => {
      stateDuring = broker.controlState;

      // The executor's own token, used at the one instant it must not work.
      const automation = controlledSurface(h!.surface, broker, broker.automationToken);
      automationRefused = (await automation.act({ type: 'click', nodeId: 'n1' })).refusal?.code;

      await signOnByHand(page, baseUrl, '100245');
      return 'completed';
    });

    expect(stateDuring).toBe('human');
    expect(automationRefused).toBe(NOT_IN_CONTROL);
    // And the lockout is temporary, not a way of breaking the run.
    expect(result.status).toBe('success');
  });

  it('stops the run when the operator decides it must not proceed', async () => {
    h = await launchHarness({ mode: 'attended' });
    h.target.faults.arm('session_expired', 1, { onPath: '/member/' });

    const { result } = await runWithOperator(h, async () => 'rejected');

    expect(result.status).toBe('escalated');
    if (result.status !== 'escalated') return;
    expect(result.escalation.reason).toBe('RECOVERY_EXHAUSTED');
    expect(result.escalation.interventionId).toBeTruthy();
  });

  it('does not take the operator\u2019s word that the work was done', async () => {
    h = await launchHarness({ mode: 'attended' });
    h.target.faults.arm('session_expired', 1, { onPath: '/member/' });

    // Says "completed" and changes nothing. With one escalation allowed, the
    // retried step finds the same dead session and the run gives up instead of
    // reporting a success nobody achieved.
    const { result } = await runWithOperator(h, async () => 'completed', { maxEscalations: 1 });

    expect(result.status).toBe('failed');
    if (result.status !== 'failed') return;
    expect(result.failure.code).toBe('CHECKPOINT_FAILED');
    expect(result.failure.message).toMatch(/operator returned step/i);
  });
});
