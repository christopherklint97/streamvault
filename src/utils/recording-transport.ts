export function recordingTransport(filePath: string | null): 'mpegts' | 'native' {
  return filePath?.toLowerCase().endsWith('.ts') ? 'mpegts' : 'native';
}

/** A playback ticket remains bound to the same recording when switching transports. */
export function recordingHlsPath(streamUrl: string, startSeconds: number): string {
  const url = new URL(streamUrl, 'http://streamvault.local');
  if (!/^\/api\/recordings\/[^/]+\/stream$/.test(url.pathname)) {
    throw new Error('Not a recording stream URL');
  }
  url.pathname = url.pathname.replace(/\/stream$/, '/hls/index.m3u8');
  if (Number.isFinite(startSeconds) && startSeconds > 0) url.searchParams.set('start', String(startSeconds));
  return `${url.pathname}${url.search}`;
}
