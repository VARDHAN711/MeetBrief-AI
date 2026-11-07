import mongoose from 'mongoose';
import { app } from './app.js';
import { env } from './config/env.js';
import { cleanupStaleUploadFiles } from './middleware/upload.js';

async function startServer(): Promise<void> {
  await cleanupStaleUploadFiles();

  try {
    await mongoose.connect(env.MONGODB_URI);
    console.log('Connected to MongoDB');
  } catch (err) {
    console.error('Failed to connect to MongoDB:', err);
    process.exit(1);
  }

  app.listen(env.PORT, () => {
    console.log(`Server listening on port ${env.PORT}`);
  });
}

startServer();
