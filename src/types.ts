export type ContentType = 'livetv' | 'movies' | 'series';

export interface Channel {
  id: string;
  name: string;
  url: string;
  logo: string;
  group: string;
  region: string;
  contentType: ContentType;
  isFavorite: boolean;
}

export interface Program {
  channelId: string;
  title: string;
  description: string;
  start: Date;
  stop: Date;
  category: string;
}

export type View = 'home' | 'channels' | 'movies' | 'series' | 'player' | 'settings';

export interface Category {
  id: string;
  name: string;
  content_type: ContentType;
  stream_count: number;
  fetched_at: number;
}

export interface PlayerState {
  status: 'idle' | 'loading' | 'playing' | 'paused' | 'error';
  currentChannel: Channel | null;
  errorMessage: string;
}

export interface WatchProgress {
  channelId: string;
  /** Current playback position in seconds */
  position: number;
  /** Total duration in seconds (0 for live content) */
  duration: number;
  /** Timestamp of last update */
  updatedAt: number;
  /** Content type at time of watching */
  contentType: ContentType;
}
