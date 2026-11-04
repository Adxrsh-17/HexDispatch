/** Wire format for every error response from every service. */
export interface ErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
    requestId?: string;
  };
}

/** Expected, client-visible failure. Anything else is a 500 and is logged. */
export class AppError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number = 500,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }

  static badRequest(message: string, details?: unknown): AppError {
    return new AppError('BAD_REQUEST', message, 400, details);
  }
  static unauthorized(message = 'Unauthorized'): AppError {
    return new AppError('UNAUTHORIZED', message, 401);
  }
  static forbidden(message = 'Forbidden'): AppError {
    return new AppError('FORBIDDEN', message, 403);
  }
  static notFound(message = 'Not found'): AppError {
    return new AppError('NOT_FOUND', message, 404);
  }
  static conflict(message: string, details?: unknown): AppError {
    return new AppError('CONFLICT', message, 409, details);
  }
  static unavailable(message = 'Service unavailable'): AppError {
    return new AppError('UNAVAILABLE', message, 503);
  }

  toBody(requestId?: string): ErrorBody {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details !== undefined ? { details: this.details } : {}),
        ...(requestId ? { requestId } : {}),
      },
    };
  }
}
