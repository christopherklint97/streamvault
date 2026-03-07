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

export type View = 'home' | 'channels' | 'movies' | 'series' | 'guide' | 'player' | 'settings';

export interface PlayerState {
  status: 'idle' | 'loading' | 'playing' | 'paused' | 'error';
  currentChannel: Channel | null;
  errorMessage: string;
}
