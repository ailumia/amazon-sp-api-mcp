# Amazon SP-API MCP

[![CI](https://github.com/ailumia/amazon-sp-api-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/ailumia/amazon-sp-api-mcp/actions/workflows/ci.yml)
[![CodeQL](https://github.com/ailumia/amazon-sp-api-mcp/actions/workflows/codeql.yml/badge.svg)](https://github.com/ailumia/amazon-sp-api-mcp/actions/workflows/codeql.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-339933?logo=node.js)](package.json)

A production-grade, version-aware [Model Context Protocol](https://modelcontextprotocol.io/) server for the Amazon Selling Partner API (SP-API), maintained by [Ailumia](https://ailumia.com/).

The server exposes a small six-tool MCP surface backed by a generated registry of **353 operations across 49 API domains and every model version currently published by Amazon**. Agents discover the right operation at runtime instead of loading hundreds of endpoint schemas into their context.

> [!IMPORTANT]
> This is an independent open-source project. It is not affiliated with, endorsed by, or sponsored by Amazon. Amazon, Selling Partner API, and SP-API are trademarks of Amazon.com, Inc. or its affiliates.

## Why this server

- **Complete model coverage** — generated from [`amzn/selling-partner-api-models`](https://github.com/amzn/selling-partner-api-models), not a hand-maintained endpoint subset.
- **Version aware** — operation IDs include their API version; upstream model commit metadata is embedded in every registry build.
- **Small MCP surface** — safe account listing, discovery, description, invocation, artifact retrieval, and a complete Reports workflow.
- **Safe by default** — remote writes and deletes require explicit confirmation; credentials are injected server-side and never accepted as tool arguments.
- **Multiple seller accounts** — configure stable account names; credentials remain server-side and multi-account calls must select an account explicitly.
- **Marketplace safety** — account metadata is loaded from Amazon and account, marketplace, and regional endpoint combinations are validated before execution.
- **Production controls** — per-account operation rate limiting, bounded concurrency, retries, dry runs, audit events, response size limits, structured errors, and request IDs.
- **Large result handling** — oversized and binary responses become integrity-checked local artifacts that can be read in bounded chunks.
- **Two transports** — stdio for local clients and stateless Streamable HTTP for controlled deployments.

## Tools

| Tool                  | Purpose                                                                            |
| --------------------- | ---------------------------------------------------------------------------------- |
| `list_accounts`       | List safe account names, regions, metadata status, and marketplace participations. |
| `discover_operations` | Search operations by intent, domain, version, and access level.                    |
| `describe_operation`  | Return the exact path, method, parameters, request body, and validation schema.    |
| `invoke_operation`    | Execute any operation in the registry. Writes and deletes require `confirm=true`.  |
| `get_artifact`        | Read a bounded chunk from a large or binary result.                                |
| `run_report`          | Create, poll, download, decompress, and persist an SP-API report.                  |

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

Set `SP_API_ACCOUNTS` to a JSON array. Credentials stay in the MCP server environment and are never accepted through tool arguments. `ACCOUNT_NAME` is a stable routing key, not an Amazon store name. It is exposed as `accountName` in MCP tool arguments and responses.

Account fields:

| Field                  | Required                        | Description                                                                  |
| ---------------------- | ------------------------------- | ---------------------------------------------------------------------------- |
| `ACCOUNT_NAME`         | When two or more accounts exist | Stable lowercase name: letters, numbers, `_`, or `-`; maximum 64 characters. |
| `SP_API_CLIENT_ID`     | Yes                             | LWA application client ID.                                                   |
| `SP_API_CLIENT_SECRET` | Yes                             | LWA application client secret.                                               |
| `SP_API_REFRESH_TOKEN` | Yes                             | Seller authorization refresh token.                                          |
| `SP_API_REGION`        | No                              | `na` by default; also supports `eu` and `fe`.                                |

### Single account

Use an array with one account. `ACCOUNT_NAME` can be omitted; the server assigns the internal name `default`. This explicit example uses all five supported account fields:

```bash
export SP_API_ACCOUNTS='[
  {
    "ACCOUNT_NAME": "primary",
    "SP_API_CLIENT_ID": "amzn1.application-oa2-client...",
    "SP_API_CLIENT_SECRET": "...",
    "SP_API_REFRESH_TOKEN": "...",
    "SP_API_REGION": "na"
  }
]'
```

### Multiple accounts

Every account must have a unique `ACCOUNT_NAME` when more than one account is configured:

```bash
export SP_API_ACCOUNTS='[
  {
    "ACCOUNT_NAME": "hexai-na",
    "SP_API_CLIENT_ID": "amzn1.application-oa2-client...",
    "SP_API_CLIENT_SECRET": "...",
    "SP_API_REFRESH_TOKEN": "...",
    "SP_API_REGION": "na"
  },
  {
    "ACCOUNT_NAME": "hexai-eu",
    "SP_API_CLIENT_ID": "amzn1.application-oa2-client...",
    "SP_API_CLIENT_SECRET": "...",
    "SP_API_REFRESH_TOKEN": "...",
    "SP_API_REGION": "eu"
  }
]'
```

At startup the server begins loading each account's marketplace participations from Amazon. Use `list_accounts` to inspect the safe result; credentials are never returned:

```json
{}
```

An example response includes `accountName`, `region`, `metadataStatus`, and marketplace objects containing `marketplaceId`, `storeName`, and participation status.

If metadata discovery fails, `metadataStatus` is `error` and the server logs the reason without exposing credentials. Marketplace-scoped calls fail closed with `ACCOUNT_METADATA_UNAVAILABLE` until discovery succeeds; operations without a Marketplace argument can still run.

Select an account by its stable name:

```json
{
  "operationId": "orders.2026-01-01.searchOrders",
  "accountName": "hexai-eu",
  "query": {
    "marketplaceIds": ["A1PA6795UKMFR9"]
  }
}
```

When multiple accounts are configured, omitting `accountName` returns `ACCOUNT_NAME_REQUIRED`. With one account it remains optional. The server never guesses an account from a marketplace ID because multiple accounts can participate in the same marketplace.

Before a marketplace-scoped request, the server verifies that every requested marketplace is active for the selected account. Operations that require a Seller/Merchant ID accept `sellerId` in their normal operation arguments. Every step of `run_report` uses the same selected account.

The supported regions are:

| Value | Endpoint                                  |
| ----- | ----------------------------------------- |
| `na`  | `https://sellingpartnerapi-na.amazon.com` |
| `eu`  | `https://sellingpartnerapi-eu.amazon.com` |
| `fe`  | `https://sellingpartnerapi-fe.amazon.com` |

Discovery and operation descriptions work when `SP_API_ACCOUNTS` is unset. `list_accounts` then returns an empty list and live calls return `ACCOUNT_NOT_FOUND`.

## MCP client configuration

Environment values in JSON-based MCP client configuration must escape the account-array JSON:

```json
{
  "mcpServers": {
    "amazon-sp-api": {
      "command": "node",
      "args": ["/absolute/path/amazon-sp-api-mcp/dist/index.js"],
      "env": {
        "SP_API_ACCOUNTS": "[{\"ACCOUNT_NAME\":\"hexai-na\",\"SP_API_CLIENT_ID\":\"...\",\"SP_API_CLIENT_SECRET\":\"...\",\"SP_API_REFRESH_TOKEN\":\"...\",\"SP_API_REGION\":\"na\"}]"
      }
    }
  }
}
```

The default transport is stdio. Logs are written to stderr so they never corrupt MCP messages on stdout.

## Typical agent flow

First list accounts and enabled marketplaces:

```json
{}
```

Then discover an operation:

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
  "accountName": "hexai-na",
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
  "accountName": "hexai-na",
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

`body` is the JSON request body as an object (or array). A JSON-encoded string is also accepted and parsed server-side, so clients that serialize nested arguments as strings still work.

Preview the validated regional request without sending the SP-API operation by using `dryRun=true`; confirmation is not required for a dry run:

```json
{
  "operationId": "listingsItems.2021-08-01.patchListingsItem",
  "accountName": "hexai-na",
  "path": {
    "sellerId": "SELLER_ID",
    "sku": "SKU-123"
  },
  "query": {
    "marketplaceIds": ["ATVPDKIKX0DER"]
  },
  "body": {},
  "dryRun": true
}
```

Successful, failed, rejected, and dry-run operations emit JSON audit events with the account name, marketplaces, operation, confirmation state, request ID when available, resource identifiers, and a SHA-256 payload hash for writes. Results and structured errors include an `auditId` for correlation. Credentials and raw request bodies are not logged.

## Reports workflow

`run_report` manages the asynchronous Reports API lifecycle and returns an artifact reference:

```json
{
  "reportType": "GET_MERCHANT_LISTINGS_ALL_DATA",
  "accountName": "hexai-na",
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
| `SP_API_ACCOUNTS`           | unset            | JSON array containing the five supported per-account fields above.    |
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
  ├── account registry + marketplace validation
  ├── Reports workflow
  └── execution pipeline
        ├── JSON Schema validation
        ├── write/delete confirmation policy
        ├── per-account LWA token provider
        ├── account + region + operation rate limiter
        ├── bounded concurrency + retry
        ├── dry-run + structured audit event
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
