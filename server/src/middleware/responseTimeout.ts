import type { Request, Response, NextFunction } from 'express';
import { unlink } from 'node:fs/promises';

export function responseTimeout(timeoutMs: number) {
  return (req: Request, res: Response, next: NextFunction): void => {
    let timedOut = false;
    const timer = setTimeout(() => {
      if (res.headersSent || res.writableEnded) return;
      timedOut = true;
      if (req.file?.path) void unlink(req.file.path).catch(() => undefined);
      res.status(504).json({ error: { code: 'LLM_TIMEOUT', message: 'The request took too long. Please try again.' } });
    }, timeoutMs);
    res.once('finish', () => clearTimeout(timer));
    res.once('close', () => clearTimeout(timer));
    res.locals.requestTimedOut = () => timedOut;
    next();
  };
}
