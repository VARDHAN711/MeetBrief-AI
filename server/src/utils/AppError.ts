export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly conversationId?: string;

  constructor(statusCode: number, code: string, message: string, conversationId?: string) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.conversationId = conversationId;
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

  static unsupportedFileType(message = 'Only .txt and .pdf files are supported.'): AppError {
    return new AppError(415, 'UNSUPPORTED_FILE_TYPE', message);
  }

  static invalidFile(message = 'The uploaded file is empty or invalid.'): AppError {
    return new AppError(400, 'INVALID_FILE', message);
  }

  static noExtractableText(message = 'This PDF seems to be scanned or image-only. This version needs a PDF with selectable text.'): AppError {
    return new AppError(422, 'NO_EXTRACTABLE_TEXT', message);
  }

  static transcriptionFailed(message = 'We could not transcribe this recording. Try a clearer or shorter file.'): AppError {
    return new AppError(502, 'TRANSCRIPTION_FAILED', message);
  }
}

