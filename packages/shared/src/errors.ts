// Generic error utilities — no domain knowledge

export class ApplicationError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: number = 500
  ) {
    super(message);
    this.name = "ApplicationError";
  }
}

export function isApplicationError(err: unknown): err is ApplicationError {
  return err instanceof ApplicationError;
}
