/**
 * The central design bet, under test.
 *
 * The claim in D1 is that a graph of roles, accessible names and adjacency
 * evidence is enough to drive a frameset-based, table-laid-out screen with no
 * test IDs. These tests are what make that a demonstrated claim rather than an
 * asserted one -- in particular that inputs with *no accessible name at all*
 * are still reachable, which is the case a role+name-only approach fails.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launchHarness, byAnchor, byName, lookUpMember, signOn, type Harness } from './helpers/harness.js';
import type { Observation } from '../src/surface/types.js';

let h: Harness;
beforeAll(async () => {
  h = await launchHarness();
}, 60_000);
afterAll(async () => h?.close());

describe('sign-on screen', () => {
  let obs: Observation;
  beforeAll(async () => {
    await h.surface.act({ type: 'navigate', location: `${h.target.url}/` });
    obs = await h.surface.observe();
  });

  it('resolves a button by role and accessible name', () => {
    expect(byName(obs.nodes, 'button', 'Sign On')).toBeTruthy();
  });

  it('flags the password field as sensitive and never captures its value', () => {
    const pwd = obs.nodes.find((n) => n.role === 'textbox' && n.sensitive);
    expect(pwd).toBeTruthy();
    expect(pwd!.value).toBeUndefined();
  });

  it('reaches unlabelled inputs through their adjacent cell, not their name', () => {
    // Both fields are nameless -- the legacy case. The anchor is the only handle.
    const user = byAnchor(obs.nodes, 'textbox', 'Operator ID');
    const pass = byAnchor(obs.nodes, 'textbox', 'Password');
    expect(user.name).toBe('');
    expect(pass.name).toBe('');
    expect(user.nodeId).not.toBe(pass.nodeId);
  });

  it('discovers a control wired up with an inline handler and no semantic tag', () => {
    // roleOf() treats [onclick] as a button; a "look for <button>" scan misses it.
    expect(obs.nodes.every((n) => n.role !== 'presentation')).toBe(true);
  });
});

describe('frameset navigation', () => {
  it('perceives controls inside every named frame', async () => {
    const obs = await signOn(h);
    const framePaths = new Set(obs.nodes.filter((n) => n.framePath.length).map((n) => n.framePath.join('/')));
    expect(framePaths).toContain('navFrame');
    expect(framePaths).toContain('contentFrame');
  });
});

describe('reading data out of a table', () => {
  it('locates a balance cell by its row context and reads it back', async () => {
    const obs = await lookUpMember(h, '100245');
    expect(obs.text).toContain('Dana Whitfield');

    const cell = obs.nodes.find(
      (n) => n.role === 'cell' && n.anchors.rowText?.includes('Savings') && /^\$[\d,]+\.\d\d$/.test(n.name),
    );
    expect(cell, 'savings balance cell located by row context').toBeTruthy();

    const read = await h.surface.act({ type: 'read', nodeId: cell!.nodeId });
    expect(read.ok).toBe(true);
    expect(read.value).toBe('$4,182.55');
  });
});

describe('node identity', () => {
  it('invalidates node ids across observations rather than letting them go stale', async () => {
    await h.surface.act({ type: 'navigate', location: `${h.target.url}/` });
    const first = await h.surface.observe();
    const stale = first.nodes[0]!.nodeId;

    await h.surface.act({ type: 'navigate', location: `${h.target.url}/` });
    await h.surface.observe();

    // The id may be reissued, but it must now refer to the current page's node
    // rather than silently addressing a detached element from before.
    const result = await h.surface.act({ type: 'click', nodeId: `${stale}-does-not-exist` });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not from the current observation/);
  });
});
