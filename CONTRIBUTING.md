# Contributing

Thank you for contributing to Ailumia's Amazon SP-API MCP server.

## Before you start

- Search existing issues and pull requests.
- Open a discussion or feature request for significant changes.
- Report security issues privately according to [SECURITY.md](SECURITY.md).
- Follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Development setup

```bash
git clone https://github.com/ailumia/amazon-sp-api-mcp.git
cd amazon-sp-api-mcp
npm ci
npm run check
```

Node.js 20, 22, and 24 are supported in CI.

## Pull requests

Keep changes focused. Every pull request should include:

- the user or developer problem being solved;
- tests for behavioral changes;
- documentation for public interfaces or configuration;
- `npm run check` passing locally;
- no credentials, seller data, access tokens, report contents, or sensitive logs.

Generated registry changes must come from `npm run registry:sync`. Do not edit `registry/operations.json` manually. Include the upstream Amazon commit in the pull request description.

## Architecture expectations

- Prefer registry-driven endpoint coverage over endpoint-specific tools.
- Add dedicated tools only for durable, multi-step workflows.
- Preserve versioned operation IDs and backwards compatibility.
- Treat write/delete confirmation and credential isolation as invariants.
- Keep non-SP-API business logic outside the core server.

## Commit and release policy

Use clear, imperative commit messages. Maintainers squash or rebase as appropriate. Releases follow semantic versioning:

- patch: fixes and compatible registry refreshes;
- minor: compatible tools, workflows, or configuration;
- major: incompatible MCP contracts or runtime requirements.

By submitting a contribution, you agree that it is licensed under Apache-2.0.
