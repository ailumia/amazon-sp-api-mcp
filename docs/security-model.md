# Security model

## Assets and trust boundaries

The server handles Amazon LWA credentials, seller-authorized SP-API data, remote write operations, downloaded reports, and MCP client requests. The MCP host and the server process are trusted. Tool arguments, upstream responses, and HTTP clients are untrusted.

## Credential handling

- Credentials are accepted only through the server environment in `SP_API_ACCOUNTS`.
- Tool schemas expose only a stable account name, never credentials or access-token parameters.
- Refresh tokens are exchanged directly with Amazon LWA.
- Access tokens are cached independently per account and refreshed before expiry.
- Logs contain operation metadata, status, latency, and request IDs, not credentials or request bodies.
- Use a process-level secret manager in hosted environments. Keep configuration files outside the repository when possible, restrict them to the server user, and never commit `.env` or credential configuration files.

## Remote actions

HTTP GET and HEAD are classified as `read`. POST, PUT, and PATCH are `write`; DELETE is `delete`. Every non-read invocation requires `confirm=true`. MCP annotations also mark the generic invocation tool as potentially destructive, but authorization must rely on server policy rather than annotations alone.

Confirmation proves explicit caller intent; it is not an authorization system. Amazon application roles and seller authorization remain the authoritative permission boundary.

When multiple accounts are configured, every live call must specify `accountName`. A single account can omit it. There is no mutable "current account" state, so concurrent requests cannot switch each other's account context.

Marketplace metadata is loaded from `getMarketplaceParticipations`. Marketplace-scoped calls are rejected unless every requested marketplace is active for the selected account. Seller IDs required by individual operations remain normal validated operation arguments. Store names returned by Amazon are display metadata and never routing identifiers.

## Input and output controls

- Path, query, header, and body arguments are validated against generated JSON Schema.
- Undeclared arguments are rejected.
- Clients cannot set arbitrary headers.
- Path values are percent-encoded.
- Concurrency, timeouts, and retries are bounded.
- Rate-limit buckets are isolated by account name, region, and operation.
- Write operations can be validated with `dryRun=true` without sending the target operation.
- Large and binary responses are stored outside model context.
- Artifact paths are server-generated and cannot be selected by callers.
- Artifacts are created with owner-only file modes where the operating system supports them.

Artifacts are not encrypted by this project. Place `SP_API_ARTIFACT_DIR` on encrypted storage, apply retention controls, and isolate it per tenant when required.

## Streamable HTTP

The secure default is loopback-only. Non-loopback binding requires a Host allowlist. An optional constant-time bearer-token check is available, but production internet exposure should use TLS and an identity-aware reverse proxy or API gateway.

The `/health` endpoint reveals only aggregate registry information and the public upstream model commit. It does not require Amazon credentials.

## Multi-tenancy

A process can contain multiple Amazon authorization accounts, but all MCP clients authorized to use that process can select any configured account name. Account routing does not provide tenant authorization or artifact isolation. Do not reuse one process for mutually untrusted tenants. Deploy one isolated process and artifact directory per tenant, or add explicit tenant-to-account authorization before sharing a deployment.

## Audit data

Structured audit events are written to stderr for integration with the operator's logging pipeline. Write events contain a SHA-256 hash of the submitted payload and selected resource identifiers, not the raw request body. Results and structured errors include the same audit ID for correlation. Operators that require durable or tamper-resistant audit retention must route stderr to an appropriate external log service.

## Reporting vulnerabilities

Do not open public issues for suspected vulnerabilities. Follow [SECURITY.md](../SECURITY.md).
