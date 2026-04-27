export class MonitorError extends Error {
  constructor(
    message: string,
    public code: string,
    public statusCode = 400
  ) {
    super(message);
    this.name = "MonitorError";
  }
}

export class ConflictError extends MonitorError {
  constructor(message = "Version conflict") {
    super(message, "CONFLICT", 409);
    this.name = "ConflictError";
  }
}

export class NotFoundError extends MonitorError {
  constructor(message = "Monitor not found") {
    super(message, "NOT_FOUND", 404);
    this.name = "NotFoundError";
  }
}

export class ValidationError extends MonitorError {
  constructor(message = "Validation failed") {
    super(message, "VALIDATION_ERROR", 400);
    this.name = "ValidationError";
  }
}
