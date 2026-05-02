/**
 * Early-boot logger. Runs before React mounts so we can capture Tizen
 * diagnostics and uncaught errors when something keeps the app from
 * rendering (no console access on a TV). Sends to /api/client-logs which
 * surfaces in `docker logs streamvault-server`.
 */

declare const __SERVER_URL__: string;

const SERVER_URL: string =
  (typeof __SERVER_URL__ !== 'undefined' && __SERVER_URL__) ||
  (typeof localStorage !== 'undefined' && localStorage.getItem('streamvault_api_url')) ||
  '';

function send(level: 'debug' | 'info' | 'warn' | 'error', message: string): void {
  const ts = new Date().toISOString();
  // Always log to console too — visible on Tizen Web Inspector if connected
  const consoleFn = level === 'debug' ? 'log' : level;
  console[consoleFn](`[SV:EARLY:${level.toUpperCase()}]`, message);

  if (!SERVER_URL) return;
  try {
    fetch(`${SERVER_URL}/api/client-logs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ logs: [{ level, message, ts }] }),
      keepalive: true,
    }).catch(() => { /* ignore */ });
  } catch {
    /* ignore */
  }
}

export function earlyLog(label: string, data?: Record<string, unknown>): void {
  const payload = data ? `${label} ${JSON.stringify(data)}` : label;
  send('info', payload);
}

export function earlyError(label: string, err: unknown): void {
  const e = err as { message?: string; stack?: string } | null;
  const detail = e ? `${e.message || String(err)} | ${e.stack || ''}` : String(err);
  send('error', `${label}: ${detail}`);
}

export function installCrashLogger(): void {
  window.addEventListener('error', (event) => {
    const e = event as ErrorEvent;
    send(
      'error',
      `[window.error] ${e.message} @ ${e.filename}:${e.lineno}:${e.colno} | ${
        (e.error && e.error.stack) || ''
      }`
    );
  });
  window.addEventListener('unhandledrejection', (event) => {
    const e = event as PromiseRejectionEvent;
    const reason = e.reason as { message?: string; stack?: string } | string;
    const msg =
      typeof reason === 'string'
        ? reason
        : `${reason?.message || String(reason)} | ${reason?.stack || ''}`;
    send('error', `[unhandledrejection] ${msg}`);
  });
}

export function logBootDiagnostics(): void {
  const html = document.documentElement;
  const body = document.body;
  const root = document.getElementById('root');
  earlyLog('boot.diag', {
    ua: navigator.userAgent,
    innerW: window.innerWidth,
    innerH: window.innerHeight,
    devicePixelRatio: window.devicePixelRatio,
    maxTouchPoints: navigator.maxTouchPoints,
    hasTizenGlobal: typeof tizen !== 'undefined',
    hasWebapis: typeof webapis !== 'undefined',
    dataTizenAttr: html.hasAttribute('data-tizen'),
    htmlClientW: html.clientWidth,
    htmlClientH: html.clientHeight,
    bodyClientW: body?.clientWidth,
    bodyClientH: body?.clientHeight,
    rootClientW: root?.clientWidth,
    rootClientH: root?.clientHeight,
    matchesLg: window.matchMedia('(min-width: 64rem)').matches,
    matchesMobile: window.matchMedia('(max-width: 1024px)').matches,
    serverUrl: SERVER_URL,
  });
}
