// Provider stream URLs embed Xtream credentials, so API responses carry an
// opaque reference instead and the server resolves it when playback starts.
const PREFIX = 'streamvault:';
const EPISODE = /^episode\/(\d{1,12})(?:\.([a-z0-9]{1,8}))?$/i;

export function channelSourceRef(channelId: string, url: string): string {
  return url ? `${PREFIX}${channelId}` : '';
}

export function episodeSourceRef(episodeId: string | number, extension?: string): string {
  const ext = extension && /^[a-z0-9]{1,8}$/i.test(extension) ? `.${extension}` : '';
  return `${PREFIX}episode/${episodeId}${ext}`;
}

export interface SourceRefResolvers {
  channelUrl(channelId: string): string | undefined;
  episodeUrl(episodeId: number, extension?: string): string | undefined;
}

/** Resolves a reference to its provider URL; other values (legacy clients) pass through. */
export function resolveSourceRef(raw: string, resolvers: SourceRefResolvers): string | undefined {
  if (!raw.startsWith(PREFIX)) return raw;
  const ref = raw.slice(PREFIX.length);
  const episode = EPISODE.exec(ref);
  if (episode) return resolvers.episodeUrl(Number(episode[1]), episode[2]);
  return resolvers.channelUrl(ref) || undefined;
}
