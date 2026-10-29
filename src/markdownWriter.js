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
}) {
  await fs.mkdir(outputDir, { recursive: true });

  const { filePrefix, isoDate, readableDateTime } = formatDateParts(recordedAt);
  const safeTitle = sanitizeTitleForFilename(title);
  const fileName = `${filePrefix}_${safeTitle}.md`;
  const outputPath = path.join(outputDir, fileName);

  const audioFileName = path.basename(audioPath);
  const formattedDuration = formatSeconds(durationSeconds);

  const markdownContent = `---
title: "${title.replace(/"/g, '\\"')}"
date: ${isoDate}
recorded_at: "${readableDateTime}"
duration: "${formattedDuration}"
source_audio: "${audioFileName}"
model: "${modelName}"
tags:
  - voice-memo
  - voxnote
---

# ${title}

- **録音日時**: ${readableDateTime}
- **再生時間**: ${formattedDuration}
- **元ファイル**: \`${audioFileName}\`

---

${summaryMarkdown}

---

## 全文文字起こし (Transcript)

${fullTranscript}
`;

  await fs.writeFile(outputPath, markdownContent, 'utf8');
  return outputPath;
}
