import { mkdirSync } from 'node:fs';
import { readdir, lstat, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import multer from 'multer';
import { env } from '../config/env.js';

export const uploadDirectory = fileURLToPath(new URL('../../uploads/tmp/', import.meta.url));
mkdirSync(uploadDirectory, { recursive: true });

const STALE_UPLOAD_AGE_MS = 60 * 60 * 1000;

export async function cleanupStaleUploadFiles(now = Date.now()): Promise<void> {
  try {
    const entries = await readdir(uploadDirectory, { withFileTypes: true });
    await Promise.all(entries.map(async entry => {
      if (!entry.isFile()) return;
      const filePath = path.join(uploadDirectory, entry.name);
      try {
        const fileStat = await lstat(filePath);
        if (!fileStat.isFile() || now - fileStat.mtimeMs <= STALE_UPLOAD_AGE_MS) return;
        await unlink(filePath);
      } catch {
        // A stale temp-file cleanup failure must not prevent server startup.
      }
    }));
  } catch {
    // A directory read failure must not prevent server startup.
  }
}

const storage = multer.diskStorage({
  destination: uploadDirectory,
  filename: (_req, file, callback) => {
    const extension = /^\.[a-z0-9]{1,10}$/i.test(file.originalname.slice(file.originalname.lastIndexOf('.')))
      ? file.originalname.slice(file.originalname.lastIndexOf('.')).toLowerCase()
      : '.upload';
    callback(null, `${randomUUID()}${extension}`);
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: Math.max(env.MAX_DOC_MB, env.MAX_AUDIO_MB) * 1024 * 1024,
    files: 1,
  },
});

export const uploadSingleFile = upload.single('file');
