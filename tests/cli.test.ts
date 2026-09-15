/**
 * The command line, without a browser and without a model.
 *
 * The CLI is how a reviewer meets this system, so the things it can get wrong
 * are the same class of mistake the rest of the code exists to prevent: an
 * unknown flag silently ignored, a business outcome collapsed into a failure
 * exit code, an intervention attached without a name, a catalog that hands an
 * agent a document replay would refuse to run.
 */

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Args, UsageError } from '../src/cli/args.js';
import { catalogCommand } from '../src/cli/catalog.js';
import { discoverCommand } from '../src/cli/discover.js';
import { startOperatorConsole } from '../src/cli/operatorConsole.js';
import { replayExitCodes } from '../src/cli/replay.js';
import { saveArtifact } from '../src/cli/store.js';
import { SessionBroker } from '../src/hitl/index.js';
import { parseArtifactOrThrow } from '../src/artifact/index.js';
import { hasLlmCredentials, readProviderConfig } from '../src/llm/factory.js';
import type { Action, ActResult, Observation, Surface } from '../src/surface/types.js';
import { readSavingsBalance } from './fixtures/readSavingsBalance.js';

describe('flag parsing', () => {
  it('reads --key value, --key=value, and a bare boolean', () => {
    const args = new Args(['--tenant', 'b', '--headless', '--input=memberId=100245']);
    expect(args.str('tenant')).toBe('b');
    expect(args.bool('headless')).toBe(true);
    expect(args.pairs('input')).toEqual({ memberId: '100245' });
  });

  it('does not treat the next flag as a value', () => {
    const args = new Args(['--headless', '--tenant', 'b']);
    expect(args.bool('headless')).toBe(true);
    expect(args.str('tenant')).toBe('b');
  });

  it('lets an input value contain "="', () => {
    const args = new Args(['--input', 'note=a=b=c']);
    expect(args.pairs('input')).toEqual({ note: 'a=b=c' });
  });

  it('rejects a repeated flag rather than last-one-wins', () => {
    const args = new Args(['--tenant', 'a', '--tenant', 'b']);
    expect(() => args.str('tenant')).toThrow(UsageError);
  });

  it('rejects unknown flags rather than ignoring them', () => {
    const args = new Args(['--unattendded']);
    expect(() => args.rejectUnknown(['unattended'])).toThrow(/Unknown flag/);
  });

  it('rejects a malformed --input', () => {
    const args = new Args(['--input', 'memberId']);
    expect(() => args.pairs('input')).toThrow(/name=value/);
  });
});

describe('catalog', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('renders a valid artifact as a callable tool', async () => {
    dir = mkdtempSync(join(tmpdir(), 'cua-catalog-'));
    saveArtifact(join(dir, 'meridian.member.read-savings-balance.json'), parseArtifactOrThrow(readSavingsBalance));

    const code = await catalogCommand(new Args(['--dir', dir, '--json']));
    expect(code).toBe(0);
  });

  it('refuses to emit a tool definition for a document that would not run', async () => {
    dir = mkdtempSync(join(tmpdir(), 'cua-catalog-'));
    writeFileSync(join(dir, 'broken.json'), '{"not":"an artifact"}\n');

    const code = await catalogCommand(new Args(['--dir', dir, '--json']));
    expect(code).toBe(1);
  });

  it('exits 1 on an empty directory rather than printing an empty catalog', async () => {
    dir = mkdtempSync(join(tmpdir(), 'cua-catalog-'));
    const code = await catalogCommand(new Args(['--dir', dir]));
    expect(code).toBe(1);
  });
});

describe('operator console', () => {
  function stubSurface(): Surface {
    const observation: Observation = {
      observedAt: new Date().toISOString(),
      location: 'https://meridian.test/app',
      title: 'Member Detail',
      text: 'Member Detail',
      nodes: [],
    };
    return {
      kind: 'browser',
      async observe(): Promise<Observation> {
        return observation;
      },
      async act(_action: Action): Promise<ActResult> {
        return { ok: true };
      },
      async close(): Promise<void> {},
    };
  }

  async function raised() {
    const broker = new SessionBroker({ surface: stubSurface(), sessionId: 'sess-1' });
    const console = await startOperatorConsole({
      broker,
      capabilityId: 'meridian.member.read-savings-balance',
    });
    const intervention = await broker.raise({
      runId: 'run-1',
      capabilityId: 'meridian.member.read-savings-balance',
      reason: 'STUCK',
      message: 'The search form did not submit.',
      stepId: 'submit-search',
      intent: 'Run the member search',
    });
    return { broker, console, intervention };
  }

  it('lists what is waiting and requires a named operator to attach', async () => {
    const { broker, console, intervention } = await raised();
    try {
      const session = await (await fetch(`${console.url}/api/session`)).json();
      expect(session.sessionId).toBe('sess-1');
      expect(session.interventions).toHaveLength(1);

      const anonymous = await fetch(`${console.url}/api/interventions/${intervention.id}/attach`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(anonymous.status).toBe(400);

      const attached = await fetch(`${console.url}/api/interventions/${intervention.id}/attach`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ operator: 'casey.n' }),
      });
      expect(attached.ok).toBe(true);

      const waiting = await (await fetch(`${console.url}/api/interventions`)).json();
      expect(waiting[0].state).toBe('attached');
      expect(waiting[0].operator).toBe('casey.n');
    } finally {
      await console.close();
      await broker.close();
    }
  });

  it('hands the session back with a disposition, and refuses a second resolve', async () => {
    const { broker, console, intervention } = await raised();
    try {
      await fetch(`${console.url}/api/interventions/${intervention.id}/attach`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ operator: 'casey.n' }),
      });

      const resolved = await fetch(`${console.url}/api/interventions/${intervention.id}/resolve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ disposition: 'completed', operator: 'casey.n', note: 'Signed back on.' }),
      });
      expect(resolved.ok).toBe(true);
      const body = await resolved.json();
      expect(body.resolution.disposition).toBe('completed');

      const again = await fetch(`${console.url}/api/interventions/${intervention.id}/resolve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ disposition: 'completed', operator: 'casey.n' }),
      });
      expect(again.status).toBe(409);

      expect(broker.waiting()).toHaveLength(0);
      expect(broker.controlState).toBe('automation');
    } finally {
      await console.close();
      await broker.close();
    }
  });

  it('rejects a disposition that does not exist, including the grant we refused to add', async () => {
    const { broker, console, intervention } = await raised();
    try {
      const response = await fetch(`${console.url}/api/interventions/${intervention.id}/resolve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ disposition: 'approved', operator: 'casey.n' }),
      });
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toMatch(/completed/);
    } finally {
      await console.close();
      await broker.close();
    }
  });
});

describe('discover without a key', () => {
  it('exits 1 with a readable reason rather than throwing', async () => {
    const previous = {
      groq: process.env.GROQ_API_KEY,
      openai: process.env.OPENAI_API_KEY,
      provider: process.env.LLM_PROVIDER,
    };
    delete process.env.GROQ_API_KEY;
    delete process.env.OPENAI_API_KEY;
    process.env.LLM_PROVIDER = 'groq';

    try {
      const code = await discoverCommand(
        new Args(['--capability', 'meridian.member.read-savings-balance', '--goal', 'look up a member']),
      );
      expect(code).toBe(1);
    } finally {
      if (previous.groq !== undefined) process.env.GROQ_API_KEY = previous.groq;
      else delete process.env.GROQ_API_KEY;
      if (previous.openai !== undefined) process.env.OPENAI_API_KEY = previous.openai;
      else delete process.env.OPENAI_API_KEY;
      if (previous.provider !== undefined) process.env.LLM_PROVIDER = previous.provider;
      else delete process.env.LLM_PROVIDER;
    }
  });
});

describe('provider config', () => {
  it('reports the key variable a reviewer needs to set, without requiring it', () => {
    const config = readProviderConfig({ LLM_PROVIDER: 'groq' });
    expect(config.keyVar).toBe('GROQ_API_KEY');
    expect(config.hasKey).toBe(false);
    expect(hasLlmCredentials({ LLM_PROVIDER: 'groq' })).toBe(false);
    expect(hasLlmCredentials({ LLM_PROVIDER: 'groq', GROQ_API_KEY: 'gsk_test' })).toBe(true);
  });
});

describe('replay exit codes', () => {
  it('distinguishes the four result statuses, including a business outcome', () => {
    expect(replayExitCodes()).toBe('0 success, 1 failed, 2 business-outcome, 3 escalated');
  });
});
