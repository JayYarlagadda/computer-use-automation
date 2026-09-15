/**
 * The discovery loop, without a model and (mostly) without a browser.
 *
 * The live compile suite already proves a scripted agent can drive the real
 * target and produce an artifact that replays. These tests pin the other half:
 * the ways the loop *stops*. A model that never converges, that is refused
 * three times, that clicks a dead control forever, that asks to type a
 * password as a value -- none of those are things a live provider will produce
 * on demand, and all of them have to terminate with a distinct code rather
 * than run until a wall-clock timeout hides the cause.
 */

import { describe, expect, it } from 'vitest';
import { discover } from '../src/agent/discover.js';
import { interpret } from '../src/agent/tools.js';
import { systemPrompt } from '../src/agent/prompt.js';
import { createScriptedProvider } from '../src/llm/mock.js';
import { LlmError } from '../src/llm/types.js';
import { policyFor } from '../src/policy/engine.js';
import type { Action, ActResult, Observation, Surface, UiNode } from '../src/surface/types.js';

const ORIGIN = 'http://127.0.0.1:4173';
const POLICY = policyFor(ORIGIN);

function node(partial: Partial<UiNode> & Pick<UiNode, 'nodeId' | 'role'>): UiNode {
  return {
    name: '',
    enabled: true,
    visible: true,
    focused: false,
    framePath: [],
    bbox: { x: 0, y: 0, width: 10, height: 10 },
    anchors: { ordinalInRole: 0 },
    ...partial,
  };
}

function observation(partial: Partial<Observation> = {}): Observation {
  return {
    observedAt: new Date().toISOString(),
    location: `${ORIGIN}/`,
    title: 'Sign On',
    text: 'Sign On',
    nodes: [node({ nodeId: 'n1', role: 'button', name: 'Go' })],
    ...partial,
  };
}

function stubSurface(opts: {
  screens?: Observation[];
  act?: (action: Action) => ActResult | Promise<ActResult>;
} = {}): Surface & { performed: Action[] } {
  const performed: Action[] = [];
  let index = 0;
  const screens = opts.screens ?? [observation()];

  return {
    kind: 'browser',
    performed,
    async observe(): Promise<Observation> {
      return screens[Math.min(index, screens.length - 1)]!;
    },
    async act(action: Action): Promise<ActResult> {
      performed.push(action);
      const result = opts.act ? await opts.act(action) : { ok: true };
      if (result.ok) index += 1;
      return result;
    },
    async close(): Promise<void> {},
  };
}

function call(name: string, args: Record<string, unknown>) {
  return {
    toolCalls: [{ id: `c${Math.random().toString(36).slice(2, 8)}`, name, arguments: args }],
    finishReason: 'tool_calls' as const,
  };
}

async function run(
  script: Parameters<typeof createScriptedProvider>[0],
  extras: Partial<Parameters<typeof discover>[0]> = {},
  surface: Surface = stubSurface(),
) {
  return discover({
    goal: 'Do the thing',
    surface,
    provider: createScriptedProvider(script),
    policy: POLICY,
    maxTurns: 8,
    maxInvalid: 3,
    maxRefusals: 3,
    maxStalledSteps: 3,
    budgetMs: 30_000,
    ...extras,
  });
}

describe('interpret', () => {
  const screen = observation({
    text: 'Sign On',
    nodes: [
      node({ nodeId: 'n1', role: 'textbox', name: '', anchors: { precedingText: 'Operator ID', ordinalInRole: 0 } }),
      node({ nodeId: 'n2', role: 'textbox', name: '', sensitive: true, anchors: { precedingText: 'Password', ordinalInRole: 1 } }),
      node({ nodeId: 'n3', role: 'button', name: 'Sign On' }),
    ],
  });

  it('rejects type_text into a sensitive field, so a password cannot be an argument', () => {
    const decision = interpret(
      { id: 'c1', name: 'type_text', arguments: { nodeId: 'n2', text: 'demo1234', why: 'sign on' } },
      screen,
    );
    expect(decision.kind).toBe('invalid');
    if (decision.kind === 'invalid') expect(decision.message).toMatch(/type_secret/);
  });

  it('accepts type_secret as a name, with an empty action text', () => {
    const decision = interpret(
      {
        id: 'c1',
        name: 'type_secret',
        arguments: { nodeId: 'n2', secretName: 'MERIDIAN_OPERATOR_PASSWORD', why: 'sign on' },
      },
      screen,
    );
    expect(decision).toMatchObject({
      kind: 'act',
      secretRef: 'MERIDIAN_OPERATOR_PASSWORD',
      action: { type: 'type', nodeId: 'n2', text: '', secret: true },
    });
  });

  it('rejects a stale node id rather than letting the surface time out', () => {
    const decision = interpret(
      { id: 'c1', name: 'click', arguments: { nodeId: 'n99', why: 'press a button that is not here' } },
      screen,
    );
    expect(decision.kind).toBe('invalid');
    if (decision.kind === 'invalid') expect(decision.message).toMatch(/n99/);
  });
});

describe('the loop stops for a reason', () => {
  it('records success when the model declares it against text that is on screen', async () => {
    const surface = stubSurface({
      screens: [observation({ title: 'Member Detail', text: 'Share Accounts  Name  Savings' })],
    });
    const result = await run(
      [
        call('finish_success', {
          summary: 'Read the balance',
          successText: 'Share Accounts',
          outputs: [],
        }),
      ],
      {},
      surface,
    );
    expect(result.status).toBe('succeeded');
    expect(result.success?.summary).toBe('Read the balance');
  });

  it('records a business outcome rather than a failure', async () => {
    const surface = stubSurface({
      screens: [observation({ text: 'No member found for number 999999' })],
    });
    const result = await run(
      [
        call('report_outcome', {
          code: 'MEMBER_NOT_FOUND',
          title: 'No such member',
          description: 'The number is well-formed but no record exists.',
          evidenceText: 'No member found for number',
        }),
      ],
      {},
      surface,
    );
    expect(result.status).toBe('business-outcome');
    expect(result.outcome?.code).toBe('MEMBER_NOT_FOUND');
  });

  it('records an escalation when the model asks for a person', async () => {
    const result = await run([call('escalate', { reason: 'The screen is asking for a second factor.' })]);
    expect(result.status).toBe('escalated');
    expect(result.escalation?.reason).toMatch(/second factor/);
  });

  it('records abandonment when the model gives up', async () => {
    const result = await run([call('abandon', { reason: 'This application has no member lookup.' })]);
    expect(result.status).toBe('abandoned');
  });

  it('exhausts the turn budget instead of looping forever', async () => {
    const result = await run([call('click', { nodeId: 'n1', why: 'try' })], { maxTurns: 1 });
    expect(result.status).toBe('failed');
    expect(result.failure?.code).toBe('TURN_BUDGET_EXHAUSTED');
  });

  it('exhausts the time budget', async () => {
    const result = await run([call('click', { nodeId: 'n1', why: 'try' })], { budgetMs: -1, maxTurns: 20 });
    expect(result.status).toBe('failed');
    expect(result.failure?.code).toBe('TIME_BUDGET_EXHAUSTED');
  });

  it('stops when consecutive actions change nothing', async () => {
    const surface = stubSurface({
      screens: [observation()],
      act: () => ({ ok: true }),
    });
    // act() increments the screen index only when ok; a single-screen stub
    // still returns the same observation, so every click is a no-op.
    const result = await run(
      [
        call('click', { nodeId: 'n1', why: 'one' }),
        call('click', { nodeId: 'n1', why: 'two' }),
        call('click', { nodeId: 'n1', why: 'three' }),
      ],
      { maxStalledSteps: 2 },
      surface,
    );
    expect(result.status).toBe('failed');
    expect(result.failure?.code).toBe('NO_PROGRESS');
  });

  it('does not count typing as a stall -- password fields never change the digest', async () => {
    const screen = observation({
      text: 'Sign On',
      nodes: [node({ nodeId: 'n2', role: 'textbox', name: '', sensitive: true })],
    });
    const surface = stubSurface({ screens: [screen, screen, screen] });
    const result = await run(
      [
        call('type_secret', { nodeId: 'n2', secretName: 'MERIDIAN_OPERATOR_PASSWORD', why: 'password' }),
        call('type_secret', { nodeId: 'n2', secretName: 'MERIDIAN_OPERATOR_PASSWORD', why: 'password again' }),
        call('escalate', { reason: 'stuck after signing on' }),
      ],
      { secrets: { MERIDIAN_OPERATOR_PASSWORD: 'demo1234' }, maxStalledSteps: 2 },
      surface,
    );
    expect(result.status).toBe('escalated');
    expect(result.steps).toHaveLength(2);
  });

  it('declares the model incoherent after repeated unusable calls', async () => {
    const result = await run(
      [
        call('click', { nodeId: 'nope', why: 'missing' }),
        call('click', { nodeId: 'nope', why: 'missing' }),
      ],
      { maxInvalid: 2 },
    );
    expect(result.status).toBe('failed');
    expect(result.failure?.code).toBe('MODEL_INCOHERENT');
  });

  it('surfaces a provider error as PROVIDER_ERROR', async () => {
    const result = await run(() => {
      throw new LlmError('rate limited', { retryable: true, status: 429 });
    });
    expect(result.status).toBe('failed');
    expect(result.failure?.code).toBe('PROVIDER_ERROR');
    expect(result.failure?.message).toMatch(/rate limited/);
  });

  it('stops when the caller aborts', async () => {
    const signal = AbortSignal.abort();
    const result = await run([call('click', { nodeId: 'n1', why: 'never' })], { signal });
    expect(result.status).toBe('failed');
    expect(result.failure?.code).toBe('ABORTED');
  });

  it('escalates after repeated policy refusals rather than retrying the same denied act', async () => {
    const surface = stubSurface({
      act: () => ({
        ok: false,
        refusal: {
          kind: 'denied',
          code: 'ROUTE_NOT_ALLOWED',
          reason: 'Administration is not on the allowlist.',
          risk: 'safe',
        },
      }),
    });
    const result = await run(
      [
        call('click', { nodeId: 'n1', why: 'admin' }),
        call('click', { nodeId: 'n1', why: 'admin again' }),
        call('click', { nodeId: 'n1', why: 'admin a third time' }),
      ],
      { maxRefusals: 3 },
      surface,
    );
    expect(result.status).toBe('escalated');
    expect(result.escalation?.reason).toMatch(/refused by the safety layer/);
  });

  it('escalates immediately when the choke point asks for a person', async () => {
    const surface = stubSurface({
      act: () => ({
        ok: false,
        refusal: {
          kind: 'approval-required',
          code: 'IRREVERSIBLE_REQUIRES_APPROVAL',
          reason: 'Posting an adjustment moves money.',
          risk: 'irreversible',
        },
      }),
    });
    const result = await run([call('click', { nodeId: 'n1', why: 'post' })], {}, surface);
    expect(result.status).toBe('escalated');
    expect(result.escalation?.reason).toMatch(/human approval/);
  });
});

describe('credentials stay out of the trace', () => {
  it('substitutes a named secret on the way to the surface, never into the step', async () => {
    const screen = observation({
      text: 'Sign On',
      nodes: [node({ nodeId: 'n2', role: 'textbox', name: '', sensitive: true })],
    });
    const done = observation({ title: 'Search', text: 'Member Search' });
    const surface = stubSurface({ screens: [screen, done] });

    const result = await run(
      [
        call('type_secret', {
          nodeId: 'n2',
          secretName: 'MERIDIAN_OPERATOR_PASSWORD',
          why: 'Enter the operator password',
        }),
        call('finish_success', { summary: 'Signed on', successText: 'Member Search', outputs: [] }),
      ],
      { secrets: { MERIDIAN_OPERATOR_PASSWORD: 'demo1234' } },
      surface,
    );

    expect(result.status).toBe('succeeded');
    expect(result.steps[0]?.secretRef).toBe('MERIDIAN_OPERATOR_PASSWORD');
    expect(result.steps[0]?.action).toMatchObject({ type: 'type', text: '', secret: true });
    expect(JSON.stringify(result.steps)).not.toContain('demo1234');
    expect(surface.performed[0]).toMatchObject({
      type: 'type',
      nodeId: 'n2',
      text: 'demo1234',
      secret: true,
    });
  });

  it('names the available credentials in the system prompt, never their values', () => {
    const prompt = systemPrompt({
      goal: 'look up a member',
      inputs: [{ name: 'memberId', value: '100245' }],
      allowedRoutes: ['/'],
      maxTurns: 8,
      secretNames: ['MERIDIAN_OPERATOR_PASSWORD'],
    });
    expect(prompt).toContain('MERIDIAN_OPERATOR_PASSWORD');
    expect(prompt).toContain('type_secret');
    expect(prompt).not.toContain('demo1234');
  });
});
