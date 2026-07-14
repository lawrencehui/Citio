# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.0] - 2026-07-14

First public release.

### Added

- Slack-native control plane for **Claude Code** and **Codex** — ask for real
  engineering work in a Slack message and get a pull request back. Both providers
  are supported and proven end-to-end.
- **Controlled MCP tool layer**: agents reach the codebase, CI, and logs through
  an allowlisted tool surface (`investigate_codebase`, `read_file`, `write_file`,
  `create_branch`, `create_pr`, `run_command`, `check_ci_status`, `query_logs`,
  `post_update`, `query_audit_log`, `recall_context`) and never handle credentials
  directly.
- **One-command install** via `npx @lawrencehui/citio` — the package ships its own
  build context (`dist/`, `Dockerfile`), so the installer runs without cloning or
  building. Building from source (`git clone` + `npm run init`) works too.
- **Guided installer**: step-by-step prompts for every credential, a Slack app
  manifest generator (`citio manifest`), an AWS credentials preflight, and a
  sign-in gate before opening the Slack app-creation page.
- **AWS ECS deployment** with optional EFS persistence, in-container device auth
  for Codex OAuth, and credentials stored in **AWS Secrets Manager** rather than
  the task definition.
- **Ambient mode** — reply to plain messages in the home channel without requiring
  an `@mention`.
- Lifecycle subcommands: `citio status`, `citio destroy`, and `citio manifest`.
- Live progress streaming to Slack while the agent works.

### Changed

- **Fargate Spot by default** — roughly 70% cheaper than on-demand.
- Task size (CPU, memory, ephemeral storage) is now driven by config rather than
  hardcoded, with a cheaper default and pause/resume support.

[Unreleased]: https://github.com/lawrencehui/Citio/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/lawrencehui/Citio/releases/tag/v0.3.0
