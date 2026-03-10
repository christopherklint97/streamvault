/**
 * Frontend logger that logs to both browser console and streams
 * to the server (which outputs to Docker stdout → Dozzle).
 */

import { useChannelStore } from '../stores/channelStore';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_QUEUE: Array<{ level: LogLevel; message: string; ts: string }> = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
const FLUSH_INTERVAL = 1000;
const MAX_QUEUE = 50;

function getApiBase(): string {
  return useChannelStore.getState().apiBaseUrl;
}

function flush() {
  if (LOG_QUEUE.length === 0) return;
  const batch = LOG_QUEUE.splice(0, MAX_QUEUE);
  const apiBase = getApiBase();
  const url = `${apiBase}/api/client-logs`;
  // Fire and forget — don't let logging failures break the app
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ logs: batch }),
  }).catch(() => {
    // Silently drop if server unreachable
  });
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flush();
  }, FLUSH_INTERVAL);
}

function log(level: LogLevel, message: string, ...args: unknown[]) {
  const ts = new Date().toISOString();

  // Always log to browser console
  const consoleFn = level === 'debug' ? 'log' : level;
  if (args.length > 0) {
    console[consoleFn](`[SV:${level.toUpperCase()}]`, message, ...args);
  } else {
    console[consoleFn](`[SV:${level.toUpperCase()}]`, message);
  }

  // Queue for server
  const fullMessage = args.length > 0
    ? `${message} ${args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')}`
    : message;
  LOG_QUEUE.push({ level, message: fullMessage, ts });

  // Flush immediately for errors, batch for others
  if (level === 'error') {
    flush();
  } else {
    scheduleFlush();
  }
}

export const clientLogger = {
  debug: (msg: string, ...args: unknown[]) => log('debug', msg, ...args),
  info: (msg: string, ...args: unknown[]) => log('info', msg, ...args),
  warn: (msg: string, ...args: unknown[]) => log('warn', msg, ...args),
  error: (msg: string, ...args: unknown[]) => log('error', msg, ...args),
};
