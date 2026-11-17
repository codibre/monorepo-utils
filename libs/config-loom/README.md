<p align="center">
  <img
    src="https://raw.githubusercontent.com/codibre/monorepo-utils/main/docs/logo.jpg"
    alt="config-loom logo: two interwoven curly braces"
    width="150"
    height="150"
  />
</p>

# @codibre/config-loom

> Eliminate config drift in pnpm + Turborepo monorepos.

A 50-package monorepo rots the same way: every `tsconfig.json` starts as a
copy-paste, then one "quick fix" at a time turns fifty identical files into
fifty snowflakes. Nobody reviews those diffs; they are invisible debt.

**config-loom** keeps one template file — `loom.json` — in git, and
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
pnpm exec config-loom init           # reverse-engineers loom.json from your existing configs
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
pnpm exec config-loom init --dry-run   # preview: shows the loom.json it would write
pnpm exec config-loom init             # writes loom.json, deletes the scattered files,
                              # git-rms them from the index, adds the .gitignore block
```

`init` asks pnpm itself which projects exist (`pnpm -r exec pwd`), scans every workspace for known config
files (`tsconfig.json`, `eslint.config.mjs`, `vitest.config.mts`,
`jest.config.js`, `nest-cli.json`, …), clusters them by content, takes the
majority content as `default`, and emits delta rules — grouped as regexes when
possible (`libs/.*-application`), or as exact `apps/bff|apps/other`
alternations — for each exception. Use `--files tsconfig.json,eslint.config.mjs`
to restrict the scope.

### 3. Wire Turborepo

Turborepo has no plugin API, so integration is **one root task** that every
other task depends on. A turbo task is just a name bound to a root
`package.json` script, so the complete wiring is:

```jsonc
// package.json (root)
{
  "scripts": {
    // the root script that the //#config-loom task runs
    "config-loom": "config-loom sync",
  },
}
```

```jsonc
// turbo.json
{
  "tasks": {
    "//#config-loom": {
      "inputs": ["loom.json", "pnpm-workspace.yaml"],
      "outputs": [
        "apps/*/tsconfig.json",
        "libs/*/tsconfig.json",
        "apps/*/eslint.config.mjs",
      ],
      "cache": true,
    },
    "build": { "dependsOn": ["//#config-loom", "^build"] },
    "test": { "dependsOn": ["//#config-loom"] },
    "lint": { "dependsOn": ["//#config-loom"] },
  },
}
```

That is the whole integration: `pnpm i && pnpm build` on a fresh clone
generates everything, and every later turbo command regenerates first — from
turbo's cache when `loom.json` hasn't changed, so the cost is zero.
Declare **every** generated file in `outputs`: on a cache hit turbo restores
exactly those paths, which is what makes the gitignored files reappear on a
fresh CI checkout without running the generator.

Also handy as a CI gate (`config-loom check` never writes):

```jsonc
"config-loom:check": { "cache": false }  // + script "config-loom:check": "config-loom check"
```

## `loom.json` reference

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
`.npmrc` and `loom.*` itself: pnpm resolves the workspace from
`package.json`, so template-generating it would undermine the tool itself.
Use [manypkg](https://github.com/trymanypkg/manypkg)/Syncpack for package.json
drift, and [pnpm catalog](https://pnpm.io/catalogs) for dependency versions.

## The `.gitignore` trade-off (read this)

Generated files being gitignored means a fresh clone only has them after the
first turbo command. If someone opens the IDE before building, the TS server
sees missing tsconfigs — the habit that fixes it is the one you already have:
build right after `pnpm install`. You can additionally wire
`"postinstall": "config-loom sync"` to close the gap entirely, and
`config-loom check` in CI is the safety net either way. If gitignoring is
unacceptable for your workflow, don't let init touch git: run
`config-loom init --keep --dry-run`, adapt the config, and commit the
generated files as normal artifacts (`check` still polices them).

## CLI

```
config-loom <command> [options]

  init     Reverse-engineer loom.json from the configs scattered across
           workspaces; delete, gitignore and regenerate them.
  sync     Generate every managed file (creates/updates only what changed).
  check    Exit 1 if any managed file is missing or stale. Never writes.

  --root <dir>       repository root (default cwd)
  --config <path>    loom.json path (default <root>/loom.json)
  --files a,b,...    [init] restrict to these file names
  --dry-run          preview, change nothing
  --keep             [init] don't delete existing files
  --force            [init] overwrite an existing loom.json
  --yes              skip the confirmation prompt
  --verbose          also list unchanged files
```

> **Naming notes.** The binary is `config-loom` only — this package
> deliberately does **not** ship a `loom` alias, which belongs to
> [@loom/core](https://loomjs.com). Prefer `pnpm exec config-loom …`
> over `pnpm config-loom …`: once the wiring script exists, the bare form
> runs the script (`sync`) and appends your arguments to it.

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
