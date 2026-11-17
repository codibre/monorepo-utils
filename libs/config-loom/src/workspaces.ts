import { LoomError } from './errors';
import { execFile } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import picomatch from 'picomatch';
import { parse as parseYaml } from 'yaml';

const execFileAsync = promisify(execFile);

/**
 * Runs the equivalent of `pnpm -r exec pwd` at `root` and returns stdout.
 * Injectable so tests do not depend on a real pnpm install.
 */
export type WorkspaceRunner = (root: string) => Promise<string>;

const PNPM_ONLY_MESSAGE =
  'config-loom only supports pnpm workspaces for now: no pnpm-workspace.yaml found. Support for other package managers may come later.';

/**
 * Ask pnpm itself which projects exist: one `pwd` per line. This is the
 * ground truth — it honours pnpm-workspace.yaml semantics exactly (glob
 * negation, `packageManager` quirks, catalogs…) without reimplementing them.
 */
export const pnpmWorkspaceRunner: WorkspaceRunner = async (root) => {
  try {
    const { stdout } = await execFileAsync(
      'pnpm',
      ['--silent', '-r', 'exec', 'pwd'],
      { cwd: root, maxBuffer: 64 * 1024 * 1024 },
    );
    return stdout;
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { stderr?: string };
    if (err.code === 'ENOENT') {
      throw new LoomError(
        'pnpm not found on PATH — config-loom requires a pnpm workspace',
      );
    }
    const detail = (err.stderr ?? err.message).trim().split('\n').slice(-3);
    throw new LoomError(
      `'pnpm -r exec pwd' failed in ${root}:\n${detail.join('\n')}`,
    );
  }
};

/**
 * Workspace directories as pnpm sees them: every directory where
 * `pnpm -r exec pwd` runs (the workspace root itself is not a workspace).
 * Returns repo-root-relative posix paths, sorted; throws outside a pnpm
 * workspace. `exclude` globs drop directories afterwards.
 */
export async function discoverWorkspaces(
  root: string,
  exclude: string[] = [],
  runner: WorkspaceRunner = pnpmWorkspaceRunner,
): Promise<string[]> {
  try {
    await access(path.join(root, 'pnpm-workspace.yaml'));
  } catch {
    throw new LoomError(`${PNPM_ONLY_MESSAGE} (${root})`);
  }
  const stdout = await runner(root);
  const dirs = new Set<string>();
  for (const line of stdout.split('\n')) {
    const dir = line.trim();
    // pnpm may mix informational lines into stdout; only real paths count.
    if (dir === '' || !path.isAbsolute(dir)) {
      continue;
    }
    const rel = path.relative(root, dir).split(path.sep).join(path.posix.sep);
    if (rel === '' || rel === '.' || rel.startsWith('..')) {
      continue; // the root itself, or a path outside the repo
    }
    dirs.add(rel);
  }
  let kept = [...dirs];
  if (exclude.length > 0) {
    const isExcluded = picomatch(exclude);
    kept = kept.filter((dir) => !isExcluded(dir));
  }
  if (kept.length === 0) {
    throw new LoomError(
      `'pnpm -r exec pwd' listed no workspaces under ${root} (after applying exclude patterns, if any)`,
    );
  }
  return kept.sort();
}

/**
 * Raw `packages:` entries from pnpm-workspace.yaml, in declaration order
 * (negations kept as-is, trailing slashes trimmed). These are the shapes
 * where NEW projects can appear, which is exactly what pattern synthesis
 * wants to mirror. Returns `[]` when the file is missing or unparseable —
 * callers then fall back to narrower patterns.
 */
export async function readWorkspaceGlobs(root: string): Promise<string[]> {
  let text: string;
  try {
    text = await readFile(path.join(root, 'pnpm-workspace.yaml'), 'utf8');
  } catch {
    return [];
  }
  try {
    const data = parseYaml(text) as unknown;
    const packages =
      data !== null && typeof data === 'object'
        ? (data as { packages?: unknown }).packages
        : undefined;
    if (!Array.isArray(packages)) {
      return [];
    }
    return packages
      .filter((glob): glob is string => typeof glob === 'string')
      .map((glob) => glob.trim().replace(/\/+$/, ''))
      .filter((glob) => glob !== '');
  } catch {
    return [];
  }
}
