import { basename, dirname } from "node:path";
import type {
  AccessLevel,
  HttpMethod,
  JsonSchema,
  ModelSchemaDefinitions,
  OperationDefinition,
  OperationParameter,
  RequestBodyDefinition,
} from "../types.js";

interface ApiDocument {
  swagger?: string;
  openapi?: string;
  info?: { title?: string; version?: string };
  paths?: Record<string, PathItem>;
  definitions?: Record<string, JsonSchema>;
  components?: {
    schemas?: Record<string, JsonSchema>;
    parameters?: Record<string, RawParameter>;
  };
  parameters?: Record<string, RawParameter>;
}

interface PathItem {
  parameters?: RawParameter[];
  [method: string]: RawOperation | RawParameter[] | undefined;
}

interface RawOperation {
  operationId?: string;
  summary?: string;
  description?: string;
  deprecated?: boolean;
  tags?: string[];
  parameters?: RawParameter[];
  requestBody?: {
    required?: boolean;
    content?: Record<string, { schema?: JsonSchema }>;
  };
}

interface RawParameter {
  $ref?: string;
  name?: string;
  in?: string;
  description?: string;
  required?: boolean;
  type?: string;
  format?: string;
  enum?: unknown[];
  items?: JsonSchema;
  schema?: JsonSchema;
  collectionFormat?: string;
  style?: string;
  explode?: boolean;
}

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "head"]);

export interface ParsedModel {
  operations: OperationDefinition[];
  schemas: ModelSchemaDefinitions;
}

export function parseApiModel(document: unknown, sourceFile: string): ParsedModel {
  if (!isObject(document)) {
    throw new Error(`${sourceFile}: API model must be an object`);
  }
  const doc = document as ApiDocument;
  if (doc.swagger !== "2.0" && typeof doc.openapi !== "string") {
    throw new Error(`${sourceFile}: expected Swagger 2.0 or OpenAPI 3.x document`);
  }

  const domain = domainFromSource(sourceFile);
  const apiVersion = nonEmpty(doc.info?.version) ?? versionFromFilename(sourceFile);
  const title = nonEmpty(doc.info?.title) ?? domain;
  const operations: OperationDefinition[] = [];

  for (const [path, pathItem] of Object.entries(doc.paths ?? {})) {
    const inheritedParameters = Array.isArray(pathItem.parameters) ? pathItem.parameters : [];
    for (const [method, raw] of Object.entries(pathItem)) {
      if (!HTTP_METHODS.has(method) || raw === undefined || Array.isArray(raw)) continue;
      const operation = raw;
      if (typeof operation.operationId !== "string" || operation.operationId.length === 0) {
        throw new Error(`${sourceFile}: ${method.toUpperCase()} ${path} has no operationId`);
      }
      const parameters = [...inheritedParameters, ...(operation.parameters ?? [])]
        .map((parameter) => resolveParameter(parameter, doc))
        .filter((parameter): parameter is RawParameter => parameter !== undefined);
      const converted = parameters
        .filter((parameter) => parameter.in !== "body")
        .map(convertParameter);
      const swaggerBody = parameters.find((parameter) => parameter.in === "body");
      const requestBody = swaggerBody
        ? convertSwaggerBody(swaggerBody)
        : convertOpenApiBody(operation.requestBody);
      const httpMethod = method.toUpperCase() as HttpMethod;

      operations.push({
        id: `${domain}.${apiVersion}.${operation.operationId}`,
        domain,
        apiVersion,
        operationId: operation.operationId,
        title,
        method: httpMethod,
        path,
        summary: cleanText(
          operation.summary ?? firstParagraph(operation.description) ?? operation.operationId,
        ),
        ...(operation.description === undefined
          ? {}
          : { description: cleanText(operation.description) }),
        deprecated: operation.deprecated === true,
        access: accessForMethod(httpMethod),
        tags: operation.tags ?? [],
        sourceFile,
        parameters: converted,
        ...(requestBody === undefined ? {} : { requestBody }),
      });
    }
  }

  const idCounts = new Map<string, number>();
  for (const operation of operations) {
    idCounts.set(operation.id, (idCounts.get(operation.id) ?? 0) + 1);
  }
  for (const operation of operations) {
    if ((idCounts.get(operation.id) ?? 0) > 1) {
      operation.id = `${operation.id}.${operation.method.toLocaleLowerCase()}`;
    }
  }

  return {
    operations,
    schemas: {
      ...(doc.definitions === undefined ? {} : { definitions: doc.definitions }),
      ...(doc.components?.schemas === undefined ? {} : { components: doc.components.schemas }),
    },
  };
}

function resolveParameter(parameter: RawParameter, doc: ApiDocument): RawParameter | undefined {
  if (parameter.$ref === undefined) return parameter;
  const swaggerPrefix = "#/parameters/";
  const openApiPrefix = "#/components/parameters/";
  if (parameter.$ref.startsWith(swaggerPrefix)) {
    return doc.parameters?.[parameter.$ref.slice(swaggerPrefix.length)];
  }
  if (parameter.$ref.startsWith(openApiPrefix)) {
    return doc.components?.parameters?.[parameter.$ref.slice(openApiPrefix.length)];
  }
  return undefined;
}

function convertParameter(parameter: RawParameter): OperationParameter {
  if (parameter.name === undefined || !isParameterLocation(parameter.in)) {
    throw new Error("API parameter is missing a supported name or location");
  }
  const schema = parameter.schema ?? schemaFromSwaggerParameter(parameter);
  return {
    name: parameter.name,
    location: parameter.in,
    ...(parameter.description === undefined
      ? {}
      : { description: cleanText(parameter.description) }),
    required: parameter.required === true || parameter.in === "path",
    schema,
    ...(parameter.collectionFormat === undefined
      ? {}
      : { collectionFormat: parameter.collectionFormat }),
    ...(parameter.style === undefined ? {} : { style: parameter.style }),
    ...(parameter.explode === undefined ? {} : { explode: parameter.explode }),
  };
}

function schemaFromSwaggerParameter(parameter: RawParameter): JsonSchema {
  return {
    type: parameter.type ?? "string",
    ...(parameter.format === undefined ? {} : { format: parameter.format }),
    ...(parameter.enum === undefined ? {} : { enum: parameter.enum }),
    ...(parameter.items === undefined ? {} : { items: parameter.items }),
  };
}

function convertSwaggerBody(parameter: RawParameter): RequestBodyDefinition | undefined {
  if (parameter.schema === undefined) return undefined;
  return {
    required: parameter.required === true,
    contentType: "application/json",
    schema: parameter.schema,
  };
}

function convertOpenApiBody(
  requestBody: RawOperation["requestBody"],
): RequestBodyDefinition | undefined {
  if (requestBody === undefined) return undefined;
  const preferred =
    requestBody.content?.["application/json"] ?? Object.values(requestBody.content ?? {})[0];
  if (preferred?.schema === undefined) return undefined;
  const contentType =
    requestBody.content?.["application/json"] === preferred
      ? "application/json"
      : (Object.keys(requestBody.content ?? {})[0] ?? "application/json");
  return { required: requestBody.required === true, contentType, schema: preferred.schema };
}

function domainFromSource(sourceFile: string): string {
  const folder = basename(dirname(sourceFile))
    .replace(/-api-model$/u, "")
    .replace(/-model$/u, "");
  return toCamelCase(folder);
}

function versionFromFilename(sourceFile: string): string {
  const filename = basename(sourceFile, ".json");
  return /(\d{4}-\d{2}-\d{2}|v\d+)$/iu.exec(filename)?.[1] ?? "unknown";
}

function toCamelCase(value: string): string {
  return value.replace(/-([a-z0-9])/gu, (_, letter: string) => letter.toUpperCase());
}

function accessForMethod(method: HttpMethod): AccessLevel {
  if (method === "GET" || method === "HEAD") return "read";
  if (method === "DELETE") return "delete";
  return "write";
}

function firstParagraph(value: string | undefined): string | undefined {
  return value?.split(/\n\s*\n/u)[0];
}

function cleanText(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === "" ? undefined : trimmed;
}

function isParameterLocation(value: string | undefined): value is "path" | "query" | "header" {
  return value === "path" || value === "query" || value === "header";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
