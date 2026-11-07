import path from 'node:path';

const MAX_DISPLAY_FILENAME_LENGTH = 120;

export function sanitizeFilename(originalName: string): string {
  const normalized = originalName.replace(/[\\/]+/g, '/');
  const leafName = path.posix.basename(normalized);
  const safeName = leafName.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim();
  return (safeName || 'uploaded-file').slice(0, MAX_DISPLAY_FILENAME_LENGTH);
}
