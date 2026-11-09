import { MemoryStore, rateLimit } from 'express-rate-limit';
import type { Request, Response, NextFunction } from 'express';
import { RATE_LIMITS } from '../config/rateLimits.js';

const response = (_req: Request, res: Response): void => {
  res.status(429).json({ error: { code: 'TOO_MANY_REQUESTS', message: 'You are sending requests too quickly. Please wait a minute and try again.' } });
};

const enabledUnlessTest = (limiter: ReturnType<typeof rateLimit>) => (req: Request, res: Response, next: NextFunction): void => {
  if (process.env.NODE_ENV === 'test' && req.app.locals.rateLimitsEnabled !== true) return next();
  limiter(req, res, next);
};

const generalStore = new MemoryStore();
const geminiStore = new MemoryStore();
export function resetRateLimitStores(): void { generalStore.resetAll(); geminiStore.resetAll(); }

export const generalRateLimit = enabledUnlessTest(rateLimit({ ...RATE_LIMITS.general, store: generalStore, standardHeaders: true, legacyHeaders: false, handler: response }));
export const geminiRateLimit = enabledUnlessTest(rateLimit({ ...RATE_LIMITS.gemini, store: geminiStore, standardHeaders: true, legacyHeaders: false, handler: response }));
