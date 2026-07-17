# Architecture

## Design goals

Amazon publishes hundreds of operations across independently versioned SP-API domains. Exposing each operation as an MCP tool would increase model context, tool-selection ambiguity, and prompt-cache churn. This project therefore keeps the MCP surface stable while allowing the operation registry to grow independently.

The implementation is a modular monolith. Runtime modules have explicit boundaries but share one process and release artifact. A service split is warranted only when credentials, trust boundaries, ownership, scaling, or failure isolation differ—not simply because the operation count grows.

## Operation identity

The normal identity is:

```text
<domain>.<api-version>.<operation-id>
```

Example:

```text
catalogItems.2022-04-01.searchCatalogItems
```

If an upstream model reuses one `operationId` for multiple HTTP methods, the method is appended:

```text
shipping.v2.linkCarrierAccount.put
shipping.v2.linkCarrierAccount.post
```

Registry generation fails on any remaining collision. This prevents a later model from silently replacing an existing endpoint.

## Registry generation

`scripts/sync-models.ts` shallow-clones Amazon's authoritative model repository into a unique temporary directory. `scripts/registry-lib.ts` recursively parses every JSON model, normalizes Swagger 2.0 and OpenAPI 3.x, verifies operation identity, sorts the result, and writes `registry/operations.json`.

The registry contains:

- source repository, commit SHA, and commit timestamp;
- operation method, path, version, access class, parameters, request body, and deprecation status;
- model-level definitions/components required to validate request-body references;
- model, domain, and operation counts.

Generation uses the upstream commit timestamp so the artifact is byte-for-byte deterministic for the same model commit.

## Runtime flow

```text
MCP client
  → discover_operations
  → describe_operation
  → invoke_operation
      → resolve operation ID
      → enforce write/delete confirmation
      → validate path/query/header/body with JSON Schema
      → obtain or refresh LWA access token
      → serialize the HTTP request
      → enter bounded-concurrency executor
      → retry 429 and transient 5xx responses
      → parse the structured response
      → return inline or persist as an artifact
```

The model cannot provide an Amazon access token through tool arguments. The server owns credential resolution and injects `x-amz-access-token` after validation.

## Tool boundaries

### `discover_operations`

Searches compact metadata. It excludes deprecated operations unless explicitly requested and supports domain, version, and access filters.

### `describe_operation`

Returns one full operation plus its generated input schema. Clients should call it only after narrowing candidates.

### `invoke_operation`

Executes one registry operation. It is intentionally generic; validation and safety policy remain operation-aware.

### `get_artifact`

Reads at most 1 MiB per call. Artifact IDs are UUIDs, paths cannot be supplied by clients, and metadata includes byte length and SHA-256.

### `run_report`

Reports are a first-class workflow because their create/poll/document/download/decompress lifecycle is substantially more complex than an ordinary endpoint call.

## Error model

Expected failures are returned as MCP tool errors with a stable `code`, a human-readable `message`, and optional structured `details`. Amazon HTTP failures preserve the status, Amazon request ID, operation ID, and parsed response body. Credentials are never included.

Protocol failures and application failures remain distinct: malformed MCP requests are handled by the SDK, while SP-API and policy failures use `isError=true` tool results.

## Extension rules

- Add an MCP tool only for a durable workflow, not as a one-to-one endpoint alias.
- Add endpoint coverage through the registry generator.
- Keep non-Amazon business inputs such as cost of goods and lead times outside the MCP core.
- Never change an existing operation identity without a migration note.
- Preserve deterministic generation and fail closed on ambiguous upstream metadata.
