import { StencilError } from './errors';
import { isPlainObject } from './util';
import fg from 'fast-glob';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';

/**
 * Workspace globs from pnpm-workspace.yaml, falling back to the root
 * package.json "workspaces" field (string array or { packages }).
 */
export async function readWorkspaceGlobs(root: string): Promise<string[]> {
  try {
    const raw = await readFile(path.join(root, 'pnpm-workspace.yaml'), 'utf8');
    const data: unknown = parseYaml(raw);
    if (isPlainObject(data) && Array.isArray(data.packages)) {
      const list = data.packages.filter(
        (item): item is string =>
          typeof item === 'string' && item.trim() !== '',
      );
      if (list.length > 0) {
        return list;
      }
    }
  } catch {
    // no pnpm-workspace.yaml (or unreadable) — try package.json below
  }
  try {
    const pkg = JSON.parse(
      await readFile(path.join(root, 'package.json'), 'utf8'),
    ) as {
      workspaces?: unknown;
    };
    const ws = pkg.workspaces;
    const list = Array.isArray(ws)
      ? ws
      : isPlainObject(ws) && Array.isArray(ws.packages)
        ? ws.packages
        : null;
    if (list) {
      return list.filter(
        (item): item is string =>
          typeof item === 'string' && item.trim() !== '',
      );
    }
  } catch {
    // no root package.json either
  }
  return [];
}

/**
 * Expand workspace globs into concrete workspace directories (any directory
 * containing a package.json under a glob), repo-root-relative, posix, sorted.
 * Patterns starting with `!` negate; `exclude` drops directories afterwards.
 */
export async function discoverWorkspaces(
  root: string,
  globs: string[],
  exclude: string[] = [],
): Promise<string[]> {
  if (globs.length === 0) {
    throw new StencilError(
      'no workspace globs configured and none found in pnpm-workspace.yaml or package.json',
    );
  }
  const patterns = globs.map((glob) => {
    const negated = glob.startsWith('!');
    const body = (negated ? glob.slice(1) : glob).replace(/\/+$/, '');
    return `${negated ? '!' : ''}${body}/package.json`;
  });
  for (const glob of exclude) {
    patterns.push(`!${glob.replace(/\/+$/, '')}/package.json`);
  }
  const hits = await fg(patterns, { cwd: root, onlyFiles: true, dot: false });
  return [...new Set(hits.map((hit) => path.posix.dirname(hit)))]
    .filter((dir) => dir !== '' && dir !== '.')
    .sort();
}
