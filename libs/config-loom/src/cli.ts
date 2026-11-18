#!/usr/bin/env node
import { checkAll } from './check';
import { loadConfig } from './config';
import { LoomError } from './errors';
import { initRepo, serializeConfig } from './init';
import { syncAll } from './sync';
import { deriveOutputs, wireRepo, type WireReport } from './wire';
import { discoverWorkspaces, type WorkspaceRunner } from './workspaces';
import { Command, InvalidArgumentError } from 'commander';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { SyncResult } from './types';

const EPILOGUE = `
Requires a pnpm workspace at the repo root: workspaces come from
  'pnpm -r exec pwd' (other package managers may come later).

Wiring (install as a root devDependency, then one line in package.json):
  "scripts": { "postinstall": "config-loom sync" }

Every pnpm install regenerates the managed files — fresh clones, CI, IDE.
Optional Turborepo upgrade: a cached //#config-loom root task that
build/test/lint depend on (see README).
`;

/** Options every command accepts (declared per command, so --help is local). */
interface SharedOpts {
  root: string;
  config?: string;
}

const addShared = (cmd: Command): Command =>
  cmd
    .option('--root <dir>', 'repository root (default: cwd)', '.')
    .option(
      '--config <path>',
      'config file path (default: <root>/config-loom.yaml)',
    );

interface RunOpts extends SharedOpts {
  dryRun?: boolean;
  verbose?: boolean;
}

interface InitOpts extends RunOpts {
  files?: string;
  templateThreshold?: number;
  keep?: boolean;
  force?: boolean;
  yes?: boolean;
  wire?: boolean;
}

/** parseArgs-style validation, phrased as a commander coercion (exit 2). */
const numberArg = (value: string): number => {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new InvalidArgumentError(`${value} is not a number`);
  }
  return n;
};

/** Commander errors look like this; we map them onto process exit codes. */
interface CommanderErrorLike {
  code?: string;
  exitCode?: number;
}

async function packageVersion(): Promise<string> {
  const pkg = JSON.parse(
    await readFile(path.join(__dirname, '..', 'package.json'), 'utf8'),
  ) as { name?: string; version?: string };
  return `${pkg.name ?? 'config-loom'} ${pkg.version ?? '0.0.0'}`;
}

function printWire(report: WireReport): void {
  if (report.scriptsAdded.length > 0) {
    console.log(`wired package.json: ${report.scriptsAdded.join(', ')}`);
  }
  if (report.turbo) {
    const parts = [];
    if (report.turbo.addedTask) {
      parts.push('//#config-loom task');
    }
    if (report.turbo.dependsOnAdded.length > 0) {
      parts.push(`dependsOn on ${report.turbo.dependsOnAdded.join(', ')}`);
    }
    if (parts.length > 0) {
      console.log(`wired ${report.turbo.file}: ${parts.join('; ')}`);
    }
  }
  for (const note of report.notes) {
    console.log(`  note: ${note}`);
  }
}

function printSync(result: SyncResult, verbose: boolean): void {
  for (const item of result.items) {
    if (item.status === 'unchanged') {
      if (verbose) {
        console.log(`  = ${item.workspace}/${item.file}`);
      }
      continue;
    }
    const mark =
      item.status === 'created' ? '+' : item.status === 'deleted' ? 'x' : '~';
    console.log(`  ${mark} ${item.workspace}/${item.file}`);
  }
  console.log(
    `created ${result.created}, updated ${result.updated}, unchanged ${result.unchanged}, skipped ${result.skipped}, deleted ${result.deleted}`,
  );
}

const commaList = (value: string): string[] =>
  value
    .split(',')
    .map((file) => file.trim())
    .filter((file) => file !== '');

/**
 * Runs the CLI and resolves with the process exit code. Usage problems
 * (unknown command/option) return 2; LoomError (config, workspace, git)
 * prints `loom: …` and returns 1; success returns 0.
 */
export async function main(
  argv: string[],
  deps: { runner?: WorkspaceRunner } = {},
): Promise<number> {
  const program = new Command();
  program
    .name('config-loom')
    .usage('<command> [options]')
    .description('keep monorepo config files in sync from one template')
    .version(await packageVersion(), '-v, --version', 'print the version')
    .showHelpAfterError('(run with --help for usage)')
    .exitOverride()
    .configureOutput({
      writeOut: (text) => console.log(text.replace(/\n$/, '')),
      writeErr: (text) => console.error(text.replace(/\n$/, '')),
    })
    .addHelpText('after', EPILOGUE);

  program
    .command('version')
    .description('print the package version')
    .action(async () => {
      console.log(await packageVersion());
    });

  const syncCmd = program
    .command('sync')
    .description(
      'generate every managed file (creates/updates only what changed)',
    )
    .option('--dry-run', 'print what would happen; change nothing')
    .option('--verbose', 'also list unchanged files');
  addShared(syncCmd).action(async (opts: RunOpts) => {
    const root = path.resolve(process.cwd(), opts.root);
    const { config } = await loadConfig(root, opts.config);
    const result = await syncAll(config, root, {
      dryRun: opts.dryRun === true,
      runner: deps.runner,
    });
    printSync(result, opts.verbose === true);
  });

  let checkFailed = false;
  const checkCmd = program
    .command('check')
    .description(
      'exit 1 if any managed file is missing or stale; never writes',
    );
  addShared(checkCmd).action(async (opts: SharedOpts) => {
    const root = path.resolve(process.cwd(), opts.root);
    const { config } = await loadConfig(root, opts.config);
    const { ok, drift } = await checkAll(config, root, {
      runner: deps.runner,
    });
    if (!ok) {
      console.error(`loom check failed — ${drift.length} file(s) out of sync:`);
      for (const item of drift) {
        const mark =
          item.status === 'created'
            ? 'missing '
            : item.status === 'deleted'
              ? 'stale   '
              : 'outdated';
        console.error(`  ${mark} ${item.workspace}/${item.file}`);
      }
      console.error("run 'config-loom sync' to fix");
      checkFailed = true;
      return;
    }
    console.log('config-loom check ok — every managed file matches the loom');
  });

  addShared(
    program
      .command('wire')
      .description(
        '(re)apply the integration: postinstall in the root package.json, ' +
          'plus a //#config-loom task in turbo.json when it exists; idempotent',
      )
      .option('--dry-run', 'print what would happen; change nothing'),
  ).action(async (opts: SharedOpts & { dryRun?: boolean }) => {
    const root = path.resolve(process.cwd(), opts.root);
    const { config } = await loadConfig(root, opts.config);
    const workspaces = await discoverWorkspaces(
      root,
      config.exclude,
      deps.runner,
    );
    const report = await wireRepo(root, {
      outputs: deriveOutputs(workspaces, Object.keys(config.files)),
      dryRun: opts.dryRun === true,
      configPath: opts.config,
    });
    printWire(report);
    if (opts.dryRun === true) {
      console.log('(dry run — nothing written)');
    }
  });

  addShared(
    program
      .command('init')
      .description(
        'reverse-engineer config-loom.yaml from the config files scattered ' +
          'across workspaces, then delete them, gitignore them and ' +
          'regenerate them (use --dry-run to preview)',
      )
      .option(
        '--files <a,b,...>',
        'only these file names (default: scan known ones)',
      )
      .option(
        '--template-threshold <n>',
        'rendered values longer than n lines move to .config-loom/ ' +
          'template files (default: 40; 0 keeps everything inline)',
        numberArg,
      )
      .option('--dry-run', 'print what would happen; change nothing')
      .option('--keep', 'leave existing files on disk (sync overwrites)')
      .option('--force', 'overwrite an existing config file')
      .option('--yes', 'skip the confirmation prompt')
      .option('--no-wire', 'do not apply the postinstall/turbo wiring')
      .option('--verbose', 'also list unchanged files'),
  ).action(async (opts: InitOpts) => {
    const root = path.resolve(process.cwd(), opts.root);
    const result = await initRepo(root, {
      runner: deps.runner,
      noWire: opts.wire === false,
      files: opts.files === undefined ? undefined : commaList(opts.files),
      templateThreshold: opts.templateThreshold,
      keep: opts.keep === true,
      force: opts.force === true,
      dryRun: opts.dryRun === true,
      yes: opts.yes === true,
    });
    for (const entry of result.plan.unmanaged) {
      console.warn(
        `  ! unparsable: ${entry.workspace}/${entry.file} (${entry.reason}) — excluded from the template; sync may replace it`,
      );
    }
    if (opts.dryRun === true) {
      console.log(
        `# ${path.basename(result.configPath)} that init would write to ${result.configPath}:`,
      );
      process.stdout.write(serializeConfig(result.plan.config));
      console.log(`# regenerate ${result.plan.managedFiles.length} file(s):`);
      for (const file of result.plan.managedFiles) {
        console.log(`#   ${file}`);
      }
      console.log(`# git rm --cached: ${result.untracked.length} file(s)`);
      if (result.plan.templates.length > 0) {
        console.log('# template file(s) init would write (commit these):');
        for (const template of result.plan.templates) {
          console.log(`#   ${template.path}`);
        }
      }
      console.log('# .gitignore block:');
      for (const pattern of result.ignorePatterns) {
        console.log(`#   ${pattern}`);
      }
      if (result.wire) {
        console.log('# wiring:');
        printWire(result.wire);
      }
      return;
    }
    console.log(`wrote ${result.configPath}`);
    console.log(
      `git: untracked ${result.untracked.length} file(s), gitignore block ${result.gitRepo ? 'updated' : 'skipped (no git repo)'}`,
    );
    if (result.sync) {
      printSync(result.sync, opts.verbose === true);
    }
    if (result.wire) {
      printWire(result.wire);
    }
    console.log(
      result.wire?.scriptsAdded.includes('postinstall')
        ? 'next: files are synced now, and every pnpm install will regenerate them'
        : 'next: add "postinstall": "config-loom sync" to the root package.json so every install regenerates the managed files (see README)',
    );
  });

  if (argv.length === 0) {
    program.outputHelp();
    return 0;
  }

  try {
    await program.parseAsync(argv, { from: 'user' });
  } catch (e) {
    if (e instanceof LoomError) {
      console.error(`loom: ${e.message}`);
      return 1;
    }
    const err = e as CommanderErrorLike;
    if (typeof err.code === 'string' && err.code.startsWith('commander.')) {
      if (
        err.code === 'commander.help' ||
        err.code === 'commander.helpDisplayed' ||
        err.code === 'commander.version'
      ) {
        return 0;
      }
      return 2;
    }
    console.error(e);
    return 1;
  }
  return checkFailed ? 1 : 0;
}

if (require.main === module) {
  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
