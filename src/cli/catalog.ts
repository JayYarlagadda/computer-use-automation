/**
 * `catalog` -- what a calling agent would be handed.
 *
 * This command exists to make one claim checkable from the outside: that a
 * capability artifact is a *callable contract* rather than a recording. What
 * it prints is generated from the same `inputs` and `outcomes` arrays the
 * replay engine executes, via `toCatalog`, so the tool definition an agent
 * receives and the document a human approved cannot drift apart.
 *
 * `--json` emits exactly the tool array -- name, description, JSON Schema --
 * which is the form an agent framework consumes. The human rendering above it
 * is a view of the same data and deliberately leads with the two things a
 * reviewer needs first: whether the capability is approved, and which
 * non-success answers it declares as legitimate.
 */

import { toCatalog } from '../artifact/index.js';
import type { CapabilityArtifact } from '../artifact/index.js';
import type { Args } from './args.js';
import { DEFAULT_ARTIFACT_DIR, loadAll, type LoadResult } from './store.js';
import { bullet, dim, green, heading, kv, line, note, problem, section, shortPath, warn, yellow } from './ui.js';

export const CATALOG_FLAGS = ['dir', 'json', 'id'];

export async function catalogCommand(args: Args): Promise<number> {
  args.rejectUnknown(CATALOG_FLAGS);

  const dir = args.str('dir', DEFAULT_ARTIFACT_DIR);
  const only = args.str('id');

  const loaded = loadAll(dir).filter((r) => !only || (r.ok && r.artifact.capability.id === only));

  if (!loaded.length) {
    line();
    note(
      only
        ? `No capability "${only}" in ${shortPath(dir)}/.`
        : `No capability artifacts in ${shortPath(dir)}/.`,
    );
    note('Record one with:  npm run discover -- --goal "..." --capability app.area.action');
    line();
    return 1;
  }

  const good = loaded.filter((r): r is Extract<LoadResult, { ok: true }> => r.ok);
  const bad = loaded.filter((r): r is Extract<LoadResult, { ok: false }> => !r.ok);

  if (args.bool('json')) {
    // Only valid artifacts reach the JSON form. Emitting a tool definition for
    // something replay would refuse to run is worse than omitting it: the agent
    // would call it and get a pre-flight failure it has no way to interpret.
    process.stdout.write(`${JSON.stringify(toCatalog(good.map((r) => r.artifact)), null, 2)}\n`);
    return bad.length ? 1 : 0;
  }

  heading(`Capability catalog  ${dim(shortPath(dir) + '/')}`);

  for (const entry of good) {
    renderCapability(entry.artifact);
    for (const warning of entry.warnings) {
      warn(`${warning.path}: ${warning.message}`);
    }
  }

  for (const entry of bad) {
    line();
    problem(`${shortPath(entry.path)} is not a valid capability artifact:`);
    for (const issue of entry.issues) bullet(`${issue.path}: ${issue.message}`);
  }

  line();
  note(`${good.length} callable, ${bad.length} rejected. Add --json for the agent-facing tool definitions.`);
  line();

  return bad.length ? 1 : 0;
}

function renderCapability(a: CapabilityArtifact): void {
  const approved = a.approval.state === 'approved';

  line();
  line(`  ${green(a.capability.id)}  ${dim(`v${a.capability.version}`)}`);
  line(`  ${a.capability.title}`);

  kv(
    'approval',
    approved
      ? 'approved (may run unattended)'
      : yellow(`${a.approval.state} -- unattended replay is refused until approved`),
  );
  kv('risk', a.risk === 'irreversible' ? yellow('irreversible -- attended only') : a.risk);
  kv('recorded on', `${a.app.product} v${a.app.productVersion}, tenant ${a.app.recordedOnTenant}`);
  kv('tenants', [a.app.recordedOnTenant, ...a.tenantOverlays.map((o) => o.tenantId)].join(', '));

  if (a.inputs.length) {
    section('takes');
    for (const input of a.inputs) {
      const shape = [
        input.type,
        input.required ? 'required' : 'optional',
        input.pattern ? `matching ${input.pattern}` : '',
        input.sensitivity !== 'public' ? input.sensitivity : '',
      ]
        .filter(Boolean)
        .join(', ');
      bullet(`${input.name}  ${dim(`(${shape})`)}`);
    }
  }

  if (a.outputs.length) {
    section('returns');
    for (const output of a.outputs) {
      const shape = [output.type, output.required ? '' : 'optional', output.sensitivity].filter(Boolean).join(', ');
      bullet(`${output.name}  ${dim(`(${shape})`)}`);
    }
  }

  // The part a calling agent most needs and most often is not told: which
  // non-success answers are answers. An agent that treats these as tool
  // failures retries them, which against banking software is not free.
  if (a.outcomes.length) {
    section('answers that are not success');
    for (const outcome of a.outcomes) bullet(`${outcome.code}  ${dim(outcome.title)}`);
  } else {
    warn('Declares no business outcomes, so every non-success answer will be reported as a failure.');
  }
}
