import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { extractText, getDocumentProxy } from 'unpdf';
import { env } from '../config/env.js';
import { AppError } from '../utils/AppError.js';
import { sanitizeFilename } from '../utils/sanitizeFilename.js';
import type { SourceType } from '../types/api.js';

export interface ExtractedUpload {
  text: string;
  sourceType: Extract<SourceType, 'txt' | 'pdf'>;
  originalFilename: string;
  mimeType: string;
  sizeBytes: number;
}

export const MAX_PDF_PAGES = 300;

const MIME_TYPES: Record<'txt' | 'pdf', ReadonlySet<string>> = {
  txt: new Set(['text/plain', 'application/octet-stream', '']),
  pdf: new Set(['application/pdf', 'application/octet-stream', '']),
};

export async function extractUploadedFile(file: Express.Multer.File): Promise<ExtractedUpload> {
  const extension = path.extname(file.originalname).toLowerCase();
  if (extension !== '.txt' && extension !== '.pdf') {
    throw AppError.unsupportedFileType('Only .txt and .pdf files are supported.');
  }

  const sourceType = extension === '.txt' ? 'txt' : 'pdf';
  if (file.size > env.MAX_DOC_MB * 1024 * 1024) {
    throw AppError.payloadTooLarge('PAYLOAD_TOO_LARGE', 'The uploaded document exceeds the maximum file size.');
  }
  const mimeType = file.mimetype.toLowerCase();
  if (!MIME_TYPES[sourceType].has(mimeType)) {
    throw AppError.invalidFile('The file content does not match its file type.');
  }

  const bytes = await readFile(file.path);
  if (bytes.length === 0) {
    throw AppError.invalidFile('The uploaded file is empty.');
  }

  const text = sourceType === 'txt' ? decodeTextFile(bytes) : await extractPdfText(bytes);
  if (sourceType === 'pdf' && !text.trim()) {
    throw AppError.noExtractableText();
  }

  return {
    text,
    sourceType,
    originalFilename: sanitizeFilename(file.originalname),
    mimeType: file.mimetype,
    sizeBytes: file.size,
  };
}

function decodeTextFile(bytes: Buffer): string {
  try {
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const normalized = decoded.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').replace(/\0/g, '');
    if (!normalized.trim()) {
      throw AppError.invalidFile('The TXT file contains no text.');
    }
    return normalized;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw AppError.invalidFile('The TXT file is not valid UTF-8.');
  }
}

async function extractPdfText(bytes: Buffer): Promise<string> {
  if (bytes.length < 5 || bytes.subarray(0, 5).toString('ascii') !== '%PDF-') {
    throw AppError.invalidFile('The uploaded file is not a valid PDF.');
  }

  let pdf: Awaited<ReturnType<typeof getDocumentProxy>>;
  try {
    pdf = await getDocumentProxy(new Uint8Array(bytes));
  } catch {
    throw AppError.invalidFile('The PDF is corrupt or could not be read.');
  }

  if (pdf.numPages > MAX_PDF_PAGES) {
    throw AppError.payloadTooLarge(
      'PAYLOAD_TOO_LARGE',
      'This PDF has too many pages. Please upload a shorter document.'
    );
  }

  try {
    const result = await extractText(pdf, { mergePages: true });
    return result.text;
  } catch {
    throw AppError.invalidFile('The PDF is password-protected, corrupt, or could not be read.');
  }
}
