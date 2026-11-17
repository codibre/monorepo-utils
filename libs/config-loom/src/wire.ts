import { parseJsonc } from './jsonc';
import { isPlainObject } from './util';
import { applyEdits, modify, type ModificationOptions } from 'jsonc-parser';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const ROOT_TASK = '//#config-loom';

export interface TurboWire {
  file: string;
  /** The `//#config-loom` root task was created or replaced. */
  addedTask: boolean;
  /** Existing tasks that gained a `//#config-loom` dependsOn entry. */
  dependsOnAdded: string[];
}

export interface WireReport {
  /** Root scripts that were added (e.g. `postinstall`, `config-loom`). */
  scriptsAdded: string[];
  /** Human-readable notes for things wiring refused to clobber. */
  notes: string[];
  /** turbo.json changes; null when no turbo.json exists. */
  turbo: TurboWire | null;
}

const SYNC_COMMAND = 'config-loom sync';

const FORMAT: ModificationOptions = {
  formattingOptions: { insertSpaces: true, tabSize: 2, eol: '\n' },
};

const APPEND: ModificationOptions = { ...FORMAT, isArrayInsertion: true };

function canonical(value: unknown): string {
  return JSON.stringify(value) ?? '';
}

/**
 * Turbo `outputs` globs covering every managed file at every depth below
 * each top-level directory that holds workspaces. New sibling projects are
 * matched automatically; the list stays human-editable afterwards.
 */
export function deriveOutputs(workspaces: string[], files: string[]): string[] {
  const tops = [...new Set(workspaces.map((w) => w.split('/')[0] ?? w))];
  const globs = new Set<string>();
  for (const top of tops.sort()) {
    for (const file of files) {
      globs.add(`${top}/**/${file}`);
    }
  }
  return [...globs].sort();
}

async function readTextOrNull(target: string): Promise<string | null> {
  try {
    return await readFile(target, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Wire a repository: add `"postinstall": "config-loom sync"` to the root
 * package.json and, when `turbo.json` exists, a cached `//#config-loom` root
 * task that every other task depends on. Edits are surgical (jsonc-parser
 * `modify`), so comments and surrounding formatting survive, and the whole
 * operation is idempotent. Existing scripts are never overwritten — a
 * pre-existing postinstall earns a note telling you to chain the command.
 */
export async function wireRepo(
  root: string,
  options: { outputs: string[]; dryRun?: boolean },
): Promise<WireReport> {
  const report: WireReport = { scriptsAdded: [], notes: [], turbo: null };

  const turboPath = path.join(root, 'turbo.json');
  const turboText = await readTextOrNull(turboPath);
  const hasTurbo = turboText !== null;

  // ---- root package.json scripts ------------------------------------------
  const pkgPath = path.join(root, 'package.json');
  let pkgText = await readTextOrNull(pkgPath);
  if (pkgText === null) {
    report.notes.push(
      'no root package.json — wiring skipped (config-loom assumes a pnpm workspace root)',
    );
  } else {
    const pkg = parseJsonc(pkgText, pkgPath) as Record<string, unknown>;
    const scripts = isPlainObject(pkg.scripts) ? pkg.scripts : {};
    let text = pkgText;
    const put = (name: string, value: string) => {
      const current = scripts[name];
      if (typeof current === 'string') {
        if (current.includes(SYNC_COMMAND)) {
          return; // already wired
        }
        report.notes.push(
          `root script "${name}" exists (${JSON.stringify(current)}) — append \`${SYNC_COMMAND}\` to keep config-loom running`,
        );
        return;
      }
      const edits = modify(text, ['scripts', name], value, FORMAT);
      text = applyEdits(text, edits);
      report.scriptsAdded.push(name);
    };
    put('postinstall', SYNC_COMMAND);
    if (hasTurbo) {
      put('config-loom', SYNC_COMMAND); // the script //#config-loom runs
    }
    if (text !== pkgText && !options.dryRun) {
      await writeFile(pkgPath, text, 'utf8');
    }
    pkgText = text;
  }

  // ---- turbo.json ----------------------------------------------------------
  if (turboText !== null) {
    const turbo = parseJsonc(turboText, turboPath) as Record<string, unknown>;
    const tasksKey = isPlainObject(turbo.pipeline) ? 'pipeline' : 'tasks';
    const tasks = isPlainObject(turbo[tasksKey])
      ? (turbo[tasksKey] as Record<string, unknown>)
      : {};

    const desired = {
      inputs: ['config-loom.jsonc', 'config-loom.json', 'pnpm-workspace.yaml'],
      outputs: options.outputs,
      cache: true,
    };

    let text = turboText;
    let addedTask = false;
    const current = tasks[ROOT_TASK];
    if (canonical(current) !== canonical(desired)) {
      // Only create/replace when absent or not already exactly our wiring.
      if (
        current === undefined ||
        (isPlainObject(current) && current['package.json'] === undefined)
      ) {
        text = applyEdits(
          text,
          modify(text, [tasksKey, ROOT_TASK], desired, FORMAT),
        );
        addedTask = true;
      } else {
        report.notes.push(
          `turbo.json "${ROOT_TASK}" looks hand-written — left untouched`,
        );
      }
    }

    const dependsOnAdded: string[] = [];
    for (const [name, spec] of Object.entries(tasks)) {
      if (name === ROOT_TASK || name.startsWith('#')) {
        continue;
      }
      const task = spec === null || spec === undefined ? {} : spec;
      if (!isPlainObject(task)) {
        continue;
      }
      const deps = (task as Record<string, unknown>).dependsOn;
      if (Array.isArray(deps)) {
        if (deps.includes(ROOT_TASK)) {
          continue;
        }
        text = applyEdits(
          text,
          modify(
            text,
            [tasksKey, name, 'dependsOn', deps.length],
            ROOT_TASK,
            APPEND,
          ),
        );
        dependsOnAdded.push(name);
      } else if (deps === undefined) {
        text = applyEdits(
          text,
          modify(text, [tasksKey, name, 'dependsOn'], [ROOT_TASK], FORMAT),
        );
        dependsOnAdded.push(name);
      }
    }

    if (addedTask || dependsOnAdded.length > 0) {
      report.turbo = { file: 'turbo.json', addedTask, dependsOnAdded };
      if (!options.dryRun) {
        await writeFile(turboPath, text, 'utf8');
      }
    }
  }

  return report;
}
