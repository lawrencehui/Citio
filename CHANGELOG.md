# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Renamed the project from **Citio** to **Citio** across code, configuration,
  and documentation. Environment variables (`CITIO_*`), the config file
  (`citio.yaml`), the CLI binary (`citio`), and the MCP server/tool prefix
  (`mcp__citio__*`) were renamed accordingly. AWS deployment resource names are
  unchanged.
- Revamped the README into a standard open-source layout.
- Switched the project license from ISC to MIT.

### Added

- **One-command install** via `npx citio` — the package now ships its build
  context (`dist/`, `Dockerfile`), so the installer runs without cloning or
  building. Building from source (`git clone` + `npm run init`) still works; the
  Docker build uses `npm ci` when a lockfile is present and falls back to
  `npm install` for the published package.
- Community-health files: Code of Conduct, this changelog, and issue/PR templates.
- Filled out `package.json` metadata (author, keywords, repository, engines).

## [0.1.3]

- Initial pre-1.0 baseline: Slack-native control plane for Claude Code / Codex,
  controlled MCP tool layer, and a one-command AWS ECS installer with optional
  EFS persistence.

[Unreleased]: https://github.com/lawrencehui/Citio/compare/v0.1.3...HEAD
[0.1.3]: https://github.com/lawrencehui/Citio/releases/tag/v0.1.3
