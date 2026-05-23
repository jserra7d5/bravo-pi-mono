export type WebToolErrorType = "ContextError" | "AdapterError" | "ToolExecutionError";

export class WebToolError extends Error {
  readonly error_type: WebToolErrorType;
  readonly suggested_action: string;

  constructor(errorType: WebToolErrorType, message: string, suggestedAction: string, options?: ErrorOptions) {
    super(message, options);
    this.name = errorType;
    this.error_type = errorType;
    this.suggested_action = suggestedAction;
  }

  toJSON(): { error_type: WebToolErrorType; message: string; suggested_action: string } {
    return {
      error_type: this.error_type,
      message: this.message,
      suggested_action: this.suggested_action,
    };
  }
}

export function contextError(message: string, suggestedAction: string): WebToolError {
  return new WebToolError("ContextError", message, suggestedAction);
}

export function adapterError(message: string, suggestedAction: string, cause?: unknown): WebToolError {
  return new WebToolError("AdapterError", message, suggestedAction, cause instanceof Error ? { cause } : undefined);
}

export function toolExecutionError(message: string, suggestedAction: string, cause?: unknown): WebToolError {
  return new WebToolError("ToolExecutionError", message, suggestedAction, cause instanceof Error ? { cause } : undefined);
}
