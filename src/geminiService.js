import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  formatSeconds,
  getAudioDurationSeconds,
  isSilentAudio,
} from './audioChunker.js';
import { logInfo, logWarn } from './notifier.js';

const execFileAsync = promisify(execFile);

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com';
const REQUEST_TIMEOUT_MS = 240_000; // 4 minutes per API request
const HEARTBEAT_INTERVAL_MS = 25_000; // Log progress every 25 seconds during long calls

const MIME_MAP = {
  '.wav': 'audio/wav',
  '.mp3': 'audio/mp3',
  '.m4a': 'audio/m4a',
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
  return MIME_MAP[ext] || 'audio/m4a';
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run an async operation while printing a periodic heartbeat log so the user knows
 * the process is actively waiting on Gemini API and not frozen.
 */
async function withProgressHeartbeat(label, fn) {
  const startTime = Date.now();
  const timer = setInterval(() => {
    const elapsedSec = Math.round((Date.now() - startTime) / 1000);
    logInfo(`  ... waiting for Gemini API response (${label}, ${elapsedSec}s elapsed)`);
  }, HEARTBEAT_INTERVAL_MS);

  if (typeof timer.unref === 'function') {
    timer.unref();
  }

  try {
    return await fn();
  } finally {
    clearInterval(timer);
  }
}

/**
 * Call Gemini REST API (`generateContent`) with automatic exponential backoff retry for 429 / 5xx.
 * Treats empty text with `finishReason: "STOP"` as `[発話なし]` without retrying.
 */
async function callGenerateContent(
  apiKey,
  model,
  contents,
  maxRetries = 3,
  label = 'generateContent'
) {
  const url = `${GEMINI_API_BASE}/v1beta/models/${encodeURIComponent(
    model
  )}:generateContent?key=${encodeURIComponent(apiKey)}`;

  let lastError;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await withProgressHeartbeat(label, () =>
        fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          body: JSON.stringify({
            contents,
            safetySettings: DEFAULT_SAFETY_SETTINGS,
            generationConfig: {
              temperature: 0.2,
            },
          }),
        })
      );

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
        httpErr.nonRetryable =
          response.status >= 400 &&
          response.status < 500 &&
          response.status !== 429;
        throw httpErr;
      }

      const data = await response.json();
      const finishReason = data.candidates?.[0]?.finishReason;

      // Check if blocked by promptFeedback or candidate finishReason
      const blockReason =
        data.promptFeedback?.blockReason ||
        (finishReason &&
        ['SAFETY', 'RECITATION', 'OTHER', 'BLOCKLIST', 'PROHIBITED_CONTENT'].includes(
          finishReason
        )
          ? finishReason
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
        // When finishReason is STOP with empty parts, the audio segment had no recognizable speech
        if (finishReason === 'STOP') {
          return '[発話なし]';
        }
        throw new Error(
          `Gemini API returned empty text. Raw response: ${JSON.stringify(data).slice(0, 300)}`
        );
      }
      return text;
    } catch (err) {
      lastError = err;
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
 * Upload an audio file via the Gemini File API (resumable upload),
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
    signal: AbortSignal.timeout(60_000),
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

  const uploadRes = await withProgressHeartbeat(
    `upload ${displayName}`,
    () =>
      fetch(uploadUrl, {
        method: 'POST',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: {
          'Content-Length': String(numBytes),
          'X-Goog-Upload-Offset': '0',
          'X-Goog-Upload-Command': 'upload, finalize',
        },
        body: fileBuffer,
      })
  );

  if (!uploadRes.ok) {
    throw new Error(
      `Failed to upload file bytes to Gemini File API: ${uploadRes.status}`
    );
  }

  const { file } = await uploadRes.json();

  // Poll until ACTIVE
  for (let i = 0; i < 30; i++) {
    const checkRes = await fetch(
      `${GEMINI_API_BASE}/v1beta/${file.name}?key=${encodeURIComponent(apiKey)}`,
      { signal: AbortSignal.timeout(30_000) }
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
    await sleep(1500);
  }

  return file;
}

async function deleteGeminiRemoteFile(apiKey, fileName) {
  try {
    await fetch(
      `${GEMINI_API_BASE}/v1beta/${fileName}?key=${encodeURIComponent(apiKey)}`,
      { method: 'DELETE', signal: AbortSignal.timeout(15_000) }
    );
  } catch {
    // Best-effort remote file cleanup
  }
}

/**
 * Transcribe audio using the dedicated Speech-to-Text model (`gemini-3.5-transcribe`)
 * via the Gemini Interactions API (`/v1beta/interactions`).
 */
async function transcribeWithDedicatedModel(audioPath, config) {
  const mimeType = getAudioMimeType(audioPath);
  const modelName = config.geminiTranscribeModel.replace(/^models\//, '');
  const stat = await fs.stat(audioPath);

  let uploadedFile = null;
  let audioContentInput;

  if (stat.size <= 15 * 1024 * 1024) {
    const buffer = await fs.readFile(audioPath);
    audioContentInput = {
      type: 'audio',
      data: buffer.toString('base64'),
      mime_type: mimeType,
    };
  } else {
    uploadedFile = await uploadToGeminiFileApi(
      config.geminiApiKey,
      audioPath,
      mimeType
    );
    audioContentInput = {
      type: 'audio',
      uri: uploadedFile.uri,
      mime_type: uploadedFile.mimeType || mimeType,
    };
  }

  try {
    const transcriptionConfig = {
      mode: 'smart',
      language_codes: ['ja-JP'],
    };
    if (
      Array.isArray(config.customVocabulary) &&
      config.customVocabulary.length > 0
    ) {
      transcriptionConfig.custom_vocabulary = config.customVocabulary.slice(
        0,
        1000
      );
    }

    const res = await withProgressHeartbeat(
      config.geminiTranscribeModel,
      () =>
        fetch(`${GEMINI_API_BASE}/v1beta/interactions`, {
          method: 'POST',
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          headers: {
            'x-goog-api-key': config.geminiApiKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: modelName,
            store: false,
            input: [audioContentInput],
            generation_config: {
              transcription_config: transcriptionConfig,
            },
          }),
        })
    );

    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(
        `gemini-3.5-transcribe HTTP ${res.status}: ${errBody.slice(0, 400)}`
      );
    }

    const data = await res.json();
    const texts = [];
    for (const step of data.steps || []) {
      if (step.type === 'model_output') {
        for (const item of step.content || []) {
          if (item.type === 'text' && item.text) {
            texts.push(item.text.trim());
          }
        }
      }
    }
    if (texts.length === 0) {
      for (const item of data.outputs || []) {
        if (item.type === 'text' && item.text) {
          texts.push(item.text.trim());
        }
      }
    }

    const combined = texts.filter(Boolean).join('\n\n').trim();
    if (!combined) {
      if (data.status === 'completed') {
        return '[発話なし]';
      }
      throw new GeminiBlockedError(data.status || 'EMPTY_TRANSCRIPT', data);
    }
    return combined;
  } finally {
    if (uploadedFile) {
      await deleteGeminiRemoteFile(config.geminiApiKey, uploadedFile.name);
    }
  }
}

/**
 * Send a single audio file + prompt to Gemini `generateContent` (using inlineData for <=15MB or File API for >15MB).
 */
async function sendAudioToGenerateContent(
  audioPath,
  promptText,
  config,
  label = 'transcribe'
) {
  // For generateContent, audio/mp4 is widely accepted for .m4a
  const ext = path.extname(audioPath).toLowerCase();
  const mimeType = ext === '.m4a' ? 'audio/mp4' : getAudioMimeType(audioPath);
  const stat = await fs.stat(audioPath);

  if (stat.size <= 15 * 1024 * 1024) {
    const buffer = await fs.readFile(audioPath);
    const base64Audio = buffer.toString('base64');
    return callGenerateContent(
      config.geminiApiKey,
      config.geminiModel,
      [
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
      ],
      3,
      label
    );
  }

  logInfo(`Uploading ${path.basename(audioPath)} via Gemini File API...`);
  const uploadedFile = await uploadToGeminiFileApi(
    config.geminiApiKey,
    audioPath,
    mimeType
  );
  try {
    return await callGenerateContent(
      config.geminiApiKey,
      config.geminiModel,
      [
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
      ],
      3,
      label
    );
  } finally {
    await deleteGeminiRemoteFile(config.geminiApiKey, uploadedFile.name);
  }
}

/**
 * Fallback when an audio chunk is blocked by `blockReason: OTHER` or `RECITATION`:
 * Immediately splits the chunk into 90-second sub-chunks so that a brief BGM/noise segment
 * only skips at most 90 seconds and does not waste time retrying the full 10-minute chunk.
 */
async function transcribeBlockedChunkBySplitting(chunk, fallbackPrompt, config) {
  const SUB_CHUNK_SECONDS = 90; // 1.5 minutes per sub-chunk for minimal loss
  const duration = await getAudioDurationSeconds(chunk.audioPath);
  const workDir = path.dirname(chunk.audioPath);
  const baseName = path.basename(chunk.audioPath, path.extname(chunk.audioPath));

  if (duration <= SUB_CHUNK_SECONDS + 15) {
    logWarn(
      `Segment [${formatSeconds(chunk.startSeconds)} - ${formatSeconds(
        chunk.endSeconds
      )}] was blocked by Gemini API; skipping segment.`
    );
    return `[※ ${formatSeconds(chunk.startSeconds)} 〜 ${formatSeconds(
      chunk.endSeconds
    )} の区間は背景音またはAPI制限によりスキップされました]`;
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
    const subTag = `${baseName}_sub90_${String(subIndex).padStart(2, '0')}`;
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

    if (await isSilentAudio(subAudioPath)) {
      logInfo(
        `  Sub-chunk #${subIndex + 1} [${formatSeconds(absStart)} - ${formatSeconds(
          absEnd
        )}] is silent; skipping API call.`
      );
      await fs.writeFile(subCachePath, '[発話なし]', 'utf8');
      subResults.push('[発話なし]');
      subIndex++;
      continue;
    }

    logInfo(
      `  Transcribing sub-chunk #${subIndex + 1} [${formatSeconds(
        absStart
      )} - ${formatSeconds(absEnd)}]...`
    );

    try {
      const subText = await sendAudioToGenerateContent(
        subAudioPath,
        `${fallbackPrompt}\n（対象区間: ${formatSeconds(absStart)}〜${formatSeconds(absEnd)}）`,
        config,
        `sub-chunk #${subIndex + 1}`
      );
      await fs.writeFile(subCachePath, subText, 'utf8');
      subResults.push(subText);
    } catch (subErr) {
      if (subErr instanceof GeminiBlockedError) {
        logWarn(
          `  Sub-chunk #${subIndex + 1} [${formatSeconds(absStart)} - ${formatSeconds(
            absEnd
          )}] blocked (${subErr.reason}); skipping this 90s segment.`
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
 * Transcribe a single audio chunk:
 * 1. Pre-checks for complete silence via `isSilentAudio`.
 * 2. If `config.geminiTranscribeModel` is a dedicated `*transcribe*` model (e.g. `gemini-3.5-transcribe`),
 *    uses the dedicated Speech-to-Text Interactions API first.
 * 3. Falls back to `config.geminiModel` (`generateContent`) with previous-chunk context and 90s sub-chunk splitting.
 */
export async function transcribeAudioChunk(
  chunk,
  totalChunks,
  promptTemplate,
  config,
  options = {}
) {
  const { dryRun = false, previousContext = '' } = options;

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

  if (await isSilentAudio(chunk.audioPath)) {
    logInfo(
      `Chunk #${chunk.index + 1}/${totalChunks} [${formatSeconds(
        chunk.startSeconds
      )} - ${formatSeconds(chunk.endSeconds)}] is silent; skipping API call.`
    );
    return '[発話なし]';
  }

  const transcribeModel = config.geminiTranscribeModel || '';

  // Try dedicated speech-to-text model (`gemini-3.5-transcribe`) if configured
  if (transcribeModel.includes('transcribe')) {
    try {
      return await transcribeWithDedicatedModel(chunk.audioPath, config);
    } catch (transcribeErr) {
      logWarn(
        `Dedicated model (${transcribeModel}) failed on chunk #${
          chunk.index + 1
        } (${transcribeErr.message}). Falling back to ${config.geminiModel}...`
      );
    }
  }

  const chunkHeader =
    totalChunks > 1
      ? `\n\n※この音声は全体のうちパート ${chunk.index + 1}/${totalChunks}（開始位置: ${formatSeconds(
          chunk.startSeconds
        )}〜${formatSeconds(chunk.endSeconds)}）です。`
      : '';

  const vocabHint =
    Array.isArray(config.customVocabulary) && config.customVocabulary.length > 0
      ? `\n\n【用語ヒント（音声に含まれる可能性がある固有名詞・専門用語）】\n${config.customVocabulary.join(', ')}`
      : '';

  const contextHint = previousContext
    ? `\n\n【直前パートの末尾（文脈・話者表記統一の参考用。この内容は重複して出力しないでください）】\n${previousContext}`
    : '';

  const fullPrompt = `${promptTemplate.trim()}${vocabHint}${chunkHeader}${contextHint}`;

  try {
    return await sendAudioToGenerateContent(
      chunk.audioPath,
      fullPrompt,
      config,
      `chunk #${chunk.index + 1}/${totalChunks}`
    );
  } catch (err) {
    if (!(err instanceof GeminiBlockedError)) {
      throw err;
    }

    const fallbackPrompt = [
      'この音声に含まれる人の会話・発言内容のみを日本語で文字起こししてください。',
      '背景の音楽・BGM・環境音・雑音はすべて無視し、聞き取れる会話のみを自然な文章で出力してください。',
      '発話がない場合は [発話なし] とだけ出力してください。前置きや挨拶は不要です。',
      vocabHint,
    ]
      .filter(Boolean)
      .join('\n');

    return await transcribeBlockedChunkBySplitting(
      chunk,
      fallbackPrompt,
      config
    );
  }
}

/**
 * Check whether the full transcript contains any actual spoken content
 * beyond `[発話なし]`, skip notices, and `### Part ...` headers.
 */
export function hasMeaningfulSpeech(transcriptText) {
  const stripped = String(transcriptText || '')
    .replace(/^###\s+Part\s+\d+.*$/gm, '')
    .replace(/\[発話なし\]/g, '')
    .replace(/\[※[^\]]*スキップされました\]/g, '')
    .trim();
  return stripped.length > 0;
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

  if (!hasMeaningfulSpeech(transcriptText)) {
    return {
      title: '発話なし（無音または背景音のみ）',
      summaryMarkdown: [
        '## 要約',
        '- 録音データ内に認識可能な発話が含まれていませんでした。',
        '',
        '## 詳細・主なトピック',
        '- 該当なし',
        '',
        '## アクションアイテム / TODO',
        '- 特になし',
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
    ],
    3,
    'summarize'
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
