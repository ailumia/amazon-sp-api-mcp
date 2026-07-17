import type { OperationDefinition, RegistryBundle } from "../src/types.js";

export function operation(overrides: Partial<OperationDefinition> = {}): OperationDefinition {
  return {
    id: "orders.v0.getOrders",
    domain: "orders",
    apiVersion: "v0",
    operationId: "getOrders",
    title: "Orders",
    method: "GET",
    path: "/orders/v0/orders",
    summary: "Get orders",
    deprecated: false,
    access: "read",
    tags: ["orders"],
    sourceFile: "orders-api-model/ordersV0.json",
    parameters: [],
    ...overrides,
  };
}

export function bundle(operations: OperationDefinition[]): RegistryBundle {
  return {
    schemaVersion: 1,
    generatedAt: "2026-01-01T00:00:00Z",
    source: {
      repository: "https://github.com/amzn/selling-partner-api-models",
      commit: "a".repeat(40),
    },
    stats: {
      models: new Set(operations.map(({ sourceFile }) => sourceFile)).size,
      domains: new Set(operations.map(({ domain }) => domain)).size,
      operations: operations.length,
    },
    operations,
    modelSchemas: Object.fromEntries(operations.map(({ sourceFile }) => [sourceFile, {}])),
  };
}
