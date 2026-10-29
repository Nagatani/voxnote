import fs from 'node:fs/promises';
import path from 'node:path';
import { formatSeconds } from './audioChunker.js';
import { logInfo, logWarn } from './notifier.js';

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com';

const MIME_MAP = {
  '.wav': 'audio/wav',
  '.mp3': 'audio/mp3',
  '.m4a': 'audio/mp4',
  '.mp4': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
};

export function getAudioMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_MAP[ext] || 'audio/mp4';
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Call Gemini REST API with automatic exponential backoff retry for 429 / 5xx errors.
 */
async function callGenerateContent(apiKey, model, contents, maxRetries = 3) {
  const url = `${GEMINI_API_BASE}/v1beta/models/${encodeURIComponent(
    model
  )}:generateContent?key=${encodeURIComponent(apiKey)}`;

  let lastError;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents,
          generationConfig: {
            temperature: 0.2,
          },
        }),
      });

      if (!response.ok) {
        const errBody = await response.text();
        if (
          (response.status === 429 || response.status >= 500) &&
          attempt < maxRetries
        ) {
          const waitMs = Math.pow(2, attempt) * 1500;
          logWarn(
            `Gemini API HTTP ${response.status} (attempt ${attempt}/${maxRetries}). Retrying in ${waitMs}ms...`
          );
          await sleep(waitMs);
          continue;
        }
        throw new Error(
          `Gemini API error (${response.status}): ${errBody.slice(0, 500)}`
        );
      }

      const data = await response.json();
      const text = (data.candidates?.[0]?.content?.parts || [])
        .map((p) => p.text || '')
        .join('')
        .trim();

      if (!text) {
        throw new Error(
          `Gemini API returned empty text. Raw response: ${JSON.stringify(data).slice(0, 300)}`
        );
      }
      return text;
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries) {
        const waitMs = Math.pow(2, attempt) * 1500;
        await sleep(waitMs);
      }
    }
  }
  throw lastError;
}

/**
 * Upload an audio file via the Gemini File API (resumable upload) for large files,
 * wait until state is ACTIVE, and return the file metadata (`uri`, `name`, `mimeType`).
 */
async function uploadToGeminiFileApi(apiKey, filePath, mimeType) {
  const fileBuffer = await fs.readFile(filePath);
  const numBytes = fileBuffer.byteLength;
  const displayName = path.basename(filePath);

  const startUrl = `${GEMINI_API_BASE}/upload/v1beta/files?key=${encodeURIComponent(
    apiKey
  )}`;
  const startRes = await fetch(startUrl, {
    method: 'POST',
    headers: {
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': String(numBytes),
      'X-Goog-Upload-Header-Content-Type': mimeType,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ file: { display_name: displayName } }),
  });

  if (!startRes.ok) {
    throw new Error(
      `Failed to initiate Gemini File upload: ${startRes.status} ${await startRes.text()}`
    );
  }

  const uploadUrl = startRes.headers.get('x-goog-upload-url');
  if (!uploadUrl) {
    throw new Error('Missing x-goog-upload-url header from Gemini File API');
  }

  const uploadRes = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      'Content-Length': String(numBytes),
      'X-Goog-Upload-Offset': '0',
      'X-Goog-Upload-Command': 'upload, finalize',
    },
    body: fileBuffer,
  });

  if (!uploadRes.ok) {
    throw new Error(
      `Failed to upload file bytes to Gemini File API: ${uploadRes.status}`
    );
  }

  const { file } = await uploadRes.json();

  // Poll until ACTIVE
  for (let i = 0; i < 30; i++) {
    const checkRes = await fetch(
      `${GEMINI_API_BASE}/v1beta/${file.name}?key=${encodeURIComponent(apiKey)}`
    );
    if (checkRes.ok) {
      const current = await checkRes.json();
      if (current.state === 'ACTIVE') {
        return current;
      }
      if (current.state === 'FAILED') {
        throw new Error(`Gemini File processing failed for ${file.name}`);
      }
    }
    await sleep(2000);
  }

  return file;
}

async function deleteGeminiRemoteFile(apiKey, fileName) {
  try {
    await fetch(
      `${GEMINI_API_BASE}/v1beta/${fileName}?key=${encodeURIComponent(apiKey)}`,
      { method: 'DELETE' }
    );
  } catch {
    // Best-effort remote file cleanup
  }
}

/**
 * Transcribe a single audio chunk using Gemini.
 */
export async function transcribeAudioChunk(
  chunk,
  totalChunks,
  promptTemplate,
  config,
  options = {}
) {
  const { dryRun = false } = options;

  if (dryRun) {
    return `[${formatSeconds(chunk.startSeconds)}] (Dry-run) チャンク #${
      chunk.index + 1
    }/${totalChunks} (${path.basename(
      chunk.audioPath
    )}) の文字起こしテストテキストです。`;
  }

  if (!config.geminiApiKey) {
    throw new Error(
      'GEMINI_API_KEY is not set. Please configure it in .env or environment variables.'
    );
  }

  const mimeType = getAudioMimeType(chunk.audioPath);
  const stat = await fs.stat(chunk.audioPath);
  const chunkHeader =
    totalChunks > 1
      ? `\n\n※この音声は全体のうちパート ${chunk.index + 1}/${totalChunks}（開始位置: ${formatSeconds(
          chunk.startSeconds
        )}〜${formatSeconds(chunk.endSeconds)}）です。`
      : '';

  const fullPrompt = `${promptTemplate.trim()}${chunkHeader}`;

  // Use inline base64 for files <= 15 MB, otherwise use Gemini File API
  if (stat.size <= 15 * 1024 * 1024) {
    const buffer = await fs.readFile(chunk.audioPath);
    const base64Audio = buffer.toString('base64');
    return callGenerateContent(config.geminiApiKey, config.geminiModel, [
      {
        role: 'user',
        parts: [
          { text: fullPrompt },
          {
            inlineData: {
              mimeType,
              data: base64Audio,
            },
          },
        ],
      },
    ]);
  }

  logInfo(`Uploading chunk #${chunk.index + 1} via Gemini File API...`);
  const uploadedFile = await uploadToGeminiFileApi(
    config.geminiApiKey,
    chunk.audioPath,
    mimeType
  );
  try {
    return await callGenerateContent(config.geminiApiKey, config.geminiModel, [
      {
        role: 'user',
        parts: [
          { text: fullPrompt },
          {
            fileData: {
              mimeType: uploadedFile.mimeType || mimeType,
              fileUri: uploadedFile.uri,
            },
          },
        ],
      },
    ]);
  } finally {
    await deleteGeminiRemoteFile(config.geminiApiKey, uploadedFile.name);
  }
}

/**
 * Generate structured Markdown summary and title from the full transcript using Gemini.
 */
export async function summarizeTranscript(
  transcriptText,
  summaryPromptTemplate,
  config,
  options = {}
) {
  const { dryRun = false } = options;

  if (dryRun) {
    return {
      title: 'ドライラン音声テストメモ',
      summaryMarkdown: [
        '## 要約',
        '- ドライランモードで生成されたテスト要約です。',
        '',
        '## 詳細・主なトピック',
        '- 音声チャンク分割とキャッシュ機構が正常に動作しています。',
        '',
        '## アクションアイテム / TODO',
        '- [ ] `.env` に `GEMINI_API_KEY` を設定して本番実行する',
      ].join('\n'),
    };
  }

  const prompt = `${summaryPromptTemplate.trim()}\n\n---\n【文字起こしテキスト】\n${transcriptText}`;
  const rawOutput = await callGenerateContent(
    config.geminiApiKey,
    config.geminiModel,
    [
      {
        role: 'user',
        parts: [{ text: prompt }],
      },
    ]
  );

  return parseTitleAndSummary(rawOutput);
}

/**
 * Extract `TITLE: ...` line and remaining Markdown body from Gemini response.
 */
export function parseTitleAndSummary(rawOutput) {
  const cleaned = rawOutput
    .trim()
    .replace(/^```(?:markdown|md|text)?\r?\n/i, '')
    .replace(/\r?\n```$/i, '')
    .trim();
  const lines = cleaned.split(/\r?\n/);
  let title = 'ボイスメモ記録';
  let bodyStartIndex = 0;

  for (let i = 0; i < Math.min(5, lines.length); i++) {
    const match = lines[i].match(/^(?:#+\s*)?TITLE\s*[:：]\s*(.+)$/i);
    if (match) {
      title = match[1].trim();
      bodyStartIndex = i + 1;
      break;
    }
  }

  const summaryMarkdown = lines.slice(bodyStartIndex).join('\n').trim();
  return {
    title,
    summaryMarkdown: summaryMarkdown || cleaned,
  };
}
