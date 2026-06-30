# Security Policy

## Supported Versions

Citio is currently pre-1.0. Security fixes should be assumed to land on the latest release tag first.

## Reporting a Vulnerability

Please do not open a public GitHub issue for credential handling, auth bypass, shell injection, or sandbox escape issues.

Report security concerns privately to **hkc.lawrence@gmail.com** (or via GitHub's private vulnerability reporting, if enabled) with:

- a short description of the issue
- affected version or commit
- reproduction steps
- impact
- any suggested remediation

If the issue involves leaked local secrets, rotate those credentials immediately before reporting.

## Scope Notes

High-priority reports include:

- shell injection in MCP tools or installer flows
- credential disclosure in Slack output, logs, or local config handling
- unauthorized repo modification or PR creation
- unintended AWS action escalation
- provider auth persistence bugs that expose tokens

## Current Security Posture

Citio is improving, but it is not yet a hardened sandbox:

- provider CLIs still retain native shell capability inside the container
- AWS is the only supported deployment target
- the installer stores secrets in the OS keychain when available, with a file fallback when keychain access is unavailable

See [docs/KNOWN_LIMITATIONS.md](docs/KNOWN_LIMITATIONS.md) for the current limitations before deploying Citio in a sensitive environment.
