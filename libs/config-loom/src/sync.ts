import { renderCandidates, renderFile } from './render';
import type { WorkspaceRunner } from './workspaces';
import { discoverWorkspaces } from './workspaces';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ItemStatus, LoomConfig, SyncItem, SyncResult } from './types';

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
  config: LoomConfig,
  root: string,
  options: { dryRun?: boolean; runner?: WorkspaceRunner } = {},
): Promise<SyncResult> {
  const workspaces = await discoverWorkspaces(
    root,
    config.exclude,
    options.runner,
  );
  const result: SyncResult = {
    items: [],
    created: 0,
    updated: 0,
    unchanged: 0,
    skipped: 0,
    deleted: 0,
  };

  for (const workspace of workspaces) {
    for (const entry of Object.values(config.files)) {
      const content = renderFile(entry, workspace);
      const target = path.join(root, workspace, entry.file);
      if (content === null) {
        // The workspace opted out (default: null, or a null rule matched).
        // Remove a file WE generated earlier — never one we cannot prove
        // we wrote. Authorship is proven by the banner prefix, or (json/
        // jsonc only) by byte-equality with a canonical render this loom
        // could have produced: canonical JSON is distinctive enough, plain
        // text is not.
        const current = await readOrNull(target);
        const provable =
          current !== null &&
          ((entry.banner !== false && current.startsWith(entry.banner)) ||
            (entry.format !== 'text' &&
              renderCandidates(entry).includes(current)));
        if (provable) {
          if (!options.dryRun) {
            await unlink(target);
          }
          result.deleted += 1;
          result.items.push({
            workspace,
            file: entry.file,
            status: 'deleted',
            path: target,
          });
        } else {
          result.skipped += 1;
        }
        continue;
      }
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
