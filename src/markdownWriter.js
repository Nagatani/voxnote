import fs from 'node:fs/promises';
import path from 'node:path';
import { formatSeconds } from './audioChunker.js';

/**
 * Sanitize a string for safe macOS/Windows/Linux filenames.
 */
export function sanitizeTitleForFilename(title) {
  return (
    String(title || 'ボイスメモ')
      .replace(/[\\/:*?"<>|#\r\n\t]+/g, '_')
      .replace(/\s+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 50) || 'ボイスメモ'
  );
}

/**
 * Extract recording start timestamp from voice recorder filenames such as:
 * - `2026-10-29-12-09-00.WAV`
 * - `2026-10-29_12-09-00.WAV`
 * - `20261029_120900.m4a`
 * Falls back to `fallbackDate` if no timestamp pattern is found in the filename.
 */
export function extractRecordedDateFromFilename(filePathOrName, fallbackDate) {
  const base = path.basename(String(filePathOrName));
  const match = base.match(
    /(20\d{2})[-_]?(\d{2})[-_]?(\d{2})[-_ T](\d{2})[-_]?(\d{2})[-_]?(\d{2})/
  );
  if (match) {
    const [, yyyy, mm, dd, hh, min, ss] = match;
    const parsed = new Date(
      Number(yyyy),
      Number(mm) - 1,
      Number(dd),
      Number(hh),
      Number(min),
      Number(ss)
    );
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }
  return fallbackDate;
}

/**
 * Collapse consecutive skip notices (`[※ 00:00:00 〜 00:03:00 ... スキップされました]`)
 * and consecutive `[発話なし]` placeholders into a single clean range.
 */
export function collapseConsecutivePlaceholders(transcript) {
  if (!transcript) return '';

  // 1. Merge consecutive time-range skip notices
  const skipPattern =
    /\[※\s*(\d{2}:\d{2}:\d{2})\s*〜\s*(\d{2}:\d{2}:\d{2})\s*の区間は([^\]]*?)スキップされました\]/g;

  const paragraphs = transcript.split(/\n{2,}/);
  const merged = [];

  for (const para of paragraphs) {
    const trimmed = para.trim();
    const singleSkipMatch = trimmed.match(
      /^\[※\s*(\d{2}:\d{2}:\d{2})\s*〜\s*(\d{2}:\d{2}:\d{2})\s*の区間は([^\]]*?)スキップされました\]$/
    );

    if (singleSkipMatch && merged.length > 0) {
      const prev = merged[merged.length - 1];
      const prevMatch = prev.match(
        /^\[※\s*(\d{2}:\d{2}:\d{2})\s*〜\s*(\d{2}:\d{2}:\d{2})\s*の区間は([^\]]*?)スキップされました\]$/
      );
      if (prevMatch && prevMatch[2] === singleSkipMatch[1]) {
        merged[merged.length - 1] = `[※ ${prevMatch[1]} 〜 ${singleSkipMatch[2]} の区間は${singleSkipMatch[3]}スキップされました]`;
        continue;
      }
    }

    if (
      trimmed === '[発話なし]' &&
      merged.length > 0 &&
      merged[merged.length - 1] === '[発話なし]'
    ) {
      continue;
    }

    merged.push(trimmed);
  }

  return merged.join('\n\n').replace(skipPattern, (full) => full);
}

/**
 * Format a Date object into local `YYYY-MM-DD_HHmmss` and `YYYY-MM-DD HH:mm:ss`
 */
export function formatDateParts(date) {
  const pad = (n) => String(n).padStart(2, '0');
  const yyyy = date.getFullYear();
  const mm = pad(date.getMonth() + 1);
  const dd = pad(date.getDate());
  const hh = pad(date.getHours());
  const min = pad(date.getMinutes());
  const ss = pad(date.getSeconds());

  return {
    filePrefix: `${yyyy}-${mm}-${dd}_${hh}${min}${ss}`,
    isoDate: `${yyyy}-${mm}-${dd}`,
    readableDateTime: `${yyyy}-${mm}-${dd} ${hh}:${min}:${ss}`,
  };
}

/**
 * Write the final Markdown file containing metadata, summary, and full transcript.
 */
export async function writeMarkdownNote({
  outputDir,
  audioPath,
  recordedAt,
  durationSeconds,
  title,
  summaryMarkdown,
  fullTranscript,
  modelName,
  transcribeModelName,
}) {
  await fs.mkdir(outputDir, { recursive: true });

  const effectiveDate = extractRecordedDateFromFilename(audioPath, recordedAt);
  const { filePrefix, readableDateTime } = formatDateParts(effectiveDate);
  const safeTitle = sanitizeTitleForFilename(title);
  const fileName = `${filePrefix}_${safeTitle}.md`;
  const outputPath = path.join(outputDir, fileName);

  const audioFileName = path.basename(audioPath);
  const formattedDuration = formatSeconds(durationSeconds);
  const cleanedTranscript = collapseConsecutivePlaceholders(fullTranscript);

  const modelLabel =
    transcribeModelName && transcribeModelName !== modelName
      ? `文字起こし: \`${transcribeModelName}\` / 要約: \`${modelName}\``
      : `\`${modelName}\``;

  const markdownContent = `# ${title}

- **録音日時**: ${readableDateTime}
- **再生時間**: ${formattedDuration}
- **元ファイル**: \`${audioFileName}\`
- **使用モデル**: ${modelLabel}

---

${summaryMarkdown}

---

## 全文文字起こし

${cleanedTranscript}
`;

  await fs.writeFile(outputPath, markdownContent, 'utf8');
  return outputPath;
}
