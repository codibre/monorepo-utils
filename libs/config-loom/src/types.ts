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
 * - `ts`: verbatim TypeScript/JavaScript source supplied by the matching
 *   rule (last one wins), but equivalence is judged over the token stream:
 *   files differing only by whitespace, comments, quote style or trailing
 *   commas are the SAME content (init folds them into one cluster; sync
 *   leaves a hand-reformatted file alone). Values must still parse as
 *   TypeScript.
 * - `text`: verbatim content supplied by the matching rule (last one wins).
 * - `yaml`: a YAML document; deep-merged like `json`, but read and compared
 *   PARSED: indentation, quoting, comments and key order never count as
 *   drift (list order and scalar types do). Multi-document streams and
 *   custom tags are rejected instead of silently corrupted. Values are
 *   YAML text (block scalars, like `json` uses JSON text) or mappings.
 */
export type FileFormat = 'json' | 'jsonc' | 'yaml' | 'ts' | 'text';

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
 * is the sibling `default` property of the file entry, never a pattern.
 * Values must have content: opting workspaces out of the file is the job
 * of `include`/`exclude`, not of null values. Instead of an inline `value`,
 * a rule may carry `template`: a repo-relative path whose file content
 * becomes the value (handy when the content is big).
 *
 * For `json`/`jsonc` a value may be written as a string containing JSONC
 * text (a YAML block scalar) — parsed at load time, keeping JSON readable
 * as JSON inside the config.
 */
export interface RuleInput {
  pattern: string;
  value?: JsonValue | string;
  /** Repo-relative template file; mutually exclusive with `value`. */
  template?: string;
}

/**
 * One file entry as written in config-loom.yaml before compilation. The
 * `files` map key names the entry; several entries may share a `filename`
 * to write the same file to different workspace subsets — for a given
 * workspace the FIRST entry whose `include` matches and whose `exclude`
 * does not is the one that renders.
 */
export interface FileSpecInput {
  /**
   * Workspace-relative file this entry generates. Defaults to the entry's
   * key in `files:`. Multiple entries may target the same filename.
   */
  filename?: string;
  /**
   * Regular expression(s) (full match against the workspace directory)
   * restricting which workspaces this entry generates. Omitted means all
   * workspaces (minus `exclude`).
   */
  include?: string | string[];
  /**
   * Regular expression(s), same syntax as `include`, that must NEVER
   * receive this file from this entry: a hard opt-out beating `default`
   * and every rule. Prefer families (`packages/mq-.*`, `.*-rs`) over name
   * lists, so new projects joining the family stay excluded without
   * editing anything.
   */
  exclude?: string | string[];
  format?: FileFormat;
  arrays?: ArrayPolicy;
  banner?: string | boolean;
  /**
   * Base content every workspace matched by this entry starts from. It
   * must have a value (there is no opt-in null mode — use `include` to
   * restrict scope). For `json`/`jsonc` it may be written as a string
   * containing the JSONC text (a block scalar) — parsed at load time.
   * Instead of an inline value, an entry may carry `template`: a
   * repo-relative path whose file content becomes the default (mutually
   * exclusive with `default`).
   */
  default?: JsonValue | string;
  /** Repo-relative template file for `default`; resolved by loadConfig. */
  template?: string;
  /**
   * Ordered list of `{ pattern, value }` rules, merged over `default` and
   * each other — later rules win (specific props beat `default`).
   */
  rules?: RuleInput[];
}

/**
 * config-loom.yaml as read from disk (comments allowed).
 */
export interface LoomConfigInput {
  /** Regular expressions for workspace directories to skip entirely. */
  exclude?: string[];
  files: Record<string, FileSpecInput>;
}

export interface CompiledRule {
  pattern: string;
  regex: RegExp;
  /** Always has content: null values are a validation error. */
  value: JsonValue | string;
}

/**
 * One compiled `files:` entry: the workspace subset it serves (include
 * minus exclude) plus the generation content for that subset.
 */
export interface CompiledScope {
  /** Empty means "every workspace". Exclude beats include. */
  include: RegExp[];
  exclude: RegExp[];
  format: FileFormat;
  arrays: ArrayPolicy;
  banner: string | false;
  /** Always has content (no opt-in null mode). */
  defaultValue: JsonValue | string;
  /** Rules, in declaration order. */
  rules: CompiledRule[];
}

export interface CompiledFileEntry {
  /** Path relative to each workspace root, e.g. `tsconfig.json`. */
  file: string;
  /** Entries sharing this filename, declaration order: first match renders. */
  scopes: CompiledScope[];
}

export interface LoomConfig {
  exclude: string[];
  /** Keyed by target filename (not by entry name). */
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
  /** Generated files removed because the workspace left every scope. */
  deleted: number;
}
