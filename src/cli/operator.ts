/**
 * `operator` -- the console a person uses to take a stuck run and hand it back.
 *
 * Shaped as a conversation rather than a command shell, because the job is
 * linear and short: something is waiting, you decide whether to take it, you
 * do the work in the browser window the run left open, you say what happened.
 * A shell with eight verbs would be a more powerful rendering of a workflow
 * that has four states.
 *
 * Two things it deliberately will not do.
 *
 * It does not drive the page. The operator works in the real Chromium window,
 * with their own hands, on the screen the run actually stopped on. That is
 * what makes it the same live session, and it is also why their actions are
 * not subject to the policy choke point -- that choke point constrains the
 * agent, not the person whose authority the escalation exists to borrow.
 *
 * And it will not let an intervention be resolved anonymously. Every prompt
 * that changes state carries a name, because the property a bank's audit
 * actually wants from a handover is that the action is attributable to a
 * person -- especially the irreversible ones, which under this design are
 * performed by the human who authorised them rather than granted back to the
 * automation.
 */

import { userInfo } from 'node:os';
import { createInterface, type Interface } from 'node:readline/promises';
import type { Disposition, Intervention } from '../hitl/index.js';
import type { Args } from './args.js';
import { DISPOSITIONS, type SessionView } from './operatorConsole.js';
import {
  bold,
  describeError,
  dim,
  fatal,
  green,
  heading,
  kv,
  line,
  note,
  problem,
  red,
  warn,
  yellow,
} from './ui.js';

export const OPERATOR_FLAGS = ['url', 'as', 'once', 'poll-ms'];

export async function operatorCommand(args: Args): Promise<number> {
  args.rejectUnknown(OPERATOR_FLAGS);

  const url = (args.str('url') ?? `http://127.0.0.1:${process.env.OPERATOR_PORT ?? 4180}`).replace(/\/$/, '');
  const operator = args.str('as') ?? process.env.OPERATOR_NAME ?? safeUsername();
  const once = args.bool('once');
  const pollMs = args.num('poll-ms', 1500);

  const session = await connect(url);

  heading('Operator console');
  kv('console', url);
  kv('session', session.sessionId);
  kv('capability', session.capabilityId);
  kv('you are', operator);
  if (session.evidencePath) kv('evidence', session.evidencePath);
  line();
  note('Waiting for the run to need a person. Ctrl-C to leave -- the run is unaffected.');

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  try {
    while (true) {
      const intervention = await waitForSomethingToDo(url, pollMs);
      if (!intervention) {
        line();
        note('The run finished and the session is closed. Nothing left to do.');
        return 0;
      }

      const handled = await handle(rl, url, operator, intervention);
      if (once && handled) return 0;
    }
  } catch (error) {
    if (isAbort(error)) return 0;
    problem(describeError(error));
    return 1;
  } finally {
    rl.close();
  }
}

// ---------------------------------------------------------------------------
// One intervention, start to finish
// ---------------------------------------------------------------------------

async function handle(
  rl: Interface,
  url: string,
  operator: string,
  intervention: Intervention,
): Promise<boolean> {
  render(intervention);

  if (intervention.state === 'attached') {
    warn(`${intervention.operator} already has this one.`);
    return false;
  }

  const take = await ask(rl, `\n  Take this session as ${bold(operator)}? [y/N] `);
  if (!/^y(es)?$/i.test(take.trim())) {
    note('Left for somebody else.');
    return false;
  }

  const attached = await post(url, `/api/interventions/${intervention.id}/attach`, { operator });
  if (!attached.ok) {
    // Somebody else took it between the listing and the answer. An ordinary
    // race with an ordinary answer, not an error worth stopping the console.
    warn(attached.error);
    return false;
  }

  line();
  line(`  ${green('You have the session.')} The automation is locked out until you hand it back.`);
  note('Work in the browser window the run left open. It is on the screen that stopped it.');
  if (intervention.intent) {
    note(`What the run was trying to do: ${intervention.intent}`);
  }

  const disposition = await askDisposition(rl);
  const noteText = (await ask(rl, '  What did you do? (recorded in evidence) ')).trim();

  const resolved = await post(url, `/api/interventions/${intervention.id}/resolve`, {
    disposition,
    operator,
    ...(noteText ? { note: noteText } : {}),
  });

  if (!resolved.ok) {
    problem(resolved.error);
    return false;
  }

  line();
  switch (disposition) {
    case 'completed':
      line(`  ${green('Handed back.')} The run resumes -- and re-checks the step's own condition`);
      note('before carrying on. It does not take your word for it.');
      break;
    case 'rejected':
      line(`  ${yellow('Stopped.')} The run reports that it was escalated and not resumed.`);
      break;
    case 'abandoned':
      line(`  ${red('Session closed.')} Nothing further can act on it.`);
      break;
  }
  line();

  return true;
}

function render(intervention: Intervention): void {
  heading(`A run needs a person  ${dim(intervention.id.slice(0, 8))}`);
  kv('reason', intervention.reason);
  kv('capability', intervention.capabilityId);
  kv('step', intervention.stepId);
  kv('intent', intervention.intent);
  kv('stopped on', `${intervention.title} -- ${intervention.location}`);
  kv('raised at', intervention.raisedAt);
  line();
  line(`  ${intervention.message}`);
}

async function askDisposition(rl: Interface): Promise<Disposition> {
  line();
  line(`  ${bold('When you are done:')}`);
  line(`    ${bold('completed')}  you did the work; the run should carry on`);
  line(`    ${bold('rejected')}   you looked, and this must not proceed`);
  line(`    ${bold('abandoned')}  end the session entirely`);

  while (true) {
    const answer = (await ask(rl, '  > ')).trim().toLowerCase();
    // An unambiguous prefix is enough, but a bare "a" must not resolve to
    // "abandoned" -- ending the session is not something to reach by typo.
    const matches = DISPOSITIONS.filter((d) => d.startsWith(answer));
    if (answer.length >= 3 && matches.length === 1) return matches[0]!;
    warn(`Type one of: ${DISPOSITIONS.join(', ')}.`);
  }
}

// ---------------------------------------------------------------------------
// Talking to the console
// ---------------------------------------------------------------------------

async function connect(url: string): Promise<SessionView> {
  try {
    const response = await fetch(`${url}/api/session`, { signal: AbortSignal.timeout(3000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return (await response.json()) as SessionView;
  } catch (error) {
    return fatal(
      `No operator console at ${url} (${describeError(error)}).`,
      'A console is started by an attended replay. In another terminal:\n' +
        '  npm run replay -- --artifact artifacts/<id>.json --input <name>=<value>',
    );
  }
}

/**
 * Polls until something is waiting, or until the session closes.
 *
 * Returns `undefined` when the run is over, which is how the console exits on
 * its own instead of sitting on a dead socket.
 */
async function waitForSomethingToDo(url: string, pollMs: number): Promise<Intervention | undefined> {
  while (true) {
    let session: SessionView;
    try {
      const response = await fetch(`${url}/api/session`, { signal: AbortSignal.timeout(3000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      session = (await response.json()) as SessionView;
    } catch {
      // The run's process exits when it finishes, taking the console with it.
      // From here that is indistinguishable from "done", and treating it as an
      // error would end every successful session with a stack trace.
      return undefined;
    }

    if (session.controlState === 'closed') return undefined;

    const waiting = session.interventions.find((i) => i.state === 'waiting');
    if (waiting) return waiting;

    await delay(pollMs);
  }
}

async function post(
  url: string,
  path: string,
  body: unknown,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const response = await fetch(url + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const payload = (await response.json().catch(() => ({}))) as { error?: string };
    if (!response.ok) return { ok: false, error: payload.error ?? `HTTP ${response.status}` };
    return { ok: true };
  } catch (error) {
    return { ok: false, error: describeError(error) };
  }
}

// ---------------------------------------------------------------------------

function ask(rl: Interface, prompt: string): Promise<string> {
  return rl.question(prompt);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeUsername(): string {
  try {
    return userInfo().username;
  } catch {
    return 'operator';
  }
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || /closed/i.test(error.message));
}
