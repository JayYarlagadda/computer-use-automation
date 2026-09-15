#!/usr/bin/env node
/**
 * The command line.
 *
 * Four commands, which are the four things this system does:
 *
 *   discover   an LLM drives a live surface until a goal is reached, and the
 *              recording is compiled into a typed capability artifact
 *   replay     that artifact executes deterministically, with no model
 *   catalog    the artifacts, rendered the way a calling agent receives them
 *   operator   a person takes a stuck session and hands it back
 *
 * They are separate binaries in spirit -- `discover` is the only one that can
 * reach a model, `replay` is the only one that runs in production, `operator`
 * is used by somebody who is not a developer. Keeping them as one entry point
 * with a subcommand is a packaging convenience, not a claim that they share a
 * lifecycle.
 *
 * Every command returns an exit code rather than calling `process.exit`, so a
 * shell can be a caller. `replay` in particular distinguishes all four result
 * statuses by code: a business outcome is not a failure at the command line
 * either.
 */

import { Args, UsageError } from './args.js';
import { loadEnvironment } from './context.js';
import { catalogCommand } from './catalog.js';
import { discoverCommand } from './discover.js';
import { operatorCommand } from './operator.js';
import { replayCommand, replayExitCodes } from './replay.js';
import { blue, bold, describeError, dim, fatal, line, problem } from './ui.js';

type Command = (args: Args) => Promise<number>;

const COMMANDS: Record<string, Command> = {
  discover: discoverCommand,
  replay: replayCommand,
  catalog: catalogCommand,
  operator: operatorCommand,
};

async function main(): Promise<number> {
  loadEnvironment();

  const argv = process.argv.slice(2);
  const name = argv[0];

  if (!name || name === 'help' || name === '--help' || name === '-h') {
    usage();
    return name ? 0 : 1;
  }

  const command = COMMANDS[name];
  if (!command) {
    problem(`There is no "${name}" command.`);
    usage();
    return 1;
  }

  return command(new Args(argv.slice(1)));
}

function usage(): void {
  line();
  line(bold('  Computer-use automation for legacy back-office software'));
  line();
  line(`  ${bold('npm run discover')} -- --capability <id> --goal "<what to do>" [--input name=value]`);
  line(dim('      Drives the target with an LLM and compiles the successful run into an artifact.'));
  line(dim('      --tenant a|b  --secret NAME  --max-turns N  --dry-run  --no-authoring'));
  line();
  line(`  ${bold('npm run replay')} -- --capability <id> [--input name=value]`);
  line(dim('      Executes an artifact deterministically. No model is reachable from this path.'));
  line(dim('      --artifact <path>  --tenant a|b  --unattended  --fault kind[:count][:path]'));
  line(dim(`      exit codes: ${replayExitCodes()}`));
  line();
  line(`  ${bold('npm run catalog')} [-- --json]`);
  line(dim('      Shows the artifacts as a calling agent receives them: typed tools with schemas.'));
  line();
  line(`  ${bold('npm run operator')} [-- --url <console>]`);
  line(dim('      Takes a session an attended replay has stopped on, and hands it back.'));
  line();
  line(`  ${dim('Start the target first:')} ${blue('npm run target')}`);
  line();
}

try {
  process.exitCode = await main();
} catch (error) {
  if (error instanceof UsageError) {
    fatal(error.message, 'Run "npm run cli -- help" for usage.');
  }
  fatal(describeError(error));
}
