# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] — 2026-05-25

### Added

- `--exit-code` flag (`git diff --exit-code`-compatible): exit 1 if any
  change is detected, 0 otherwise. Errors still exit non-zero. Works
  across `--text-only`, `--md`, `--images-only`, and the default HTML
  mode. Lets CI scripts gate on "kicad files changed" via process exit
  instead of grepping rendered output. (#14)
- `Nets` subsection in the structural text / markdown diff for
  `.kicad_pcb`. Reports added / removed named nets and pads that
  were rewired between nets (`R1.2: GND → /VCC`). Identity is the
  net **name** (not the id, which KiCad renumbers across saves);
  the unconnected net `""` is excluded from the name set, but
  pad transitions to / from unconnected are still surfaced. Both
  legacy `(net id "name")` and KiCad 10 `(net "name")` atom shapes
  are supported, including derivation from segment / via / zone net
  references when no top-level `(net N "name")` table is present.
  (#15)
- `kicadiff check` subcommand: runs `kicad-cli pcb drc` /
  `kicad-cli sch erc` on both sides of a comparison and reports
  the violation delta as `+N new / -M fixed / =K unchanged`. Exits
  1 only when the target side introduces **new** violations, so the
  gate fails on regressions while ignoring pre-existing findings.
  Violation identity is `sha256(type ‖ sorted item descriptions)`,
  deliberately excluding uuid, position, and severity to avoid
  spurious churn. (#17)
- `kicadiff cache stats` and `kicadiff cache prune` subcommands.
  `stats` reports the cache directory, entry count, total size, and
  oldest / newest timestamps. `prune` accepts `--older-than <duration>`
  or `--all`, plus `--dry-run` for previewing. `--all` requires a
  `.kicadiff-cache` sentinel marker (auto-installed on first cache
  write / read) so a misconfigured `KICADIFF_CACHE_DIR` can't wipe
  an unrelated directory. (#16)

### Changed

- GitHub Action: use `kicadiff --exit-code` to detect "has changes"
  instead of grepping the structural diff output for indented detail
  rows. Cleaner contract, no longer coupled to the printed format.
  **Requires kicadiff CLI >= 0.2.0** for external consumers using
  `install-kicadiff: bunx`. (#19)
- Markdown report template context: `has_structural_diff` and
  `has_changes` now also turn `true` when only nets changed.
  Custom `--md-template` / `--md-file-template` users filtering on
  those booleans no longer drop PCB files where only routing changed.
  Three new context vars exposed for PCB files: `nets_added`,
  `nets_removed`, `nets_changed`. (#15)

## [0.1.1] — 2026-05-10

Initial release on npm. See git history for details.

[0.2.0]: https://github.com/sksat/kicadiff/releases/tag/v0.2.0
[0.1.1]: https://github.com/sksat/kicadiff/releases/tag/v0.1.1
