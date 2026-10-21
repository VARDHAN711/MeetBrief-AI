import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { env } from './config/env.js';

export const app = express();

app.use(helmet());
app.use(
  cors({
    origin: env.CLIENT_ORIGIN,
    credentials: true,
  })
);
app.use(express.json());

app.get('/api/health', (_req, res) => {
  res.status(200).json({
    data: {
      ok: true,
    },
  });
});
