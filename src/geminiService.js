import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { formatSeconds, getAudioDurationSeconds } from './audioChunker.js';
import { logInfo, logWarn } from './notifier.js';

const execFileAsync = promisify(execFile);

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com';

const MIME_MAP = {
  '.wav': 'audio/wav',
  '.mp3': 'audio/mp3',
  '.m4a': 'audio/mp4',
  '.mp4': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.wma': 'audio/x-ms-wma',
  '.webm': 'audio/webm',
};

const DEFAULT_SAFETY_SETTINGS = [
  { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_CIVIC_INTEGRITY', threshold: 'BLOCK_NONE' },
];

export class GeminiBlockedError extends Error {
  constructor(reason, rawResponse) {
    super(
      `Gemini API blocked content (reason: ${reason}). Raw response: ${JSON.stringify(
        rawResponse
      ).slice(0, 300)}`
    );
    this.name = 'GeminiBlockedError';
    this.reason = reason;
  }
}

export function getAudioMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_MAP[ext] || 'audio/mp4';
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Call Gemini REST API with automatic exponential backoff retry for 429 / 5xx / network errors.
 * Throws `GeminiBlockedError` immediately (without pointless retries on cached blocks)
 * when `promptFeedback.blockReason` or `finishReason` blocks the response.
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
          safetySettings: DEFAULT_SAFETY_SETTINGS,
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
        const httpErr = new Error(
          `Gemini API error (${response.status}): ${errBody.slice(0, 500)}`
        );
        httpErr.nonRetryable = response.status >= 400 && response.status < 500 && response.status !== 429;
        throw httpErr;
      }

      const data = await response.json();

      // Check if blocked by promptFeedback or candidate finishReason
      const blockReason =
        data.promptFeedback?.blockReason ||
        (data.candidates?.[0]?.finishReason &&
        ['SAFETY', 'RECITATION', 'OTHER', 'BLOCKLIST', 'PROHIBITED_CONTENT'].includes(
          data.candidates[0].finishReason
        )
          ? data.candidates[0].finishReason
          : null);

      const text = (data.candidates?.[0]?.content?.parts || [])
        .filter((p) => !p.thought)
        .map((p) => p.text || '')
        .join('')
        .trim();

      if (!text) {
        if (blockReason) {
          throw new GeminiBlockedError(blockReason, data);
        }
        throw new Error(
          `Gemini API returned empty text. Raw response: ${JSON.stringify(data).slice(0, 300)}`
        );
      }
      return text;
    } catch (err) {
      lastError = err;
      // Do not retry identical payload if blocked by safety/recitation/other or 4xx client error
      if (err instanceof GeminiBlockedError || err.nonRetryable) {
        throw err;
      }
      if (attempt < maxRetries) {
        const waitMs = Math.pow(2, attempt) * 1500;
        logWarn(
          `Request attempt ${attempt}/${maxRetries} failed (${err.message}). Retrying in ${waitMs}ms...`
        );
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
 * Send a single audio file + prompt to Gemini (using inlineData for <=15MB or File API for >15MB).
 */
async function sendAudioToGemini(audioPath, promptText, config) {
  const mimeType = getAudioMimeType(audioPath);
  const stat = await fs.stat(audioPath);

  if (stat.size <= 15 * 1024 * 1024) {
    const buffer = await fs.readFile(audioPath);
    const base64Audio = buffer.toString('base64');
    return callGenerateContent(config.geminiApiKey, config.geminiModel, [
      {
        role: 'user',
        parts: [
          { text: promptText },
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

  logInfo(`Uploading ${path.basename(audioPath)} via Gemini File API...`);
  const uploadedFile = await uploadToGeminiFileApi(
    config.geminiApiKey,
    audioPath,
    mimeType
  );
  try {
    return await callGenerateContent(config.geminiApiKey, config.geminiModel, [
      {
        role: 'user',
        parts: [
          { text: promptText },
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
 * Fallback when a long audio chunk is blocked by `blockReason: OTHER` or `RECITATION`:
 * Splits the chunk into smaller 3-minute (180s) sub-chunks so that a brief noisy/BGM segment
 * does not cause the entire 20-minute chunk to fail.
 */
async function transcribeBlockedChunkBySplitting(chunk, fallbackPrompt, config) {
  const SUB_CHUNK_SECONDS = 180; // 3 minutes per sub-chunk
  const duration = await getAudioDurationSeconds(chunk.audioPath);
  const workDir = path.dirname(chunk.audioPath);
  const baseName = path.basename(chunk.audioPath, path.extname(chunk.audioPath));

  if (duration <= SUB_CHUNK_SECONDS + 15) {
    // Already short and still blocked -> skip only this segment instead of aborting the whole file
    logWarn(
      `Segment [${formatSeconds(chunk.startSeconds)} - ${formatSeconds(
        chunk.endSeconds
      )}] was blocked by Gemini API even after fallback; skipping segment.`
    );
    return `[※ ${formatSeconds(chunk.startSeconds)} 〜 ${formatSeconds(
      chunk.endSeconds
    )} の区間は背景音またはAPIのコンテンツ制限（blockReason: OTHER）により文字起こしをスキップしました]`;
  }

  logInfo(
    `Splitting blocked chunk [${formatSeconds(chunk.startSeconds)} - ${formatSeconds(
      chunk.endSeconds
    )}] into ${SUB_CHUNK_SECONDS}s sub-chunks for recovery...`
  );

  const subResults = [];
  let subIndex = 0;

  for (let offset = 0; offset < duration; offset += SUB_CHUNK_SECONDS) {
    const subLen = Math.min(SUB_CHUNK_SECONDS, duration - offset);
    const absStart = chunk.startSeconds + offset;
    const absEnd = absStart + subLen;
    const subTag = `${baseName}_sub${String(subIndex).padStart(2, '0')}`;
    const subAudioPath = path.join(workDir, `${subTag}.m4a`);
    const subCachePath = path.join(workDir, `${subTag}.txt`);

    if (fsSync.existsSync(subCachePath)) {
      const cached = await fs.readFile(subCachePath, 'utf8');
      subResults.push(cached);
      subIndex++;
      continue;
    }

    if (!fsSync.existsSync(subAudioPath)) {
      await execFileAsync('ffmpeg', [
        '-y',
        '-ss',
        String(offset),
        '-t',
        String(subLen),
        '-i',
        chunk.audioPath,
        '-ac',
        '1',
        '-ar',
        '16000',
        '-c:a',
        'aac',
        '-b:a',
        '64k',
        subAudioPath,
      ]);
    }

    logInfo(
      `  Transcribing sub-chunk #${subIndex + 1} [${formatSeconds(
        absStart
      )} - ${formatSeconds(absEnd)}]...`
    );

    try {
      const subText = await sendAudioToGemini(
        subAudioPath,
        `${fallbackPrompt}\n（対象区間: ${formatSeconds(absStart)}〜${formatSeconds(absEnd)}）`,
        config
      );
      await fs.writeFile(subCachePath, subText, 'utf8');
      subResults.push(subText);
    } catch (subErr) {
      if (subErr instanceof GeminiBlockedError) {
        logWarn(
          `  Sub-chunk #${subIndex + 1} [${formatSeconds(absStart)} - ${formatSeconds(
            absEnd
          )}] blocked (${subErr.reason}); skipping this 3-min segment.`
        );
        const placeholder = `[※ ${formatSeconds(absStart)} 〜 ${formatSeconds(
          absEnd
        )} の区間は背景音またはAPI制限によりスキップされました]`;
        await fs.writeFile(subCachePath, placeholder, 'utf8');
        subResults.push(placeholder);
      } else {
        throw subErr;
      }
    }

    subIndex++;
  }

  return subResults.join('\n\n');
}

/**
 * Transcribe a single audio chunk using Gemini, with automatic fallback and sub-chunk
 * recovery if Gemini returns `blockReason: OTHER` / `RECITATION`.
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

  const chunkHeader =
    totalChunks > 1
      ? `\n\n※この音声は全体のうちパート ${chunk.index + 1}/${totalChunks}（開始位置: ${formatSeconds(
          chunk.startSeconds
        )}〜${formatSeconds(chunk.endSeconds)}）です。`
      : '';

  const fullPrompt = `${promptTemplate.trim()}${chunkHeader}`;

  try {
    return await sendAudioToGemini(chunk.audioPath, fullPrompt, config);
  } catch (err) {
    if (!(err instanceof GeminiBlockedError)) {
      throw err;
    }

    logWarn(
      `Chunk #${chunk.index + 1} [${formatSeconds(
        chunk.startSeconds
      )} - ${formatSeconds(
        chunk.endSeconds
      )}] was blocked (${err.reason}). Retrying with simplified prompt...`
    );

    const fallbackPrompt = [
      'この音声に含まれる人の会話・発言内容のみを日本語で文字起こししてください。',
      '背景の音楽・BGM・環境音・雑音はすべて無視し、聞き取れる会話のみを自然な文章で出力してください。',
      '前置きや挨拶は出力せず、本文のみを出力してください。',
    ].join('\n');

    try {
      return await sendAudioToGemini(
        chunk.audioPath,
        `${fallbackPrompt}\n（区間: ${formatSeconds(chunk.startSeconds)}〜${formatSeconds(
          chunk.endSeconds
        )}）`,
        config
      );
    } catch (fallbackErr) {
      if (!(fallbackErr instanceof GeminiBlockedError)) {
        throw fallbackErr;
      }
      return await transcribeBlockedChunkBySplitting(
        chunk,
        fallbackPrompt,
        config
      );
    }
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
