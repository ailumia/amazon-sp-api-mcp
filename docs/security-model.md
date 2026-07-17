# Security model

## Assets and trust boundaries

The server handles Amazon LWA credentials, seller-authorized SP-API data, remote write operations, downloaded reports, and MCP client requests. The MCP host and the server process are trusted. Tool arguments, upstream responses, and HTTP clients are untrusted.

## Credential handling

- Credentials are accepted only through the server environment.
- Tool schemas do not expose credential or access-token parameters.
- Refresh tokens are exchanged directly with Amazon LWA.
- Access tokens are cached in memory and refreshed before expiry.
- Logs contain operation metadata, status, latency, and request IDs, not credentials or request bodies.
- Use a process-level secret manager in hosted environments; do not commit `.env` files.

## Remote actions

HTTP GET and HEAD are classified as `read`. POST, PUT, and PATCH are `write`; DELETE is `delete`. Every non-read invocation requires `confirm=true`. MCP annotations also mark the generic invocation tool as potentially destructive, but authorization must rely on server policy rather than annotations alone.

Confirmation proves explicit caller intent; it is not an authorization system. Amazon application roles and seller authorization remain the authoritative permission boundary.

## Input and output controls

- Path, query, header, and body arguments are validated against generated JSON Schema.
- Undeclared arguments are rejected.
- Clients cannot set arbitrary headers.
- Path values are percent-encoded.
- Concurrency, timeouts, and retries are bounded.
- Large and binary responses are stored outside model context.
- Artifact paths are server-generated and cannot be selected by callers.
- Artifacts are created with owner-only file modes where the operating system supports them.

Artifacts are not encrypted by this project. Place `SP_API_ARTIFACT_DIR` on encrypted storage, apply retention controls, and isolate it per tenant when required.

## Streamable HTTP

The secure default is loopback-only. Non-loopback binding requires a Host allowlist. An optional constant-time bearer-token check is available, but production internet exposure should use TLS and an identity-aware reverse proxy or API gateway.

The `/health` endpoint reveals only aggregate registry information and the public upstream model commit. It does not require Amazon credentials.

## Multi-tenancy

The current process represents one configured Amazon authorization context. Do not reuse one process for mutually untrusted tenants. Deploy one isolated process and artifact directory per tenant, or contribute a credential-provider abstraction with explicit tenant authentication and authorization.

## Reporting vulnerabilities

Do not open public issues for suspected vulnerabilities. Follow [SECURITY.md](../SECURITY.md).
