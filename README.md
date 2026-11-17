<p align="center">
  <img
    src="https://raw.githubusercontent.com/codibre/monorepo-utils/main/docs/logo.jpg"
    alt="config-loom logo: two interwoven curly braces"
    width="120"
    height="120"
  />
</p>

# monorepo-utils

Utilities to keep large monorepos healthy. Built and maintained by
[Codibre](https://github.com/Codibre), designed around
**pnpm workspaces + [Turborepo](https://turbo.build/repo)**.

## Packages

| Package                                    | What it does                                                                                                                                                                  |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`@codibre/config-loom`](libs/config-loom) | Generates and keeps per-project config files (`tsconfig.json`, `eslint.config.mjs`, `vitest.config.mts`, …) in sync from a single regex-rules template, killing config drift. |

## Why

Monorepos with dozens of subprojects rot the same way: every `tsconfig.json`
starts as a copy-paste and diverges one "quick fix" at a time. This repo hosts
small, sharp CLIs that attack that decay. Start with
[`config-loom`](libs/config-loom#readme).

## Repository layout

```
.
├── libs/               # one directory per published package
├── scripts/            # shared release tooling (conventional-increment)
├── turbo.json          # task graph
└── pnpm-workspace.yaml
```

## Getting started

```sh
pnpm install
pnpm build
pnpm test
pnpm lint
```

## Releases

Each package under `libs/*` is versioned and published independently by
[release-it](https://github.com/release-it/release-it) on merge to `main`, using
path-scoped conventional commits: only commits touching a package's own
directory since its last `@scope/name@x.y.z` tag trigger a bump
(`feat` → minor, `fix`/`perf` → patch, `BREAKING CHANGE` → major).
The gate lives in [`.release-it.base.js`](.release-it.base.js) and
[`scripts/conventional-increment.js`](scripts/conventional-increment.js).

## License

[MIT](LICENSE)
