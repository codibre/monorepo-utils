import { readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export const GITIGNORE_BEGIN = '# BEGIN turbo-stencil generated files';
export const GITIGNORE_END = '# END turbo-stencil generated files';

const UNTRACK_CHUNK = 50;

export async function isGitRepo(root: string): Promise<boolean> {
  try {
    await run('git', ['rev-parse', '--is-inside-work-tree'], { cwd: root });
    return true;
  } catch {
    return false;
  }
}

/** Repo files tracked by git, as paths relative to `root`. */
export async function listTrackedFiles(root: string): Promise<Set<string>> {
  const { stdout } = await run('git', ['ls-files', '-z'], {
    cwd: root,
    maxBuffer: 64 * 1024 * 1024,
  });
  return new Set(stdout.split('\0').filter(Boolean));
}

/**
 * `git rm --cached` without touching the working tree — the file stays on
 * disk (regenerated right away) but leaves future commits.
 */
export async function untrackFiles(
  root: string,
  files: string[],
): Promise<void> {
  for (let i = 0; i < files.length; i += UNTRACK_CHUNK) {
    await run(
      'git',
      ['rm', '--cached', '--quiet', '--', ...files.slice(i, i + UNTRACK_CHUNK)],
      {
        cwd: root,
      },
    );
  }
}

export function buildGitignoreBlock(patterns: string[]): string {
  const body = [...patterns].sort();
  return `${GITIGNORE_BEGIN}\n${body.join('\n')}\n${GITIGNORE_END}\n`;
}

/**
 * Replace (or append) the delimited turbo-stencil block in the root
 * .gitignore. Idempotent: running it twice produces the same file.
 */
export async function updateGitignoreBlock(
  root: string,
  patterns: string[],
): Promise<void> {
  const target = path.join(root, '.gitignore');
  let content = '';
  try {
    content = await readFile(target, 'utf8');
  } catch {
    content = '';
  }
  const block = buildGitignoreBlock(patterns);
  const begin = content.indexOf(GITIGNORE_BEGIN);
  const end = content.indexOf(GITIGNORE_END);
  if (begin >= 0 && end > begin) {
    const after = content.slice(end + GITIGNORE_END.length);
    content = `${content.slice(0, begin)}${block}${after.startsWith('\n') ? after.slice(1) : after}`;
  } else {
    if (content.length > 0 && !content.endsWith('\n')) {
      content += '\n';
    }
    if (content.length > 0) {
      content += '\n';
    }
    content += block;
  }
  await writeFile(target, content, 'utf8');
}
