import type { Request, Response, NextFunction, ErrorRequestHandler } from 'express';
import mongoose from 'mongoose';
import { MulterError } from 'multer';
import { AppError } from '../utils/AppError.js';

export const asyncHandler =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };

export const errorHandler: ErrorRequestHandler = (
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction
): void => {
  if (req.aborted || res.destroyed || res.headersSent || isAbortedRequestError(err)) return;
  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      error: {
        code: err.code,
        message: err.message,
        ...(err.conversationId ? { conversationId: err.conversationId } : {}),
      },
    });
    return;
  }

  if (err instanceof MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      res.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'The uploaded file exceeds the maximum file size.' } });
      return;
    }

    res.status(400).json({
      error: {
        code: 'INVALID_INPUT',
        message: err.code === 'LIMIT_UNEXPECTED_FILE'
          ? 'Upload one file using the "file" field.'
          : 'The multipart upload is invalid.',
      },
    });
    return;
  }

  // Handle Mongoose CastError (malformed ObjectId)
  if (err instanceof mongoose.Error.CastError) {
    res.status(400).json({
      error: {
        code: 'INVALID_ID',
        message: 'Invalid ID format',
      },
    });
    return;
  }

  // Handle body-parser PayloadTooLargeError (413)
  if (
    (typeof err === 'object' && err !== null && 'type' in err && (err as { type: string }).type === 'entity.too.large') ||
    (typeof err === 'object' && err !== null && 'status' in err && (err as { status: number }).status === 413)
  ) {
    res.status(413).json({
      error: {
        code: 'PAYLOAD_TOO_LARGE',
        message: 'Request payload exceeds size limit',
      },
    });
    return;
  }

  // Handle SyntaxError from express.json()
  if (err instanceof SyntaxError && 'status' in err && (err as { status: number }).status === 400) {
    res.status(400).json({
      error: {
        code: 'BAD_REQUEST',
        message: 'Malformed JSON payload',
      },
    });
    return;
  }

  // Unknown / unhandled error - sanitize and never leak internal details/stack traces
  const code = err instanceof AppError ? err.code : 'INTERNAL_SERVER_ERROR';
  const conversationId = typeof req.params.id === 'string' ? req.params.id : 'none';
  console.error(`ServerError conversationId=${conversationId} code=${code}`);
  res.status(500).json({
    error: {
      code: 'INTERNAL_SERVER_ERROR',
      message: 'An unexpected internal error occurred',
    },
  });
};

function isAbortedRequestError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const candidate = err as { code?: unknown; name?: unknown; message?: unknown };
  return candidate.code === 'ECONNABORTED' || candidate.code === 'ABORT_ERR' ||
    candidate.name === 'AbortError' || candidate.message === 'request aborted';
}
