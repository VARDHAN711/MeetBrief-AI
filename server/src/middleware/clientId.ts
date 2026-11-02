import type { Request, Response, NextFunction } from 'express';
import { AppError } from '../utils/AppError.js';

declare global {
  namespace Express {
    interface Request {
      clientId?: string;
    }
  }
}

const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function clientIdMiddleware(req: Request, _res: Response, next: NextFunction): void {
  const headerVal = req.headers['x-client-id'];

  if (!headerVal || Array.isArray(headerVal) || !UUID_V4_REGEX.test(headerVal)) {
    return next(AppError.invalidClientId('Header x-client-id is required and must be a valid UUID v4'));
  }

  req.clientId = headerVal.toLowerCase();
  next();
}

