import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export async function makeTempDir(prefix = 'turbo-stencil-'): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), prefix));
}

export async function putFile(
  root: string,
  rel: string,
  content: string,
): Promise<void> {
  const target = path.join(root, rel);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, 'utf8');
}

export async function getRel(root: string, rel: string): Promise<string> {
  return await readFile(path.join(root, rel), 'utf8');
}

export function workspaceName(rel: string): string {
  return rel.replace(/\//g, '-').replace(/[^a-zA-Z0-9-]/g, '-');
}

/**
 * Create a fake workspace: a directory with a package.json plus any extra
 * files. `rel` is repo-root relative (e.g. `apps/bff`).
 */
export async function createWorkspace(
  root: string,
  rel: string,
  files: Record<string, string> = {},
): Promise<void> {
  await putFile(
    root,
    `${rel}/package.json`,
    JSON.stringify({ name: workspaceName(rel), version: '1.0.0' }, null, 2) +
      '\n',
  );
  for (const [file, content] of Object.entries(files)) {
    await putFile(root, `${rel}/${file}`, content);
  }
}

export function tsConfig(overrides: Record<string, unknown> = {}): string {
  return (
    JSON.stringify(
      {
        compilerOptions: {
          target: 'es2023',
          ...overrides,
        },
        include: ['src'],
      },
      null,
      2,
    ) + '\n'
  );
}
