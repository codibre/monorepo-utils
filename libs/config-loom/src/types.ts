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
 * One rule as written in config-loom.yaml: a `pattern` prop plus its
 * `value`. A pattern is a regular expression matched (anchored, full match)
 * against the workspace directory path relative to the repo root, e.g.
 * `libs/.*-application`. It matches directories literally, so a pattern of
 * `default` matches a workspace folder named `default` — the base content
 * is the sibling `default` property of the file spec, never a pattern.
 * A `value` of `null` (or absent) opts the matched workspaces out of the
 * file (only meaningful when a `default` exists). Instead of an inline
 * `value`, a rule may carry `template`: a repo-relative path whose file
 * content becomes the value (handy when the content is a big script).
 */
export interface RuleInput {
  pattern: string;
  value?: JsonValue | string | null;
  /** Repo-relative template file; mutually exclusive with `value`. */
  template?: string | null;
}

/**
 * One generated file, as written in config-loom.yaml before compilation.
 */
export interface FileSpecInput {
  format?: FileFormat;
  arrays?: ArrayPolicy;
  banner?: string | boolean;
  /**
   * Base content every matching workspace starts from. `null` (or absent)
   * makes the entry opt-in: only workspaces hit by a non-null rule get the
   * file. Instead of an inline value, a spec may carry `template`: a
   * repo-relative path whose file content becomes the default (mutually
   * exclusive with `default`).
   */
  default?: JsonValue | string | null;
  /** Repo-relative template file for `default`; resolved by loadConfig. */
  template?: string | null;
  /**
   * Ordered list of `{ pattern, value }` rules, merged over `default` and
   * each other — later rules win (specific props beat `default`). A rule
   * value of `null` opts its matches out of the file.
   */
  rules?: RuleInput[];
  /**
   * Regular expressions (same syntax as rule keys, full match against the
   * workspace directory) for workspaces that must NEVER receive this file.
   * A hard opt-out: it beats `default` and every rule, at any position.
   * Prefer directory/naming families (`packages/mq-.*`,
   * `packages/.*-medicine-quotation-sdk`) over name lists, so new projects
   * joining the family stay excluded without editing anything.
   */
  exclude?: string[];
}

/**
 * config-loom.yaml as read from disk (comments allowed).
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
  /** Compiled per-file `exclude` patterns: hard opt-out, beats everything. */
  exclude: RegExp[];
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
