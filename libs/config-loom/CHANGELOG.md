# Changelog

## [0.9.1](https://github.com/codibre/monorepo-utils/compare/config-loom%400.8.0...config-loom%400.9.1) (2026-11-18)

### Features

* **config-loom:** init moves big values to .config-loom templates ([ca7fc86](https://github.com/codibre/monorepo-utils/commit/ca7fc86ed65559e88dae33f3619fd40fd7efe01c)), closes [#13](https://github.com/codibre/monorepo-utils/issues/13)
* **config-loom:** per-command --help via commander ([bdcb90d](https://github.com/codibre/monorepo-utils/commit/bdcb90db2fed948de9a44c0d1c2dedf22c1ee975)), closes [#15](https://github.com/codibre/monorepo-utils/issues/15)
* **config-loom:** yaml format comparing documents by parsed content ([ffdd5f6](https://github.com/codibre/monorepo-utils/commit/ffdd5f64fc4e166d5f92393ac6f9f7cbbf9d1a95)), closes [#12](https://github.com/codibre/monorepo-utils/issues/12)

## [0.5.0](https://github.com/codibre/monorepo-utils/compare/config-loom%400.4.0...config-loom%400.5.0) (2026-11-17)

### Features

* **config-loom:** default is a file-spec prop; drop JSON config; add template files ([ff20413](https://github.com/codibre/monorepo-utils/commit/ff204131e4294b60ae4925085c52ab71e15c5f24))
* **config-loom:** switch the template to YAML with { pattern, value } rules ([929fb32](https://github.com/codibre/monorepo-utils/commit/929fb32cd710d7b284a7ca9d5cd3a4ba6b9258c1))

## [0.4.0](https://github.com/codibre/monorepo-utils/compare/config-loom%400.3.0...config-loom%400.4.0) (2026-11-17)

### Features

* **config-loom:** prune tsconfig rule fields equivalent to the default ([a141836](https://github.com/codibre/monorepo-utils/commit/a141836aa2711649229d65c3fe2895e3926932db)), closes [#5](https://github.com/codibre/monorepo-utils/issues/5)

## [0.3.0](https://github.com/codibre/monorepo-utils/compare/config-loom%400.2.0...config-loom%400.3.0) (2026-11-17)

### Features

* **config-loom:** generalize rule keys with directory shapes, guards and composites ([ed1a80b](https://github.com/codibre/monorepo-utils/commit/ed1a80bc356bcb48cbf4ab9809562c56365d8420))
* **config-loom:** text entries collapse into default + exclude too ([8ff7995](https://github.com/codibre/monorepo-utils/commit/8ff7995818393eb001ecadc76591cb6e50526315))

### Bug Fixes

* **config-loom:** tsconfig renders strict JSON; render-match proves deletion authorship ([a2837f1](https://github.com/codibre/monorepo-utils/commit/a2837f11256d642fae28536948af83d175c9eccf))

## [0.2.0](https://github.com/codibre/monorepo-utils/compare/config-loom%400.1.3...config-loom%400.2.0) (2026-11-17)

### Features

* **config-loom:** per-file exclude prop + merge-patch deltas over defaults ([a5cfcad](https://github.com/codibre/monorepo-utils/commit/a5cfcadbc4554e604cb48088c8be23473983ef0c))
* **config-loom:** wildcard-first init ([ee0f685](https://github.com/codibre/monorepo-utils/commit/ee0f68596c2aac27208a02fb078f22a304fd2fde))

## [0.1.3](https://github.com/codibre/monorepo-utils/compare/config-loom%400.1.2...config-loom%400.1.3) (2026-11-17)

### Bug Fixes

* removing totally unneeded disclaimer ([a45384b](https://github.com/codibre/monorepo-utils/commit/a45384bb56816d7fdb3aa80908b8a7949fe14c0c))

## [0.1.2](https://github.com/codibre/monorepo-utils/compare/config-loom%400.1.1...config-loom%400.1.2) (2026-11-17)

### Bug Fixes

* preparing stage publish ([7173522](https://github.com/codibre/monorepo-utils/commit/71735220a5204fd4db8e326c87ca513f5880fafd))

## [0.1.1](https://github.com/codibre/monorepo-utils/compare/config-loom%400.1.0...config-loom%400.1.1) (2026-11-17)

### Bug Fixes

* fix lib name on readme ([06d5308](https://github.com/codibre/monorepo-utils/commit/06d53085c5ccbcc4ae49aa8641f8b6a789f7c9ab))

## 0.1.0 (2026-11-17)

### Features

* **config-loom:** config file is config-loom.json; postinstall is the integration ([0168b39](https://github.com/codibre/monorepo-utils/commit/0168b3973a427f736ac2e5e889c174db2bd81ca5))
* **config-loom:** discover workspaces through pnpm itself ([577aceb](https://github.com/codibre/monorepo-utils/commit/577aceb51715e6bd4014b666cabbb9ce910d30a5))
* **config-loom:** init auto-wires postinstall and turbo.json ([2af0ef3](https://github.com/codibre/monorepo-utils/commit/2af0ef30f9c6a4077d49db0f2b50ed8c0abcca3e))
* **config-loom:** template is config-loom.jsonc; strict JSON where comments would bite ([1169e17](https://github.com/codibre/monorepo-utils/commit/1169e178d0b07cab628623981b87ba1721a4b129))
