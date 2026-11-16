import { renderFile } from './render';
import { discoverWorkspaces, readWorkspaceGlobs } from './workspaces';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ItemStatus, StencilConfig, SyncItem, SyncResult } from './types';

async function readOrNull(target: string): Promise<string | null> {
  try {
    return await readFile(target, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Generate every managed file for every workspace. Files already holding the
 * exact rendered content are left untouched (mtime preserved), so this is
 * cheap enough to run as a root task before every turbo command.
 */
export async function syncAll(
  config: StencilConfig,
  root: string,
  options: { dryRun?: boolean } = {},
): Promise<SyncResult> {
  const globs = config.workspaces ?? (await readWorkspaceGlobs(root));
  const workspaces = await discoverWorkspaces(root, globs, config.exclude);
  const result: SyncResult = {
    items: [],
    created: 0,
    updated: 0,
    unchanged: 0,
    skipped: 0,
  };

  for (const workspace of workspaces) {
    for (const entry of Object.values(config.files)) {
      const content = renderFile(entry, workspace);
      if (content === null) {
        result.skipped += 1;
        continue;
      }
      const target = path.join(root, workspace, entry.file);
      const current = await readOrNull(target);
      let status: ItemStatus;
      if (current === null) {
        status = 'created';
      } else if (current === content) {
        status = 'unchanged';
      } else {
        status = 'updated';
      }
      if (status !== 'unchanged' && !options.dryRun) {
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, content, 'utf8');
      }
      result[status] += 1;
      const item: SyncItem = {
        workspace,
        file: entry.file,
        status,
        path: target,
      };
      result.items.push(item);
    }
  }

  return result;
}
