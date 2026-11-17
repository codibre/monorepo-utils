<p align="center">
  <img
    src="https://raw.githubusercontent.com/codibre/monorepo-utils/main/docs/logo.jpg"
    alt="config-loom logo: two interwoven curly braces"
    width="150"
    height="150"
  />
</p>

# config-loom

> Eliminate config drift in pnpm + Turborepo monorepos.

A 50-package monorepo rots the same way: every `tsconfig.json` starts as a
copy-paste, then one "quick fix" at a time turns fifty identical files into
fifty snowflakes. Nobody reviews those diffs; they are invisible debt.

**config-loom** keeps one template file — `config-loom.jsonc` — in git, and
generates every per-project config file from it:

```jsonc
{
  "files": {
    "tsconfig.json": {
      "rules": {
        // everything starts here
        "default": {
          "compilerOptions": { "target": "es2023", "strict": true },
          "include": ["src"],
        },
        // regex keys are matched (full match) against the workspace
        // directory path, deep-merged over the default, top to bottom
        "libs/.*-application": { "compilerOptions": { "composite": true } },
        "apps/bff|apps/vd-gestao-admin": {
          "compilerOptions": { "types": ["node"] },
        },
      },
    },
  },
}
```

Then every workspace gets its `tsconfig.json` regenerated before any turbo
command runs — from the turbo cache when nothing changed, so the cost is zero.
The generated files are **gitignored**: no more config diffs in pull requests,
no more someone hand-editing a generated file.

```sh
pnpm add -D -w @codibre/config-loom  # once: root devDependency
pnpm exec config-loom init           # reverse-engineers config-loom.jsonc from your existing configs
pnpm exec config-loom sync           # (re)generate everything
pnpm exec config-loom check          # CI gate: fail if anything drifted
```

## Why not X?

| Tool                                                                                                  | What it does                       | Why we built this instead                                                                               |
| ----------------------------------------------------------------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------- |
| [Projen](https://projen.io)                                                                           | Config-as-code, generates projects | Opinionated project model; heavy to retrofit into an existing 50-package monorepo.                      |
| [moon](https://moonrepo.dev) `project.sync`                                                           | File templates + syncing           | Requires migrating task running to moon.                                                                |
| Nx generators/plugin graph                                                                            | Scaffold + inference               | Nx-specific; Turborepo has **no plugin lifecycle hooks** by design, so there is nothing to hook into.   |
| [manypkg](https://github.com/trymanypkg/manypkg) / [Syncpack](https://github.com/JamieMason/syncpack) | package.json consistency only      | `package.json` is precisely what config-loom refuses to generate (pnpm resolves the workspace from it). |
| `turbo gen` (Plop)                                                                                    | Scaffolding                        | One-shot generation; does not keep existing files in sync continuously.                                 |

Turborepo's official answer to drift is shared presets (`extends:
"@repo/tsconfig/base"`), which works — but leaves a committed per-project file
that can still diverge (and reviewers still read it). config-loom deletes
that file entirely.

## Getting started

### 1. Add it to the workspace root

```sh
pnpm add -D -w @codibre/config-loom
```

### 2. Run init

```sh
pnpm exec config-loom init --dry-run   # preview: shows the config-loom.jsonc it would write
pnpm exec config-loom init             # writes config-loom.jsonc, deletes the scattered files,
                              # git-rms them from the index, adds the .gitignore block
```

`init` asks pnpm itself which projects exist (`pnpm -r exec pwd`), scans every workspace for known config
files (`tsconfig.json`, `eslint.config.mjs`, `vitest.config.mts`,
`jest.config.js`, `nest-cli.json`, …), clusters them by content, takes the
majority content as `default`, and emits delta rules — grouped as regexes when
possible (`libs/.*-application`), or as exact `apps/bff|apps/other`
alternations — for each exception. Use `--files tsconfig.json,eslint.config.mjs`
to restrict the scope.

### 3. Wire it up — one line (init does it for you)

```jsonc
// package.json (root)
{
  "scripts": {
    "postinstall": "config-loom sync",
  },
}
```

`init` writes exactly this. If the repo also has a **`turbo.json`**, init
wires that too — the `//#config-loom` root task (with `outputs` derived from
your real workspaces) plus `dependsOn: ["//#config-loom"]` on every other
task, and the small `config-loom` script the task runs. All edits are
surgical (jsonc-parser): comments and formatting survive, nothing that
exists is overwritten (a custom `postinstall` earns a note to chain
`config-loom sync` instead), and everything is idempotent — `config-loom
wire` re-applies the wiring any time, `init --no-wire` opts out.

That one script is the whole integration. `pnpm install` — fresh clone, CI runner, or a
Tuesday afternoon pull — regenerates every managed file, and the files are on
disk before anything else runs (TS server included). It is task-runner
agnostic: works with npm/yarn/pnpm scripts, Turborepo, moon, or no runner at
all. Add a CI gate with a second script, since `check` never writes:

```jsonc
"check:configs": "config-loom check"
```

**Optional Turborepo upgrade.** Turbo has no plugin API, but you can also
declare a root task so every turbo command re-syncs first, cache-guarded —
useful when installs run with `--ignore-scripts`, or when you want drift
caught between commands rather than only at install time:

```jsonc
// turbo.json — also add script "config-loom": "config-loom sync"
{
  "tasks": {
    "//#config-loom": {
      "inputs": [
        "config-loom.jsonc",
        "config-loom.json",
        "pnpm-workspace.yaml",
      ],
      "outputs": ["apps/*/tsconfig.json", "libs/*/tsconfig.json"],
      "cache": true,
    },
    "build": { "dependsOn": ["//#config-loom", "^build"] },
    "test": { "dependsOn": ["//#config-loom"] },
  },
}
```

Declare **every** generated file in `outputs`: on a cache hit turbo restores
exactly those paths. With the postinstall wiring you don't need this to make
gitignored files reappear — install already does.

## `config-loom.jsonc` reference

> The template is `.jsonc` on purpose: comments document the regex rules and
> VS Code handles `.jsonc` natively — no "comments are not permitted in JSON"
> squiggles. `config-loom.json` is still read (drop it in and it wins over
> nothing — candidates are tried in order), you just have to live without
> editor-endorsed comments there. Generated files follow the same law:
> banners only where comments are safe for the toolchain and the IDE
> (`tsconfig.json`/`jsconfig.json` get them; `nest-cli.json`,
> `tsconfig.build.json` and friends render as strict JSON, no banner —
> per-entry `"banner"` and `"format": "jsonc"` override if your tools
> tolerate comments).

Top level:

| Key       | Default  | Meaning                                                     |
| --------- | -------- | ----------------------------------------------------------- |
| `exclude` | `[]`     | Globs of workspace directories to skip.                     |
| `files`   | required | Map of repo-relative (per-workspace) file path → file spec. |

Workspace discovery is delegated to pnpm itself — `pnpm -r exec pwd` runs in
the repo root and every reported directory is a workspace (the root is not).
That honours all of pnpm's own semantics without reimplementing them, so
pnpm is required **for now**; support for other package managers may come
later. `pnpm-workspace.yaml` stays a great `inputs` entry in your turbo task
regardless: adding a project should re-run the generator.

Per-file spec:

| Key      | Default                                 | Meaning                                                                                        |
| -------- | --------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `format` | `jsonc` for `.json`, `text` otherwise   | `json`, `jsonc` (comments tolerated when read, banner by default) or `text` (verbatim content) |
| `arrays` | `replace`                               | What a rule's array does to the base array: `replace`, `concat` or `unique`                    |
| `banner` | jsonc: warning comment; json/text: none | Header line. `false` disables; strings allowed for `jsonc`/`text`.                             |
| `rules`  | required                                | `default` plus regex keys, in declaration order.                                               |

Rule semantics:

- Keys other than `default` are JavaScript regular expressions, matched
  **fully anchored** (`^(?:pattern)$`) against the workspace directory path
  relative to the repo root (`apps/bff`, `libs/some-ui`…), always with posix
  separators.
- For `json`/`jsonc`, every matching rule is deep-merged over the accumulated
  value **in declaration order** — the last rule wins on conflicts. Arrays
  follow `arrays`; everything else is overwritten.
- For `text`, the **last matching rule replaces** the content entirely.
- `"default": null` makes an entry opt-in: only workspaces hit by a rule get
  the file. `init` uses this automatically when a file does not exist in every
  workspace.
- Rule values must be objects (`json`/`jsonc`) or strings (`text`).

### What can never be generated

`package.json`, lockfiles, `pnpm-workspace.yaml`, `turbo.json`, `.gitignore`,
`.npmrc` and `config-loom.*` itself: pnpm resolves the workspace from
`package.json`, so template-generating it would undermine the tool itself.
Use [manypkg](https://github.com/trymanypkg/manypkg)/Syncpack for package.json
drift, and [pnpm catalog](https://pnpm.io/catalogs) for dependency versions.

## The `.gitignore` trade-off (read this)

Generated files being gitignored means they exist only where the tool has
run. The `postinstall` wiring above closes that gap by construction — every
`pnpm install` regenerates before any developer or CI job touches the tree —
and `config-loom check` in CI is the safety net. If gitignoring is still
unacceptable for your workflow, don't let init touch git: run
`config-loom init --keep --dry-run`, adapt the config, and commit the
generated files as normal artifacts (`check` still polices them).

## CLI

```
config-loom <command> [options]

  init     Reverse-engineer config-loom.jsonc from the configs scattered across
           workspaces; delete, gitignore and regenerate them.
  sync     Generate every managed file (creates/updates only what changed).
  check    Exit 1 if any managed file is missing or stale. Never writes.
  wire     (Re)apply the integration: postinstall in the root package.json,
           plus a //#config-loom task in turbo.json when it exists.

  --root <dir>       repository root (default cwd)
  --config <path>    config-loom.jsonc path (default <root>/config-loom.jsonc)
  --files a,b,...    [init] restrict to these file names
  --dry-run          preview, change nothing
  --keep             [init] don't delete existing files
  --force            [init] overwrite an existing config-loom.jsonc
  --yes              skip the confirmation prompt
  --no-wire          [init] skip the package.json/turbo.json wiring
  --verbose          also list unchanged files
```

> **Naming note.** The binary is `config-loom` only — no bare `loom` alias,
> since that name is taken on npm and Loom owns it in search results. Run it
> with `pnpm exec config-loom …` (or `pnpm config-loom …` when no script
> shadows the name).

## Programmatic API

```ts
import {
  loadConfig,
  syncAll,
  checkAll,
  buildPlan,
  initRepo,
  deepMerge,
  computeDelta,
} from '@codibre/config-loom';

const { config } = await loadConfig(process.cwd());
const report = await syncAll(config, process.cwd(), { dryRun: true });
```

## License

MIT
