# Known Limitations

Citio is not a fully hardened multi-cloud platform yet. The current open-source release should be treated as AWS-first and pre-1.0.

## Runtime and Session Model

- One active agent task runs at a time per container. This is intentional because Citio currently treats the provider session as container-scoped.
- Provider sessions do not survive a container restart or redeploy. Citio now retries a failed resume as a fresh session, but the original provider-side conversation state is still ephemeral.
- Workspace state only persists across redeploys when EFS persistence is enabled in the installer.

## Providers

- AWS deployment is the only supported cloud path today.
- Claude and Codex are supported, but they are not symmetric:
  - Claude uses `CLAUDE_CODE_OAUTH_TOKEN` or API key auth.
  - Codex OAuth depends on persisted `~/.codex/auth.json`.
- Codex still relies on the CLI's native execution model. Citio configures Codex MCP, but the CLI surface is not as clean as Claude's `--mcp-config`.

## Security and Isolation

- Citio is a control plane, but the provider CLIs still retain native shell capabilities inside the container.
- MCP tools are safer than before, but this is not a policy-grade sandbox yet.
- The installer stores secrets in the OS keychain when available, with a file fallback on platforms where the keychain backend is unavailable.

## Installer and Deployment

- The interactive installer is intended for trusted operator machines, not CI/CD runners.
- The release workflow is included, but an actual Git remote and GitHub repository configuration are still required before it can run in your project.
- Local `citio.yaml` is generated for deployment convenience; it should be treated as local machine state, not committed project config.
