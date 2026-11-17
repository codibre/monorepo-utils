#!/usr/bin/env node
import { checkAll } from './check';
import { loadConfig } from './config';
import { LoomError } from './errors';
import { initRepo, serializeConfig } from './init';
import { syncAll } from './sync';
import { deriveOutputs, wireRepo, type WireReport } from './wire';
import { discoverWorkspaces, type WorkspaceRunner } from './workspaces';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import type { SyncResult } from './types';

const USAGE = `config-loom — keep monorepo config files in sync from one template

Usage:
  config-loom <command> [options]

Commands:
  init        Reverse-engineer config-loom.jsonc from the config files scattered
              across workspaces, then delete them, gitignore them and
              regenerate them (use --dry-run to preview).
  sync        Generate every managed file (creates/updates only what changed).
  check       Exit 1 if any managed file is missing or stale. Never writes.
  wire        (Re)apply the integration: postinstall in the root
              package.json, plus a //#config-loom task in turbo.json when
              it exists. Idempotent; never overwrites existing scripts.
  version     Print the package version.
  help        This screen.

Options:
  --root <dir>        Repository root (default: cwd)
  --config <path>     config file path (default: <root>/config-loom.jsonc)
  --files <a,b,...>   [init] only these file names (default: scan known ones)
  --dry-run           Print what would happen; change nothing
  --keep              [init] leave existing files on disk (sync overwrites)
  --force             [init] overwrite an existing config file
  --yes               Skip the confirmation prompt
  --verbose           Also list unchanged files
  -h, --help          Same as 'help'
  -v, --version       Same as 'version'

Requires a pnpm workspace at the repo root: workspaces come from
  'pnpm -r exec pwd' (other package managers may come later).

Wiring (install as a root devDependency, then one line in package.json):
  "scripts": { "postinstall": "config-loom sync" }

Every pnpm install regenerates the managed files — fresh clones, CI, IDE.
Optional Turborepo upgrade: a cached //#config-loom root task that
build/test/lint depend on (see README).
`;

interface Flags {
  root: string;
  config?: string;
  files?: string[];
  dryRun: boolean;
  keep: boolean;
  force: boolean;
  yes: boolean;
  verbose: boolean;
  noWire: boolean;
}

function readFlags(
  values: Record<string, string | boolean | undefined>,
): Flags {
  const files = typeof values.files === 'string' ? values.files : undefined;
  return {
    root: typeof values.root === 'string' ? values.root : '.',
    config: typeof values.config === 'string' ? values.config : undefined,
    files: files
      ?.split(',')
      .map((file) => file.trim())
      .filter((file) => file !== ''),
    dryRun: values['dry-run'] === true,
    keep: values.keep === true,
    force: values.force === true,
    yes: values.yes === true,
    verbose: values.verbose === true,
    noWire: values['no-wire'] === true,
  };
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

export async function main(
  argv: string[],
  deps: { runner?: WorkspaceRunner } = {},
): Promise<number> {
  let positionals: string[];
  let flags: Flags;
  try {
    const parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        root: { type: 'string' },
        config: { type: 'string' },
        files: { type: 'string' },
        'no-wire': { type: 'boolean' },
        'dry-run': { type: 'boolean' },
        keep: { type: 'boolean' },
        force: { type: 'boolean' },
        yes: { type: 'boolean' },
        verbose: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
    });
    positionals = parsed.positionals;
    flags = readFlags(parsed.values);
  } catch (e) {
    console.error(`loom: ${(e as Error).message}`);
    return 2;
  }

  const command = positionals[0] ?? 'help';
  const root = path.resolve(process.cwd(), flags.root);

  try {
    switch (command) {
      case 'help':
        console.log(USAGE);
        return 0;
      case 'version':
        console.log(await packageVersion());
        return 0;
      case 'sync': {
        const { config } = await loadConfig(root, flags.config);
        const result = await syncAll(config, root, {
          dryRun: flags.dryRun,
          runner: deps.runner,
        });
        printSync(result, flags.verbose);
        return 0;
      }
      case 'check': {
        const { config } = await loadConfig(root, flags.config);
        const { ok, drift } = await checkAll(config, root, {
          runner: deps.runner,
        });
        if (!ok) {
          console.error(
            `loom check failed — ${drift.length} file(s) out of sync:`,
          );
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
          return 1;
        }
        console.log(
          'config-loom check ok — every managed file matches the loom',
        );
        return 0;
      }
      case 'wire': {
        const { config } = await loadConfig(root, flags.config);
        const workspaces = await discoverWorkspaces(
          root,
          config.exclude,
          deps.runner,
        );
        const report = await wireRepo(root, {
          outputs: deriveOutputs(workspaces, Object.keys(config.files)),
          dryRun: flags.dryRun,
        });
        printWire(report);
        if (flags.dryRun) {
          console.log('(dry run — nothing written)');
        }
        return 0;
      }
      case 'init': {
        const result = await initRepo(root, {
          runner: deps.runner,
          noWire: flags.noWire,
          files: flags.files,
          keep: flags.keep,
          force: flags.force,
          dryRun: flags.dryRun,
          yes: flags.yes,
        });
        for (const entry of result.plan.unmanaged) {
          console.warn(
            `  ! unparsable: ${entry.workspace}/${entry.file} (${entry.reason}) — excluded from the template; sync may replace it`,
          );
        }
        if (flags.dryRun) {
          console.log(
            `# ${path.basename(result.configPath)} that init would write to ${result.configPath}:`,
          );
          process.stdout.write(serializeConfig(result.plan.config));
          console.log(
            `# regenerate ${result.plan.managedFiles.length} file(s):`,
          );
          for (const file of result.plan.managedFiles) {
            console.log(`#   ${file}`);
          }
          console.log(`# git rm --cached: ${result.untracked.length} file(s)`);
          console.log('# .gitignore block:');
          for (const pattern of result.ignorePatterns) {
            console.log(`#   ${pattern}`);
          }
          if (result.wire) {
            console.log('# wiring:');
            printWire(result.wire);
          }
          return 0;
        }
        console.log(`wrote ${result.configPath}`);
        console.log(
          `git: untracked ${result.untracked.length} file(s), gitignore block ${result.gitRepo ? 'updated' : 'skipped (no git repo)'}`,
        );
        if (result.sync) {
          printSync(result.sync, flags.verbose);
        }
        if (result.wire) {
          printWire(result.wire);
        }
        console.log(
          result.wire?.scriptsAdded.includes('postinstall')
            ? 'next: files are synced now, and every pnpm install will regenerate them'
            : 'next: add "postinstall": "config-loom sync" to the root package.json so every install regenerates the managed files (see README)',
        );
        return 0;
      }
      default:
        console.error(`loom: unknown command "${command}"`);
        console.log(USAGE);
        return 2;
    }
  } catch (e) {
    if (e instanceof LoomError) {
      console.error(`loom: ${e.message}`);
      return 1;
    }
    console.error(e);
    return 1;
  }
}

if (require.main === module) {
  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
