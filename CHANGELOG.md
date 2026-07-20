# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Simplified each `SP_API_ACCOUNTS` entry to `ACCOUNT_NAME`, `SP_API_CLIENT_ID`, `SP_API_CLIENT_SECRET`, `SP_API_REFRESH_TOKEN`, and `SP_API_REGION`; seller IDs remain operation arguments where required.

## [1.0.0] - 2026-07-20

### Added

- Version-aware registry generated from all current Amazon SP-API models.
- Compact discovery, account listing, description, invocation, artifact, and Reports workflow tools.
- `SP_API_ACCOUNTS` configuration for one or many seller accounts, with stable `accountName` routing, independent refresh-token caches, regional endpoints, and explicit selection for multi-account calls.
- Safe `list_accounts` metadata discovery through `getMarketplaceParticipations`.
- Account, seller ID, and marketplace validation before SP-API execution.
- Per-account, region, and operation rate-limit buckets layered with bounded global concurrency.
- Write dry runs and structured audit events with request IDs, resource identifiers, and payload hashes.
- LWA authentication, schema validation, write/delete confirmation, retries, structured errors, and artifact integrity metadata.
- stdio and stateless Streamable HTTP transports.
- Full test, CI, CodeQL, dependency update, model sync, and release automation.
- Open-source governance, contribution, security, architecture, and operational documentation.

[Unreleased]: https://github.com/ailumia/amazon-sp-api-mcp/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/ailumia/amazon-sp-api-mcp/releases/tag/v1.0.0
