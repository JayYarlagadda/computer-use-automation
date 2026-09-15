/**
 * Terminal output.
 *
 * The CLI is how a reviewer meets this system, so what it prints is part of
 * the deliverable rather than debug chatter. Two rules hold throughout:
 *
 * Results are printed as the four-way contract, not as a boolean. A business
 * outcome reads as an answer with a code, a failure reads as a failure with a
 * screenshot path, and an escalation reads as work handed to a person. If the
 * terminal collapsed those into "ok" and "not ok" it would be re-introducing
 * at the last possible moment the exact conflation the result type exists to
 * prevent.
 *
 * And nothing here formats a value it has not been told is safe to show. The
 * redaction boundaries are upstream -- perception, evidence, declared
 * sensitivity -- and a print helper that reached past them for a nicer summary
 * would be a leak with good intentions.
 */

const COLOUR = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;

const wrap = (code: string) => (text: string) => (COLOUR ? `\u001b[${code}m${text}\u001b[0m` : text);

export const bold = wrap('1');
export const dim = wrap('2');
export const red = wrap('31');
export const green = wrap('32');
export const yellow = wrap('33');
export const blue = wrap('34');

export function heading(text: string): void {
  process.stdout.write(`\n${bold(text)}\n`);
}

export function line(text = ''): void {
  process.stdout.write(`${text}\n`);
}

/** Aligned label/value pairs. The width is fixed so blocks line up. */
export function kv(label: string, value: string | number | undefined): void {
  if (value === undefined || value === '') return;
  line(`  ${dim(label.padEnd(18))}${value}`);
}

/** A label introducing a list of `bullet`s, aligned with `kv`. */
export function section(label: string): void {
  line(`  ${dim(label)}`);
}

export function bullet(text: string): void {
  line(`    - ${text}`);
}

export function note(text: string): void {
  line(dim(`  ${text}`));
}

export function warn(text: string): void {
  line(`  ${yellow('!')} ${text}`);
}

export function problem(text: string): void {
  process.stderr.write(`  ${red('x')} ${text}\n`);
}

/**
 * Fatal, phrased for someone who has not read the code.
 *
 * `hint` is where the next command goes. A CLI that says what is wrong without
 * saying what to type has moved the problem to a search engine.
 */
export function fatal(message: string, hint?: string): never {
  process.stderr.write(`\n${red('Error')}  ${message}\n`);
  if (hint) process.stderr.write(`${dim(hint)}\n`);
  process.stderr.write('\n');
  process.exit(1);
}

export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function duration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

/** Path shown relative to where the command was run, with forward slashes. */
export function shortPath(path: string): string {
  const cwd = process.cwd();
  const relative = path.startsWith(cwd) ? path.slice(cwd.length + 1) : path;
  return relative.replaceAll('\\', '/');
}
