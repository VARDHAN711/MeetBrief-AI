import mongoose from 'mongoose';
import { createServer } from 'node:http';
import { app } from './app.js';
import { env } from './config/env.js';
import { cleanupStaleUploadFiles } from './middleware/upload.js';

async function startServer(): Promise<void> {
  await cleanupStaleUploadFiles();

  try {
    await mongoose.connect(env.MONGODB_URI);
    console.log('Connected to MongoDB');
  } catch (err) {
    console.error('StartupError code=DATABASE_UNAVAILABLE');
    process.exit(1);
  }

  const server = createServer(app);
  server.requestTimeout = 480_000;
  server.headersTimeout = 60_000;
  server.listen(env.PORT, () => {
    console.log(`Server listening on port ${env.PORT}`);
  });
}

startServer();
