/**
 * Flag parsing, by hand.
 *
 * A dependency would do this, but the whole surface needed here is `--flag`,
 * `--key value`, `--key=value` and a repeatable `--input name=value`. Adding a
 * package for that means one more thing in the supply chain of a project whose
 * central claim is about what it refuses to let through.
 *
 * Unknown flags are rejected rather than ignored. A typo in `--unattendded`
 * that silently runs the attended path is exactly the class of mistake this
 * system is supposed to make impossible, and it costs one line to catch.
 */

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

export class Args {
  private readonly values = new Map<string, string[]>();
  private readonly bare = new Set<string>();

  readonly positional: string[] = [];

  constructor(argv: string[]) {
    for (let i = 0; i < argv.length; i++) {
      const token = argv[i]!;

      if (!token.startsWith('--')) {
        this.positional.push(token);
        continue;
      }

      const body = token.slice(2);
      const eq = body.indexOf('=');

      if (eq !== -1) {
        this.push(body.slice(0, eq), body.slice(eq + 1));
        continue;
      }

      const next = argv[i + 1];
      // `--headless --tenant b` must not read "--tenant" as the value of
      // `--headless`, so anything starting with `--` ends the flag.
      if (next === undefined || next.startsWith('--')) {
        this.bare.add(body);
        this.values.set(body, this.values.get(body) ?? []);
        continue;
      }

      this.push(body, next);
      i++;
    }
  }

  private push(name: string, value: string): void {
    const existing = this.values.get(name);
    if (existing) existing.push(value);
    else this.values.set(name, [value]);
  }

  has(name: string): boolean {
    return this.values.has(name);
  }

  /** A single value. Repeated flags are an error, not a last-one-wins guess. */
  str(name: string): string | undefined;
  str(name: string, fallback: string): string;
  str(name: string, fallback?: string): string | undefined {
    const values = this.values.get(name);
    if (!values?.length) return fallback;
    if (values.length > 1) throw new UsageError(`--${name} was given more than once.`);
    return values[0];
  }

  required(name: string, hint: string): string {
    const value = this.str(name);
    if (!value) throw new UsageError(`--${name} is required. ${hint}`);
    return value;
  }

  list(name: string): string[] {
    return this.values.get(name) ?? [];
  }

  /**
   * `--input memberId=100245 --input branch=07` becomes a record.
   *
   * The value may contain `=`; only the first one separates. A member note or
   * a query string passed as an input should not need escaping.
   */
  pairs(name: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const raw of this.list(name)) {
      const eq = raw.indexOf('=');
      if (eq <= 0) {
        throw new UsageError(`--${name} expects name=value, got "${raw}".`);
      }
      out[raw.slice(0, eq)] = raw.slice(eq + 1);
    }
    return out;
  }

  bool(name: string, fallback = false): boolean {
    if (this.bare.has(name)) return true;
    const value = this.str(name);
    if (value === undefined) return fallback;
    if (value === 'true' || value === '1' || value === 'yes') return true;
    if (value === 'false' || value === '0' || value === 'no') return false;
    throw new UsageError(`--${name} expects true or false, got "${value}".`);
  }

  num(name: string, fallback: number): number {
    const value = this.str(name);
    if (value === undefined) return fallback;
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) throw new UsageError(`--${name} expects a number, got "${value}".`);
    return parsed;
  }

  /** Call once every flag a command understands has been read. */
  rejectUnknown(known: string[]): void {
    const allowed = new Set(known);
    const unknown = [...this.values.keys()].filter((name) => !allowed.has(name));
    if (unknown.length) {
      throw new UsageError(
        `Unknown ${unknown.length === 1 ? 'flag' : 'flags'}: ${unknown.map((f) => `--${f}`).join(', ')}. ` +
          `This command takes: ${known.map((f) => `--${f}`).join(', ')}.`,
      );
    }
  }
}
