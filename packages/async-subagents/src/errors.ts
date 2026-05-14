export class SubagentError extends Error {
  readonly code: string;
  readonly details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = "SubagentError";
    this.code = code;
    this.details = details;
  }
}

export function assertSubagent(condition: unknown, code: string, message: string, details?: unknown): asserts condition {
  if (!condition) throw new SubagentError(code, message, details);
}
