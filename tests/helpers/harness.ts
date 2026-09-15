/**
 * Test harness: one Meridian tenant plus a BrowserSurface pointed at it.
 *
 * The target runs in-process on an OS-assigned port. That buys three things
 * worth having: `npm test` needs no second terminal, a developer's own
 * `npm run target` on :4173 cannot collide with a test run, and a test can
 * arm a fault by calling the FaultBox directly instead of round-tripping
 * through the admin HTTP surface.
 */

import { startMeridian, type MeridianHandle, DEMO_PASS, DEMO_USER } from '../../targets/meridian/server.js';
import { BrowserSurface } from '../../src/surface/browserSurface.js';
import { policyFor } from '../../src/policy/engine.js';
import type { ExecutionMode, Policy, PolicyDecision } from '../../src/policy/types.js';
import type { Action, ActResult, Observation, UiNode } from '../../src/surface/types.js';

export interface Harness {
  target: MeridianHandle;
  surface: BrowserSurface;
  /** Every policy decision the surface made, in order. */
  decisions: Array<{ action: Action; decision: PolicyDecision }>;
  close(): Promise<void>;
}

export async function launchHarness(
  opts: { tenant?: string; mode?: ExecutionMode; policy?: Policy } = {},
): Promise<Harness> {
  const target = await startMeridian({ tenant: opts.tenant });
  const decisions: Harness['decisions'] = [];

  const surface = await BrowserSurface.launch({
    headless: true,
    policy: opts.policy ?? policyFor(target.url),
    mode: opts.mode ?? 'discovery',
    // The agent's navigate tool takes a path; this is where its origin comes from.
    baseUrl: target.url,
    onPolicyDecision: (action, decision) => decisions.push({ action, decision }),
  });

  return {
    target,
    surface,
    decisions,
    close: async () => {
      await surface.close();
      await target.close();
    },
  };
}

/** Drives the sign-on screen the way the agent would: by anchor, not by name. */
export async function signOn(h: Harness): Promise<Observation> {
  await h.surface.act({ type: 'navigate', location: `${h.target.url}/` });
  const obs = await h.surface.observe();

  const user = byAnchor(obs.nodes, 'textbox', 'Operator ID');
  const pass = byAnchor(obs.nodes, 'textbox', 'Password');
  const submit = byName(obs.nodes, 'button', 'Sign On');

  await h.surface.act({ type: 'type', nodeId: user.nodeId, text: DEMO_USER });
  await h.surface.act({ type: 'type', nodeId: pass.nodeId, text: DEMO_PASS, secret: true });
  await h.surface.act({ type: 'click', nodeId: submit.nodeId });

  const after = await h.surface.observe();
  if (/Invalid operator|Sign On/i.test(after.title)) {
    throw new Error(`Sign-on did not take. Still on:\n${describe(after)}`);
  }
  return after;
}

/**
 * Signs on and searches for a member, landing on whatever screen results.
 *
 * Every step is checked as it happens. A helper that quietly returns the wrong
 * screen turns one broken navigation into a scatter of `undefined is not an
 * object` failures in unrelated assertions, which is a much worse debugging
 * experience than failing here with the screen we actually ended up on.
 */
export async function lookUpMember(h: Harness, memberId: string): Promise<Observation> {
  let obs = await signOn(h);

  // Tenant B interposes a notice screen after sign-on.
  const ack = obs.nodes.find((n) => n.role === 'link' && /Acknowledge and Continue/i.test(n.name));
  if (ack) {
    expectOk(await h.surface.act({ type: 'click', nodeId: ack.nodeId }), 'acknowledge notice');
    obs = await h.surface.observe();
  }

  const field = obs.nodes.find((n) => n.role === 'textbox' && !!n.anchors.precedingText);
  const search = obs.nodes.find((n) => n.role === 'button' && n.name !== 'Clear');
  if (!field || !search) {
    throw new Error(`Not on the search screen after sign-on. Saw:\n${describe(obs)}`);
  }

  expectOk(await h.surface.act({ type: 'type', nodeId: field.nodeId, text: memberId }), 'type member id');
  expectOk(await h.surface.act({ type: 'click', nodeId: search.nodeId }), 'submit search');

  return h.surface.observe();
}

function expectOk(result: ActResult, what: string): void {
  if (!result.ok) {
    throw new Error(`Harness step "${what}" failed: ${result.refusal?.code ?? ''} ${result.error ?? ''}`);
  }
}

function describe(obs: Observation): string {
  return [
    `  location: ${obs.location}`,
    `  title: ${obs.title}`,
    `  text: ${obs.text.slice(0, 300).replace(/\n/g, ' | ')}`,
  ].join('\n');
}

export function byName(nodes: UiNode[], role: string, name: string): UiNode {
  const hit = nodes.find((n) => n.role === role && n.name === name);
  if (!hit) throw new Error(`No ${role} named "${name}". Saw: ${summarise(nodes, role)}`);
  return hit;
}

export function byAnchor(nodes: UiNode[], role: string, precedingText: string): UiNode {
  const hit = nodes.find((n) => n.role === role && n.anchors.precedingText === precedingText);
  if (!hit) throw new Error(`No ${role} anchored to "${precedingText}". Saw: ${summarise(nodes, role)}`);
  return hit;
}

function summarise(nodes: UiNode[], role: string): string {
  return (
    nodes
      .filter((n) => n.role === role)
      .map((n) => `{name:"${n.name}" anchor:"${n.anchors.precedingText ?? ''}"}`)
      .join(', ') || '(none)'
  );
}
