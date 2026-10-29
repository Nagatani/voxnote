import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Compute SHA-256 hash of a file using streams (low memory usage even for large WAVs).
 */
export function computeFileHash(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

/**
 * Manages processed audio file records to prevent duplicate API calls.
 */
export class HistoryStore {
  constructor(historyFilePath) {
    this.historyFilePath = historyFilePath;
    this.records = this._load();
  }

  _load() {
    try {
      if (fs.existsSync(this.historyFilePath)) {
        const raw = fs.readFileSync(this.historyFilePath, 'utf8');
        return JSON.parse(raw);
      }
    } catch {
      // Fall back to empty object if corrupted
    }
    return {};
  }

  _save() {
    const dir = path.dirname(this.historyFilePath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      this.historyFilePath,
      JSON.stringify(this.records, null, 2),
      'utf8'
    );
  }

  isProcessed(fileHash) {
    return Boolean(this.records[fileHash]);
  }

  markProcessed(fileHash, metadata) {
    this.records[fileHash] = {
      ...metadata,
      processedAt: new Date().toISOString(),
    };
    this._save();
  }

  getRecord(fileHash) {
    return this.records[fileHash] || null;
  }
}
