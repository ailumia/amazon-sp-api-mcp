export class SpApiMcpError extends Error {
  public constructor(
    message: string,
    public readonly code: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "SpApiMcpError";
  }
}

export function errorPayload(error: unknown): {
  code: string;
  message: string;
  details?: unknown;
} {
  if (error instanceof SpApiMcpError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details }),
    };
  }
  return {
    code: "INTERNAL_ERROR",
    message: error instanceof Error ? error.message : "Unknown error",
  };
}
