import { describe, expect, it } from "vitest";
import { parseApiModel } from "../src/registry/model-parser.js";

describe("parseApiModel", () => {
  it("normalizes Swagger 2 operations and body schemas", () => {
    const result = parseApiModel(
      {
        swagger: "2.0",
        info: { title: "Selling Partner API for Orders", version: "v0" },
        paths: {
          "/orders/{orderId}": {
            parameters: [{ name: "orderId", in: "path", required: true, type: "string" }],
            post: {
              operationId: "updateOrder",
              description: "Update an order.\n\nMore details.",
              tags: ["ordersV0"],
              parameters: [
                { name: "marketplaceIds", in: "query", type: "array", items: { type: "string" } },
                {
                  name: "payload",
                  in: "body",
                  required: true,
                  schema: { $ref: "#/definitions/Payload" },
                },
              ],
            },
          },
        },
        definitions: { Payload: { type: "object" } },
      },
      "orders-api-model/ordersV0.json",
    );

    expect(result.operations).toHaveLength(1);
    expect(result.operations[0]).toMatchObject({
      id: "orders.v0.updateOrder",
      domain: "orders",
      method: "POST",
      access: "write",
      summary: "Update an order.",
      requestBody: { required: true, schema: { $ref: "#/definitions/Payload" } },
    });
    expect(result.operations[0]?.parameters).toHaveLength(2);
    expect(result.schemas.definitions).toHaveProperty("Payload");
  });

  it("normalizes OpenAPI 3 request bodies and referenced parameters", () => {
    const result = parseApiModel(
      {
        openapi: "3.0.3",
        info: { title: "Catalog", version: "2022-04-01" },
        components: {
          schemas: { Request: { type: "object" } },
          parameters: {
            ItemId: { name: "itemId", in: "path", required: true, schema: { type: "string" } },
          },
        },
        paths: {
          "/items/{itemId}": {
            patch: {
              operationId: "patchItem",
              parameters: [{ $ref: "#/components/parameters/ItemId" }],
              requestBody: {
                required: true,
                content: {
                  "application/json": { schema: { $ref: "#/components/schemas/Request" } },
                },
              },
            },
          },
        },
      },
      "catalog-items-api-model/catalogItems_2022-04-01.json",
    );

    expect(result.operations[0]).toMatchObject({
      id: "catalogItems.2022-04-01.patchItem",
      requestBody: { contentType: "application/json", required: true },
    });
    expect(result.schemas.components).toHaveProperty("Request");
  });

  it("disambiguates duplicate upstream operation IDs by HTTP method", () => {
    const result = parseApiModel(
      {
        swagger: "2.0",
        info: { title: "Shipping", version: "v2" },
        paths: {
          "/carrier": {
            put: { operationId: "linkCarrierAccount" },
            post: { operationId: "linkCarrierAccount" },
          },
        },
      },
      "shipping-api-model/shippingV2.json",
    );
    expect(result.operations.map(({ id }) => id)).toEqual([
      "shipping.v2.linkCarrierAccount.put",
      "shipping.v2.linkCarrierAccount.post",
    ]);
  });

  it("rejects unsupported documents and missing operation IDs", () => {
    expect(() => parseApiModel({}, "bad.json")).toThrow("expected Swagger 2.0 or OpenAPI 3.x");
    expect(() =>
      parseApiModel({ swagger: "2.0", paths: { "/bad": { get: {} } } }, "bad-api-model/bad.json"),
    ).toThrow("has no operationId");
  });
});
