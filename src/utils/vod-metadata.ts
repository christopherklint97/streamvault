export function parseVodId(channelId: string): number | null {
  const match = /^(?:vod|movie)_(\d+)$/.exec(channelId);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) ? value : null;
}

export function isVodInfoLoading(vodId: number | null, requestLoading: boolean): boolean {
  return vodId !== null && requestLoading;
}

export function parseMediaDuration(value: string | undefined): number | undefined {
  const text = value?.trim();
  if (!text) return undefined;

  if (text.includes(':')) {
    const parts = text.split(':').map(Number);
    if (parts.length < 2 || parts.length > 3 || parts.some(part => !Number.isFinite(part) || part < 0)) return undefined;
    return parts.reduce((total, part) => total * 60 + part, 0);
  }

  const minutes = /^(\d+(?:\.\d+)?)\s*(?:m|min|mins|minutes)$/i.exec(text);
  if (minutes) return Math.round(Number(minutes[1]) * 60);
  return undefined;
}
