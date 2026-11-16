#!/usr/bin/env node
import { checkAll } from './check';
import { loadConfig } from './config';
import { StencilError } from './errors';
import { initRepo, serializeConfig } from './init';
import { syncAll } from './sync';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import type { SyncResult } from './types';

const USAGE = `turbo-stencil — keep monorepo config files in sync from one template

Usage:
  turbo-stencil <command> [options]

Commands:
  init        Reverse-engineer stencil.json from the config files scattered
              across workspaces, then delete them, gitignore them and
              regenerate them (use --dry-run to preview).
  sync        Generate every managed file (creates/updates only what changed).
  check       Exit 1 if any managed file is missing or stale. Never writes.
  version     Print the package version.
  help        This screen.

Options:
  --root <dir>        Repository root (default: cwd)
  --config <path>     stencil.json path (default: <root>/stencil.json)
  --files <a,b,...>   [init] only these file names (default: scan known ones)
  --dry-run           Print what would happen; change nothing
  --keep              [init] leave existing files on disk (sync overwrites)
  --force             [init] overwrite an existing stencil.json
  --yes               Skip the confirmation prompt
  --verbose           Also list unchanged files
  -h, --help          Same as 'help'
  -v, --version       Same as 'version'

Turbo wiring (install as a root devDependency, then):
  package.json  "scripts": { "turbo-stencil": "turbo-stencil sync" }
  turbo.json    "tasks": {
                  "//#turbo-stencil": {
                    "inputs": ["stencil.json", "pnpm-workspace.yaml"],
                    "outputs": ["apps/*/tsconfig.json", "libs/*/tsconfig.json"]
                  },
                  "build": { "dependsOn": ["//#turbo-stencil", "^build"] }
                }

Every turbo command regenerates the managed files first — from turbo's
cache when stencil.json did not change, so the cost is zero.
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
  };
}

async function packageVersion(): Promise<string> {
  const pkg = JSON.parse(
    await readFile(path.join(__dirname, '..', 'package.json'), 'utf8'),
  ) as { name?: string; version?: string };
  return `${pkg.name ?? 'turbo-stencil'} ${pkg.version ?? '0.0.0'}`;
}

function printSync(result: SyncResult, verbose: boolean): void {
  for (const item of result.items) {
    if (item.status === 'unchanged') {
      if (verbose) {
        console.log(`  = ${item.workspace}/${item.file}`);
      }
      continue;
    }
    const mark = item.status === 'created' ? '+' : '~';
    console.log(`  ${mark} ${item.workspace}/${item.file}`);
  }
  console.log(
    `created ${result.created}, updated ${result.updated}, unchanged ${result.unchanged}, skipped ${result.skipped}`,
  );
}

export async function main(argv: string[]): Promise<number> {
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
    console.error(`stencil: ${(e as Error).message}`);
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
        const result = await syncAll(config, root, { dryRun: flags.dryRun });
        printSync(result, flags.verbose);
        return 0;
      }
      case 'check': {
        const { config } = await loadConfig(root, flags.config);
        const { ok, drift } = await checkAll(config, root);
        if (!ok) {
          console.error(
            `stencil check failed — ${drift.length} file(s) out of sync:`,
          );
          for (const item of drift) {
            const mark = item.status === 'created' ? 'missing ' : 'outdated ';
            console.error(`  ${mark} ${item.workspace}/${item.file}`);
          }
          console.error("run 'turbo-stencil sync' to fix");
          return 1;
        }
        console.log(
          'turbo-stencil check ok — every managed file matches the stencil',
        );
        return 0;
      }
      case 'init': {
        const result = await initRepo(root, {
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
            `# stencil.json that init would write to ${result.configPath}:`,
          );
          process.stdout.write(serializeConfig(result.plan.config));
          console.log(
            `# regenerate ${result.plan.managedFiles.length} file(s):`,
          );
          for (const file of result.plan.managedFiles) {
            console.log(`#   ${file}`);
          }
          console.log(`# git rm --cached: ${result.untracked.length} file(s)`);
          return 0;
        }
        console.log(`wrote ${result.configPath}`);
        console.log(
          `git: untracked ${result.untracked.length} file(s), gitignore block ${result.gitRepo ? 'updated' : 'skipped (no git repo)'}`,
        );
        if (result.sync) {
          printSync(result.sync, flags.verbose);
        }
        console.log(
          'next: wire turbo-stencil — root devDependency + script "turbo-stencil": "turbo-stencil sync" + the //#turbo-stencil task in turbo.json that build/test/lint depend on (see README)',
        );
        return 0;
      }
      default:
        console.error(`stencil: unknown command "${command}"`);
        console.log(USAGE);
        return 2;
    }
  } catch (e) {
    if (e instanceof StencilError) {
      console.error(`stencil: ${e.message}`);
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
