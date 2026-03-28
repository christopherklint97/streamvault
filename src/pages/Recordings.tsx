import { useEffect, useMemo, useCallback, useState, useRef } from 'react';
import { useRecordingStore } from '../stores/recordingStore';
import { usePlayerStore } from '../stores/playerStore';
import { useAppStore } from '../stores/appStore';
import { useChannelStore, SAME_ORIGIN } from '../stores/channelStore';
import type { Recording, RecordingRule, Channel } from '../types';
import { cn } from '../utils/cn';

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
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

const STATUS_COLORS: Record<string, string> = {
  scheduled: '#3b82f6',
  recording: '#ef4444',
  completed: '#22c55e',
  failed: '#f59e0b',
  cancelled: '#6b7280',
};

function RecordingCard({ rec, onPlay, onCancel, onStop, onDelete }: {
  rec: Recording;
  onPlay: () => void;
  onCancel: () => void;
  onStop: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="bg-surface-border rounded-[10px] p-3.5 flex flex-col gap-1.5" data-focusable>
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
        {rec.status === 'recording' && (
          <button className="py-1 px-3 rounded text-12 font-semibold bg-[#b45309] text-white transition-colors duration-150 hover:bg-[#d97706]" onClick={onStop}>Stop</button>
        )}
        {(rec.status === 'scheduled' || rec.status === 'recording') && (
          <button className="py-1 px-3 rounded text-12 font-semibold bg-[#4b5563] text-white transition-colors duration-150 hover:bg-[#6b7280]" onClick={onCancel}>Cancel</button>
        )}
        <button className="py-1 px-3 rounded text-12 font-semibold bg-[#2a2a3e] text-[#ef4444] transition-colors duration-150 hover:bg-[#7f1d1d] hover:text-[#fca5a5]" onClick={onDelete}>Delete</button>
      </div>
    </div>
  );
}

function RuleCard({ rule, onToggle, onDelete }: {
  rule: RecordingRule;
  onToggle: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="bg-surface-border rounded-[10px] p-3.5 flex flex-col gap-1.5" data-focusable>
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
        {rule.max_recordings > 0 && <span>Max: {rule.max_recordings}</span>}
      </div>
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
      } catch {
        // ignore
      }
    }, 300);
  }, [apiBaseUrl]);

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
  const updateRule = useRecordingStore((s) => s.updateRule);
  const deleteRule = useRecordingStore((s) => s.deleteRule);
  const setChannel = usePlayerStore((s) => s.setChannel);
  const navigate = useAppStore((s) => s.navigate);
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

  const handlePlay = useCallback((rec: Recording) => {
    setChannel({
      id: `recording_${rec.id}`,
      name: rec.title,
      url: `/api/recordings/${rec.id}/stream`,
      logo: '',
      group: '',
      region: '',
      contentType: 'movies',
    });
    navigate('player');
  }, [setChannel, navigate]);

  const { upcoming, inProgress, completed, failed } = useMemo(() => {
    const upcoming: Recording[] = [];
    const inProgress: Recording[] = [];
    const completed: Recording[] = [];
    const failed: Recording[] = [];
    for (const r of recordings) {
      if (r.status === 'scheduled') upcoming.push(r);
      else if (r.status === 'recording') inProgress.push(r);
      else if (r.status === 'completed') completed.push(r);
      else if (r.status === 'failed') failed.push(r);
    }
    return { upcoming, inProgress, completed, failed };
  }, [recordings]);

  return (
    <div className="p-4 lg:p-6 lg:px-8 h-full overflow-y-auto pb-20 lg:pb-8" tabIndex={0}>
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
          {rules.length > 0 ? (
            <div className="grid grid-cols-1 lg:grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-3">
              {rules.map(r => (
                <RuleCard
                  key={r.id}
                  rule={r}
                  onToggle={() => updateRule(r.id, { enabled: !r.enabled })}
                  onDelete={() => deleteRule(r.id)}
                />
              ))}
            </div>
          ) : (
            <div className="text-center text-[#6b7280] py-12 text-base">
              No recording rules. Create one from the TV Guide by long-pressing a program.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
