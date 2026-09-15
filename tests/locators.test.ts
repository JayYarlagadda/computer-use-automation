/**
 * Locator construction, without a browser.
 *
 * The claim being tested is the one the compiler exists to make: a rung is
 * emitted only when the *real* resolver uniquely finds the recorded node on
 * the recorded screen. Everything else -- ranking, refusing instance data,
 * refusing circular extraction -- is in service of that.
 */

import { describe, expect, it } from 'vitest';
import { buildLadder } from '../src/agent/locators.js';
import { resolveTarget } from '../src/replay/resolve.js';
import type { Observation, UiNode } from '../src/surface/types.js';
import type { TargetStrategy } from '../src/artifact/schema.js';

function node(partial: Partial<UiNode> & Pick<UiNode, 'nodeId' | 'role'>): UiNode {
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

function observationOf(nodes: UiNode[], text = ''): Observation {
  return {
    observedAt: '2026-09-11T00:00:00.000Z',
    location: 'http://127.0.0.1/app',
    title: 'Test',
    nodes,
    text,
  };
}

/** Re-runs each accepted rung through the production resolver. */
function resolvedBy(strategy: TargetStrategy, subject: UiNode, observation: Observation) {
  return resolveTarget(
    { description: 'probe', framePath: subject.framePath, strategies: [strategy] },
    observation,
  );
}

describe('buildLadder', () => {
  it('keeps a rung only when the real resolver uniquely finds that node', () => {
    const search = node({ nodeId: 'n1', role: 'button', name: 'Search' });
    const clear = node({ nodeId: 'n2', role: 'button', name: 'Clear', anchors: { ordinalInRole: 1 } });
    const observation = observationOf([search, clear]);

    const ladder = buildLadder(search, observation);
    expect(ladder.target).toBeTruthy();
    expect(ladder.target!.strategies[0]).toMatchObject({ kind: 'role-name', name: 'Search' });

    for (const strategy of ladder.target!.strategies) {
      const outcome = resolvedBy(strategy, search, observation);
      expect(outcome.ok, `rung ${strategy.kind} should resolve`).toBe(true);
      if (outcome.ok) expect(outcome.node.nodeId).toBe('n1');
    }
  });

  it('refuses a role-name that matches more than one control', () => {
    const a = node({ nodeId: 'n1', role: 'button', name: 'Select', anchors: { ordinalInRole: 0 } });
    const b = node({ nodeId: 'n2', role: 'button', name: 'Select', anchors: { ordinalInRole: 1 } });
    const observation = observationOf([a, b]);

    const ladder = buildLadder(a, observation);
    const roleName = ladder.rungs.find((r) => r.kind === 'role-name');
    expect(roleName?.accepted).toBe(false);
    expect(roleName?.reason).toMatch(/matched 2/);

    // A weaker, unique rung still has to survive -- otherwise the control is
    // unaddressable, which is worse than falling down the ladder.
    expect(ladder.target?.strategies.some((s) => s.kind === 'structural')).toBe(true);
    const structural = ladder.target!.strategies.find((s) => s.kind === 'structural')!;
    const outcome = resolvedBy(structural, a, observation);
    expect(outcome.ok && outcome.node.nodeId).toBe('n1');
  });

  it('refuses a strategy that uniquely matches the wrong control', () => {
    // Two textboxes, both labelled "Amount" to their left. The one we acted
    // on is the second. An anchor on precedingText alone would uniquely
    // match the first if we only searched until we found one -- the resolver
    // requires uniqueness, so that rung is dropped and something more
    // specific has to win.
    const first = node({
      nodeId: 'n1',
      role: 'textbox',
      anchors: { precedingText: 'Amount', ordinalInRole: 0 },
    });
    const second = node({
      nodeId: 'n2',
      role: 'textbox',
      anchors: { precedingText: 'Amount', sectionText: 'Fees', ordinalInRole: 1 },
    });
    const observation = observationOf([first, second]);

    const ladder = buildLadder(second, observation);
    const plainAnchor = ladder.rungs.find(
      (r) => r.kind === 'anchor' && r.summary.includes('labelled "Amount"') && !r.summary.includes('matching'),
    );
    expect(plainAnchor?.accepted).toBe(false);
    expect(plainAnchor?.reason).toMatch(/matched 2/);
  });

  it('addresses a nameless field by the cell to its left', () => {
    const field = node({
      nodeId: 'n3',
      role: 'textbox',
      name: '',
      framePath: ['contentFrame'],
      anchors: { precedingText: 'Member ID', sectionText: 'Member Search', ordinalInRole: 0 },
    });
    const observation = observationOf([field]);

    const ladder = buildLadder(field, observation);
    expect(ladder.rungs.find((r) => r.kind === 'role-name')?.accepted).toBe(false);
    expect(ladder.target?.strategies[0]).toMatchObject({
      kind: 'anchor',
      precedingText: 'Member ID',
    });
  });

  it('will not quote a recorded amount as a locator, even for an action', () => {
    const cell = node({
      nodeId: 'n4',
      role: 'cell',
      name: '$4,182.55',
      anchors: { rowText: 'Savings SV-4471 $4,182.55 Active', ordinalInRole: 2 },
    });
    const observation = observationOf([cell]);

    const ladder = buildLadder(cell, observation);
    expect(ladder.rungs.find((r) => r.kind === 'role-name')?.reason).toMatch(/rendered data/);
    expect(ladder.target?.strategies.some((s) => s.kind === 'role-name')).toBe(false);
  });

  it('extracts a value by where it sits and the shape it has, never by what it says', () => {
    const label = node({ nodeId: 'n5', role: 'cell', name: 'Savings', anchors: { ordinalInRole: 0 } });
    const amount = node({
      nodeId: 'n6',
      role: 'cell',
      name: '$4,182.55',
      anchors: { rowText: 'Savings SV-4471 $4,182.55 Active', ordinalInRole: 2 },
    });
    const observation = observationOf([label, amount]);

    const ladder = buildLadder(amount, observation, { purpose: 'extraction' });

    expect(ladder.rungs.find((r) => r.kind === 'role-name')?.accepted).toBe(false);
    expect(ladder.rungs.find((r) => r.kind === 'structural')?.accepted).toBe(false);

    const kept = ladder.target?.strategies ?? [];
    expect(kept.length).toBeGreaterThan(0);
    for (const strategy of kept) {
      expect(strategy.kind).toBe('anchor');
      if (strategy.kind === 'anchor') {
        expect(strategy.namePattern).toMatch(/\\d/);
        expect(strategy.rowText).toBe('Savings');
      }
      const outcome = resolvedBy(strategy, amount, observation);
      expect(outcome.ok && outcome.node.nodeId).toBe('n6');
    }
  });

  it('refuses to embed a goal value in any rung', () => {
    const field = node({
      nodeId: 'n7',
      role: 'textbox',
      name: '100245',
      anchors: { precedingText: 'Member ID', ordinalInRole: 0 },
    });
    const observation = observationOf([field]);

    const ladder = buildLadder(field, observation, { avoid: ['100245'] });
    expect(JSON.stringify(ladder.target)).not.toContain('100245');
    expect(ladder.rungs.find((r) => r.kind === 'role-name')?.accepted).toBe(false);
  });

  it('never emits a coordinates rung', () => {
    // Observation does not carry a viewport, so a bounding box cannot resolve
    // honestly. Structural is the last rung that still degrades predictably.
    const ghost = node({ nodeId: 'n8', role: 'generic' });
    const ladder = buildLadder(ghost, observationOf([ghost]));
    expect(ladder.rungs.some((r) => r.kind === 'coordinates')).toBe(false);
    expect(ladder.target?.strategies.some((s) => s.kind === 'structural')).toBe(true);
  });
});
