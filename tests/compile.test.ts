/**
 * Discovery to artifact to replay.
 *
 * Two layers of test, on purpose.
 *
 * The unit tests below drive `compile()` with a hand-built trace. They are
 * what pin the refusals: a failed run, a credential that was not declared, a
 * success quote that only holds for one member, an outcome that would fire on
 * every success. A live model will not produce those on demand.
 *
 * The integration suite at the bottom is the claim the submission rests on.
 * A scripted model drives the real target in a real browser; the compiler
 * turns that run into an artifact; the replay engine executes the artifact
 * with **no model anywhere in the loop**, against a **different member
 * number** than the one discovery used. A compiler that merely replayed the
 * recorded run would pass a weaker version of that test and fail this one.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { launchHarness, type Harness } from './helpers/harness.js';
import { DEMO_PASS, DEMO_USER } from '../targets/meridian/server.js';
import { compile, discover, type CompileOptions, type CompileResult } from '../src/agent/index.js';
import type { AuthoringProposal } from '../src/agent/authoring.js';
import type { DiscoveryRun, TraceStep } from '../src/agent/trace.js';
import { createScriptedProvider } from '../src/llm/mock.js';
import { policyFor } from '../src/policy/engine.js';
import { replay } from '../src/replay/index.js';
import type { LlmRequest, LlmResponse } from '../src/llm/types.js';
import type { Observation, UiNode } from '../src/surface/types.js';
import type { CapabilityArtifact } from '../src/artifact/schema.js';

const MEMBER_ID = '100245';

const SECRETS: Record<string, string> = {
  MERIDIAN_OPERATOR_ID: DEMO_USER,
  MERIDIAN_OPERATOR_PASSWORD: DEMO_PASS,
};

const APP = {
  vendor: 'Meridian Systems',
  product: 'CoreBank Servicing',
  productVersion: '7.2.11',
  surfaceKind: 'browser' as const,
  recordedOnTenant: 'a',
};

const POLICY = policyFor('http://127.0.0.1:9');

const AUTHORING: AuthoringProposal = {
  title: "Read a member's savings balance",
  description:
    'Signs on to the servicing application, looks up a member by number, and returns the balance ' +
    'of their savings account. Read-only.',
  inputs: [{ name: 'memberId', description: 'The six-digit member number.', example: '123456' }],
  outputs: [
    { name: 'memberName', description: 'Full name on the member record.' },
    { name: 'savingsBalance', description: 'Savings balance as a decimal string.' },
  ],
  outcomes: [
    {
      code: 'MEMBER_NOT_FOUND',
      title: 'No member with that number',
      description: 'The number is well-formed but no record exists.',
      detectText: 'No member found for number',
    },
    {
      code: 'ALWAYS_FIRES',
      title: 'An outcome that matches every successful run',
      description: 'Present to prove the compiler refuses it.',
      detectText: 'Share Accounts',
    },
  ],
};

// ---------------------------------------------------------------------------
// Synthetic traces
// ---------------------------------------------------------------------------

function node(
  partial: Omit<Partial<UiNode>, 'anchors'> & Pick<UiNode, 'nodeId' | 'role'> & { anchors?: Partial<UiNode['anchors']> },
): UiNode {
  return {
    name: '',
    enabled: true,
    visible: true,
    focused: false,
    framePath: [],
    bbox: { x: 0, y: 0, width: 40, height: 16 },
    ...partial,
    anchors: { ordinalInRole: 0, ...partial.anchors },
  };
}

function observation(partial: Partial<Observation> & Pick<Observation, 'nodes'>): Observation {
  return {
    observedAt: '2026-09-11T00:00:00.000Z',
    location: 'http://127.0.0.1:9/search',
    title: 'Member Search',
    text: 'Member Search',
    ...partial,
  };
}

function step(partial: Partial<TraceStep> & Pick<TraceStep, 'action' | 'why'>): TraceStep {
  const before = partial.observationBefore ?? observation({ nodes: [] });
  return {
    index: 0,
    turn: 1,
    ok: true,
    ...partial,
    observationBefore: before,
  };
}

function run(partial: Partial<DiscoveryRun> = {}): DiscoveryRun {
  const successScreen = observation({
    location: 'http://127.0.0.1:9/member/100245',
    title: 'Member Detail',
    text: 'Member Detail\nShare Accounts\nSavings',
    nodes: [],
  });

  return {
    runId: 'run-1',
    status: 'succeeded',
    goal: 'Look up member 100245 and read their current savings balance.',
    inputs: [{ name: 'memberId', value: MEMBER_ID, description: 'The member number.' }],
    startedAt: '2026-09-11T00:00:00.000Z',
    finishedAt: '2026-09-11T00:00:10.000Z',
    elapsedMs: 10_000,
    turns: 1,
    steps: [],
    model: { provider: 'scripted', model: 'scripted', promptVersion: 'discovery/1' },
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    success: {
      summary: 'Read the savings balance for member 100245',
      successText: 'Share Accounts',
      outputs: [],
      finalObservation: successScreen,
    },
    ...partial,
  };
}

function compileRun(discovered: DiscoveryRun, extras: Partial<CompileOptions> = {}): CompileResult {
  return compile({
    run: discovered,
    capability: { id: 'test.read-savings' },
    app: APP,
    policy: POLICY,
    secrets: SECRETS,
    ...extras,
  });
}

function expectCompiled(result: CompileResult) {
  if (!result.ok) {
    throw new Error(
      `Compilation failed:\n${result.report.issues
        .map((i) => `  [${i.severity}] ${i.path}: ${i.message}`)
        .join('\n')}`,
    );
  }
  return result;
}

// ---------------------------------------------------------------------------
// Unit: what the compiler refuses, and what it rewrites
// ---------------------------------------------------------------------------

describe('compile (synthetic traces)', () => {
  it('will not compile a run that did not reach its goal', () => {
    const result = compileRun(
      run({
        status: 'abandoned',
        abandonment: { reason: 'Nothing here.' },
        success: undefined,
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.report.issues[0]?.message).toMatch(/abandoned/i);
  });

  it('turns a typed goal value into a parameter, not a literal', () => {
    const field = node({
      nodeId: 'n1',
      role: 'textbox',
      framePath: ['contentFrame'],
      anchors: { precedingText: 'Member ID' },
    });
    const before = observation({ nodes: [field] });

    const result = expectCompiled(
      compileRun(
        run({
          steps: [
            step({
              why: 'Type the member number',
              action: { type: 'type', nodeId: 'n1', text: MEMBER_ID },
              node: field,
              observationBefore: before,
            }),
          ],
        }),
      ),
    );

    const typed = result.artifact.steps.find((s) => s.action.type === 'type');
    expect(typed?.action).toMatchObject({ type: 'type', value: { from: 'param', param: 'memberId' } });
    expect(JSON.stringify(result.artifact.steps)).not.toContain(MEMBER_ID);
    expect(result.artifact.provenance.goal).not.toContain(MEMBER_ID);
    expect(result.artifact.provenance.goal).toContain('{memberId}');
  });

  it('keeps a password type even when the screen looks unchanged', () => {
    const pass = node({
      nodeId: 'n2',
      role: 'textbox',
      sensitive: true,
      anchors: { precedingText: 'Password' },
    });
    const screen = observation({ nodes: [pass] });

    const result = expectCompiled(
      compileRun(
        run({
          steps: [
            step({
              why: 'Enter the operator password',
              action: { type: 'type', nodeId: 'n2', text: DEMO_PASS },
              node: pass,
              observationBefore: screen,
              observationAfter: screen,
              noChange: true,
            }),
          ],
        }),
      ),
    );

    expect(result.artifact.steps).toHaveLength(1);
    expect(result.artifact.steps[0]?.action).toMatchObject({
      type: 'type',
      value: { from: 'secret', ref: 'MERIDIAN_OPERATOR_PASSWORD' },
    });
  });

  it('records credentials as named references and refuses an undeclared one', () => {
    const user = node({
      nodeId: 'n1',
      role: 'textbox',
      anchors: { precedingText: 'Operator ID' },
    });
    const pass = node({
      nodeId: 'n2',
      role: 'textbox',
      sensitive: true,
      anchors: { precedingText: 'Password' },
    });

    const ok = expectCompiled(
      compileRun(
        run({
          steps: [
            step({
              why: 'Enter the operator ID',
              action: { type: 'type', nodeId: 'n1', text: DEMO_USER },
              node: user,
              observationBefore: observation({ nodes: [user] }),
            }),
            step({
              index: 1,
              turn: 2,
              why: 'Enter the operator password',
              action: { type: 'type', nodeId: 'n2', text: DEMO_PASS },
              node: pass,
              observationBefore: observation({ nodes: [pass] }),
            }),
          ],
        }),
      ),
    );

    const refs = ok.artifact.steps
      .filter((s) => s.action.type === 'type' && s.action.value.from === 'secret')
      .map((s) => (s.action as { value: { ref: string } }).value.ref);
    expect(refs).toEqual(['MERIDIAN_OPERATOR_ID', 'MERIDIAN_OPERATOR_PASSWORD']);

    const refused = compileRun(
      run({
        steps: [
          step({
            why: 'Type a password we were not told about',
            action: { type: 'type', nodeId: 'n2', text: 'hunter2' },
            node: pass,
            observationBefore: observation({ nodes: [pass] }),
          }),
        ],
      }),
      { secrets: {} },
    );
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.report.issues.some((i) => /secret/i.test(i.message))).toBe(true);
  });

  it('drops exploration and keeps the flow', () => {
    const search = node({ nodeId: 'n1', role: 'button', name: 'Search' });
    const dead = node({ nodeId: 'n2', role: 'button', name: 'Clear' });
    const screen = observation({ nodes: [search, dead] });

    const result = expectCompiled(
      compileRun(
        run({
          steps: [
            step({
              why: 'Click a control that does nothing',
              action: { type: 'click', nodeId: 'n2' },
              node: dead,
              observationBefore: screen,
              observationAfter: screen,
              noChange: true,
            }),
            step({
              index: 1,
              turn: 2,
              why: 'Run the member search',
              action: { type: 'click', nodeId: 'n1' },
              node: search,
              observationBefore: screen,
              observationAfter: observation({
                location: 'http://127.0.0.1:9/member/100245',
                title: 'Member Detail',
                text: 'Member Detail',
                nodes: [search],
              }),
            }),
          ],
        }),
      ),
    );

    expect(result.report.stepsExplored).toBe(2);
    expect(result.report.stepsKept).toBe(1);
    expect(result.report.dropped[0]?.why).toMatch(/unchanged/);
    expect(result.artifact.steps).toHaveLength(1);
  });

  it('refuses a success quote that only holds for this run', () => {
    const result = compileRun(
      run({
        steps: [
          step({
            why: 'Open the application',
            action: { type: 'navigate', location: '/' },
            observationBefore: observation({ nodes: [] }),
            observationAfter: observation({
              location: 'http://127.0.0.1:9/',
              title: 'Sign On',
              text: 'Operator Sign On',
              nodes: [],
            }),
          }),
        ],
        success: {
          summary: 'Looked up 100245',
          successText: `Member ${MEMBER_ID}`,
          outputs: [],
          finalObservation: observation({
            location: `http://127.0.0.1:9/member/${MEMBER_ID}`,
            title: 'Member Detail',
            text: `Member ${MEMBER_ID}`,
            nodes: [],
          }),
        },
      }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.report.issues.some((i) => /successCheckpoint/.test(i.path))).toBe(true);
  });

  it('refuses an outcome that would fire on a successful run', () => {
    const search = node({ nodeId: 'n1', role: 'button', name: 'Search' });
    const result = expectCompiled(
      compileRun(
        run({
          steps: [
            step({
              why: 'Run the member search',
              action: { type: 'click', nodeId: 'n1' },
              node: search,
              observationBefore: observation({ nodes: [search] }),
              observationAfter: observation({
                location: 'http://127.0.0.1:9/member/100245',
                title: 'Member Detail',
                text: 'Member Detail\nShare Accounts',
                nodes: [search],
              }),
            }),
          ],
        }),
        { authoring: AUTHORING },
      ),
    );

    const always = result.report.outcomes.find((o) => o.code === 'ALWAYS_FIRES');
    expect(always?.accepted).toBe(false);
    expect(always?.reason).toMatch(/success screen/i);
    expect(result.artifact.outcomes.map((o) => o.code)).toEqual(['MEMBER_NOT_FOUND']);
  });

  it('canonicalises a recorded path against the goal inputs', () => {
    const result = expectCompiled(
      compileRun(
        run({
          steps: [
            step({
              why: 'Open the member that was just found',
              action: { type: 'navigate', location: `http://127.0.0.1:9/member/${MEMBER_ID}` },
              observationBefore: observation({ nodes: [] }),
              observationAfter: observation({
                location: `http://127.0.0.1:9/member/${MEMBER_ID}`,
                title: 'Member Detail',
                text: 'Member Detail\nShare Accounts',
                nodes: [],
              }),
            }),
          ],
        }),
      ),
    );

    expect(result.artifact.steps[0]?.action).toMatchObject({
      type: 'navigate',
      location: {
        pathTemplate: '/member/{memberId}',
        params: { memberId: { from: 'param', param: 'memberId' } },
      },
    });
  });
});

// ---------------------------------------------------------------------------
// Integration: one live discovery, then model-free replay
// ---------------------------------------------------------------------------

function pick(request: LlmRequest, matcher: RegExp, after?: RegExp): string {
  const last = [...request.messages].reverse().find((m) => m.role === 'user');
  const screen = last && 'content' in last ? last.content : '';
  const lines = screen.split('\n');

  const from = after ? lines.findIndex((line) => after.test(line)) : 0;
  if (from < 0) throw new Error(`No line matching ${after} on this screen:\n${screen}`);

  for (const line of lines.slice(from + (after ? 1 : 0))) {
    if (matcher.test(line)) {
      const id = line.trim().split(/\s+/)[0];
      if (id && /^f?\d*n\d+$/i.test(id)) return id;
    }
  }
  throw new Error(`No control matching ${matcher} on this screen:\n${screen}`);
}

function call(name: string, args: Record<string, unknown>): Partial<LlmResponse> {
  return {
    toolCalls: [{ id: `c${Math.random().toString(36).slice(2, 8)}`, name, arguments: args }],
    finishReason: 'tool_calls',
  };
}

function lastScreen(request: LlmRequest): string {
  const last = [...request.messages].reverse().find((m) => m.role === 'user');
  return last && 'content' in last ? last.content : '';
}

/**
 * Reads the screen it is shown, the way a model is supposed to.
 *
 * Turn-numbered scripts look simpler and fall apart the moment the loop
 * spends a turn on an invalid call or a settle that has not finished: the
 * next request is the same screen again, and a script that has already
 * moved on clicks Search before it has typed the member number.
 */
function script(memberId: string) {
  let typedUser = false;
  let typedPass = false;
  let typedMember = false;

  return (request: LlmRequest): Partial<LlmResponse> => {
    const screen = lastScreen(request);

    if (/Share Accounts/.test(screen) || /cell\s+"Savings"/.test(screen)) {
      return call('finish_success', {
        summary: 'Read the savings balance for the requested member',
        successText: 'Share Accounts',
        outputs: [
          {
            name: 'memberName',
            nodeId: pick(request, /cell\s+"/, /cell\s+"Name"/),
            description: 'Full name on the member record',
            type: 'string',
            sensitivity: 'restricted',
          },
          {
            name: 'savingsBalance',
            nodeId: pick(request, /cell\s+"[$£€][\d,]+\.\d{2}"/, /cell\s+"Savings"/),
            description: 'Current savings balance',
            type: 'currency',
            sensitivity: 'internal',
          },
        ],
      });
    }

    if (/labelled-by="Member ID"/.test(screen)) {
      if (!typedMember) {
        typedMember = true;
        return call('type_text', {
          nodeId: pick(request, /labelled-by="Member ID"/),
          text: memberId,
          why: 'Type the member number into the search form',
        });
      }
      return call('click', {
        nodeId: pick(request, /button\s+"Search"/),
        why: 'Run the member search',
      });
    }

    if (/labelled-by="Operator ID"/.test(screen)) {
      if (!typedUser) {
        typedUser = true;
        return call('type_text', {
          nodeId: pick(request, /labelled-by="Operator ID"/),
          text: DEMO_USER,
          why: 'Enter the operator ID',
        });
      }
      if (!typedPass) {
        typedPass = true;
        return call('type_text', {
          nodeId: pick(request, /labelled-by="Password"/),
          text: DEMO_PASS,
          why: 'Enter the operator password',
        });
      }
      return call('click', {
        nodeId: pick(request, /button\s+"Sign On"/),
        why: 'Submit the sign-on form',
      });
    }

    return call('navigate', { path: '/', why: 'Open the servicing application sign-on screen' });
  };
}

let liveArtifact: CapabilityArtifact;
let liveReport: CompileResult['report'];

async function discoverLive(): Promise<void> {
  if (liveArtifact) return;
  const harness = await launchHarness();
  try {
    const discovered = await discover({
      goal: `Look up member ${MEMBER_ID} and read their current savings balance.`,
      inputs: [{ name: 'memberId', value: MEMBER_ID, description: 'The member number to look up.' }],
      surface: harness.surface,
      provider: createScriptedProvider(script(MEMBER_ID)),
      policy: policyFor(harness.target.url),
      maxTurns: 10,
    });

    if (discovered.status !== 'succeeded') {
      throw new Error(
        `Discovery did not succeed: ${discovered.status} ${JSON.stringify(discovered.failure ?? {})}`,
      );
    }

    const compiled = expectCompiled(
      compile({
        run: discovered,
        capability: { id: 'meridian.member.read-savings-balance' },
        app: APP,
        policy: policyFor(harness.target.url),
        secrets: SECRETS,
        authoring: AUTHORING,
      }),
    );
    liveArtifact = compiled.artifact;
    liveReport = compiled.report;
  } finally {
    await harness.close();
  }
}

describe('a live run becomes a reusable capability', () => {
  beforeAll(discoverLive, 90_000);

  it('produces a valid draft capability from the live run', () => {
    expect(liveArtifact.capability.id).toBe('meridian.member.read-savings-balance');
    expect(liveArtifact.approval.state).toBe('draft');
    expect(liveArtifact.risk).toBe('reversible');
    expect(liveArtifact.steps.length).toBeGreaterThanOrEqual(5);
    expect(liveArtifact.provenance.stepsKept).toBe(liveReport.stepsKept);
    expect(liveArtifact.provenance.goal).not.toContain(MEMBER_ID);
  });

  it('never writes the recorded member number or the credentials into the artifact', () => {
    const serialised = JSON.stringify({
      steps: liveArtifact.steps,
      inputs: liveArtifact.inputs,
      outputs: liveArtifact.outputs,
      outcomes: liveArtifact.outcomes,
      successCheckpoint: liveArtifact.successCheckpoint,
    });
    expect(serialised).not.toContain(MEMBER_ID);
    expect(serialised).not.toContain(DEMO_PASS);

    const typed = liveArtifact.steps.filter((s) => s.action.type === 'type');
    expect(typed.some((s) => s.action.type === 'type' && s.action.value.from === 'param')).toBe(true);
    expect(
      typed
        .filter((s) => s.action.type === 'type' && s.action.value.from === 'secret')
        .map((s) => (s.action as { value: { ref: string } }).value.ref),
    ).toEqual(expect.arrayContaining(['MERIDIAN_OPERATOR_ID', 'MERIDIAN_OPERATOR_PASSWORD']));
  });

  it('emits only locator strategies that resolved to the recorded control', () => {
    const all = liveReport.locators.flatMap((l) => l.rungs);
    expect(all.some((r) => r.accepted)).toBe(true);
    expect(all.some((r) => !r.accepted)).toBe(true);
    for (const rung of all.filter((r) => r.accepted)) expect(rung.reason).toBe('');
  });

  it('addresses the unnamed sign-on fields by their label cell', () => {
    const secretSteps = liveArtifact.steps.filter(
      (s) => s.action.type === 'type' && s.action.value.from === 'secret',
    );
    expect(secretSteps.length).toBeGreaterThanOrEqual(2);
    for (const s of secretSteps) {
      const kinds = s.target!.strategies.map((strategy) => strategy.kind);
      expect(kinds).toContain('anchor');
      expect(kinds).not.toContain('role-name');
    }
  });

  it('extracts values by where they sit, never by what they say', () => {
    const balance = liveArtifact.outputs.find((o) => o.name === 'savingsBalance');
    expect(balance?.type).toBe('currency');
    expect(balance?.extract.transforms).toContain('strip-currency');

    for (const output of liveArtifact.outputs) {
      if (output.extract.kind !== 'node-text') continue;
      for (const strategy of output.extract.target.strategies) {
        expect(strategy.kind).not.toBe('role-name');
        expect(strategy.kind).not.toBe('structural');
      }
    }
  });

  it('keeps the legitimate outcome and drops the one that matches success', () => {
    expect(liveArtifact.outcomes.map((o) => o.code)).toContain('MEMBER_NOT_FOUND');
    expect(liveArtifact.outcomes.map((o) => o.code)).not.toContain('ALWAYS_FIRES');
  });
});

describe('the compiled artifact replays without a model', () => {
  let h: Harness | undefined;

  beforeAll(discoverLive, 90_000);

  afterEach(async () => {
    await h?.close();
    h = undefined;
  });

  afterAll(async () => {
    await h?.close();
  });

  async function play(memberId: string) {
    h = await launchHarness({ mode: 'attended' });
    return replay({
      artifact: liveArtifact,
      inputs: { memberId },
      tenantId: 'a',
      baseUrl: h.target.url,
      mode: 'attended',
      surface: h.surface,
      secrets: (ref) => SECRETS[ref],
      timeoutMs: 60_000,
    });
  }

  it('returns the same answer discovery found', async () => {
    const result = await play(MEMBER_ID);
    if (result.status !== 'success') {
      throw new Error(`Expected success, got ${result.status}: ${JSON.stringify(result, null, 2)}`);
    }
    expect(result.outputs.savingsBalance?.value).toBe('4182.55');
    expect(result.outputs.memberName?.value).toBe('Dana Whitfield');
  });

  it('answers for a member it was never recorded against', async () => {
    const result = await play('100246');
    if (result.status !== 'success') {
      throw new Error(`Expected success, got ${result.status}: ${JSON.stringify(result, null, 2)}`);
    }
    expect(result.outputs.memberName?.value).toBe('Marcus Bell');
    expect(result.outputs.savingsBalance?.value).toMatch(/^\d+\.\d{2}$/);
    expect(result.outputs.savingsBalance?.value).not.toBe('4182.55');
  });

  it('reports a business outcome rather than a failure for an unknown member', async () => {
    const result = await play('999999');
    expect(result.status).toBe('business-outcome');
    if (result.status === 'business-outcome') {
      expect(result.outcome.code).toBe('MEMBER_NOT_FOUND');
    }
  });
});
