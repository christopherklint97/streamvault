/** Add live-player transport options to a server stream path. */
export function withLiveStreamOptions(path: string, audioOnly: boolean): string {
  if (!audioOnly) return path;
  return `${path}${path.includes('?') ? '&' : '?'}audio=1`;
}
