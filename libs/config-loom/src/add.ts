import {
  compileConfig,
  defaultFormatFor,
  findConfigFile,
  resolveTemplates,
} from './config';
import { LoomError } from './errors';
import {
  isGitRepo,
  listTrackedFiles,
  untrackFiles,
  updateGitignoreBlock,
} from './git';
import { synthesizeIgnoreList } from './ignore';
import { buildPlan, serializeConfig, synthesizePattern } from './init';
import { KNOWN_TEMPLATES } from './registry';
import { scopeFor } from './render';
import { readOrNull } from './util';
import { syncAll } from './sync';
import { discoverWorkspaces, readWorkspaceGlobs } from './workspaces';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import type {
  FileSpecInput,
  LoomConfigInput,
  SyncItem,
  SyncResult,
} from './types';
import type { WorkspaceRunner } from './workspaces';

export interface AddOptions {
  /** Explicit loom path (default: the first config-loom.yaml/yml at root). */
  configPath?: string;
  /** Repo-relative template file supplying the content (single filename only). */
  template?: string;
  /** Scope restriction written into every added entry (regexes, full match). */
  include?: string[];
  /** Hard opt-out written into every added entry (regexes, full match). */
  exclude?: string[];
  /** Validate and report only: write neither the loom nor the files. */
  dryRun?: boolean;
  runner?: WorkspaceRunner;
}

export interface AddedEntry {
  /** The `files:` key of the added entry (the normalized filename). */
  entryName: string;
  /** Where the content came from. */
  source: 'template' | 'disk' | 'known';
  /** The entry exactly as it was (or would be) written into the loom. */
  entry: FileSpecInput;
  /** Workspaces that received the file (statuses other than unchanged). */
  generated: SyncItem[];
}

export interface AddResult {
  /** The loom file used (or that would be written). */
  configPath: string;
  /** One record per requested filename, in request order. */
  added: AddedEntry[];
  /** In-scope workspaces discovered at add time. */
  workspaces: string[];
  /** Whether the root is a git repo (the git phase below ran/applies). */
  gitRepo: boolean;
  /** Managed files taken out of the git index — they stay on disk. */
  untracked: string[];
  /** The full .gitignore block patterns after the addition. */
  ignorePatterns: string[];
  /** The full sync result (absent on dry runs). */
  sync?: SyncResult;
}

/** Workspace-relative target: no absolute paths, no escaping `..` segments. */
function normalizeTarget(raw: string, label: string): string {
  const slash = raw.split(path.sep).join('/');
  if (slash.length === 0 || path.isAbsolute(raw) || slash.startsWith('/')) {
    throw new LoomError(
      `${label}: expected a workspace-relative file name, got "${raw}"`,
    );
  }
  const segments = slash
    .split('/')
    .filter((part) => part !== '' && part !== '.');
  if (segments.length === 0 || segments.some((part) => part === '..')) {
    throw new LoomError(`${label}: "${raw}" escapes the workspace directory`);
  }
  return segments.join('/');
}

/**
 * Add managed files to the loom and sync every in-scope workspace with
 * them — keeping init's whole contract: the generated files leave the git
 * index (staying on disk) and the delimited `.gitignore` block is
 * re-synthesized from ALL managed entries with the wildcard-first shapes,
 * so each new file lands exactly where init would have placed it, and a
 * later `init --force` regenerates the identical block.
 *
 * Content source per filename: `--template` first (single-filename adds
 * only), then the CURRENT on-disk instances clustered exactly as init
 * would (so adopting files that already exist keeps every variant as a
 * rule instead of overwriting them), then the built-in registry keyed by
 * basename (see registry.ts) for files no workspace has yet. An unknown
 * name that exists nowhere and has no template is an error pointing at
 * both alternatives. Added entries are plain loom entries afterwards:
 * scopes, rules and templates can be edited by hand, and new workspaces
 * inherit the files with zero loom edits.
 */
export async function addFiles(
  root: string,
  filenames: string[],
  options: AddOptions = {},
): Promise<AddResult> {
  if (filenames.length === 0) {
    throw new LoomError('add requires at least one file name');
  }
  if (options.template !== undefined && filenames.length > 1) {
    throw new LoomError(
      '--template supplies content for ONE file name; run one add per file',
    );
  }
  const targets = filenames.map((raw) => normalizeTarget(raw, 'filename'));
  const duplicates = targets.filter(
    (target, index) => targets.indexOf(target) !== index,
  );
  if (duplicates.length > 0) {
    throw new LoomError(
      `duplicate file name in add request: ${[...new Set(duplicates)].join(', ')}`,
    );
  }

  const configPath = await findConfigFile(root, options.configPath);
  const parsed = parseYaml(await readFile(configPath, 'utf8'), {
    prettyErrors: true,
  }) as unknown;
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new LoomError(
      `${configPath}: expected a YAML mapping at the top level`,
    );
  }
  const input = parsed as LoomConfigInput;
  const files: Record<string, FileSpecInput> = { ...input.files };

  const targetLabel = (name: string, spec: FileSpecInput): string =>
    spec.filename !== undefined
      ? normalizeTarget(spec.filename, `files["${name}"].filename`)
      : normalizeTarget(name, `files["${name}"] (entry key)`);
  for (const [name, spec] of Object.entries(files)) {
    const plain =
      spec !== null && typeof spec === 'object' && !Array.isArray(spec);
    if (!plain) {
      continue; // compileConfig reports malformed entries below
    }
    const existing = targetLabel(name, spec);
    if (targets.includes(existing)) {
      throw new LoomError(
        `"${existing}" is already managed by entry "${name}" — edit ${configPath} and run 'config-loom sync' instead`,
      );
    }
  }

  const added: AddedEntry[] = [];
  const globs = await readWorkspaceGlobs(root);
  const probeWorkspaces = await discoverWorkspaces(
    root,
    input.exclude ?? [],
    options.runner,
  );
  for (const target of targets) {
    let entry: FileSpecInput;
    let source: AddedEntry['source'];
    if (options.template !== undefined) {
      entry = { format: defaultFormatFor(target), template: options.template };
      source = 'template';
    } else {
      // Adopt whatever the repo already has: cluster the current on-disk
      // instances so divergent files (a cargo hook, an older shim) survive
      // as rules instead of being steamrolled by a template.
      let present = false;
      for (const workspace of probeWorkspaces) {
        if ((await readOrNull(path.join(root, workspace, target))) !== null) {
          present = true;
          break;
        }
      }
      const plan = present
        ? await buildPlan(root, {
            files: [target],
            runner: options.runner,
            globs,
            templateThreshold: 0,
          })
        : undefined;
      const derived = plan?.config.files[target];
      const base = target.split('/').pop() ?? target;
      const known = KNOWN_TEMPLATES[base];
      const format = defaultFormatFor(target);
      if (
        derived !== undefined &&
        known !== undefined &&
        format !== 'json' &&
        format !== 'yaml'
      ) {
        // Hybrid: the known template becomes the guarantee for EVERY
        // in-scope workspace (including ones that never had the file —
        // the lazy-structures failure mode), while each on-disk variant
        // is preserved verbatim as a rule.
        const rules = [...(derived.rules ?? [])];
        const defaultCluster = plan?.clusters.find(
          (cluster) => cluster.file === target && cluster.kind === 'default',
        );
        if (
          defaultCluster !== undefined &&
          defaultCluster.members.length > 0 &&
          typeof derived.default === 'string' &&
          derived.default !== known.content
        ) {
          rules.unshift({
            pattern: synthesizePattern(
              defaultCluster.members,
              plan?.workspaces ?? [],
              globs,
            ),
            value: derived.default,
          });
        }
        entry = { ...derived, default: known.content, rules };
        delete entry.include;
        delete entry.exclude;
        source = 'disk';
      } else if (derived !== undefined) {
        entry = derived;
        source = 'disk';
      } else if (known !== undefined) {
        entry = { format: known.format, default: known.content };
        source = 'known';
      } else {
        throw new LoomError(
          `no content source for "${target}": no workspace has it — pass ` +
            '--template <repo-relative path>, seed an on-disk file with ' +
            `'config-loom init --files ${base} --force', or choose a known ` +
            `template: ${Object.keys(KNOWN_TEMPLATES).join(', ')}`,
        );
      }
    }
    if (options.include !== undefined && options.include.length > 0) {
      entry.include = [...options.include];
    }
    if (options.exclude !== undefined && options.exclude.length > 0) {
      entry.exclude = [...options.exclude];
    }
    files[target] = entry;
    added.push({ entryName: target, source, entry, generated: [] });
  }

  const merged: LoomConfigInput = { ...input, files };
  // Validate the WHOLE loom (templates resolved) before touching disk: an
  // entry that cannot compile must leave the previous loom untouched.
  const resolved = await resolveTemplates(merged, root, configPath);
  const config = compileConfig(resolved, configPath);

  const workspaces = await discoverWorkspaces(
    root,
    config.exclude,
    options.runner,
  );
  const gitRepo = await isGitRepo(root);
  const tracked = gitRepo ? await listTrackedFiles(root) : new Set<string>();

  // Re-synthesize the gitignore block from the COMPLETE managed set (all
  // entries, not just the added ones) so shapes and ordering are exactly
  // what init would produce for this repo.
  const managedEntries: { workspace: string; file: string }[] = [];
  for (const entry of Object.values(config.files)) {
    for (const workspace of workspaces) {
      if (scopeFor(entry, workspace) !== null) {
        managedEntries.push({ workspace, file: entry.file });
      }
    }
  }
  const untracked = managedEntries
    .map(({ workspace, file }) => `${workspace}/${file}`)
    .filter((file) => tracked.has(file))
    .sort();
  const ignorePatterns = synthesizeIgnoreList(managedEntries, globs, tracked);

  if (options.dryRun === true) {
    // a dry sync enumerates exactly which workspaces WOULD receive the file
    const dry = await syncAll(config, root, {
      dryRun: true,
      runner: options.runner,
    });
    for (const record of added) {
      record.generated = dry.items.filter(
        (item) => item.file === record.entryName && item.status !== 'unchanged',
      );
    }
    return {
      configPath,
      added,
      workspaces,
      gitRepo,
      untracked,
      ignorePatterns,
    };
  }

  await writeFile(configPath, serializeConfig(merged), 'utf8');
  const sync = await syncAll(config, root, { runner: options.runner });
  for (const record of added) {
    record.generated = sync.items.filter(
      (item) => item.file === record.entryName && item.status !== 'unchanged',
    );
  }
  if (gitRepo) {
    if (untracked.length > 0) {
      await untrackFiles(root, untracked);
    }
    await updateGitignoreBlock(root, ignorePatterns);
  }
  return {
    configPath,
    added,
    workspaces,
    gitRepo,
    untracked,
    ignorePatterns,
    sync,
  };
}
