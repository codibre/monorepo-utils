# @codibre/turbo-stencil

> Eliminate config drift in pnpm + Turborepo monorepos.

A 50-package monorepo rots the same way: every `tsconfig.json` starts as a
copy-paste, then one "quick fix" at a time turns fifty identical files into
fifty snowflakes. Nobody reviews those diffs; they are invisible debt.

**turbo-stencil** keeps one template file — `stencil.json` — in git, and
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
pnpm dlx @codibre/turbo-stencil init   # reverse-engineers stencil.json from your existing configs
pnpm dlx @codibre/turbo-stencil sync   # (re)generate everything
pnpm dlx @codibre/turbo-stencil check  # CI gate: fail if anything drifted
```

## Why not X?

| Tool                                                                                                  | What it does                       | Why we built this instead                                                                                 |
| ----------------------------------------------------------------------------------------------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------- |
| [Projen](https://projen.io)                                                                           | Config-as-code, generates projects | Opinionated project model; heavy to retrofit into an existing 50-package monorepo.                        |
| [moon](https://moonrepo.dev) `project.sync`                                                           | File templates + syncing           | Requires migrating task running to moon.                                                                  |
| Nx generators/plugin graph                                                                            | Scaffold + inference               | Nx-specific; Turborepo has **no plugin lifecycle hooks** by design, so there is nothing to hook into.     |
| [manypkg](https://github.com/trymanypkg/manypkg) / [Syncpack](https://github.com/JamieMason/syncpack) | package.json consistency only      | `package.json` is precisely what turbo-stencil refuses to generate (pnpm resolves the workspace from it). |
| `turbo gen` (Plop)                                                                                    | Scaffolding                        | One-shot generation; does not keep existing files in sync continuously.                                   |

Turborepo's official answer to drift is shared presets (`extends:
"@repo/tsconfig/base"`), which works — but leaves a committed per-project file
that can still diverge (and reviewers still read it). turbo-stencil deletes
that file entirely.

## Getting started

### 1. Add it to the workspace root

```sh
pnpm add -D -w @codibre/turbo-stencil
```

### 2. Run init

```sh
pnpm stencil init --dry-run   # preview: shows the stencil.json it would write
pnpm stencil init             # writes stencil.json, deletes the scattered files,
                              # git-rms them from the index, adds the .gitignore block
```

`init` reads `pnpm-workspace.yaml`, scans every workspace for known config
files (`tsconfig.json`, `eslint.config.mjs`, `vitest.config.mts`,
`jest.config.js`, `nest-cli.json`, …), clusters them by content, takes the
majority content as `default`, and emits delta rules — grouped as regexes when
possible (`libs/.*-application`), or as exact `apps/bff|apps/other`
alternations — for each exception. Use `--files tsconfig.json,eslint.config.mjs`
to restrict the scope.

### 3. Wire Turborepo

Turborepo has no plugin API, so integration is one root task that every other
task depends on:

```jsonc
// package.json (root)
{
  "scripts": {
    "stencil": "stencil sync",
    "postinstall": "stencil sync", // files exist right after clone + pnpm install
  },
}
```

```jsonc
// turbo.json
{
  "tasks": {
    "//#stencil": {
      "inputs": ["stencil.json", "pnpm-workspace.yaml"],
      "outputs": [
        "apps/*/tsconfig.json",
        "libs/*/tsconfig.json",
        "apps/*/eslint.config.mjs",
      ],
      "cache": true,
    },
    "build": { "dependsOn": ["//#stencil", "^build"] },
    "test": { "dependsOn": ["//#stencil"] },
    "lint": { "dependsOn": ["//#stencil"] },
  },
}
```

When `stencil.json` hasn't changed, turbo restores the outputs from cache and
the generator doesn't even run. Declare every generated file in `outputs` —
that is what makes gitignored files reappear on a fresh CI checkout.

Also handy as a CI gate (`stencil check` never writes):

```jsonc
"//#stencil-check": { "dependsOn": [], "cache": false }  // + script "stencil:check": "stencil check"
```

## `stencil.json` reference

Top level:

| Key          | Default                                                | Meaning                                                     |
| ------------ | ------------------------------------------------------ | ----------------------------------------------------------- |
| `workspaces` | `pnpm-workspace.yaml` (or `package.json` `workspaces`) | Globs used to discover workspace directories.               |
| `exclude`    | `[]`                                                   | Globs of workspace directories to skip.                     |
| `files`      | required                                               | Map of repo-relative (per-workspace) file path → file spec. |

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
`.npmrc` and `stencil.*` itself: pnpm resolves the workspace from
`package.json`, so template-generating it would undermine the tool itself.
Use [manypkg](https://github.com/trymanypkg/manypkg)/Syncpack for package.json
drift, and [pnpm catalog](https://pnpm.io/catalogs) for dependency versions.

## The `.gitignore` trade-off (read this)

Generated files being gitignored means a fresh clone only has them after
`pnpm install` (postinstall) or the first turbo command. If your team opens
the IDE before that, the TS server sees missing tsconfigs — so wire
`postinstall`, and keep `stencil check` in CI as the safety net. If that is
unacceptable for your workflow, just don't let init touch git: run
`stencil init --keep --dry-run`, adapt the config, and commit the generated
files as normal artifacts (`check` will still police them).

## CLI

```
stencil <command> [options]

  init     Reverse-engineer stencil.json from the configs scattered across
           workspaces; delete, gitignore and regenerate them.
  sync     Generate every managed file (creates/updates only what changed).
  check    Exit 1 if any managed file is missing or stale. Never writes.

  --root <dir>       repository root (default cwd)
  --config <path>    stencil.json path (default <root>/stencil.json)
  --files a,b,...    [init] restrict to these file names
  --dry-run          preview, change nothing
  --keep             [init] don't delete existing files
  --force            [init] overwrite an existing stencil.json
  --yes              skip the confirmation prompt
  --verbose          also list unchanged files
```

> **Binary name note.** The package exposes `stencil` and `turbo-stencil`.
> `stencil` collides with [@stencil/core](https://stenciljs.com)'s CLI if both
> are installed in the same project — in that case use `turbo-stencil` (same
> behavior, same flags).

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
} from '@codibre/turbo-stencil';

const { config } = await loadConfig(process.cwd());
const report = await syncAll(config, process.cwd(), { dryRun: true });
```

## License

MIT
