/**
 * Any value expressible in JSON.
 */
export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

/**
 * How a generated file is serialized.
 *
 * - `json`: strict JSON output (2-space indent).
 * - `jsonc`: like `json`, but reading accepts comments/trailing commas
 *   (tsconfig-style) and the generated header banner is enabled by default.
 * - `text`: verbatim content supplied by the matching rule (last one wins).
 */
export type FileFormat = 'json' | 'jsonc' | 'text';

/**
 * What happens when a rule patch contains an array and the base already has
 * one under the same key.
 *
 * - `replace`: the patch array wins (default — safest for tsconfig `include`
 *   and friends).
 * - `concat`: base + patch arrays are concatenated.
 * - `unique`: concatenated, then de-duplicated by canonical JSON value.
 */
export type ArrayPolicy = 'replace' | 'concat' | 'unique';

/**
 * One generated file, as written in config-loom.json before compilation.
 */
export interface FileSpecInput {
  format?: FileFormat;
  arrays?: ArrayPolicy;
  banner?: string | boolean;
  /**
   * Insertion-ordered map of `default` + regex patterns to content.
   * Regex keys are matched (anchored, full-match) against the workspace
   * directory path relative to the repo root, e.g. `libs/.*-application`.
   * A rule value of `null` opts the matched workspaces out of the file
   * (only meaningful when `default` is set).
   */
  rules: Record<string, JsonValue | string | null>;
}

/**
 * config-loom.json as read from disk (comments allowed).
 */
export interface LoomConfigInput {
  /** Globs of workspace directories to skip entirely. */
  exclude?: string[];
  files: Record<string, FileSpecInput>;
}

export interface CompiledRule {
  pattern: string;
  regex: RegExp;
  /** `null` marks an opt-out rule: matched workspaces get no file. */
  value: JsonValue | string | null;
}

export interface CompiledFileEntry {
  /** Path relative to each workspace root, e.g. `tsconfig.json`. */
  file: string;
  format: FileFormat;
  arrays: ArrayPolicy;
  banner: string | false;
  hasDefault: boolean;
  /** null when `default` is explicitly null (opt-in mode: only matches get a file). */
  defaultValue: JsonValue | string | null;
  /** Non-default rules, in declaration order. */
  rules: CompiledRule[];
}

export interface LoomConfig {
  exclude: string[];
  files: Record<string, CompiledFileEntry>;
}

export type ItemStatus = 'created' | 'updated' | 'unchanged' | 'deleted';

export interface SyncItem {
  workspace: string;
  file: string;
  status: ItemStatus;
  /** Absolute path of the (potential) output file. */
  path: string;
}

export interface SyncResult {
  items: SyncItem[];
  created: number;
  updated: number;
  unchanged: number;
  skipped: number;
  /** Generated files removed because a later opt-out (`null`) rule matched. */
  deleted: number;
}
