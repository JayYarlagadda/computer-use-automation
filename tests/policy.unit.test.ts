/**
 * Policy engine in isolation -- no browser, no target app.
 *
 * These run in milliseconds and cover the edges that are tedious to reach
 * through a UI: route-pattern boundaries, the mode matrix for irreversible
 * actions, and which regulated shapes the redactor actually matches.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, PolicyEngine, policyFor } from '../src/policy/engine.js';
import type { UiNode } from '../src/surface/types.js';

const ORIGIN = 'http://127.0.0.1:4173';
const policy = policyFor(ORIGIN);

function node(name: string): UiNode {
  return {
    nodeId: 'n0',
    role: 'link',
    name,
    enabled: true,
    visible: true,
    focused: false,
    framePath: [],
    bbox: { x: 0, y: 0, width: 10, height: 10 },
    anchors: { ordinalInRole: 0 },
  };
}

const at = (location: string) => ({ mode: 'unattended' as const, location });

describe('route patterns', () => {
  it('matches a single segment where a wildcard is written', () => {
    const d = policy.check({ type: 'navigate', location: `${ORIGIN}/member/100245` }, at(ORIGIN));
    expect(d.effect).toBe('allow');
  });

  it('does not let a wildcard span a path separator', () => {
    // "/member/*" must not match "/member/100245/adjust" -- that route is
    // allowlisted separately and on purpose, because it is the risky one.
    const restricted = new PolicyEngine({ ...DEFAULT_POLICY, allowedRoutes: ['/member/*'] });
    const d = restricted.check({ type: 'navigate', location: `${ORIGIN}/member/100245/adjust` }, at(ORIGIN));
    expect(d.effect).toBe('deny');
  });

  it('rejects an unparseable location rather than defaulting to allow', () => {
    const d = policy.check({ type: 'navigate', location: 'not a url' }, at(ORIGIN));
    expect(d).toMatchObject({ effect: 'deny', code: 'ORIGIN_NOT_ALLOWED' });
  });

  it('rejects a different port on the same host', () => {
    const d = policy.check({ type: 'navigate', location: 'http://127.0.0.1:9999/search' }, at(ORIGIN));
    expect(d).toMatchObject({ effect: 'deny', code: 'ORIGIN_NOT_ALLOWED' });
  });
});

describe('risk classification', () => {
  it('treats reads, waits and navigation as safe', () => {
    expect(policy.classify({ type: 'read', nodeId: 'n0' })).toBe('safe');
    expect(policy.classify({ type: 'wait', ms: 10 })).toBe('safe');
    expect(policy.classify({ type: 'navigate', location: ORIGIN })).toBe('safe');
  });

  it('treats a click on a money-moving control as irreversible', () => {
    expect(policy.classify({ type: 'click', nodeId: 'n0' }, node('Post Adjustment'))).toBe('irreversible');
    expect(policy.classify({ type: 'click', nodeId: 'n0' }, node('Transfer Funds'))).toBe('irreversible');
    expect(policy.classify({ type: 'click', nodeId: 'n0' }, node('Close Account'))).toBe('irreversible');
  });

  it('treats an ordinary click as reversible', () => {
    expect(policy.classify({ type: 'click', nodeId: 'n0' }, node('Search'))).toBe('reversible');
  });
});

describe('the mode matrix for irreversible actions', () => {
  const click = { type: 'click' as const, nodeId: 'n0' };
  const ctx = (mode: 'discovery' | 'unattended' | 'attended') => ({
    mode,
    location: `${ORIGIN}/member/100245`,
    node: node('Post Adjustment'),
  });

  it('denies under unattended replay', () => {
    expect(policy.check(click, ctx('unattended'))).toMatchObject({
      effect: 'deny',
      code: 'IRREVERSIBLE_UNATTENDED',
    });
  });

  it('denies during discovery, so exploration cannot move money', () => {
    expect(policy.check(click, ctx('discovery'))).toMatchObject({ effect: 'deny' });
  });

  it('asks for approval when a human is at the console', () => {
    expect(policy.check(click, ctx('attended'))).toMatchObject({ effect: 'require-approval' });
  });
});

describe('redaction', () => {
  it('scrubs SSN-shaped values', () => {
    expect(policy.redact('SSN 412-88-0173 on file')).toBe('SSN [REDACTED] on file');
  });

  it('scrubs long digit runs that look like card or account numbers', () => {
    expect(policy.redact('4111111111111111')).toBe('[REDACTED]');
  });

  it('leaves ordinary business data alone', () => {
    // Over-redaction is its own failure: a scrubbed balance is a broken
    // capability, so the patterns are deliberately shape-specific.
    expect(policy.redact('$4,182.55')).toBe('$4,182.55');
    expect(policy.redact('Member 100245 / Dana Whitfield')).toBe('Member 100245 / Dana Whitfield');
    expect(policy.redact('SV-0044182')).toBe('SV-0044182');
  });

  it('scrubs every occurrence, not just the first', () => {
    expect(policy.redact('412-88-0173 and 318-55-9920')).toBe('[REDACTED] and [REDACTED]');
  });

  it('scrubs values that are run together with adjacent text', () => {
    // The regression this guards: a \b-anchored pattern finds no boundary
    // between "N" and "4", so it misses the concatenated form -- which is
    // precisely what a table row's innerText looks like on these screens.
    expect(policy.redact('SSN412-88-0173 Joined2014-03-11')).toBe('SSN[REDACTED] Joined2014-03-11');
    expect(policy.redact('Account4111111111111111Balance')).toBe('Account[REDACTED]Balance');
  });

  it('still refuses to match a fragment of a longer digit run', () => {
    // "not preceded or followed by a digit" is what replaces \b; without it,
    // a 20-digit string would be half-redacted into something meaningless.
    expect(policy.redact('12345678901234567890123')).toBe('12345678901234567890123');
  });

  it('classifies the link into a money-moving screen as irreversible, not just the submit', () => {
    expect(policy.classify({ type: 'click', nodeId: 'n0' }, node('Post Balance Adjustment'))).toBe(
      'irreversible',
    );
  });
});
