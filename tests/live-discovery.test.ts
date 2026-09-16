/**
 * Live Groq (or whatever LLM_PROVIDER is) against the real target.
 *
 * The rest of the suite uses a scripted model so `npm test` stays free,
 * deterministic, and runnable by a reviewer with no key. This file is the
 * other half of the claim: a real provider, a real browser, compile, then
 * replay for a different member with the model gone.
 *
 * It is skipped automatically when no key is set. With a key in `.env` it
 * runs as part of `npm test`. `npm run test:live` is the same file, and
 * fails loudly if the key is missing rather than skipping.
 */

import { existsSync } from 'node:fs';
import { config as loadDotenv } from 'dotenv';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { launchHarness, type Harness } from './helpers/harness.js';
import { DEMO_PASS, DEMO_USER } from '../targets/meridian/server.js';
import { compile, discover, effectiveSteps, proposeMetadata } from '../src/agent/index.js';
import { createProviderFromEnv, hasLlmCredentials, readProviderConfig } from '../src/llm/factory.js';
import { policyFor } from '../src/policy/engine.js';
import { replay } from '../src/replay/index.js';
import { createFileSink } from '../src/evidence/fileSink.js';
import type { CapabilityArtifact } from '../src/artifact/schema.js';

if (existsSync('.env')) loadDotenv({ quiet: true });

const REQUIRE = process.env.npm_lifecycle_event === 'test:live';
const READY = hasLlmCredentials() && (REQUIRE || process.env.LIVE_LLM !== '0');
const MEMBER_ID = '100245';
const OTHER_MEMBER = '100246';

const SECRETS: Record<string, string> = {
  MERIDIAN_OPERATOR_ID: DEMO_USER,
  MERIDIAN_OPERATOR_PASSWORD: DEMO_PASS,
};

if (REQUIRE && !READY) {
  throw new Error(
    `test:live needs ${readProviderConfig().keyVar} in .env. Run npm run set-key.`,
  );
}

describe.skipIf(!READY)('live model discovery against the real target', () => {
  let harness: Harness | undefined;
  let artifact: CapabilityArtifact;

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  beforeAll(async () => {
    const provider = createProviderFromEnv();
    harness = await launchHarness({ mode: 'discovery' });
    const policy = policyFor(harness.target.url);
    const evidence = createFileSink({
      root: 'evidence/scratch',
      runId: `live-${provider.name}`,
      kind: 'discovery',
      label: 'meridian.member.read-savings-balance',
      redact: (text) => policy.redact(text),
    });

    await harness.surface.act({ type: 'navigate', location: `${harness.target.url}/` });

    const discovered = await discover({
      goal: `Look up member ${MEMBER_ID} and read their current savings balance.`,
      inputs: [{ name: 'memberId', value: MEMBER_ID, description: 'The member number to look up.' }],
      surface: harness.surface,
      provider,
      policy,
      evidence,
      secrets: SECRETS,
      allowedRoutes: policy.config.allowedRoutes,
      maxTurns: 16,
      budgetMs: 4 * 60_000,
    });

    if (discovered.status !== 'succeeded') {
      throw new Error(
        `Live discovery did not succeed (${discovered.status}): ${JSON.stringify(
          discovered.failure ?? discovered.escalation ?? discovered.abandonment ?? discovered.outcome ?? {},
        )}`,
      );
    }

    const typed = discovered.steps.filter((s) => s.action.type === 'type');
    for (const step of typed) {
      expect(step.action.type === 'type' && step.action.text).not.toBe(DEMO_PASS);
    }

    const authoring = await proposeMetadata(provider, {
      goal: discovered.goal,
      capabilityId: 'meridian.member.read-savings-balance',
      inputNames: discovered.inputs.map((i) => i.name),
      outputs: discovered.success!.outputs.map((o) => ({ name: o.name, type: o.type })),
      intents: effectiveSteps(discovered).map((step) => step.why),
      successScreenText: discovered.success!.finalObservation.text,
    });

    const compiled = compile({
      run: discovered,
      capability: { id: 'meridian.member.read-savings-balance' },
      app: {
        vendor: 'Meridian Systems',
        product: 'CoreBank Servicing',
        productVersion: '7.2.11',
        surfaceKind: 'browser',
        recordedOnTenant: 'a',
      },
      policy,
      secrets: SECRETS,
      ...(authoring.ok ? { authoring: authoring.proposal } : {}),
    });

    if (!compiled.ok) {
      throw new Error(
        `Live run compiled with errors:\n${compiled.report.issues
          .map((i) => `  ${i.path}: ${i.message}`)
          .join('\n')}`,
      );
    }

    artifact = compiled.artifact;
    await harness.close();
    harness = undefined;
  }, 240_000);

  it('reaches the goal with a real provider and does not write the password into the trace', () => {
    expect(artifact.capability.id).toBe('meridian.member.read-savings-balance');
    expect(artifact.steps.length).toBeGreaterThanOrEqual(4);
    const typedSecrets = artifact.steps.filter(
      (s) => s.action.type === 'type' && s.action.value.from === 'secret',
    );
    expect(typedSecrets.map((s) => (s.action as { value: { ref: string } }).value.ref)).toEqual(
      expect.arrayContaining(['MERIDIAN_OPERATOR_PASSWORD']),
    );
    expect(JSON.stringify(artifact.steps)).not.toContain(DEMO_PASS);
  });

  it('replays for a member the live run never saw, with no model', async () => {
    harness = await launchHarness({ mode: 'attended' });
    const result = await replay({
      artifact,
      inputs: { memberId: OTHER_MEMBER },
      tenantId: 'a',
      baseUrl: harness.target.url,
      mode: 'attended',
      surface: harness.surface,
      secrets: (ref) => SECRETS[ref],
      timeoutMs: 60_000,
    });
    if (result.status !== 'success') {
      throw new Error(`Expected success, got ${result.status}: ${JSON.stringify(result, null, 2)}`);
    }
    expect(result.outputs.savingsBalance?.value).toMatch(/^\d+\.\d{2}$/);
    expect(result.outputs.savingsBalance?.value).not.toBe('4182.55');
    if (result.outputs.memberName) {
      expect(result.outputs.memberName.value).toBe('Marcus Bell');
    }
  });

  it('does not report success for a member that does not exist', async () => {
    harness = await launchHarness({ mode: 'attended' });
    const result = await replay({
      artifact,
      inputs: { memberId: '999999' },
      tenantId: 'a',
      baseUrl: harness.target.url,
      mode: 'attended',
      surface: harness.surface,
      secrets: (ref) => SECRETS[ref],
      timeoutMs: 60_000,
    });
    expect(result.status).not.toBe('success');
    if (artifact.outcomes.some((o) => o.code === 'MEMBER_NOT_FOUND') && result.status === 'business-outcome') {
      expect(result.outcome.code).toBe('MEMBER_NOT_FOUND');
    }
  });
});
