import type { Request, Response, NextFunction, ErrorRequestHandler } from 'express';
import mongoose from 'mongoose';
import { AppError } from '../utils/AppError.js';

export const asyncHandler =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };

export const errorHandler: ErrorRequestHandler = (
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction
): void => {
  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      error: {
        code: err.code,
        message: err.message,
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
  console.error('Unhandled server error:', err instanceof Error ? err.name : 'UnknownError');
  res.status(500).json({
    error: {
      code: 'INTERNAL_SERVER_ERROR',
      message: 'An unexpected internal error occurred',
    },
  });
};
