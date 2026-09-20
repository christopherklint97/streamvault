export type ContentType = 'livetv' | 'movies' | 'series';

export interface Channel {
  id: string;
  name: string;
  url: string;
  logo: string;
  group: string;
  region: string;
  contentType: ContentType;
  /** Provider-reported VOD duration in seconds, when known. */
  duration?: number;
  /** Parent series ID for an episode. */
  seriesId?: string;
  /** Explicit recording identity; avoids inferring it from a synthetic channel ID. */
  recordingId?: string;
}

export interface Program {
  channelId: string;
  title: string;
  description: string;
  start: Date;
  stop: Date;
  category: string;
}

export type View = 'home' | 'channels' | 'movies' | 'series' | 'player' | 'settings' | 'seriesDetail' | 'movieDetail' | 'guide' | 'recordings' | 'recordingDetail';

export interface MovieInfo {
  name: string;
  cover: string;
  plot: string;
  genre: string;
  releaseDate: string;
  rating: string;
  cast: string;
  director: string;
  duration: string;
  tmdbId: string;
}

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

export interface Episode {
  id: string;
  episodeNum: number;
  title: string;
  season: number;
  url: string;
  containerExtension: string;
  duration: string;
  plot: string;
  image: string;
  rating: number;
}

export interface SeasonInfo {
  seasonNumber: number;
  name: string;
  episodeCount: number;
  cover: string;
}

export interface SeriesInfo {
  name: string;
  cover: string;
  plot: string;
  genre: string;
  releaseDate: string;
  rating: string;
  cast: string;
  director: string;
  seasons: SeasonInfo[];
  episodes: Record<number, Episode[]>;
}

export interface FavoriteList {
  id: string;
  name: string;
  channelIds: string[];
}

export type RecordingStatus = 'scheduled' | 'recording' | 'completed' | 'failed' | 'cancelled';

export interface Recording {
  id: string;
  channel_id: string;
  channel_name: string;
  title: string;
  status: RecordingStatus;
  start_time: number;
  end_time: number;
  actual_start: number | null;
  actual_end: number | null;
  file_path: string | null;
  file_size: number;
  duration: number;
  error: string | null;
  rule_id: string | null;
  program_title: string | null;
  created_at: number;
  master_file_path?: string | null;
  derivative_file_path?: string | null;
  derivative_error?: string | null;
  analysis_state?: CommercialAnalysisStatus;
  analysis_error?: string | null;
  analysis_profile?: string | null;
  commercial_segment_count?: number;
  commercial_seconds?: number;
  commercial_skip_override?: boolean | 0 | 1 | null;
}

export type CommercialAnalysisStatus =
  | 'not_requested'
  | 'not_analyzed'
  | 'queued'
  | 'analyzing'
  | 'completed'
  | 'review_needed'
  | 'ready'
  | 'failed';

export type CommercialSegmentState = 'suggested' | 'accepted' | 'rejected';
export type CommercialSegmentSource = 'manual' | 'detector' | 'scte35' | string;

export interface CommercialSegment {
  id: string;
  startSeconds: number;
  endSeconds: number;
  source: CommercialSegmentSource;
  confidence: number | null;
  state: CommercialSegmentState;
  detectorVersion?: string;
  profileVersion?: string;
}

export interface CommercialAnalysisInfo {
  status: CommercialAnalysisStatus;
  error: string | null;
  detector: string | null;
  profileVersion: string | null;
}

export interface CommercialSegmentsResponse {
  analysis: CommercialAnalysisInfo;
  segments: CommercialSegment[];
  autoSkipOverride: boolean | null;
  effectiveAutoSkip: boolean;
}

export type RecordingRuleMatchType = 'exact' | 'startsWith' | 'contains';
export type RecordingRepeatPolicy = 'all' | 'include_unknown' | 'new_only';

export interface RecordingRule {
  id: string;
  channel_id: string;
  channel_name: string;
  match_title: string;
  match_type: RecordingRuleMatchType;
  repeat_policy: RecordingRepeatPolicy;
  enabled: number;
  padding_before: number;
  padding_after: number;
  max_recordings: number;
  created_at: number;
}

export interface CreateRecordingRuleInput {
  channelId: string;
  channelName: string;
  matchTitle: string;
  matchType: RecordingRuleMatchType;
  paddingBefore: number;
  paddingAfter: number;
  repeatPolicy: RecordingRepeatPolicy;
  maxRecordings: number;
}

export interface UpdateRecordingRuleInput {
  matchTitle: string;
  matchType: RecordingRuleMatchType;
  enabled: boolean;
  paddingBefore: number;
  paddingAfter: number;
  repeatPolicy: RecordingRepeatPolicy;
  maxRecordings: number;
}

export interface RecordingStatusInfo {
  activeCount: number;
  diskUsageBytes: number;
  schedulerRunning: boolean;
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
  /** Parent series ID so episode progress can appear on Home. */
  seriesId?: string;
  /** Completed episodes stay recorded so Series Detail can advance to the next one. */
  completed?: boolean;
}
