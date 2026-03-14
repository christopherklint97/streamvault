import { useEffect, useMemo, useCallback, useState } from 'react';
import { useRecordingStore } from '../stores/recordingStore';
import { usePlayerStore } from '../stores/playerStore';
import { useAppStore } from '../stores/appStore';
import type { Recording, RecordingRule } from '../types';

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
    <div className="recording-card" data-focusable>
      <div className="recording-card__header">
        <span
          className="recording-card__status"
          style={{ backgroundColor: STATUS_COLORS[rec.status] || '#6b7280' }}
        >
          {rec.status === 'recording' && '⏺ '}
          {STATUS_LABELS[rec.status] || rec.status}
        </span>
        <span className="recording-card__channel">{rec.channel_name}</span>
      </div>
      <div className="recording-card__title">{rec.title}</div>
      <div className="recording-card__meta">
        <span>{formatDateTime(rec.start_time)}</span>
        {rec.duration > 0 && <span>{formatDuration(rec.duration)}</span>}
        {rec.file_size > 0 && <span>{formatBytes(rec.file_size)}</span>}
      </div>
      {rec.error && <div className="recording-card__error">{rec.error}</div>}
      <div className="recording-card__actions">
        {rec.status === 'completed' && (
          <button className="recording-card__btn recording-card__btn--play" onClick={onPlay}>Play</button>
        )}
        {rec.status === 'recording' && (
          <button className="recording-card__btn recording-card__btn--stop" onClick={onStop}>Stop</button>
        )}
        {(rec.status === 'scheduled' || rec.status === 'recording') && (
          <button className="recording-card__btn recording-card__btn--cancel" onClick={onCancel}>Cancel</button>
        )}
        <button className="recording-card__btn recording-card__btn--delete" onClick={onDelete}>Delete</button>
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
    <div className="recording-card" data-focusable>
      <div className="recording-card__header">
        <span
          className="recording-card__status"
          style={{ backgroundColor: rule.enabled ? '#22c55e' : '#6b7280' }}
        >
          {rule.enabled ? 'Active' : 'Disabled'}
        </span>
        <span className="recording-card__channel">{rule.channel_name}</span>
      </div>
      <div className="recording-card__title">
        {rule.match_type === 'exact' ? `"${rule.match_title}"` : `*${rule.match_title}*`}
      </div>
      <div className="recording-card__meta">
        <span>Pad: -{rule.padding_before / 60000}m / +{rule.padding_after / 60000}m</span>
        {rule.max_recordings > 0 && <span>Max: {rule.max_recordings}</span>}
      </div>
      <div className="recording-card__actions">
        <button className="recording-card__btn" onClick={onToggle}>
          {rule.enabled ? 'Disable' : 'Enable'}
        </button>
        <button className="recording-card__btn recording-card__btn--delete" onClick={onDelete}>Delete</button>
      </div>
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
    <div className="recordings-page" tabIndex={0}>
      <div className="recordings-page__header">
        <h1 className="recordings-page__title">Recordings</h1>
        {status && (
          <div className="recordings-page__status">
            <span>{status.activeCount} active</span>
            <span>{formatBytes(status.diskUsageBytes)} used</span>
          </div>
        )}
      </div>

      <div className="recordings-page__tabs">
        <button
          className={`recordings-page__tab${tab === 'recordings' ? ' recordings-page__tab--active' : ''}`}
          onClick={() => setTab('recordings')}
        >
          Recordings ({recordings.length})
        </button>
        <button
          className={`recordings-page__tab${tab === 'rules' ? ' recordings-page__tab--active' : ''}`}
          onClick={() => setTab('rules')}
        >
          Rules ({rules.length})
        </button>
      </div>

      {tab === 'recordings' && (
        <div className="recordings-page__content">
          {inProgress.length > 0 && (
            <section className="recordings-page__section">
              <h2 className="recordings-page__section-title">In Progress</h2>
              <div className="recordings-page__grid">
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
            <section className="recordings-page__section">
              <h2 className="recordings-page__section-title">Upcoming</h2>
              <div className="recordings-page__grid">
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
            <section className="recordings-page__section">
              <h2 className="recordings-page__section-title">Completed</h2>
              <div className="recordings-page__grid">
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
            <section className="recordings-page__section">
              <h2 className="recordings-page__section-title">Failed</h2>
              <div className="recordings-page__grid">
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
            <div className="recordings-page__empty">
              No recordings yet. Schedule one from the TV Guide.
            </div>
          )}
        </div>
      )}

      {tab === 'rules' && (
        <div className="recordings-page__content">
          {rules.length > 0 ? (
            <div className="recordings-page__grid">
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
            <div className="recordings-page__empty">
              No recording rules. Create one from the TV Guide by long-pressing a program.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
