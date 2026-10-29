import { execFile } from 'node:child_process';
import os from 'node:os';

/**
 * Send a macOS Notification Center alert via osascript (no external dependencies).
 */
export function sendMacNotification(title, message, enabled = true) {
  if (!enabled || os.platform() !== 'darwin') {
    return Promise.resolve(false);
  }

  const safeTitle = String(title).replace(/["\\]/g, '\\$&');
  const safeMsg = String(message).replace(/["\\]/g, '\\$&');
  const script = `display notification "${safeMsg}" with title "${safeTitle}"`;

  return new Promise((resolve) => {
    execFile('osascript', ['-e', script], { timeout: 3000 }, (err) => {
      resolve(!err);
    });
  });
}

export function logInfo(msg) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [INFO] ${msg}`);
}

export function logWarn(msg) {
  const ts = new Date().toISOString();
  console.warn(`[${ts}] [WARN] ${msg}`);
}

export function logError(msg, err) {
  const ts = new Date().toISOString();
  console.error(`[${ts}] [ERROR] ${msg}`, err ? err.message || err : '');
}
