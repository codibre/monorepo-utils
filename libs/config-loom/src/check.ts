import { syncAll } from './sync';
import type { WorkspaceRunner } from './workspaces';
import type { LoomConfig, SyncItem, SyncResult } from './types';

export interface CheckResult {
  ok: boolean;
  /** Files that are missing or differ from what the loom would generate. */
  drift: SyncItem[];
  result: SyncResult;
}

/**
 * CI-side guarantee: generate everything in memory and fail if any managed
 * file on disk is stale or missing. Never writes.
 */
export async function checkAll(
  config: LoomConfig,
  root: string,
  options: { runner?: WorkspaceRunner } = {},
): Promise<CheckResult> {
  const result = await syncAll(config, root, {
    dryRun: true,
    runner: options.runner,
  });
  const drift = result.items.filter((item) => item.status !== 'unchanged');
  return { ok: drift.length === 0, drift, result };
}
