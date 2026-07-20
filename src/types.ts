export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue;
}

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD";
export type AccessLevel = "read" | "write" | "delete";
export type ParameterLocation = "path" | "query" | "header";

export interface JsonSchema {
  [key: string]: unknown;
}

export interface OperationParameter {
  name: string;
  location: ParameterLocation;
  description?: string;
  required: boolean;
  schema: JsonSchema;
  collectionFormat?: string;
  style?: string;
  explode?: boolean;
}

export interface RequestBodyDefinition {
  required: boolean;
  contentType: string;
  schema: JsonSchema;
}

export interface OperationDefinition {
  id: string;
  domain: string;
  apiVersion: string;
  operationId: string;
  title: string;
  method: HttpMethod;
  path: string;
  summary: string;
  description?: string;
  deprecated: boolean;
  access: AccessLevel;
  tags: string[];
  sourceFile: string;
  parameters: OperationParameter[];
  requestBody?: RequestBodyDefinition;
}

export interface ModelSchemaDefinitions {
  definitions?: Record<string, JsonSchema>;
  components?: Record<string, JsonSchema>;
}

export interface RegistryBundle {
  schemaVersion: 1;
  generatedAt: string;
  source: {
    repository: string;
    commit: string;
  };
  stats: {
    models: number;
    domains: number;
    operations: number;
  };
  operations: OperationDefinition[];
  modelSchemas: Record<string, ModelSchemaDefinitions>;
}

export interface InvocationArguments {
  path?: Record<string, JsonValue>;
  query?: Record<string, JsonValue>;
  headers?: Record<string, JsonValue>;
  body?: JsonValue;
}

export interface InvocationResult {
  operationId: string;
  accountName?: string;
  auditId?: string;
  dryRun?: boolean;
  status: number;
  requestId?: string;
  rateLimit?: string;
  data?: JsonValue;
  artifact?: ArtifactReference;
}

export interface ArtifactReference {
  id: string;
  mediaType: string;
  bytes: number;
  sha256: string;
}
