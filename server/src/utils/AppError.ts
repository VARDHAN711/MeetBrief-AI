export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }

  static badRequest(code: string, message: string): AppError {
    return new AppError(400, code, message);
  }

  static notFound(code: string, message: string): AppError {
    return new AppError(404, code, message);
  }

  static payloadTooLarge(code = 'PAYLOAD_TOO_LARGE', message = 'Request payload exceeds limit'): AppError {
    return new AppError(413, code, message);
  }

  static invalidClientId(message = 'Header x-client-id must be a valid UUID v4'): AppError {
    return new AppError(400, 'INVALID_CLIENT_ID', message);
  }

  static invalidId(message = 'Invalid conversation ID format'): AppError {
    return new AppError(400, 'INVALID_ID', message);
  }

  static conversationNotFound(message = 'Conversation not found'): AppError {
    return new AppError(404, 'CONVERSATION_NOT_FOUND', message);
  }

  static conflict(code: string, message: string): AppError {
    return new AppError(409, code, message);
  }
}

