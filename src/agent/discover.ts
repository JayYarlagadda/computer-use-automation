/**
 * The discovery loop: observe, decide, act, until the goal is reached.
 *
 * The interesting part of this file is not the loop -- that is twenty lines --
 * but the set of ways it refuses to run forever.
 *
 * A model driving a UI fails by *persisting*, not by crashing. It clicks a
 * disabled button eleven times, or alternates between two screens, or keeps
 * rephrasing a request the policy layer has already refused. None of that
 * raises an exception, and all of it burns real money against a real bank
 * system. So the loop carries four independent budgets -- turns, wall clock,
 * consecutive incoherent replies, and consecutive actions that changed nothing
 * -- and each one terminates with a distinct code, because "it ran out of
 * turns" and "it stopped making progress on turn four" call for different
 * fixes.
 *
 * Repeated policy refusals are treated as a signal rather than an error. A
 * model that has been refused three times is not going to talk its way past
 * the fourth, and the honest reading is that the goal needs authority the agent
 * does not have. That escalates to a human instead of failing, which is the
 * behaviour the brief asks for and also the correct one.
 *
 * Two things this loop deliberately does not do. It does not call the policy
 * layer -- `Surface.act()` is the single choke point, and a second check here
 * would be a second place to get it wrong. And it observes once per turn: the
 * observation at the top of turn N is recorded as the "after" state of the
 * action taken on turn N-1, so a step's before and after are real observations
 * rather than one real and one re-read.
 */

import { randomUUID } from 'node:crypto';
import type { EvidenceSink } from '../evidence/types.js';
import { NULL_SINK } from '../evidence/types.js';
import type { LlmMessage, LlmProvider, LlmUsage } from '../llm/types.js';
import { LlmError } from '../llm/types.js';
import type { Policy } from '../policy/types.js';
import type { Action, Observation, Surface } from '../surface/types.js';
import { renderObservation, systemPrompt, type GoalInput } from './prompt.js';
import { DISCOVERY_TOOLS, interpret, PROMPT_VERSION } from './tools.js';
import type { DiscoveryFailureCode, DiscoveryRun, TraceStep } from './trace.js';

export interface DiscoveryOptions {
  goal: string;
  /** Values the caller supplied. These become the capability's parameters. */
  inputs?: GoalInput[];
  surface: Surface;
  provider: LlmProvider;
  /** Used to redact the run log. Enforcement lives in the surface. */
  policy: Policy;
  evidence?: EvidenceSink;
  /** Shown to the model so it does not waste turns probing the allowlist. */
  allowedRoutes?: string[];
  maxTurns?: number;
  budgetMs?: number;
  /** Refusals before the run is handed to a human. */
  maxRefusals?: number;
  /** Incoherent replies in a row before the run is declared unproductive. */
  maxInvalid?: number;
  /** Actions in a row that change nothing before the run is declared stuck. */
  maxStalledSteps?: number;
  runId?: string;
  signal?: AbortSignal;
}

const DEFAULTS = {
  maxTurns: 24,
  budgetMs: 5 * 60_000,
  maxRefusals: 3,
  maxInvalid: 3,
  maxStalledSteps: 3,
};

export async function discover(options: DiscoveryOptions): Promise<DiscoveryRun> {
  const cfg = { ...DEFAULTS, ...stripUndefined(options) };
  const { surface, provider, policy } = options;
  const evidence = options.evidence ?? NULL_SINK;
  const inputs = options.inputs ?? [];
  const runId = options.runId ?? randomUUID();

  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  const steps: TraceStep[] = [];
  const usage: LlmUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  const transcript: Array<Record<string, unknown>> = [];

  const messages: LlmMessage[] = [
    {
      role: 'system',
      content: systemPrompt({
        goal: options.goal,
        inputs,
        allowedRoutes: options.allowedRoutes ?? ['(the whole application)'],
        maxTurns: cfg.maxTurns,
      }),
    },
  ];

  let turn = 0;
  let refusals = 0;
  let invalidStreak = 0;
  let stalledStreak = 0;

  const finish = (
    partial: Pick<DiscoveryRun, 'status'> & Partial<DiscoveryRun>,
  ): DiscoveryRun => ({
    runId,
    goal: options.goal,
    inputs,
    startedAt,
    finishedAt: new Date().toISOString(),
    elapsedMs: Date.now() - startedAtMs,
    turns: turn,
    steps,
    model: { provider: provider.name, model: provider.model, promptVersion: PROMPT_VERSION },
    usage,
    evidencePath: evidence.path || undefined,
    ...partial,
  });

  const fail = (code: DiscoveryFailureCode, message: string) =>
    finish({ status: 'failed', failure: { code, message } });

  await evidence.event({
    at: startedAt,
    kind: 'run.started',
    runId,
    goal: options.goal,
    // Names and redacted values. An input can be a member number, and the log
    // is an artefact we publish.
    inputs: inputs.map((input) => ({ name: input.name, value: policy.redact(input.value) })),
    provider: provider.name,
    model: provider.model,
    promptVersion: PROMPT_VERSION,
    budgets: {
      maxTurns: cfg.maxTurns,
      budgetMs: cfg.budgetMs,
      maxRefusals: cfg.maxRefusals,
      maxInvalid: cfg.maxInvalid,
      maxStalledSteps: cfg.maxStalledSteps,
    },
  });

  const complete = async (run: DiscoveryRun): Promise<DiscoveryRun> => {
    await evidence.event({
      at: run.finishedAt,
      kind: 'run.finished',
      status: run.status,
      turns: run.turns,
      elapsedMs: run.elapsedMs,
      usage: run.usage,
      ...(run.failure ? { failure: run.failure } : {}),
      ...(run.escalation ? { escalation: run.escalation } : {}),
      ...(run.outcome ? { outcome: { code: run.outcome.code, title: run.outcome.title } } : {}),
      ...(run.success ? { summary: run.success.summary } : {}),
    });

    // Written so the loop can be re-run against genuine model output with no
    // key and no network -- see createRecordedProvider.
    await evidence.file(
      'transcript.json',
      JSON.stringify(
        { provider: provider.name, model: provider.model, promptVersion: PROMPT_VERSION, turns: transcript },
        null,
        2,
      ),
    );
    return run;
  };

  try {
    while (true) {
      if (options.signal?.aborted) return complete(fail('ABORTED', 'Cancelled by the caller.'));

      const elapsed = Date.now() - startedAtMs;
      if (elapsed > cfg.budgetMs) {
        return complete(
          fail('TIME_BUDGET_EXHAUSTED', `Ran for ${Math.round(elapsed / 1000)}s without reaching the goal.`),
        );
      }
      if (turn >= cfg.maxTurns) {
        return complete(
          fail('TURN_BUDGET_EXHAUSTED', `Used all ${cfg.maxTurns} turns without reaching the goal.`),
        );
      }
      turn += 1;

      // --- observe -------------------------------------------------------
      let observation: Observation;
      try {
        observation = await surface.observe({ screenshot: true });
      } catch (error) {
        return complete(fail('SURFACE_ERROR', `Could not read the screen: ${describeError(error)}`));
      }

      const previous = steps.at(-1);
      if (previous && !previous.observationAfter) {
        previous.observationAfter = observation;
        // A type/select into a sensitive field cannot change the digest:
        // the value is never captured. Counting that as "no change" would
        // abort a sign-on after three password keystrokes.
        const looksSame = digest(previous.observationBefore) === digest(observation);
        const silent = previous.action.type === 'type' || previous.action.type === 'select';
        previous.noChange = looksSame && !silent;
        if (previous.noChange) {
          stalledStreak += 1;
          if (stalledStreak >= cfg.maxStalledSteps) {
            return complete(
              fail(
                'NO_PROGRESS',
                `${stalledStreak} actions in a row left the screen unchanged; the agent is stuck on "${observation.title}".`,
              ),
            );
          }
        } else {
          stalledStreak = 0;
        }
      }

      if (observation.screenshot) {
        const path = await evidence.screenshot(`turn-${turn}`, observation.screenshot);
        if (previous && !previous.screenshotPath) previous.screenshotPath = path;
      }
      await evidence.observation(`turn-${turn}`, observation);
      await evidence.event({
        at: new Date().toISOString(),
        kind: 'observed',
        turn,
        location: observation.location,
        title: observation.title,
        nodes: observation.nodes.length,
      });

      messages.push({ role: 'user', content: renderObservation(observation, turn, cfg.maxTurns) });

      // --- decide ----------------------------------------------------------
      let response;
      try {
        response = await provider.complete(
          { messages, tools: DISCOVERY_TOOLS, requireTool: true, temperature: 0 },
          options.signal,
        );
      } catch (error) {
        const message = error instanceof LlmError ? error.message : describeError(error);
        return complete(fail('PROVIDER_ERROR', message));
      }

      usage.promptTokens += response.usage?.promptTokens ?? 0;
      usage.completionTokens += response.usage?.completionTokens ?? 0;
      usage.totalTokens += response.usage?.totalTokens ?? 0;

      const call = response.toolCalls[0];
      transcript.push({
        turn,
        response: {
          text: response.text,
          toolCalls: response.toolCalls,
          finishReason: response.finishReason,
          usage: response.usage,
        },
      });
      await evidence.event({
        at: new Date().toISOString(),
        kind: 'model.turn',
        turn,
        latencyMs: response.latencyMs,
        finishReason: response.finishReason,
        usage: response.usage,
        text: policy.redact(response.text),
        tool: call ? { name: call.name, arguments: redactArgs(policy, call.arguments) } : null,
      });

      if (!call) {
        invalidStreak += 1;
        if (invalidStreak >= cfg.maxInvalid) {
          return complete(fail('MODEL_INCOHERENT', 'The model stopped calling tools.'));
        }
        messages.push({ role: 'assistant', content: response.text });
        messages.push({ role: 'user', content: 'You must call exactly one tool. Try again.' });
        continue;
      }

      messages.push({ role: 'assistant', content: response.text, toolCalls: [call] });
      const decision = interpret(call, observation);

      if (decision.kind === 'invalid') {
        invalidStreak += 1;
        await evidence.event({
          at: new Date().toISOString(),
          kind: 'decision.rejected',
          turn,
          tool: call.name,
          reason: decision.message,
        });
        messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: decision.message });
        if (invalidStreak >= cfg.maxInvalid) {
          return complete(
            fail('MODEL_INCOHERENT', `${invalidStreak} unusable tool calls in a row. Last: ${decision.message}`),
          );
        }
        continue;
      }
      invalidStreak = 0;

      // --- terminal decisions ----------------------------------------------
      if (decision.kind === 'finish') {
        return complete(
          finish({
            status: 'succeeded',
            success: {
              summary: decision.summary,
              successText: decision.successText,
              outputs: decision.outputs,
              finalObservation: observation,
            },
          }),
        );
      }

      if (decision.kind === 'outcome') {
        return complete(
          finish({
            status: 'business-outcome',
            outcome: {
              code: decision.code,
              title: decision.title,
              description: decision.description,
              evidenceText: decision.evidenceText,
              finalObservation: observation,
            },
          }),
        );
      }

      if (decision.kind === 'escalate') {
        return complete(finish({ status: 'escalated', escalation: { reason: decision.reason } }));
      }

      if (decision.kind === 'abandon') {
        return complete(finish({ status: 'abandoned', abandonment: { reason: decision.reason } }));
      }

      // --- act ---------------------------------------------------------------
      const step: TraceStep = {
        index: steps.length,
        turn,
        why: decision.why,
        action: decision.action,
        node: decision.node,
        observationBefore: observation,
        ok: false,
      };
      steps.push(step);

      let result;
      try {
        result = await surface.act(decision.action);
      } catch (error) {
        return complete(fail('SURFACE_ERROR', `Action failed hard: ${describeError(error)}`));
      }

      step.ok = result.ok;
      step.refusal = result.refusal;
      step.error = result.error;

      await evidence.event({
        at: new Date().toISOString(),
        kind: 'action',
        turn,
        why: decision.why,
        action: describeAction(decision.action, policy),
        target: decision.node
          ? { role: decision.node.role, name: policy.redact(decision.node.name) }
          : undefined,
        ok: result.ok,
        refusal: result.refusal,
        error: result.error,
      });

      if (result.refusal) {
        // A request for a human is not something to argue with; hand over now.
        if (result.refusal.kind === 'approval-required') {
          return complete(
            finish({
              status: 'escalated',
              escalation: {
                reason: `The safety layer requires human approval: ${result.refusal.reason}`,
              },
            }),
          );
        }

        refusals += 1;
        if (refusals >= cfg.maxRefusals) {
          return complete(
            finish({
              status: 'escalated',
              escalation: {
                reason:
                  `${refusals} actions were refused by the safety layer, most recently: ` +
                  `${result.refusal.reason}. The goal appears to need authority the agent does not have.`,
              },
            }),
          );
        }

        messages.push({
          role: 'tool',
          toolCallId: call.id,
          name: call.name,
          content:
            `REFUSED by the safety layer (${result.refusal.code}): ${result.refusal.reason}. ` +
            'This is final. Do not attempt the same thing another way. Choose a different ' +
            'approach, or escalate if the goal needs it.',
        });
        continue;
      }

      messages.push({
        role: 'tool',
        toolCallId: call.id,
        name: call.name,
        content: result.ok
          ? 'Done. The next message shows the resulting screen.'
          : `The action did not succeed: ${result.error ?? 'unknown reason'}. The next message shows the current screen.`,
      });
    }
  } catch (error) {
    return complete(fail('SURFACE_ERROR', describeError(error)));
  }
}

// ---------------------------------------------------------------------------

/**
 * A cheap fingerprint of what the screen shows.
 *
 * Node ids are excluded because they are regenerated on every observation and
 * would make every screen look different from itself. Values are included:
 * typing into a field changes nothing structurally, and treating that as "no
 * progress" would abort a run mid-form.
 */
function digest(observation: Observation): string {
  return [
    observation.location,
    observation.title,
    observation.nodes
      .filter((node) => node.visible)
      .map((node) => `${node.role}:${node.name}:${node.value ?? ''}:${node.enabled}`)
      .join('|'),
  ].join('\u0000');
}

/** Never logs typed text verbatim -- it could be anything the model chose. */
function describeAction(action: Action, policy: Policy): string {
  switch (action.type) {
    case 'type':
      return `type ${action.text.length} characters into ${action.nodeId}`;
    case 'click':
      return `click ${action.nodeId}`;
    case 'select':
      return `select "${policy.redact(action.option)}" in ${action.nodeId}`;
    case 'press':
      return `press ${action.key}`;
    case 'navigate':
      return `navigate to ${policy.redact(action.location)}`;
    case 'read':
      return `read ${action.nodeId}`;
    case 'wait':
      return `wait ${action.ms}ms`;
  }
}

function redactArgs(policy: Policy, args: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(policy.redact(JSON.stringify(args))) as Record<string, unknown>;
}

function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/** Spread-friendly: an explicit `undefined` should not beat a default. */
function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}
