import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { CONFIG_DIR } from '../../../config/userConfig.js';
import { logger } from '../../../utils/logger.js';

export const DOCUMENTS_DIR = path.join(CONFIG_DIR, 'documents');

const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.json', '.jsonl', '.csv', '.tsv',
  '.py', '.ts', '.js', '.jsx', '.tsx', '.java', '.c', '.cpp', '.h',
  '.go', '.rs', '.rb', '.php', '.sh', '.yaml', '.yml', '.toml', '.ini',
  '.xml', '.html', '.css', '.sql', '.log', '.yml',
]);

export const PDF_EXTENSIONS = new Set(['.pdf']);

/**
 * True when the file name looks like plain text we can safely hand to a model
 * (either a text/code file or a PDF that the model's own tools can read).
 */
export function isDocFileSupported(fileName: string): boolean {
  const ext = path.extname(fileName || '').toLowerCase();
  return TEXT_EXTENSIONS.has(ext) || PDF_EXTENSIONS.has(ext);
}

interface CachedDocument {
  filePath: string;
  fileName: string;
  uploadedAt: number;
}

/** Per-user latest uploaded document, keyed by Telegram user id. */
const documentCache = new Map<number, CachedDocument>();

/** Directory per user so multiple users never collide. */
function userDir(userId: number): string {
  return path.join(DOCUMENTS_DIR, String(userId));
}

/**
 * Save an uploaded text/PDF document for later inline /pdf use.
 * Returns the absolute path or null when the file type is unsupported.
 */
export async function cacheDocument(
  userId: number,
  tempFilePath: string,
  fileName: string,
): Promise<string | null> {
  if (!isDocFileSupported(fileName)) return null;

  try {
    const dir = userDir(userId);
    await fs.mkdir(dir, { recursive: true });
    const dest = path.join(dir, fileName);
    await fs.copyFile(tempFilePath, dest);
    documentCache.set(userId, {
      filePath: dest,
      fileName,
      uploadedAt: Date.now(),
    });
    logger.info(`[pdfCache] Cached document userId=${userId} file="${fileName}" -> ${dest}`);
    return dest;
  } catch (e) {
    logger.warn(`[pdfCache] Failed to cache document userId=${userId}: ${e}`);
    return null;
  }
}

/**
 * Return the most recently cached document path for a user, if any.
 */
export function getCachedDocument(userId: number): CachedDocument | undefined {
  return documentCache.get(userId);
}

/**
 * Forget a user's cached document (e.g. after a failed read).
 */
export function clearCachedDocument(userId: number): void {
  documentCache.delete(userId);
}

/** Test helper: wipe the in-memory cache. */
export function _clearAllDocumentsForTest(): void {
  documentCache.clear();
}
