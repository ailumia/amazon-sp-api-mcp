import AjvModule from "ajv";
import type { Ajv as AjvInstance, Options, ValidateFunction } from "ajv";
import addFormatsModule from "ajv-formats";
import { SpApiMcpError } from "../errors.js";
import type {
  AccessLevel,
  InvocationArguments,
  JsonSchema,
  OperationDefinition,
  RegistryBundle,
} from "../types.js";

export interface DiscoveryQuery {
  query?: string;
  domain?: string;
  version?: string;
  access?: AccessLevel;
  includeDeprecated?: boolean;
  limit?: number;
}

const AjvConstructor = AjvModule as unknown as new (options?: Options) => AjvInstance;
const addFormats = addFormatsModule as unknown as (ajv: AjvInstance) => AjvInstance;

export class OperationRegistry {
  readonly #byId: Map<string, OperationDefinition>;
  readonly #ajv: AjvInstance;
  readonly #validators = new Map<string, ValidateFunction>();

  public constructor(public readonly bundle: RegistryBundle) {
    this.#byId = new Map(bundle.operations.map((operation) => [operation.id, operation]));
    if (this.#byId.size !== bundle.operations.length) {
      throw new SpApiMcpError("Registry contains duplicate operation IDs", "INVALID_REGISTRY");
    }
    this.#ajv = new AjvConstructor({ allErrors: true, strict: false });
    addFormats(this.#ajv);
  }

  public get(operationId: string): OperationDefinition {
    const operation = this.#byId.get(operationId);
    if (operation === undefined) {
      throw new SpApiMcpError(`Unknown operation: ${operationId}`, "OPERATION_NOT_FOUND");
    }
    return operation;
  }

  public discover(query: DiscoveryQuery): OperationDefinition[] {
    const terms = (query.query ?? "").toLocaleLowerCase().split(/\s+/u).filter(Boolean);
    return this.bundle.operations
      .filter((operation) => query.includeDeprecated === true || !operation.deprecated)
      .filter((operation) => query.domain === undefined || operation.domain === query.domain)
      .filter((operation) => query.version === undefined || operation.apiVersion === query.version)
      .filter((operation) => query.access === undefined || operation.access === query.access)
      .map((operation) => ({ operation, score: scoreOperation(operation, terms) }))
      .filter(({ score }) => terms.length === 0 || score > 0)
      .sort(
        (left, right) =>
          right.score - left.score || left.operation.id.localeCompare(right.operation.id),
      )
      .slice(0, query.limit ?? 20)
      .map(({ operation }) => operation);
  }

  public validate(operation: OperationDefinition, arguments_: InvocationArguments): void {
    const validator = this.validatorFor(operation);
    if (!validator(arguments_)) {
      throw new SpApiMcpError("Arguments do not match the operation schema", "INVALID_ARGUMENTS", {
        operationId: operation.id,
        errors: validator.errors,
      });
    }
  }

  private validatorFor(operation: OperationDefinition): ValidateFunction {
    const existing = this.#validators.get(operation.id);
    if (existing !== undefined) return existing;
    const compiled = this.#ajv.compile(this.inputSchema(operation));
    this.#validators.set(operation.id, compiled);
    return compiled;
  }

  public inputSchema(operation: OperationDefinition): JsonSchema {
    const properties: Record<string, JsonSchema> = {};
    const required: string[] = [];
    for (const location of ["path", "query", "header"] as const) {
      const parameters = operation.parameters.filter(
        (parameter) => parameter.location === location,
      );
      if (parameters.length === 0) continue;
      const locationRequired = parameters
        .filter((parameter) => parameter.required)
        .map(({ name }) => name);
      properties[location === "header" ? "headers" : location] = {
        type: "object",
        additionalProperties: false,
        properties: Object.fromEntries(
          parameters.map((parameter) => [parameter.name, parameter.schema]),
        ),
        ...(locationRequired.length === 0 ? {} : { required: locationRequired }),
      };
      if (locationRequired.length > 0) required.push(location === "header" ? "headers" : location);
    }
    if (operation.requestBody !== undefined) {
      properties.body = operation.requestBody.schema;
      if (operation.requestBody.required) required.push("body");
    }
    const modelSchemas = this.bundle.modelSchemas[operation.sourceFile];
    return {
      type: "object",
      additionalProperties: false,
      properties,
      ...(required.length === 0 ? {} : { required }),
      ...(modelSchemas?.definitions === undefined ? {} : { definitions: modelSchemas.definitions }),
      ...(modelSchemas?.components === undefined
        ? {}
        : { components: { schemas: modelSchemas.components } }),
    };
  }
}

function scoreOperation(operation: OperationDefinition, terms: string[]): number {
  const fields = {
    id: operation.id.toLocaleLowerCase(),
    operationId: operation.operationId.toLocaleLowerCase(),
    domain: operation.domain.toLocaleLowerCase(),
    summary: operation.summary.toLocaleLowerCase(),
    description: operation.description?.toLocaleLowerCase() ?? "",
    tags: operation.tags.join(" ").toLocaleLowerCase(),
  };
  return terms.reduce((score, term) => {
    if (fields.id === term || fields.operationId === term) return score + 100;
    if (fields.operationId.includes(term)) score += 40;
    if (fields.domain.includes(term)) score += 25;
    if (fields.id.includes(term)) score += 20;
    if (fields.summary.includes(term)) score += 10;
    if (fields.tags.includes(term)) score += 5;
    if (fields.description.includes(term)) score += 2;
    return score;
  }, 0);
}
