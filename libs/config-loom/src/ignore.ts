import picomatch from 'picomatch';

/**
 * Inputs for gitignore-pattern synthesis.
 */
export interface IgnoreSynthesisInput {
  /** Workspaces that currently hold a managed copy of the file. */
  workspaces: string[];
  /** `packages:` globs from pnpm-workspace.yaml (negations are ignored). */
  globs: string[];
  /** Every file tracked by git, repo-root relative. */
  tracked: Iterable<string>;
  /** Every path config-loom owns (regenerates). A wildcard may only cover tracked files from this set. */
  managed: ReadonlySet<string>;
}

/**
 * A wildcard is safe when it matches no tracked file that config-loom does
 * not own — a hand-written file (or one that never parses for the loom)
 * must never fall silently into the ignore block.
 */
function isSafePattern(
  pattern: string,
  tracked: string[],
  managed: ReadonlySet<string>,
): boolean {
  const isMatch = picomatch(pattern, { dot: true });
  return !tracked.some((file) => !managed.has(file) && isMatch(file));
}

function parentDir(workspace: string): string | null {
  const cut = workspace.lastIndexOf('/');
  return cut > 0 ? workspace.slice(0, cut) : null;
}

/**
 * Turn a managed file into as few gitignore patterns as possible, so adding
 * a new subproject never requires editing `.gitignore` again:
 *
 * 1. each pnpm workspace glob (`apps/*`, `packages/**`, …) becomes
 *    `<glob>/<file>` — this mirrors exactly where new projects can appear;
 * 2. remaining workspaces collapse to `<parent>` + `/*` + `<file>`;
 * 3. anything left (or anything a wildcard would over-cover) is enumerated.
 *
 * Every wildcard is validated against the tracked file set first: if a
 * pattern would ignore a tracked file that is not managed by the loom, the
 * pattern is rejected and those workspaces fall through to the next shape.
 */
export function synthesizeIgnorePatterns(
  file: string,
  input: IgnoreSynthesisInput,
): string[] {
  const tracked = [...input.tracked];
  const uncovered = new Set(input.workspaces);
  const patterns: string[] = [];

  // 1. pnpm workspace globs, in declaration order.
  for (const raw of input.globs) {
    if (uncovered.size === 0) {
      break;
    }
    if (raw.startsWith('!')) {
      continue; // negated entries only trim pnpm's expansion, never widen ours
    }
    const glob = raw.replace(/\/+$/, '');
    if (glob === '') {
      continue;
    }
    const pattern = `${glob}/${file}`;
    const covered = [...uncovered].filter((workspace) =>
      picomatch.isMatch(workspace, glob, { dot: true }),
    );
    if (
      covered.length === 0 ||
      !isSafePattern(pattern, tracked, input.managed)
    ) {
      continue;
    }
    patterns.push(pattern);
    for (const workspace of covered) {
      uncovered.delete(workspace);
    }
  }

  // 2. shared parent directories, biggest group first.
  const emittedParents = new Set<string>();
  while (uncovered.size > 0 && emittedParents.size < uncovered.size + 1) {
    const groups = new Map<string, string[]>();
    for (const workspace of uncovered) {
      const parent = parentDir(workspace);
      if (parent !== null) {
        const group = groups.get(parent) ?? [];
        group.push(workspace);
        groups.set(parent, group);
      }
    }
    const best = [...groups.entries()]
      .filter(([parent]) => !emittedParents.has(parent))
      .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))[0];
    if (!best) {
      break;
    }
    const [parent, members] = best;
    emittedParents.add(parent);
    const pattern = `${parent}/*/${file}`;
    if (isSafePattern(pattern, tracked, input.managed)) {
      patterns.push(pattern);
      for (const workspace of members) {
        uncovered.delete(workspace);
      }
    }
  }

  // 3. whatever is left is enumerated verbatim.
  for (const workspace of uncovered) {
    patterns.push(`${workspace}/${file}`);
  }
  return [...new Set(patterns)].sort();
}

/**
 * Build the whole gitignore block content from the explicit set of managed
 * `<workspace>/<file>` entries (never inferred by suffix-stripping: one spec
 * name can be a suffix of another spec's path).
 */
export function synthesizeIgnoreList(
  entries: Iterable<{ workspace: string; file: string }>,
  globs: string[],
  tracked: Set<string>,
): string[] {
  const byFile = new Map<string, string[]>();
  const managed = new Set<string>();
  for (const { workspace, file } of entries) {
    managed.add(`${workspace}/${file}`);
    const group = byFile.get(file) ?? [];
    group.push(workspace);
    byFile.set(file, group);
  }
  const out = new Set<string>();
  for (const [file, workspaces] of byFile) {
    for (const pattern of synthesizeIgnorePatterns(file, {
      workspaces,
      globs,
      tracked,
      managed,
    })) {
      out.add(pattern);
    }
  }
  return [...out].sort();
}
