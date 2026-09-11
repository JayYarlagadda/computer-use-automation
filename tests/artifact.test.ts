/**
 * The artifact contract, under test.
 *
 * Three things are being checked here, in rough order of importance.
 *
 * That the schema can express the real flow -- the reference fixture is the
 * actual Meridian capability, and if it stops validating, the schema has
 * regressed in a way no unit test of individual fields would catch.
 *
 * That the validator rejects the specific mistakes that survive review: a step
 * typing a parameter nobody declared, an overlay for a step that does not
 * exist, a capability that recovers by invoking itself.
 *
 * That binding, canonicalisation and catalog generation are pure and stable,
 * because replay determinism rests on them.
 */

import { describe, expect, it } from 'vitest';
import {
  bindTenant,
  canonicalisePath,
  digest,
  expandPath,
  inputsToJsonSchema,
  matchPath,
  parseArtifact,
  parseArtifactOrThrow,
  toToolDefinition,
  type CapabilityArtifactInput,
} from '../src/artifact/index.js';
import { readSavingsBalance } from './fixtures/readSavingsBalance.js';

/** Structured clone so a mutating test cannot leak into the next one. */
function draft(mutate: (a: any) => void = () => {}): CapabilityArtifactInput {
  const copy = structuredClone(readSavingsBalance) as any;
  mutate(copy);
  return copy;
}

/**
 * Asserts the artifact was rejected, and for the stated reason.
 *
 * Searches all issues rather than indexing the first: warnings and errors share
 * one list, so positional assertions would pass or fail on unrelated edits.
 */
function expectRejected(artifact: CapabilityArtifactInput, reason: RegExp): void {
  const result = parseArtifact(artifact);
  expect(result.ok, 'artifact should have been rejected').toBe(false);
  if (result.ok) return;

  const matched = result.issues.filter((i) => i.severity === 'error' && reason.test(i.message));
  expect(matched, `no error matching ${reason}. Got:\n${JSON.stringify(result.issues, null, 2)}`).not.toHaveLength(
    0,
  );
}

describe('the schema can express the real flow', () => {
  it('validates the reference capability', () => {
    const result = parseArtifact(readSavingsBalance);
    if (!result.ok) {
      throw new Error(`Reference artifact failed validation:\n${JSON.stringify(result.issues, null, 2)}`);
    }
    expect(result.artifact.capability.id).toBe('meridian.member.read-savings-balance');
  });

  it('produces no warnings on the reference capability', () => {
    const result = parseArtifact(readSavingsBalance);
    expect(result.ok && result.warnings).toEqual([]);
  });

  it('applies declared defaults so authors can omit the boilerplate', () => {
    const a = parseArtifactOrThrow(readSavingsBalance);
    expect(a.approval.state).toBe('draft');
    expect(a.steps[0]!.optional).toBe(false);
    expect(a.steps[0]!.timeoutMs).toBe(10_000);
  });

  it('keeps credentials out of the artifact entirely', () => {
    const a = parseArtifactOrThrow(readSavingsBalance);
    const signOn = a.steps.find((s) => s.id === 'enter-password')!;

    // The artifact records the *name* of a secret, never a value -- which is
    // what makes it safe to commit a sign-on flow to a public repository.
    expect(signOn.action).toMatchObject({ type: 'type', value: { from: 'secret' } });
    expect(JSON.stringify(a)).not.toMatch(/demo1234/);
  });
});

describe('referential integrity', () => {
  it('rejects a step that types an undeclared parameter', () => {
    expectRejected(
      draft((a) => {
        a.steps[5].action.value = { from: 'param', param: 'memberNumber' };
      }),
      /undeclared input "memberNumber"/,
    );
  });

  it('rejects an overlay that overrides a step which does not exist', () => {
    expectRejected(
      draft((a) => {
        a.tenantOverlays[0].steps = { 'enter-branch-code': { skip: true } };
      }),
      /does not exist/,
    );
  });

  it('rejects a capability that recovers by running itself', () => {
    expectRejected(
      draft((a) => {
        a.recovery[1].then = { kind: 'run-capability', capabilityId: 'meridian.member.read-savings-balance' };
      }),
      /cannot recover by running itself/,
    );
  });

  it('rejects a click step with no target', () => {
    expectRejected(
      draft((a) => {
        delete a.steps[3].target;
      }),
      /is a click but has no target/,
    );
  });

  it('rejects a navigate template whose placeholder is unsupplied', () => {
    expectRejected(
      draft((a) => {
        a.steps[0].action.location = { pathTemplate: '/member/{memberId}', params: {} };
      }),
      /needs "memberId"/,
    );
  });

  it('rejects an uncompilable regular expression rather than failing mid-run', () => {
    expectRejected(
      draft((a) => {
        a.outputs[2].extract.pattern = 'Savings\\s+(SV-\\d+';
      }),
      /valid regular expression/,
    );
  });

  it('refuses to return a secret as an output', () => {
    expectRejected(
      draft((a) => {
        a.outputs[0].sensitivity = 'secret';
      }),
      /never returns a secret/,
    );
  });

  it('refuses an example value on a regulated input', () => {
    expectRejected(
      draft((a) => {
        a.inputs[0].sensitivity = 'restricted';
        a.inputs[0].example = '412-88-0173';
      }),
      /must not carry an example value/,
    );
  });

  it('warns, rather than fails, when a navigating step asserts nothing', () => {
    const result = parseArtifact(
      draft((a) => {
        delete a.steps[3].checkpoint;
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.ok && result.warnings.map((w) => w.message).join()).toMatch(/asserts nothing/);
  });

  it('does not nag about a step that changes nothing on screen', () => {
    // Typing into a field has nothing to assert; warning about it would train
    // authors to write checkpoints that assert the screen they were already on.
    const result = parseArtifact(readSavingsBalance);
    expect(result.ok && result.warnings).toEqual([]);
  });
});

describe('path canonicalisation', () => {
  it('parameterises a concrete path by whole segments', () => {
    expect(canonicalisePath('/member/100245', { memberId: '100245' })).toBe('/member/{memberId}');
    expect(canonicalisePath('/member/100245/adjust', { memberId: '100245' })).toBe('/member/{memberId}/adjust');
  });

  it('does not parameterise a segment that merely contains the value', () => {
    // The failure mode this prevents reads perfectly well in review.
    expect(canonicalisePath('/branch/100245-north', { memberId: '100245' })).toBe('/branch/100245-north');
  });

  it('round-trips through expand and match', () => {
    const template = '/member/{memberId}';
    const concrete = expandPath(template, { memberId: '100245' });

    expect(concrete).toBe('/member/100245');
    expect(matchPath(template, concrete)).toEqual({ memberId: '100245' });
  });

  it('returns undefined for a path that does not match, rather than throwing', () => {
    expect(matchPath('/member/{memberId}', '/search')).toBeUndefined();
    expect(matchPath('/member/{memberId}', '/member/100245/adjust')).toBeUndefined();
  });

  it('refuses to expand a template with a missing value', () => {
    expect(() => expandPath('/member/{memberId}', {})).toThrow(/no value supplied/);
  });
});

describe('the digest identifies behaviour, not history', () => {
  it('is stable across key ordering', () => {
    const a = parseArtifactOrThrow(readSavingsBalance);
    const reordered = parseArtifactOrThrow(JSON.parse(JSON.stringify({ ...a, app: { ...a.app } })));

    expect(digest(reordered)).toBe(digest(a));
  });

  it('ignores approval state and stability counters', () => {
    const a = parseArtifactOrThrow(readSavingsBalance);
    const approved = { ...a, approval: { state: 'approved' as const, stability: { runs: 9, successes: 9, degraded: 1 } } };

    expect(digest(approved)).toBe(digest(a));
  });

  it('changes when a step changes', () => {
    const a = parseArtifactOrThrow(readSavingsBalance);
    const edited = parseArtifactOrThrow(
      draft((d) => {
        d.steps[6].target.strategies[0].name = 'Find Member';
      }),
    );

    expect(digest(edited)).not.toBe(digest(a));
  });
});

describe('tenant binding', () => {
  const base = parseArtifactOrThrow(readSavingsBalance);

  it('returns the base artifact unchanged for a tenant with no overlay', () => {
    const bound = bindTenant(base, 'a');
    expect(bound.overlay).toBeUndefined();
    expect(digest(bound.artifact)).toBe(digest(base));
  });

  it('remaps every label a second institution words differently', () => {
    const { artifact, overlay } = bindTenant(base, 'b');
    expect(overlay?.tenantId).toBe('b');

    const memberField = artifact.steps.find((s) => s.id === 'enter-member-id')!.target!;
    const anchor = memberField.strategies.find((s) => s.kind === 'anchor')!;
    expect(anchor).toMatchObject({ precedingText: 'Member No.' });

    const searchButton = artifact.steps.find((s) => s.id === 'submit-search')!.target!;
    expect(searchButton.strategies[0]).toMatchObject({ kind: 'role-name', name: 'Find Member' });
  });

  it('remaps labels inside checkpoints and outcome predicates too', () => {
    const { artifact } = bindTenant(base, 'b');
    const success = artifact.successCheckpoint;

    expect(success.kind).toBe('all');
    const texts = success.kind === 'all' ? success.of.map((c) => (c.kind === 'text-present' ? c.text : '')) : [];
    expect(texts).toContain('Deposit Accounts');
    expect(texts).not.toContain('Share Accounts');
  });

  it('does not mutate the base artifact', () => {
    const before = digest(base);
    bindTenant(base, 'b');
    expect(digest(base)).toBe(before);
  });

  it('reports product version drift instead of silently proceeding', () => {
    const bound = bindTenant(base, 'b', { productVersion: '7.4.03' });
    expect(bound.versionDrift).toEqual({ recordedAgainst: '7.2.11', bindingTo: '7.4.03' });
  });

  it('reports no drift when the versions agree', () => {
    expect(bindTenant(base, 'a', { productVersion: '7.2.11' }).versionDrift).toBeUndefined();
  });

  it('still validates after binding', () => {
    const { artifact } = bindTenant(base, 'b');
    expect(parseArtifact(artifact).ok).toBe(true);
  });
});

describe('the agent-facing catalog', () => {
  const base = parseArtifactOrThrow(readSavingsBalance);

  it('derives a JSON Schema from the declared inputs', () => {
    const schema = inputsToJsonSchema(base.inputs);

    expect(schema).toMatchObject({
      type: 'object',
      required: ['memberId'],
      additionalProperties: false,
    });
    expect(schema.properties.memberId).toMatchObject({
      type: 'string',
      pattern: '^\\d{6}$',
      examples: ['100245'],
    });
  });

  it('tells the calling agent which non-success answers are legitimate', () => {
    const tool = toToolDefinition(base);

    // Without this the caller treats "no such member" as a tool failure and
    // retries, which is the exact confusion the outcome list exists to prevent.
    expect(tool.description).toContain('MEMBER_NOT_FOUND');
    expect(tool.description).toContain('PERMISSION_DENIED');
    expect(tool.description).toMatch(/results rather than errors/);
  });

  it('tells the caller the capability is not yet approved', () => {
    expect(toToolDefinition(base).description).toMatch(/Approval state: draft/);
  });

  it('names the tool in a form function-calling APIs accept', () => {
    expect(toToolDefinition(base).name).toBe('meridian_member_read-savings-balance');
  });

  it('describes currency as a decimal string rather than a float', () => {
    const withCurrencyInput = parseArtifactOrThrow(
      draft((a) => {
        a.inputs.push({
          name: 'amount',
          type: 'currency',
          description: 'Amount to apply.',
          required: false,
          sensitivity: 'internal',
        });
      }),
    );

    const property = inputsToJsonSchema(withCurrencyInput.inputs).properties.amount!;
    expect(property.type).toBe('string');
    expect(property.description).toMatch(/Decimal string/);
  });
});
