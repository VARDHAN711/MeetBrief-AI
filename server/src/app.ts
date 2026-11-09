import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { env } from './config/env.js';
import { conversationsRouter } from './routes/conversations.routes.js';
import { errorHandler } from './middleware/errorHandler.js';
import { generalRateLimit } from './middleware/rateLimit.js';
import { responseTimeout } from './middleware/responseTimeout.js';

export const app = express();

app.disable('x-powered-by');
app.use('/api', (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
app.use(helmet());
app.use(
  cors({
    origin: (origin, callback) => callback(null, origin === env.CLIENT_ORIGIN ? origin : false),
    credentials: true,
  })
);
app.use('/api', (req, res, next) => {
  generalRateLimit(req, res, next);
});
app.use(express.json({ limit: '2mb' }));

app.get('/api/health', responseTimeout(120_000), (_req, res) => {
  res.status(200).json({
    data: {
      ok: true,
    },
  });
});

app.use('/api/conversations', conversationsRouter);

app.use(errorHandler);
