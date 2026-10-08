export interface PersistentVideoPlaybackState {
  paused: boolean;
  readyState: number;
  channelId?: string;
  awaitingGesture?: boolean;
}

export function shouldStartPlayerPlayback(
  previousChannelId: string | undefined,
  currentChannelId: string,
  mobile: boolean,
  video: PersistentVideoPlaybackState | null,
): boolean {
  if (previousChannelId !== undefined && previousChannelId !== currentChannelId) return true;
  if (!mobile) return true;
  if (!video || video.channelId !== currentChannelId) return true;
  if (video.awaitingGesture && video.readyState > 0) return false;
  return video.paused || video.readyState === 0;
}
