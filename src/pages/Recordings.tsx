import { useEffect, useMemo, useCallback, useState, useRef } from 'react';
import { useRecordingStore } from '../stores/recordingStore';
import { usePlayerStore } from '../stores/playerStore';
import { useAppStore } from '../stores/appStore';
import { useChannelStore, SAME_ORIGIN } from '../stores/channelStore';
import type { Recording, RecordingRule, Channel, RecordingRepeatPolicy, RecordingRuleMatchType } from '../types';
import { cn } from '../utils/cn';
import FocusZone from '../components/FocusZone';
import { getRecordingAnalysisStatus, getRecordingCommercialSeconds } from '../utils/recording-commercial';
import { getRecordingPlaybackUrl } from '../services/recordingPlayback';
import {
  createRecordingRuleDraft,
  repeatPolicyDescription,
  repeatPolicyLabel,
} from '../utils/recordingRules';


function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

function formatDuration(seconds: number): string {
  if (!seconds) return '—';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function formatDateTime(ms: number): string {
  return new Date(ms).toLocaleString([], {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

const STATUS_LABELS: Record<string, string> = {
  scheduled: 'Scheduled',
  recording: 'Recording',
  finalizing: 'Finalizing',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

const STATUS_COLORS: Record<string, string> = {
  scheduled: '#3b82f6',
  recording: '#ef4444',
  finalizing: '#8b5cf6',
  completed: '#22c55e',
  failed: '#f59e0b',
  cancelled: '#6b7280',
};

const ANALYSIS_LABELS: Record<string, string> = {
  not_analyzed: 'Not analyzed',
  queued: 'Analysis queued',
  analyzing: 'Analyzing',
  review_needed: 'Review needed',
  ready: 'Breaks ready',
  failed: 'Analysis failed',
};

const ANALYSIS_COLORS: Record<string, string> = {
  not_analyzed: '#475569',
  queued: '#1d4ed8',
  analyzing: '#0369a1',
  review_needed: '#b45309',
  ready: '#15803d',
  failed: '#b91c1c',
};

function RecordingCard({ rec, onPlay, onCancel, onStop, onDelete, onAnalyze, onReview }: {
  rec: Recording;
  onPlay: () => void;
  onCancel: () => void;
  onStop: () => void;
  onDelete: () => void;
  onAnalyze: () => void;
  onReview: () => void;
}) {
  const analysisStatus = getRecordingAnalysisStatus(rec);
  const segmentCount = rec.commercial_segment_count ?? 0;
  const commercialSeconds = getRecordingCommercialSeconds(rec);
  return (
    <div className="bg-surface-border rounded-[10px] p-3.5 flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <span
          className="py-0.5 px-2 rounded text-11 font-semibold text-white uppercase tracking-wider"
          style={{ backgroundColor: STATUS_COLORS[rec.status] || '#6b7280' }}
        >
          {rec.status === 'recording' && '⏺ '}
          {STATUS_LABELS[rec.status] || rec.status}
        </span>
        <span className="text-13 text-[#9ca3af] overflow-hidden text-ellipsis whitespace-nowrap">{rec.channel_name}</span>
      </div>
      <div className="text-base font-semibold overflow-hidden text-ellipsis whitespace-nowrap">{rec.title}</div>
      {rec.status === 'completed' && (
        <div className="flex flex-wrap items-center gap-2">
          <span
            className="rounded px-2 py-0.5 text-11 font-semibold uppercase tracking-wide text-white"
            style={{ backgroundColor: ANALYSIS_COLORS[analysisStatus] || '#475569' }}
          >
            {ANALYSIS_LABELS[analysisStatus] || analysisStatus}
          </span>
          {segmentCount > 0 && (
            <span className="text-12 text-[#9ca3af]">
              {segmentCount} {segmentCount === 1 ? 'break' : 'breaks'} · {formatDuration(commercialSeconds)}
            </span>
          )}
        </div>
      )}
      <div className="flex gap-3 text-12 text-[#6b7280]">
        <span>{formatDateTime(rec.start_time)}</span>
        {rec.duration > 0 && <span>{formatDuration(rec.duration)}</span>}
        {rec.file_size > 0 && <span>{formatBytes(rec.file_size)}</span>}
      </div>
      {rec.error && <div className="text-12 text-[#f59e0b] overflow-hidden text-ellipsis whitespace-nowrap">{rec.error}</div>}
      <div className="flex gap-1.5 mt-1">
        {rec.status === 'completed' && (
          <button className="py-1 px-3 rounded text-12 font-semibold bg-[#1d4ed8] text-white transition-colors duration-150 hover:bg-[#2563eb]" onClick={onPlay}>Play</button>
        )}
        {rec.status === 'completed' && (analysisStatus === 'not_analyzed' || analysisStatus === 'failed') && (
          <button className="py-1 px-3 rounded text-12 font-semibold bg-[#2a2a3e] text-[#dbeafe] transition-colors duration-150 hover:bg-[#334155]" onClick={onAnalyze}>
            {analysisStatus === 'failed' ? 'Retry' : 'Analyze'}
          </button>
        )}
        {rec.status === 'completed' && (analysisStatus === 'review_needed' || analysisStatus === 'ready' || segmentCount > 0) && (
          <button className="py-1 px-3 rounded text-12 font-semibold bg-[#78350f] text-[#fde68a] transition-colors duration-150 hover:bg-[#92400e]" onClick={onReview}>Review</button>
        )}
        {rec.status === 'recording' && (
          <button className="py-1 px-3 rounded text-12 font-semibold bg-[#b45309] text-white transition-colors duration-150 hover:bg-[#d97706]" onClick={onStop}>Stop</button>
        )}
        {(rec.status === 'scheduled' || rec.status === 'recording' || rec.status === 'finalizing') && (
          <button className="py-1 px-3 rounded text-12 font-semibold bg-[#4b5563] text-white transition-colors duration-150 hover:bg-[#6b7280]" onClick={onCancel}>Cancel</button>
        )}
        <button className="py-1 px-3 rounded text-12 font-semibold bg-[#2a2a3e] text-[#ef4444] transition-colors duration-150 hover:bg-[#7f1d1d] hover:text-[#fca5a5]" onClick={onDelete}>Delete</button>
      </div>
    </div>
  );
}

function RuleCard({ rule, onToggle, onDelete, onRetentionChange }: {
  rule: RecordingRule;
  onToggle: () => void;
  onDelete: () => void;
  onRetentionChange: (limit: number) => void;
}) {
  const initialRetention = rule.retention_count > 0
    ? rule.retention_count
    : rule.max_recordings > 0 ? rule.max_recordings : 0;
  const [retentionValue, setRetentionValue] = useState(initialRetention > 0 ? String(initialRetention) : '');
  const parsedRetention = retentionValue.trim() === '' ? 0 : Number(retentionValue);
  const validRetention = Number.isInteger(parsedRetention) && parsedRetention >= 0;
  const retentionUnchanged = rule.max_recordings === 0 && parsedRetention === rule.retention_count;
  return (
    <div className="bg-surface-border rounded-[10px] p-3.5 flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <span
          className="py-0.5 px-2 rounded text-11 font-semibold text-white uppercase tracking-wider"
          style={{ backgroundColor: rule.enabled ? '#22c55e' : '#6b7280' }}
        >
          {rule.enabled ? 'Active' : 'Disabled'}
        </span>
        <span className="text-13 text-[#9ca3af] overflow-hidden text-ellipsis whitespace-nowrap">{rule.channel_name}</span>
      </div>
      <div className="text-base font-semibold overflow-hidden text-ellipsis whitespace-nowrap">
        {rule.match_type === 'exact' ? `"${rule.match_title}"` : `*${rule.match_title}*`}
      </div>
      <div className="flex gap-3 text-12 text-[#6b7280]">
        <span>Pad: -{rule.padding_before / 60000}m / +{rule.padding_after / 60000}m</span>
        <span>{repeatPolicyLabel(rule.repeat_policy)}</span>
        {rule.airing_policy === 'once' ? (
          <span>Record once</span>
        ) : rule.retention_count > 0 ? (
          <span>Keep latest {rule.retention_count}</span>
        ) : rule.max_recordings > 0 ? (
          <span>Stops after {rule.max_recordings}</span>
        ) : (
          <span>Keep all</span>
        )}
      </div>
      {rule.airing_policy === 'every' && (
        <div className="mt-1">
          <div className="flex items-end gap-2">
          <label className="min-w-0 flex-1 text-12 text-[#9ca3af]">
            Keep latest
            <input
              data-focusable
              aria-label={`Keep latest for ${rule.match_title}`}
              type="number"
              inputMode="numeric"
              min={0}
              step={1}
              placeholder="All"
              value={retentionValue}
              onChange={(event) => setRetentionValue(event.target.value)}
              className="mt-1 w-full rounded border border-[#333] bg-[#1a1a2e] px-2 py-1.5 text-13 text-white outline-none focus:border-[#3b82f6]"
            />
          </label>
          <button
            className="rounded bg-[#1d4ed8] px-3 py-1.5 text-12 font-semibold text-white disabled:opacity-40"
            disabled={!validRetention || retentionUnchanged}
            onClick={() => onRetentionChange(parsedRetention)}
          >
            Save limit
          </button>
          </div>
          <p className="mt-1 text-11 text-[#f59e0b]">
            {rule.max_recordings > 0
              ? 'Saving converts this legacy stop-after rule to rolling retention.'
              : 'Lowering this limit deletes older completed recordings immediately and cannot be undone.'}
          </p>
          {rule.max_recordings > 0 && (
            <p className="mt-1 text-11 text-[#f59e0b]">
              If the new limit is below the completed count, older recordings are deleted immediately and cannot be restored.
            </p>
          )}
        </div>
      )}
      <div className="flex gap-1.5 mt-1">
        <button className="py-1 px-3 rounded text-12 font-semibold bg-[#2a2a3e] text-[#d1d5db] transition-colors duration-150 hover:bg-[#3a3a5e]" onClick={onToggle}>
          {rule.enabled ? 'Disable' : 'Enable'}
        </button>
        <button className="py-1 px-3 rounded text-12 font-semibold bg-[#2a2a3e] text-[#ef4444] transition-colors duration-150 hover:bg-[#7f1d1d] hover:text-[#fca5a5]" onClick={onDelete}>Delete</button>
      </div>
    </div>
  );
}

function toLocalDatetime(date: Date): string {
  const y = date.getFullYear();
  const mo = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const h = String(date.getHours()).padStart(2, '0');
  const mi = String(date.getMinutes()).padStart(2, '0');
  return `${y}-${mo}-${d}T${h}:${mi}`;
}

function ScheduleForm({ onCreated }: { onCreated: () => void }) {
  const createRecording = useRecordingStore((s) => s.createRecording);
  const apiBaseUrl = useChannelStore((s) => s.apiBaseUrl);
  const showToast = useAppStore((s) => s.showToastMessage);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Channel[]>([]);
  const [selectedChannel, setSelectedChannel] = useState<Channel | null>(null);
  const [title, setTitle] = useState('');
  const [startTime, setStartTime] = useState(() => {
    const d = new Date();
    d.setMinutes(d.getMinutes() + 5);
    d.setSeconds(0, 0);
    return toLocalDatetime(d);
  });
  const [endTime, setEndTime] = useState(() => {
    const d = new Date();
    d.setHours(d.getHours() + 1, d.getMinutes() + 5);
    d.setSeconds(0, 0);
    return toLocalDatetime(d);
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleSearch = useCallback((q: string) => {
    setQuery(q);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    if (q.trim().length < 2) {
      setResults([]);
      return;
    }
    searchTimer.current = setTimeout(async () => {
      try {
        const base = SAME_ORIGIN ? '' : apiBaseUrl;
        const resp = await fetch(`${base}/api/search?q=${encodeURIComponent(q)}&type=livetv`);
        if (!resp.ok) return;
        const data = await resp.json();
        setResults((data.channels || []).slice(0, 20));
      } catch (err) {
        showToast(`Search failed: ${err}`);
      }
    }, 300);
  }, [apiBaseUrl, showToast]);

  const handleSelectChannel = useCallback((ch: Channel) => {
    setSelectedChannel(ch);
    setQuery(ch.name);
    setResults([]);
    if (!title) setTitle(ch.name);
  }, [title]);

  const handleSubmit = useCallback(async () => {
    if (!selectedChannel) { setError('Select a channel'); return; }
    const start = new Date(startTime).getTime();
    const end = new Date(endTime).getTime();
    if (isNaN(start) || isNaN(end)) { setError('Invalid date/time'); return; }
    if (end <= start) { setError('End time must be after start time'); return; }
    if (!title.trim()) { setError('Title is required'); return; }

    setSubmitting(true);
    setError('');
    const rec = await createRecording(selectedChannel.id, title.trim(), start, end);
    setSubmitting(false);
    if (rec) {
      setSelectedChannel(null);
      setQuery('');
      setTitle('');
      onCreated();
    } else {
      setError('Failed to create recording');
    }
  }, [selectedChannel, title, startTime, endTime, createRecording, onCreated]);

  return (
    <div className="bg-surface-border rounded-[10px] p-4 mb-6">
      <h3 className="text-15 font-semibold mb-3 text-[#d1d5db]">Schedule Recording</h3>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        {/* Channel search */}
        <div className="relative">
          <label className="block text-12 text-[#9ca3af] mb-1">Channel</label>
          <input
            className="w-full py-2 px-3 rounded bg-[#1a1a2e] border border-[#333] text-white text-14 outline-none focus:border-[#3b82f6]"
            placeholder="Search live TV channels..."
            value={query}
            onChange={(e) => { handleSearch(e.target.value); if (selectedChannel) setSelectedChannel(null); }}
          />
          {results.length > 0 && (
            <div className="absolute z-10 top-full left-0 right-0 mt-1 max-h-48 overflow-y-auto bg-[#1a1a2e] border border-[#333] rounded shadow-lg">
              {results.map((ch) => (
                <button
                  key={ch.id}
                  className="block w-full text-left py-2 px-3 text-14 text-white hover:bg-[#2a2a3e] transition-colors"
                  onClick={() => handleSelectChannel(ch)}
                >
                  <span className="font-medium">{ch.name}</span>
                  {ch.group && <span className="text-12 text-[#6b7280] ml-2">{ch.group}</span>}
                </button>
              ))}
            </div>
          )}
          {selectedChannel && (
            <div className="mt-1 text-12 text-[#22c55e]">Selected: {selectedChannel.name}</div>
          )}
        </div>

        {/* Title */}
        <div>
          <label className="block text-12 text-[#9ca3af] mb-1">Title</label>
          <input
            className="w-full py-2 px-3 rounded bg-[#1a1a2e] border border-[#333] text-white text-14 outline-none focus:border-[#3b82f6]"
            placeholder="Recording title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </div>

        {/* Start time */}
        <div>
          <label className="block text-12 text-[#9ca3af] mb-1">Start Time</label>
          <input
            type="datetime-local"
            className="w-full py-2 px-3 rounded bg-[#1a1a2e] border border-[#333] text-white text-14 outline-none focus:border-[#3b82f6] [color-scheme:dark]"
            value={startTime}
            onChange={(e) => setStartTime(e.target.value)}
          />
        </div>

        {/* End time */}
        <div>
          <label className="block text-12 text-[#9ca3af] mb-1">End Time</label>
          <input
            type="datetime-local"
            className="w-full py-2 px-3 rounded bg-[#1a1a2e] border border-[#333] text-white text-14 outline-none focus:border-[#3b82f6] [color-scheme:dark]"
            value={endTime}
            onChange={(e) => setEndTime(e.target.value)}
          />
        </div>
      </div>

      {error && <div className="text-12 text-[#f59e0b] mt-2">{error}</div>}

      <button
        className="mt-3 py-2 px-5 rounded text-14 font-semibold bg-[#1d4ed8] text-white transition-colors duration-150 hover:bg-[#2563eb] disabled:opacity-50"
        disabled={submitting || !selectedChannel}
        onClick={handleSubmit}
      >
        {submitting ? 'Scheduling...' : 'Schedule'}
      </button>
    </div>
  );
}

function RuleForm({ onCreated }: { onCreated: () => void }) {
  const createRule = useRecordingStore((state) => state.createRule);
  const apiBaseUrl = useChannelStore((state) => state.apiBaseUrl);
  const showToast = useAppStore((state) => state.showToastMessage);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Channel[]>([]);
  const [selectedChannel, setSelectedChannel] = useState<Channel | null>(null);
  const [draft, setDraft] = useState(() => createRecordingRuleDraft());
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchGeneration = useRef(0);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => () => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchGeneration.current += 1;
  }, []);

  const handleSearch = useCallback((value: string) => {
    setQuery(value);
    setSelectedChannel(null);
    setDraft((current) => ({ ...current, channelId: '', channelName: '' }));
    setError('');
    searchGeneration.current += 1;
    const generation = searchGeneration.current;
    if (searchTimer.current) clearTimeout(searchTimer.current);
    if (value.trim().length < 2) {
      setResults([]);
      return;
    }
    searchTimer.current = setTimeout(async () => {
      try {
        const base = SAME_ORIGIN ? '' : apiBaseUrl;
        const response = await fetch(`${base}/api/search?q=${encodeURIComponent(value.trim())}&type=livetv`);
        if (!response.ok || generation !== searchGeneration.current) return;
        const data = await response.json() as { channels?: Channel[] };
        if (generation === searchGeneration.current) setResults((data.channels ?? []).slice(0, 20));
      } catch (searchError) {
        if (generation === searchGeneration.current) showToast(`Search failed: ${searchError}`);
      }
    }, 300);
  }, [apiBaseUrl, showToast]);

  const handleSelectChannel = useCallback((channel: Channel) => {
    setSelectedChannel(channel);
    setQuery(channel.name);
    setResults([]);
    setDraft((current) => ({ ...current, channelId: channel.id, channelName: channel.name }));
    setError('');
    titleInputRef.current?.focus({ preventScroll: true });
  }, []);

  const handleSubmit = useCallback(async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedChannel) {
      setError('Select a channel');
      searchInputRef.current?.focus({ preventScroll: true });
      return;
    }
    const matchTitle = draft.matchTitle.trim();
    if (!matchTitle) {
      setError('Program title is required');
      titleInputRef.current?.focus({ preventScroll: true });
      return;
    }
    const paddingBeforeMinutes = Number(draft.paddingBeforeMinutes);
    const paddingAfterMinutes = Number(draft.paddingAfterMinutes);
    if (!Number.isFinite(paddingBeforeMinutes) || paddingBeforeMinutes < 0
      || !Number.isFinite(paddingAfterMinutes) || paddingAfterMinutes < 0) {
      setError('Padding must be zero or more minutes');
      return;
    }
    const parsedMaximum = draft.retentionLimit.trim() === '' ? 0 : Number(draft.retentionLimit);
    if (!draft.recordOnce && (!Number.isInteger(parsedMaximum) || parsedMaximum < 0)) {
      setError('Keep latest must be a whole number or blank');
      return;
    }

    setSubmitting(true);
    setError('');
    const rule = await createRule({
      channelId: selectedChannel.id,
      channelName: selectedChannel.name,
      matchTitle,
      matchType: draft.matchType,
      paddingBefore: Math.round(paddingBeforeMinutes * 60_000),
      paddingAfter: Math.round(paddingAfterMinutes * 60_000),
      repeatPolicy: draft.repeatPolicy,
      retentionLimit: draft.recordOnce ? 0 : parsedMaximum,
      airingPolicy: draft.recordOnce ? 'once' : 'every',
    });
    setSubmitting(false);
    if (!rule) {
      setError('Failed to create recording rule');
      return;
    }
    setSelectedChannel(null);
    setQuery('');
    setResults([]);
    setDraft(createRecordingRuleDraft());
    showToast('Recording rule created');
    onCreated();
    searchInputRef.current?.focus({ preventScroll: true });
  }, [createRule, draft, onCreated, selectedChannel, showToast]);

  return (
    <form className="mb-6 rounded-[10px] bg-surface-border p-4" onSubmit={handleSubmit}>
      <h3 className="mb-1 text-15 font-semibold text-[#d1d5db]">Create recurring rule</h3>
      <p className="mb-4 text-12 text-[#9ca3af]">Match future guide programs on one channel.</p>
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <div className="relative">
          <label className="mb-1 block text-12 text-[#9ca3af]" htmlFor="rule-channel-search">Channel</label>
          <input
            ref={searchInputRef}
            id="rule-channel-search"
            data-focusable
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={results.length > 0}
            aria-controls="rule-channel-results"
            autoComplete="off"
            className="w-full rounded border border-[#333] bg-[#1a1a2e] px-3 py-2 text-14 text-white outline-none focus:border-[#3b82f6]"
            placeholder="Search live TV channels..."
            value={query}
            onChange={(event) => handleSearch(event.target.value)}
          />
          {results.length > 0 && (
            <div id="rule-channel-results" className="absolute left-0 right-0 top-full z-10 mt-1 max-h-48 overflow-y-auto rounded border border-[#333] bg-[#1a1a2e] shadow-lg">
              {results.map((channel) => (
                <button
                  key={channel.id}
                  type="button"
                  data-focusable
                  className="block w-full px-3 py-2 text-left text-14 text-white transition-colors hover:bg-[#2a2a3e] focus:bg-[#2a2a3e]"
                  onClick={() => handleSelectChannel(channel)}
                >
                  <span className="font-medium">{channel.name}</span>
                  {channel.group && <span className="ml-2 text-12 text-[#6b7280]">{channel.group}</span>}
                </button>
              ))}
            </div>
          )}
          {selectedChannel && <p className="mt-1 text-12 text-[#22c55e]">Selected: {selectedChannel.name}</p>}
        </div>

        <div>
          <label className="mb-1 block text-12 text-[#9ca3af]" htmlFor="rule-match-title">Program title</label>
          <input
            ref={titleInputRef}
            id="rule-match-title"
            data-focusable
            autoComplete="off"
            className="w-full rounded border border-[#333] bg-[#1a1a2e] px-3 py-2 text-14 text-white outline-none focus:border-[#3b82f6]"
            placeholder="e.g. SportsCenter"
            value={draft.matchTitle}
            onChange={(event) => setDraft((current) => ({ ...current, matchTitle: event.target.value }))}
          />
        </div>

        <div>
          <label className="mb-1 block text-12 text-[#9ca3af]" htmlFor="rule-match-type">Title matching</label>
          <select
            id="rule-match-type"
            data-focusable
            className="w-full rounded border border-[#333] bg-[#1a1a2e] px-3 py-2 text-14 text-white outline-none focus:border-[#3b82f6]"
            value={draft.matchType}
            onChange={(event) => setDraft((current) => ({ ...current, matchType: event.target.value as RecordingRuleMatchType }))}
          >
            <option value="exact">Exact title</option>
            <option value="startsWith">Starts with</option>
            <option value="contains">Contains</option>
          </select>
        </div>

        <div>
          <label className="mb-1 block text-12 text-[#9ca3af]" htmlFor="rule-repeat-policy">Repeat policy</label>
          <select
            id="rule-repeat-policy"
            data-focusable
            className="w-full rounded border border-[#333] bg-[#1a1a2e] px-3 py-2 text-14 text-white outline-none focus:border-[#3b82f6]"
            value={draft.repeatPolicy}
            onChange={(event) => setDraft((current) => ({ ...current, repeatPolicy: event.target.value as RecordingRepeatPolicy }))}
          >
            <option value="all">All airings</option>
            <option value="include_unknown">New and unknown</option>
            <option value="new_only">New only</option>
          </select>
          <p className="mt-1 text-12 text-[#6b7280]">{repeatPolicyDescription(draft.repeatPolicy)}</p>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1 block text-12 text-[#9ca3af]" htmlFor="rule-padding-before">Padding before (min)</label>
            <input id="rule-padding-before" data-focusable type="number" inputMode="numeric" min={0} step={1} value={draft.paddingBeforeMinutes} onChange={(event) => setDraft((current) => ({ ...current, paddingBeforeMinutes: Number(event.target.value) }))} className="w-full rounded border border-[#333] bg-[#1a1a2e] px-3 py-2 text-14 text-white outline-none focus:border-[#3b82f6]" />
          </div>
          <div>
            <label className="mb-1 block text-12 text-[#9ca3af]" htmlFor="rule-padding-after">Padding after (min)</label>
            <input id="rule-padding-after" data-focusable type="number" inputMode="numeric" min={0} step={1} value={draft.paddingAfterMinutes} onChange={(event) => setDraft((current) => ({ ...current, paddingAfterMinutes: Number(event.target.value) }))} className="w-full rounded border border-[#333] bg-[#1a1a2e] px-3 py-2 text-14 text-white outline-none focus:border-[#3b82f6]" />
          </div>
        </div>

        <div>
          <label className="mb-1 block text-12 text-[#9ca3af]" htmlFor="rule-retention-limit">Keep latest completed recordings</label>
          <input id="rule-retention-limit" data-focusable type="number" inputMode="numeric" min={0} step={1} disabled={draft.recordOnce} placeholder="Keep all" value={draft.retentionLimit} onChange={(event) => setDraft((current) => ({ ...current, retentionLimit: event.target.value }))} className="w-full rounded border border-[#333] bg-[#1a1a2e] px-3 py-2 text-14 text-white outline-none disabled:opacity-40 focus:border-[#3b82f6]" />
          <p className="mt-1 text-12 text-[#6b7280]">Set 1 for newest only. Older completed recordings are removed after a newer one is ready.</p>
          <label className="mt-2 flex cursor-pointer items-center gap-2 text-13 text-[#d1d5db]" htmlFor="rule-record-once">
            <input id="rule-record-once" data-focusable type="checkbox" checked={draft.recordOnce} onChange={(event) => setDraft((current) => ({ ...current, recordOnce: event.target.checked }))} />
            Record once, then stop matching
          </label>
        </div>
      </div>

      {error && <p role="alert" className="mt-3 text-12 text-[#f59e0b]">{error}</p>}
      <button type="submit" data-focusable disabled={submitting || !selectedChannel} className="mt-4 rounded bg-[#1d4ed8] px-5 py-2 text-14 font-semibold text-white transition-colors hover:bg-[#2563eb] disabled:opacity-50">
        {submitting ? 'Creating…' : 'Create rule'}
      </button>
    </form>
  );
}

type Tab = 'recordings' | 'rules';

export default function Recordings() {
  const recordings = useRecordingStore((s) => s.recordings);
  const rules = useRecordingStore((s) => s.rules);
  const status = useRecordingStore((s) => s.status);
  const fetchRecordings = useRecordingStore((s) => s.fetchRecordings);
  const fetchRules = useRecordingStore((s) => s.fetchRules);
  const fetchStatus = useRecordingStore((s) => s.fetchStatus);
  const cancelRec = useRecordingStore((s) => s.cancelRecording);
  const stopRec = useRecordingStore((s) => s.stopRecording);
  const deleteRec = useRecordingStore((s) => s.deleteRecording);
  const analyzeCommercials = useRecordingStore((s) => s.analyzeCommercials);
  const updateRule = useRecordingStore((s) => s.updateRule);
  const deleteRule = useRecordingStore((s) => s.deleteRule);
  const apiBaseUrl = useChannelStore((s) => s.apiBaseUrl);
  const setChannel = usePlayerStore((s) => s.setChannel);
  const navigate = useAppStore((s) => s.navigate);
  const navigateToRecording = useAppStore((s) => s.navigateToRecording);
  const showToast = useAppStore((s) => s.showToastMessage);
  const [tab, setTab] = useState<Tab>('recordings');

  useEffect(() => {
    fetchRecordings();
    fetchRules();
    fetchStatus();
    // Poll while on this page
    const interval = setInterval(() => {
      fetchRecordings();
      fetchStatus();
    }, 10_000);
    return () => clearInterval(interval);
  }, [fetchRecordings, fetchRules, fetchStatus]);

  const handlePlay = useCallback(async (rec: Recording) => {
    const directUrl = `/api/recordings/${encodeURIComponent(rec.id)}/stream`;
    try {
      const playbackUrl = await getRecordingPlaybackUrl({
        apiBaseUrl,
        recordingId: rec.id,
        directUrl,
      });
      setChannel({
        id: `recording_${rec.id}`,
        name: rec.title,
        url: playbackUrl,
        logo: '',
        group: '',
        region: '',
        contentType: 'movies',
        recordingId: rec.id,
        duration: rec.duration,
      });
      navigate('player');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      showToast(`Unable to play recording: ${message}`);
    }
  }, [apiBaseUrl, navigate, setChannel, showToast]);

  const { upcoming, inProgress, completed, failed } = useMemo(() => {
    const upcoming: Recording[] = [];
    const inProgress: Recording[] = [];
    const completed: Recording[] = [];
    const failed: Recording[] = [];
    for (const r of recordings) {
      if (r.status === 'scheduled') upcoming.push(r);
      else if (r.status === 'recording' || r.status === 'finalizing') inProgress.push(r);
      else if (r.status === 'completed') completed.push(r);
      else if (r.status === 'failed') failed.push(r);
    }
    return { upcoming, inProgress, completed, failed };
  }, [recordings]);

  return (
    <FocusZone className="p-4 lg:p-6 lg:px-8 h-full overflow-y-auto pb-20 lg:pb-8 outline-hidden">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-22 lg:text-28 font-bold">Recordings</h1>
        {status && (
          <div className="flex gap-4 text-sm text-[#9ca3af]">
            <span>{status.activeCount} active</span>
            <span>{formatBytes(status.diskUsageBytes)} used</span>
          </div>
        )}
      </div>

      <div className="flex gap-1 mb-5 border-b border-[#333]">
        <button
          className={cn(
            'py-2 px-5 text-15 border-b-2 transition-colors duration-150 hover:text-[#e5e7eb]',
            tab === 'recordings' ? 'text-white border-[#3b82f6]' : 'text-[#9ca3af] border-transparent'
          )}
          onClick={() => setTab('recordings')}
        >
          Recordings ({recordings.length})
        </button>
        <button
          className={cn(
            'py-2 px-5 text-15 border-b-2 transition-colors duration-150 hover:text-[#e5e7eb]',
            tab === 'rules' ? 'text-white border-[#3b82f6]' : 'text-[#9ca3af] border-transparent'
          )}
          onClick={() => setTab('rules')}
        >
          Rules ({rules.length})
        </button>
      </div>

      {tab === 'recordings' && (
        <div className="pb-8">
          <ScheduleForm onCreated={() => fetchRecordings()} />

          {inProgress.length > 0 && (
            <section className="mb-6">
              <h2 className="text-18 font-semibold mb-3 text-[#d1d5db]">In Progress</h2>
              <div className="grid grid-cols-1 lg:grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-3">
                {inProgress.map(r => (
                  <RecordingCard
                    key={r.id}
                    rec={r}
                    onPlay={() => {}}
                    onCancel={() => cancelRec(r.id)}
                    onStop={() => stopRec(r.id)}
                    onDelete={() => deleteRec(r.id)}
                    onAnalyze={() => { void analyzeCommercials(r.id); }}
                    onReview={() => navigateToRecording(r.id)}
                  />
                ))}
              </div>
            </section>
          )}

          {upcoming.length > 0 && (
            <section className="mb-6">
              <h2 className="text-18 font-semibold mb-3 text-[#d1d5db]">Upcoming</h2>
              <div className="grid grid-cols-1 lg:grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-3">
                {upcoming.map(r => (
                  <RecordingCard
                    key={r.id}
                    rec={r}
                    onPlay={() => {}}
                    onCancel={() => cancelRec(r.id)}
                    onStop={() => {}}
                    onDelete={() => deleteRec(r.id)}
                    onAnalyze={() => { void analyzeCommercials(r.id); }}
                    onReview={() => navigateToRecording(r.id)}
                  />
                ))}
              </div>
            </section>
          )}

          {completed.length > 0 && (
            <section className="mb-6">
              <h2 className="text-18 font-semibold mb-3 text-[#d1d5db]">Completed</h2>
              <div className="grid grid-cols-1 lg:grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-3">
                {completed.map(r => (
                  <RecordingCard
                    key={r.id}
                    rec={r}
                    onPlay={() => handlePlay(r)}
                    onCancel={() => {}}
                    onStop={() => {}}
                    onDelete={() => deleteRec(r.id)}
                    onAnalyze={() => { void analyzeCommercials(r.id); }}
                    onReview={() => navigateToRecording(r.id)}
                  />
                ))}
              </div>
            </section>
          )}

          {failed.length > 0 && (
            <section className="mb-6">
              <h2 className="text-18 font-semibold mb-3 text-[#d1d5db]">Failed</h2>
              <div className="grid grid-cols-1 lg:grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-3">
                {failed.map(r => (
                  <RecordingCard
                    key={r.id}
                    rec={r}
                    onPlay={() => {}}
                    onCancel={() => {}}
                    onStop={() => {}}
                    onDelete={() => deleteRec(r.id)}
                    onAnalyze={() => { void analyzeCommercials(r.id); }}
                    onReview={() => navigateToRecording(r.id)}
                  />
                ))}
              </div>
            </section>
          )}

          {recordings.length === 0 && (
            <div className="text-center text-[#6b7280] py-12 text-base">
              No recordings yet. Schedule one from the TV Guide.
            </div>
          )}
        </div>
      )}

      {tab === 'rules' && (
        <div className="pb-8">
          <RuleForm onCreated={() => { void fetchRules(); }} />
          {rules.length > 0 ? (
            <div className="grid grid-cols-1 lg:grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-3">
              {rules.map(r => (
                <RuleCard
                  key={`${r.id}:${r.retention_count}`}
                  rule={r}
                  onToggle={() => updateRule(r.id, { enabled: !r.enabled })}
                  onDelete={() => deleteRule(r.id)}
                  onRetentionChange={(limit) => { void updateRule(r.id, { retentionLimit: limit, maxRecordings: 0 }); }}
                />
              ))}
            </div>
          ) : (
            <div className="text-center text-[#6b7280] py-12 text-base">
              No recording rules yet. Use the form above to match future guide programs.
            </div>
          )}
        </div>
      )}
    </FocusZone>
  );
}
