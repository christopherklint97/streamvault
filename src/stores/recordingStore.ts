import { create } from 'zustand';
import type {
  CommercialSegment,
  CommercialSegmentsResponse,
  CreateRecordingRuleInput,
  Recording,
  RecordingRule,
  RecordingStatusInfo,
  UpdateRecordingRuleInput,
} from '../types';
import { useChannelStore, SAME_ORIGIN } from './channelStore';
import { useAppStore } from './appStore';
import { apiFetch } from '../services/api';

const toast = (msg: string) => useAppStore.getState().showToastMessage(msg);
const commercialRequestVersions = new Map<string, number>();
const commercialRequestControllers = new Map<string, AbortController>();

function beginCommercialRequest(id: string, withController: boolean): { version: number; controller?: AbortController } {
  commercialRequestControllers.get(id)?.abort();
  commercialRequestControllers.delete(id);
  const version = (commercialRequestVersions.get(id) ?? 0) + 1;
  commercialRequestVersions.set(id, version);
  if (!withController) return { version };
  const controller = new AbortController();
  commercialRequestControllers.set(id, controller);
  return { version, controller };
}

function isCurrentCommercialRequest(id: string, version: number): boolean {
  return commercialRequestVersions.get(id) === version;
}

interface RecordingState {
  recordings: Recording[];
  rules: RecordingRule[];
  status: RecordingStatusInfo | null;
  commercialSegments: Record<string, CommercialSegmentsResponse>;
  commercialSegmentsLoading: Record<string, boolean>;
  commercialSegmentsError: Record<string, string | null>;
  loading: boolean;
}

function getBaseUrl(): string {
  return SAME_ORIGIN ? '' : useChannelStore.getState().apiBaseUrl;
}

interface RecordingActions {
  fetchRecordings: (status?: string) => Promise<void>;
  fetchRules: () => Promise<void>;
  fetchStatus: () => Promise<void>;
  createRecording: (channelId: string, title: string, startTime: number, endTime: number) => Promise<Recording | null>;
  createFromProgram: (channelId: string, programStart: number, programStop: number, title: string) => Promise<Recording | null>;
  cancelRecording: (id: string) => Promise<void>;
  stopRecording: (id: string) => Promise<void>;
  deleteRecording: (id: string) => Promise<void>;
  createRule: (input: CreateRecordingRuleInput) => Promise<RecordingRule | null>;
  updateRule: (id: string, updates: Partial<UpdateRecordingRuleInput>) => Promise<void>;
  deleteRule: (id: string) => Promise<void>;
  fetchCommercialSegments: (id: string, options?: { force?: boolean; silent?: boolean }) => Promise<CommercialSegmentsResponse | null>;
  analyzeCommercials: (id: string) => Promise<boolean>;
  saveCommercialSegments: (id: string, segments: CommercialSegment[]) => Promise<CommercialSegmentsResponse | null>;
  setCommercialSkipOverride: (id: string, enabled: boolean | null) => Promise<CommercialSegmentsResponse | null>;
}

export const useRecordingStore = create<RecordingState & RecordingActions>()((set, get) => ({
  recordings: [],
  rules: [],
  status: null,
  commercialSegments: {},
  commercialSegmentsLoading: {},
  commercialSegmentsError: {},
  loading: false,

  fetchRecordings: async (status?: string) => {
    set({ loading: true });
    try {
      const params = status ? `?status=${encodeURIComponent(status)}` : '';
      const data = await apiFetch<{ recordings?: Recording[] }>(getBaseUrl(), `/api/recordings${params}`);
      set({ recordings: data.recordings || [] });
    } catch (err) {
      toast(`Failed to fetch recordings: ${err}`);
    } finally {
      set({ loading: false });
    }
  },

  fetchRules: async () => {
    try {
      const data = await apiFetch<{ rules?: RecordingRule[] }>(getBaseUrl(), '/api/recording-rules');
      set({ rules: data.rules || [] });
    } catch (err) {
      toast(`Failed to fetch rules: ${err}`);
    }
  },

  fetchStatus: async () => {
    try {
      const data = await apiFetch<RecordingStatusInfo>(getBaseUrl(), '/api/recording-status');
      set({ status: data });
    } catch (err) {
      toast(`Failed to fetch recording status: ${err}`);
    }
  },

  createRecording: async (channelId, title, startTime, endTime) => {
    try {
      const data = await apiFetch<{ recording: Recording }>(getBaseUrl(), '/api/recordings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channelId, title, startTime, endTime }),
      });
      await get().fetchRecordings();
      return data.recording;
    } catch (err) {
      toast(`Failed to create recording: ${err}`);
      return null;
    }
  },

  createFromProgram: async (channelId, programStart, programStop, title) => {
    try {
      const data = await apiFetch<{ recording: Recording }>(getBaseUrl(), '/api/recordings/from-program', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channelId, programStart, programStop, title }),
      });
      await get().fetchRecordings();
      return data.recording;
    } catch (err) {
      toast(`Failed to create recording: ${err}`);
      return null;
    }
  },

  cancelRecording: async (id) => {
    try {
      await apiFetch(getBaseUrl(), `/api/recordings/${encodeURIComponent(id)}/cancel`, { method: 'POST' });
      await get().fetchRecordings();
    } catch (err) {
      toast(`Failed to cancel recording: ${err}`);
    }
  },

  stopRecording: async (id) => {
    try {
      await apiFetch(getBaseUrl(), `/api/recordings/${encodeURIComponent(id)}/stop`, { method: 'POST' });
      await get().fetchRecordings();
    } catch (err) {
      toast(`Failed to stop recording: ${err}`);
    }
  },

  deleteRecording: async (id) => {
    try {
      await apiFetch(getBaseUrl(), `/api/recordings/${encodeURIComponent(id)}`, { method: 'DELETE' });
      set((state) => {
        const commercialSegments = { ...state.commercialSegments };
        delete commercialSegments[id];
        return { recordings: state.recordings.filter((recording) => recording.id !== id), commercialSegments };
      });
    } catch (err) {
      toast(`Failed to delete recording: ${err}`);
    }
  },

  createRule: async (input) => {
    try {
      const data = await apiFetch<{ rule: RecordingRule }>(getBaseUrl(), '/api/recording-rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      set((state) => ({ rules: [...state.rules.filter((rule) => rule.id !== data.rule.id), data.rule] }));
      return data.rule;
    } catch (err) {
      toast(`Failed to create rule: ${err}`);
      return null;
    }
  },

  updateRule: async (id, updates) => {
    try {
      const data = await apiFetch<{ rule: RecordingRule }>(getBaseUrl(), `/api/recording-rules/${encodeURIComponent(id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      });
      set((state) => ({
        rules: state.rules.map((rule) => rule.id === id ? data.rule : rule),
      }));
    } catch (err) {
      toast(`Failed to update rule: ${err}`);
    }
  },

  deleteRule: async (id) => {
    try {
      await apiFetch(getBaseUrl(), `/api/recording-rules/${encodeURIComponent(id)}`, { method: 'DELETE' });
      set({ rules: get().rules.filter((rule) => rule.id !== id) });
    } catch (err) {
      toast(`Failed to delete rule: ${err}`);
    }
  },

  fetchCommercialSegments: async (id, options = {}) => {
    const cached = get().commercialSegments[id];
    if (cached && !options.force) return cached;
    const { version, controller } = beginCommercialRequest(id, true);
    set((state) => ({
      commercialSegmentsLoading: { ...state.commercialSegmentsLoading, [id]: true },
      commercialSegmentsError: { ...state.commercialSegmentsError, [id]: null },
    }));
    try {
      const data = await apiFetch<CommercialSegmentsResponse>(
        getBaseUrl(),
        `/api/recordings/${encodeURIComponent(id)}/commercial-segments`,
        { cache: 'no-store', signal: controller?.signal },
      );
      if (!isCurrentCommercialRequest(id, version)) return null;
      commercialRequestControllers.delete(id);
      set((state) => ({
        commercialSegments: { ...state.commercialSegments, [id]: data },
        commercialSegmentsLoading: { ...state.commercialSegmentsLoading, [id]: false },
      }));
      return data;
    } catch (err) {
      if (!isCurrentCommercialRequest(id, version)) return null;
      commercialRequestControllers.delete(id);
      const message = err instanceof Error ? err.message : String(err);
      set((state) => ({
        commercialSegmentsLoading: { ...state.commercialSegmentsLoading, [id]: false },
        commercialSegmentsError: { ...state.commercialSegmentsError, [id]: message },
      }));
      if (!options.silent) toast(`Failed to load commercial intervals: ${message}`);
      return null;
    }
  },

  analyzeCommercials: async (id) => {
    try {
      await apiFetch(getBaseUrl(), `/api/recordings/${encodeURIComponent(id)}/analyze`, { method: 'POST' });
      set((state) => ({
        recordings: state.recordings.map((recording) => recording.id === id
          ? { ...recording, analysis_state: 'queued', analysis_error: null }
          : recording),
      }));
      return true;
    } catch (err) {
      toast(`Failed to start commercial analysis: ${err}`);
      return false;
    }
  },

  saveCommercialSegments: async (id, segments) => {
    const { version } = beginCommercialRequest(id, false);
    try {
      const updated = await apiFetch<CommercialSegmentsResponse>(getBaseUrl(), `/api/recordings/${encodeURIComponent(id)}/commercial-segments`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ segments }),
      });
      if (!isCurrentCommercialRequest(id, version)) return null;
      set((state) => ({
        commercialSegments: { ...state.commercialSegments, [id]: updated },
        commercialSegmentsLoading: { ...state.commercialSegmentsLoading, [id]: false },
        commercialSegmentsError: { ...state.commercialSegmentsError, [id]: null },
      }));
      await get().fetchRecordings();
      return updated;
    } catch (err) {
      toast(`Failed to save commercial intervals: ${err}`);
      return null;
    }
  },

  setCommercialSkipOverride: async (id, enabled) => {
    const { version } = beginCommercialRequest(id, false);
    try {
      const updated = await apiFetch<CommercialSegmentsResponse>(getBaseUrl(), `/api/recordings/${encodeURIComponent(id)}/commercial-skip`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      if (!isCurrentCommercialRequest(id, version)) return null;
      set((state) => ({
        commercialSegments: { ...state.commercialSegments, [id]: updated },
        commercialSegmentsLoading: { ...state.commercialSegmentsLoading, [id]: false },
        commercialSegmentsError: { ...state.commercialSegmentsError, [id]: null },
        recordings: state.recordings.map((recording) => recording.id === id
          ? { ...recording, commercial_skip_override: enabled }
          : recording),
      }));
      return updated;
    } catch (err) {
      toast(`Failed to update commercial skipping: ${err}`);
      return null;
    }
  },
}));
