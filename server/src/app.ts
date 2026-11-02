import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { env } from './config/env.js';
import { conversationsRouter } from './routes/conversations.routes.js';
import { errorHandler } from './middleware/errorHandler.js';

export const app = express();

app.use(helmet());
app.use(
  cors({
    origin: env.CLIENT_ORIGIN,
    credentials: true,
  })
);
app.use(express.json({ limit: '2mb' }));

app.get('/api/health', (_req, res) => {
  res.status(200).json({
    data: {
      ok: true,
    },
  });
});

app.use('/api/conversations', conversationsRouter);

app.use(errorHandler);
