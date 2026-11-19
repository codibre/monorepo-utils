import { findConfigFile, resolveTemplates, compileConfig } from './config';
import { LoomError } from './errors';
import {
  isGitRepo,
  listTrackedFiles,
  untrackFiles,
  updateGitignoreBlock,
} from './git';
import { synthesizeIgnoreList } from './ignore';
import { buildPlan, serializeConfig } from './init';
import { scopeFor } from './render';
import { syncAll } from './sync';
import { discoverWorkspaces, readWorkspaceGlobs } from './workspaces';
import { readFile, writeFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import type { FileSpecInput, LoomConfigInput, SyncResult } from './types';
import type { WorkspaceRunner } from './workspaces';

export interface RefreshOptions {
  /** Explicit loom path (default: the first config-loom.yaml/yml at root). */
  configPath?: string;
  /** Restrict re-derivation to these managed file names (default: all). */
  filenames?: string[];
  /** Report only: write neither the loom nor the files. */
  dryRun?: boolean;
  runner?: WorkspaceRunner;
  /** Override pnpm-workspace globs (tests). */
  globs?: string[];
}

export interface RefreshEntryReport {
  /** The managed file this report covers. */
  file: string;
  /** Loom entry keys rewritten (alias keys are preserved as-is). */
  keys: string[];
  status: 'updated' | 'unchanged' | 'preserved';
  /** Rule counts before and after re-derivation. */
  rules: [number: number, after: number];
  /** Why the entry was preserved untouched, when it was. */
  reason?: string;
}

export interface RefreshResult {
  configPath: string;
  /** Whether the loom content changed (comments/whitespace ignored). */
  changed: boolean;
  reports: RefreshEntryReport[];
  workspaces: string[];
  gitRepo: boolean;
  /** Managed files taken out of the git index — they stay on disk. */
  untracked: string[];
  /** The full .gitignore block patterns after the refresh. */
  ignorePatterns: string[];
  /** The loom text as it was (or would be) written. */
  newConfig: string;
  /** The sync result validating the regenerated files (absent on dry runs). */
  sync?: SyncResult;
}

/** The target file an entry writes: its `filename` prop or its key. */
function fileOf(name: string, spec: FileSpecInput): string {
  return spec.filename ?? name;
}

function entryText(name: string, entry: FileSpecInput): string {
  return serializeConfig({ files: { [name]: entry } });
}

/**
 * Re-derive the loom from the CURRENT workspace state — the forward answer
 * to `add`: a new project appeared with hand-written configs (or somebody
 * edited a generated one by hand), and instead of translating that edit
 * into rules by hand, refresh clusters every current file again (init's
 * exact machinery) and rewrites each managed entry so the loom reproduces
 * what is on disk.
 *
 * Identity and curation survive: entry keys (including alias keys),
 * entries sharing one filename, entries with no file currently on disk, and
 * entries outside the requested subset are kept exactly as they were —
 * only single-entry files that were found get their default/rules
 * regenerated. The top-level workspace `exclude` list is preserved (init
 * regenerates from scratch; refresh respects what the owner curated).
 * The git phase matches init/add: generated files leave the index and the
 * wildcard-first `.gitignore` block is re-synthesized from the complete
 * managed set.
 */
export async function refreshLoom(
  root: string,
  options: RefreshOptions = {},
): Promise<RefreshResult> {
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

  const keysByFile = new Map<string, string[]>();
  for (const [name, spec] of Object.entries(files)) {
    const plain =
      spec !== null && typeof spec === 'object' && !Array.isArray(spec);
    const file = plain ? fileOf(name, spec) : name;
    const group = keysByFile.get(file) ?? [];
    group.push(name);
    keysByFile.set(file, group);
  }

  let refreshSet: string[];
  if (options.filenames !== undefined && options.filenames.length > 0) {
    refreshSet = options.filenames.map((raw) => raw.trim());
    const unknown = refreshSet.filter((file) => !keysByFile.has(file));
    if (unknown.length > 0) {
      throw new LoomError(
        `not managed by ${configPath}: ${unknown.join(', ')} — add them first with 'config-loom add'`,
      );
    }
  } else {
    refreshSet = [...keysByFile.keys()];
  }

  const globs = options.globs ?? (await readWorkspaceGlobs(root));
  const plan = await buildPlan(root, {
    files: refreshSet,
    runner: options.runner,
    globs,
  });

  const reports: RefreshEntryReport[] = [];
  const mergedFiles: Record<string, FileSpecInput> = {};
  for (const [name, spec] of Object.entries(files)) {
    const plain =
      spec !== null && typeof spec === 'object' && !Array.isArray(spec);
    const file = plain ? fileOf(name, spec) : name;
    if (!refreshSet.includes(file)) {
      mergedFiles[name] = spec;
      continue;
    }
    const group = keysByFile.get(file) ?? [name];
    const derived = plan.config.files[file];
    const rulesBefore = (spec.rules ?? []).length;
    let merged: FileSpecInput = spec;
    let status: RefreshEntryReport['status'] = 'preserved';
    let reason: string | undefined;
    if (group.length > 1) {
      reason = 'several entries share this filename';
    } else if (!plain) {
      reason = 'malformed entry (fix it in the loom)';
    } else if (derived === undefined) {
      reason = 'no file found on any workspace — kept as is';
    } else {
      merged = {
        ...derived,
        ...(name === file ? {} : { filename: file }),
      };
      status =
        entryText(name, spec) === entryText(name, merged)
          ? 'unchanged'
          : 'updated';
    }
    mergedFiles[name] = merged;
    const existing = reports.find((report) => report.file === file);
    if (existing === undefined) {
      reports.push({
        file,
        keys: group,
        status,
        rules: [rulesBefore, (merged.rules ?? []).length],
        reason,
      });
    } else {
      existing.keys.push(...group);
      existing.rules = [
        existing.rules[0] + rulesBefore,
        existing.rules[1] + (merged.rules ?? []).length,
      ];
      if (status === 'preserved' && existing.status !== 'preserved') {
        existing.status = 'preserved';
        existing.reason = reason ?? 'mixed entries';
      }
    }
  }

  const merged: LoomConfigInput = { ...input, files: mergedFiles };
  // Validate the WHOLE loom before touching disk.
  const resolved = await resolveTemplates(merged, root, configPath);
  const config = compileConfig(resolved, configPath);

  const workspaces = await discoverWorkspaces(
    root,
    config.exclude,
    options.runner,
  );
  const gitRepo = await isGitRepo(root);
  const tracked = gitRepo ? await listTrackedFiles(root) : new Set<string>();
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
  const newConfig = serializeConfig(merged);
  const changed = newConfig !== serializeConfig({ ...input });

  if (options.dryRun === true) {
    return {
      configPath,
      changed,
      reports,
      workspaces,
      gitRepo,
      untracked,
      ignorePatterns,
      newConfig,
    };
  }

  if (changed) {
    await writeFile(configPath, newConfig, 'utf8');
  }
  const sync = await syncAll(config, root, { runner: options.runner });
  if (gitRepo) {
    if (untracked.length > 0) {
      await untrackFiles(root, untracked);
    }
    await updateGitignoreBlock(root, ignorePatterns);
  }
  return {
    configPath,
    changed,
    reports,
    workspaces,
    gitRepo,
    untracked,
    ignorePatterns,
    newConfig,
    sync,
  };
}
