import { renderCandidates, renderFile, scopeFor } from './render';
import { tsEquivalent } from './tsformat';
import { isJsonFormat } from './util';
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
        // No entry scope covers this workspace (or its scope excluded it).
        // Remove a file WE generated earlier — never one we cannot prove
        // we wrote. Authorship is proven by any scope's banner prefix, or
        // (json/jsonc only) by byte-equality with a canonical render this
        // loom could have produced: canonical JSON is distinctive enough,
        // plain text and TypeScript source are not.
        const current = await readOrNull(target);
        const provable =
          current !== null &&
          (entry.scopes.some(
            (scope) =>
              scope.banner !== false && current.startsWith(scope.banner),
          ) ||
            (entry.scopes.some((scope) => isJsonFormat(scope.format)) &&
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
      } else if (
        scopeFor(entry, workspace)?.format === 'ts' &&
        tsEquivalent(current, content, entry.file)
      ) {
        // A ts file is up to date when it is the same CODE — a prettier
        // pass or hand reformat must not count as drift, and rewriting it
        // would only start a formatting tug-of-war with the repo's own
        // formatter.
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
