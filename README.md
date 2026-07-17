# Amazon SP-API MCP

[![CI](https://github.com/ailumia/amazon-sp-api-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/ailumia/amazon-sp-api-mcp/actions/workflows/ci.yml)
[![CodeQL](https://github.com/ailumia/amazon-sp-api-mcp/actions/workflows/codeql.yml/badge.svg)](https://github.com/ailumia/amazon-sp-api-mcp/actions/workflows/codeql.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-339933?logo=node.js)](package.json)

A production-grade, version-aware [Model Context Protocol](https://modelcontextprotocol.io/) server for the Amazon Selling Partner API (SP-API), maintained by [Ailumia](https://ailumia.com/).

The server exposes a stable five-tool MCP surface backed by a generated registry of **353 operations across 49 API domains and every model version currently published by Amazon**. Agents discover the right operation at runtime instead of loading hundreds of endpoint schemas into their context.

> [!IMPORTANT]
> This is an independent open-source project. It is not affiliated with, endorsed by, or sponsored by Amazon. Amazon, Selling Partner API, and SP-API are trademarks of Amazon.com, Inc. or its affiliates.

## Why this server

- **Complete model coverage** — generated from [`amzn/selling-partner-api-models`](https://github.com/amzn/selling-partner-api-models), not a hand-maintained endpoint subset.
- **Version aware** — operation IDs include their API version; upstream model commit metadata is embedded in every registry build.
- **Small MCP surface** — discovery, description, invocation, artifact retrieval, and a complete Reports workflow.
- **Safe by default** — remote writes and deletes require explicit confirmation; credentials are injected server-side and never accepted as tool arguments.
- **Production controls** — schema validation, bounded concurrency, rate-limit-aware retries, response size limits, structured errors, request IDs, and JSON logs to stderr.
- **Large result handling** — oversized and binary responses become integrity-checked local artifacts that can be read in bounded chunks.
- **Two transports** — stdio for local clients and stateless Streamable HTTP for controlled deployments.

## Tools

| Tool                  | Purpose                                                                           |
| --------------------- | --------------------------------------------------------------------------------- |
| `discover_operations` | Search operations by intent, domain, version, and access level.                   |
| `describe_operation`  | Return the exact path, method, parameters, request body, and validation schema.   |
| `invoke_operation`    | Execute any operation in the registry. Writes and deletes require `confirm=true`. |
| `get_artifact`        | Read a bounded chunk from a large or binary result.                               |
| `run_report`          | Create, poll, download, decompress, and persist an SP-API report.                 |

## Requirements

- Node.js 20 or newer
- An Amazon SP-API application
- An LWA client ID, client secret, and seller refresh token for live calls

Discovery and operation descriptions work without Amazon credentials.

## Install

Clone and build the pinned source:

```bash
git clone https://github.com/ailumia/amazon-sp-api-mcp.git
cd amazon-sp-api-mcp
npm ci
npm run build
```

The package is also prepared for public npm publication as `@ailumia/amazon-sp-api-mcp`. Until a release is present on npm, configure clients to run the local `dist/index.js` shown below.

## Configure credentials

Set credentials in the MCP server process environment, not in prompts or tool calls:

```bash
export SP_API_CLIENT_ID="amzn1.application-oa2-client..."
export SP_API_CLIENT_SECRET="..."
export SP_API_REFRESH_TOKEN="<seller-refresh-token>"
export SP_API_REGION="na"
```

Regions:

| Value | Endpoint                                  |
| ----- | ----------------------------------------- |
| `na`  | `https://sellingpartnerapi-na.amazon.com` |
| `eu`  | `https://sellingpartnerapi-eu.amazon.com` |
| `fe`  | `https://sellingpartnerapi-fe.amazon.com` |

For short-lived development sessions, `SP_API_ACCESS_TOKEN` can be supplied instead of refresh-token credentials. It is not refreshed automatically.

## MCP client configuration

Use an absolute path. Environment variables can be moved to your secret manager or MCP host configuration.

```json
{
  "mcpServers": {
    "amazon-sp-api": {
      "command": "node",
      "args": ["/absolute/path/amazon-sp-api-mcp/dist/index.js"],
      "env": {
        "SP_API_CLIENT_ID": "...",
        "SP_API_CLIENT_SECRET": "...",
        "SP_API_REFRESH_TOKEN": "...",
        "SP_API_REGION": "na"
      }
    }
  }
}
```

The default transport is stdio. Logs are written to stderr so they never corrupt MCP messages on stdout.

## Typical agent flow

First discover an operation:

```json
{
  "query": "orders updated since a timestamp",
  "domain": "orders",
  "access": "read"
}
```

Then describe the selected version:

```json
{
  "operationId": "orders.2026-01-01.searchOrders"
}
```

Finally invoke it using the returned location-aware schema:

```json
{
  "operationId": "orders.2026-01-01.searchOrders",
  "query": {
    "marketplaceIds": ["ATVPDKIKX0DER"],
    "lastUpdatedAfter": "2026-07-01T00:00:00Z"
  }
}
```

Exact operation names and arguments evolve with Amazon's models. Always use `discover_operations` and `describe_operation` rather than relying on an example indefinitely.

### State-changing operations

POST, PUT, and PATCH operations require `confirm=true`. DELETE operations receive the stricter `delete` access classification and also require confirmation.

```json
{
  "operationId": "listingsItems.2021-08-01.patchListingsItem",
  "path": {
    "sellerId": "SELLER_ID",
    "sku": "SKU-123"
  },
  "query": {
    "marketplaceIds": ["ATVPDKIKX0DER"]
  },
  "body": {},
  "confirm": true
}
```

## Reports workflow

`run_report` manages the asynchronous Reports API lifecycle and returns an artifact reference:

```json
{
  "reportType": "GET_MERCHANT_LISTINGS_ALL_DATA",
  "marketplaceIds": ["ATVPDKIKX0DER"],
  "confirm": true
}
```

The workflow creates the report, polls `getReport`, fetches the report document, downloads the pre-signed URL, decompresses GZIP content when necessary, and stores the result with SHA-256 integrity metadata.

## Streamable HTTP

Local HTTP mode:

```bash
npm run build
node dist/index.js --transport http
```

Endpoints:

- `POST /mcp` — stateless Streamable HTTP MCP
- `GET /health` — registry and source-commit health information

The default bind address is `127.0.0.1`. A non-loopback `HOST` requires `MCP_ALLOWED_HOSTS` to reduce DNS rebinding risk. Set `MCP_BEARER_TOKEN` for shared deployments:

```bash
HOST=0.0.0.0 \
MCP_ALLOWED_HOSTS=mcp.example.com \
MCP_BEARER_TOKEN="use-at-least-16-random-characters" \
node dist/index.js --transport http
```

TLS and internet-facing authorization should be terminated by a trusted reverse proxy or identity-aware gateway. See [Security model](docs/security-model.md).

## Runtime configuration

| Variable                    | Default          | Description                                                           |
| --------------------------- | ---------------- | --------------------------------------------------------------------- |
| `SP_API_REGION`             | `na`             | Amazon SP-API region: `na`, `eu`, or `fe`.                            |
| `SP_API_ENDPOINT`           | region endpoint  | Explicit endpoint override, primarily for tests and proxies.          |
| `SP_API_MAX_RETRIES`        | `5`              | Retry limit for 429 and transient 5xx responses.                      |
| `SP_API_MAX_CONCURRENCY`    | `4`              | Maximum concurrent outbound SP-API requests.                          |
| `SP_API_MAX_RESPONSE_BYTES` | `1048576`        | Maximum inline response size before artifact storage.                 |
| `SP_API_REQUEST_TIMEOUT_MS` | `60000`          | Per-request timeout.                                                  |
| `SP_API_ARTIFACT_DIR`       | `./artifacts`    | Local artifact storage directory.                                     |
| `LOG_LEVEL`                 | `info`           | Pino log level.                                                       |
| `HOST` / `PORT`             | `127.0.0.1:3000` | Streamable HTTP listener.                                             |
| `MCP_ALLOWED_HOSTS`         | unset            | Comma-separated HTTP Host allowlist. Required for non-loopback binds. |
| `MCP_BEARER_TOKEN`          | unset            | Optional HTTP bearer token, minimum 16 characters.                    |

## Registry updates

The tracked registry is deterministic for an upstream commit and records both the repository and commit SHA.

```bash
npm run registry:sync
npm run registry:check
```

The weekly GitHub workflow runs the same process and opens a pull request when Amazon publishes model changes. Registry generation supports Swagger 2.0 and OpenAPI 3.x.

## Architecture

```text
MCP tools
  ├── version-aware operation registry
  ├── Reports workflow
  └── execution pipeline
        ├── JSON Schema validation
        ├── write/delete confirmation policy
        ├── LWA token provider
        ├── bounded concurrency + retry
        ├── SP-API HTTP transport
        └── inline result / artifact store
```

See [Architecture](docs/architecture.md) for module boundaries, operation identity, data flow, and extension rules.

## Development

```bash
npm ci
npm run check
```

`npm run check` runs formatting verification, ESLint, strict TypeScript, tests with coverage, the production build, and registry contract validation.

Useful commands:

```bash
npm run dev
npm run test:watch
npm run registry:generate -- /path/to/selling-partner-api-models/models
```

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md), the [Code of Conduct](CODE_OF_CONDUCT.md), and [SECURITY.md](SECURITY.md) before opening a pull request or reporting a vulnerability.

## License

Apache License 2.0. The generated registry derives structural metadata from Amazon's Apache-2.0-licensed Selling Partner API models; attribution is recorded in [NOTICE](NOTICE).
