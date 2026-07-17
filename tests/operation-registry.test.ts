import { describe, expect, it } from "vitest";
import { OperationRegistry } from "../src/registry/operation-registry.js";
import { bundle, operation } from "./helpers.js";

describe("OperationRegistry", () => {
  it("searches by text, domain, access, and deprecation state", () => {
    const registry = new OperationRegistry(
      bundle([
        operation(),
        operation({
          id: "listings.2021-08-01.patchListingsItem",
          domain: "listings",
          apiVersion: "2021-08-01",
          operationId: "patchListingsItem",
          method: "PATCH",
          access: "write",
          summary: "Patch a listings item",
          tags: ["listings"],
        }),
        operation({ id: "orders.v0.old", operationId: "old", deprecated: true }),
      ]),
    );

    expect(registry.discover({ query: "orders" }).map(({ id }) => id)).toEqual([
      "orders.v0.getOrders",
    ]);
    expect(registry.discover({ domain: "listings", access: "write" })).toHaveLength(1);
    expect(registry.discover({ domain: "orders", includeDeprecated: true })).toHaveLength(2);
  });

  it("builds and enforces a location-aware validation schema", () => {
    const target = operation({
      path: "/orders/{orderId}",
      parameters: [
        { name: "orderId", location: "path", required: true, schema: { type: "string" } },
        {
          name: "limit",
          location: "query",
          required: false,
          schema: { type: "integer", minimum: 1 },
        },
      ],
    });
    const registry = new OperationRegistry(bundle([target]));
    expect(() =>
      registry.validate(target, { path: { orderId: "123" }, query: { limit: 5 } }),
    ).not.toThrow();
    expect(() => registry.validate(target, { query: { limit: 0 } })).toThrow("operation schema");
    expect(registry.inputSchema(target)).toMatchObject({ type: "object", required: ["path"] });
  });

  it("rejects duplicate and unknown operation IDs", () => {
    expect(() => new OperationRegistry(bundle([operation(), operation()]))).toThrow("duplicate");
    const registry = new OperationRegistry(bundle([operation()]));
    expect(() => registry.get("missing")).toThrow("Unknown operation");
  });
});
