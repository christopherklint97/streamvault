import { useCallback, useEffect, useRef, useState } from 'react';
import FocusZone from '../components/FocusZone';
import { useAppStore } from '../stores/appStore';
import { useRecordingStore } from '../stores/recordingStore';
import type { CommercialSegment } from '../types';
import {
  applyCommercialDraftLoad,
  applyCommercialDraftSave,
  beginCommercialDraft,
  editCommercialDraft,
  isCommercialDraftDirty,
  isCommercialDraftEditable,
} from '../services/commercialDraft';
import { prepareCommercialSegments } from '../utils/commercial-intervals';
import { cn } from '../utils/cn';
import { getRecordingAnalysisError, getRecordingAnalysisStatus, normalizeCommercialAnalysisStatus } from '../utils/recording-commercial';

interface RecordingDetailProps {
  recordingId: string;
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = Math.floor(seconds % 60);
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
    : `${minutes}:${String(remainder).padStart(2, '0')}`;
}

function confidenceLabel(confidence: number | null): string {
  return Number.isFinite(confidence) ? `${Math.round((confidence ?? 0) * 100)}%` : '—';
}

function makeManualSegment(
  now: () => number = Date.now,
  random: () => number = Math.random,
): CommercialSegment {
  return {
    id: `manual_${now()}_${random().toString(36).slice(2, 7)}`,
    startSeconds: 0,
    endSeconds: 30,
    source: 'manual',
    confidence: 1,
    state: 'accepted',
  };
}

function RecordingDetailContent({ recordingId }: RecordingDetailProps) {
  const recordings = useRecordingStore((state) => state.recordings);
  const metadata = useRecordingStore((state) => state.commercialSegments[recordingId]);
  const loadError = useRecordingStore((state) => state.commercialSegmentsError[recordingId]);
  const fetchRecordings = useRecordingStore((state) => state.fetchRecordings);
  const fetchSegments = useRecordingStore((state) => state.fetchCommercialSegments);
  const analyze = useRecordingStore((state) => state.analyzeCommercials);
  const saveSegments = useRecordingStore((state) => state.saveCommercialSegments);
  const setOverride = useRecordingStore((state) => state.setCommercialSkipOverride);
  const goBack = useAppStore((state) => state.goBack);
  const setNavigationBlocker = useAppStore((state) => state.setNavigationBlocker);
  const showToast = useAppStore((state) => state.showToastMessage);
  const recording = recordings.find((candidate) => candidate.id === recordingId);
  const duration = recording?.duration ?? 0;

  const [draftState, setDraftState] = useState(() => beginCommercialDraft(recordingId));
  const [validationErrors, setValidationErrors] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const editorRef = useRef<HTMLElement>(null);
  const addButtonRef = useRef<HTMLButtonElement>(null);
  const draft = draftState.segments;
  const editable = isCommercialDraftEditable(draftState);
  const dirty = isCommercialDraftDirty(draftState);

  useEffect(() => {
    if (!recording) void fetchRecordings();
    let active = true;
    void fetchSegments(recordingId, { force: true }).then((loaded) => {
      if (!active) return;
      setDraftState((current) => applyCommercialDraftLoad(current, recordingId, loaded));
    });
    return () => { active = false; };
  }, [fetchRecordings, fetchSegments, recording, recordingId]);

  useEffect(() => {
    const status = normalizeCommercialAnalysisStatus(metadata?.analysis.status ?? recording?.analysis_state);
    if (status !== 'queued' && status !== 'analyzing') return;
    const timer = setInterval(() => {
      void Promise.all([
        fetchRecordings(),
        fetchSegments(recordingId, { force: true, silent: true }),
      ]).then(([, loaded]) => {
        if (!loaded) return;
        setDraftState((current) => applyCommercialDraftLoad(current, recordingId, loaded));
      });
    }, 5_000);
    return () => clearInterval(timer);
  }, [fetchRecordings, fetchSegments, metadata?.analysis.status, recording?.analysis_state, recordingId]);

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!dirty) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [dirty]);

  useEffect(() => {
    if (!dirty) return;
    return setNavigationBlocker(() => window.confirm('Discard unsaved commercial interval changes?'));
  }, [dirty, setNavigationBlocker]);

  const requestBack = useCallback(() => {
    goBack();
  }, [goBack]);

  const updateSegment = useCallback((id: string, updates: Partial<CommercialSegment>) => {
    setDraftState((current) => isCommercialDraftEditable(current)
      ? editCommercialDraft(current, current.segments.map((segment) => segment.id === id ? { ...segment, ...updates } : segment))
      : current);
    setValidationErrors([]);
  }, []);

  const nudge = useCallback((id: string, boundary: 'startSeconds' | 'endSeconds', amount: number) => {
    setDraftState((current) => isCommercialDraftEditable(current)
      ? editCommercialDraft(current, current.segments.map((segment) => segment.id === id
        ? { ...segment, [boundary]: Math.max(0, segment[boundary] + amount) }
        : segment))
      : current);
    setValidationErrors([]);
  }, []);

  const handleAdd = useCallback(() => {
    setDraftState((current) => {
      if (!isCommercialDraftEditable(current)) return current;
      const segment = makeManualSegment();
      const lastEnd = current.segments.reduce((maximum, item) => Math.max(maximum, Number.isFinite(item.endSeconds) ? item.endSeconds : 0), 0);
      segment.startSeconds = Math.min(lastEnd, Math.max(0, duration - 1));
      segment.endSeconds = Math.min(duration || segment.startSeconds + 30, segment.startSeconds + 30);
      return editCommercialDraft(current, [...current.segments, segment]);
    });
  }, [duration]);

  const handleRemove = useCallback((id: string, index: number) => {
    setDraftState((current) => isCommercialDraftEditable(current)
      ? editCommercialDraft(current, current.segments.filter((item) => item.id !== id))
      : current);
    setValidationErrors([]);
    requestAnimationFrame(() => {
      const cards = editorRef.current?.querySelectorAll<HTMLElement>('[data-segment-id]');
      const nextCard = cards?.[Math.min(index, Math.max(0, (cards?.length ?? 1) - 1))];
      const nextControl = nextCard?.querySelector<HTMLElement>('[data-focusable]') ?? addButtonRef.current;
      nextControl?.focus({ preventScroll: true });
    });
  }, []);

  const handleSave = useCallback(async () => {
    if (!editable) return;
    const prepared = prepareCommercialSegments(draft, duration);
    if (!prepared.ok) {
      setValidationErrors(prepared.errors);
      return;
    }
    setSaving(true);
    const refreshed = await saveSegments(recordingId, prepared.segments);
    setSaving(false);
    if (!refreshed) return;
    setDraftState((current) => applyCommercialDraftSave(current, refreshed));
    setValidationErrors([]);
    showToast('Commercial intervals saved');
  }, [draft, duration, editable, recordingId, saveSegments, showToast]);

  const handleAnalyze = useCallback(async () => {
    if (!editable) return;
    const started = await analyze(recordingId);
    if (started) {
      showToast('Commercial analysis queued');
      void fetchSegments(recordingId, { force: true, silent: true });
    }
  }, [analyze, editable, fetchSegments, recordingId, showToast]);

  const handleOverride = useCallback(async (enabled: boolean | null) => {
    if (!editable) return;
    await setOverride(recordingId, enabled);
  }, [editable, recordingId, setOverride]);

  if (!recording) {
    return (
      <FocusZone className="h-full p-4 lg:p-8" onBack={requestBack}>
        <button data-focusable onClick={requestBack} className="rounded-lg border border-white/20 px-4 py-2">Back</button>
        <p className="mt-6 text-[#aaa]">Loading recording…</p>
      </FocusZone>
    );
  }

  const analysisStatus = normalizeCommercialAnalysisStatus(
    metadata?.analysis.status ?? getRecordingAnalysisStatus(recording),
  );
  const analysisError = metadata?.analysis.error ?? getRecordingAnalysisError(recording);
  const override = metadata?.autoSkipOverride
    ?? (recording.commercial_skip_override == null ? null : Boolean(recording.commercial_skip_override));
  const effective = metadata?.effectiveAutoSkip ?? false;
  const canAnalyze = analysisStatus === 'not_analyzed' || analysisStatus === 'failed';

  return (
    <FocusZone className="h-full overflow-y-auto p-4 pb-24 lg:p-8 outline-hidden" onBack={requestBack}>
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-5">
        <header className="flex flex-wrap items-start gap-3">
          <button
            data-focusable
            onClick={requestBack}
            className="rounded-lg border border-white/20 bg-white/5 px-4 py-2 text-sm focus:border-accent"
            aria-label="Back to recordings"
          >
            ← Back
          </button>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-22 font-bold lg:text-28">{recording.title}</h1>
            <p className="text-sm text-[#999]">{recording.channel_name} · {formatTime(duration)}</p>
          </div>
          {dirty && <span className="rounded bg-[#b45309] px-3 py-1 text-xs font-semibold text-white">Unsaved changes</span>}
        </header>

        <section className="rounded-xl border border-white/10 bg-surface-border p-4">
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="text-lg font-semibold">Commercial analysis</h2>
            <span className={cn(
              'rounded px-2.5 py-1 text-xs font-bold uppercase tracking-wide',
              analysisStatus === 'failed' ? 'bg-[#7f1d1d] text-[#fecaca]'
                : analysisStatus === 'ready' ? 'bg-[#14532d] text-[#bbf7d0]'
                  : analysisStatus === 'review_needed' ? 'bg-[#78350f] text-[#fde68a]'
                    : 'bg-[#263244] text-[#cbd5e1]',
            )}>{analysisStatus.replace('_', ' ')}</span>
            {canAnalyze && (
              <button data-focusable disabled={!editable} onClick={handleAnalyze} className="rounded-lg bg-[#1d4ed8] px-4 py-2 text-sm font-semibold text-white disabled:opacity-40 focus:ring-2 focus:ring-white">
                {analysisStatus === 'failed' ? 'Retry analysis' : 'Analyze recording'}
              </button>
            )}
          </div>
          {analysisError && <p role="alert" className="mt-3 rounded bg-[#451a1a] p-3 text-sm text-[#fecaca]">{analysisError}</p>}
          {metadata?.analysis.detector && (
            <p className="mt-2 text-xs text-[#777]">
              Detector: {metadata.analysis.detector}{metadata.analysis.profileVersion ? ` · profile ${metadata.analysis.profileVersion}` : ''}
            </p>
          )}
        </section>

        <section className="rounded-xl border border-white/10 bg-surface-border p-4">
          <h2 className="text-lg font-semibold">Automatic skipping</h2>
          <p className="mt-1 text-sm text-[#999]">
            Effective setting: <strong className={effective ? 'text-[#86efac]' : 'text-[#ccc]'}>{effective ? 'On' : 'Off'}</strong>. Only accepted intervals are used.
          </p>
          <div className="mt-3 flex flex-wrap gap-2" role="group" aria-label="Recording auto-skip override">
            {([
              { value: null, label: 'Use global' },
              { value: true, label: 'On' },
              { value: false, label: 'Off' },
            ] as const).map((choice) => (
              <button
                key={choice.label}
                data-focusable
                disabled={!editable}
                aria-pressed={override === choice.value}
                onClick={() => handleOverride(choice.value)}
                className={cn(
                  'rounded-lg border px-4 py-2 text-sm font-semibold disabled:opacity-40 focus:border-white',
                  override === choice.value ? 'border-accent bg-accent text-black' : 'border-white/15 bg-white/5 text-[#ddd]',
                )}
              >
                {choice.label}
              </button>
            ))}
          </div>
        </section>

        <section ref={editorRef} aria-busy={draftState.phase === 'loading'} className="rounded-xl border border-white/10 bg-surface-border p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold">Commercial intervals</h2>
              <p className="text-sm text-[#888]">Adjust boundaries, approve detector suggestions, or add manual intervals.</p>
            </div>
            <button ref={addButtonRef} data-focusable disabled={!editable} onClick={handleAdd} className="rounded-lg border border-accent px-4 py-2 text-sm font-semibold text-accent disabled:opacity-40 focus:bg-accent focus:text-black">+ Add interval</button>
          </div>

          {draftState.phase === 'loading' && <p className="py-6 text-[#999]">Loading intervals…</p>}
          {loadError && <p role="alert" className="mt-3 rounded bg-[#451a1a] p-3 text-sm text-[#fecaca]">{loadError}</p>}
          {draftState.phase === 'ready' && draft.length === 0 && <p className="py-6 text-[#777]">No commercial intervals yet.</p>}

          <div className="mt-4 flex flex-col gap-3">
            {draft.map((segment, index) => (
              <article key={segment.id} data-segment-id={segment.id} className="rounded-xl border border-white/10 bg-[#151522] p-3.5">
                <div className="flex flex-wrap items-center gap-2 text-xs text-[#aaa]">
                  <span className="font-bold text-white">Break {index + 1}</span>
                  <span className="rounded bg-white/10 px-2 py-0.5">{segment.source}</span>
                  <span>{confidenceLabel(segment.confidence)} confidence</span>
                  <span className={cn(
                    'rounded px-2 py-0.5 font-bold uppercase',
                    segment.state === 'accepted' ? 'bg-[#14532d] text-[#bbf7d0]'
                      : segment.state === 'rejected' ? 'bg-[#7f1d1d] text-[#fecaca]'
                        : 'bg-[#78350f] text-[#fde68a]',
                  )}>{segment.state}</span>
                </div>

                <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                  {(['startSeconds', 'endSeconds'] as const).map((boundary) => (
                    <div key={boundary}>
                      <label className="mb-1 block text-xs text-[#999]" htmlFor={`${segment.id}-${boundary}`}>
                        {boundary === 'startSeconds' ? 'Start' : 'End'} (seconds)
                      </label>
                      <div className="flex gap-1.5">
                        <button data-focusable disabled={!editable} aria-label={`Move ${boundary === 'startSeconds' ? 'start' : 'end'} back one second`} onClick={() => nudge(segment.id, boundary, -1)} className="rounded border border-white/15 px-3 text-lg disabled:opacity-40">−</button>
                        <input
                          id={`${segment.id}-${boundary}`}
                          data-focusable
                          disabled={!editable}
                          type="number"
                          inputMode="decimal"
                          min={0}
                          max={duration || undefined}
                          step={0.1}
                          value={Number.isNaN(segment[boundary]) ? '' : segment[boundary]}
                          onChange={(event) => updateSegment(segment.id, {
                            [boundary]: event.target.value === '' ? Number.NaN : Number(event.target.value),
                          })}
                          className="min-w-0 flex-1 rounded border border-white/15 bg-[#090912] px-3 py-2 text-white focus:border-accent"
                        />
                        <button data-focusable disabled={!editable} aria-label={`Move ${boundary === 'startSeconds' ? 'start' : 'end'} forward one second`} onClick={() => nudge(segment.id, boundary, 1)} className="rounded border border-white/15 px-3 text-lg disabled:opacity-40">+</button>
                      </div>
                    </div>
                  ))}
                </div>
                <p className="mt-2 text-xs text-[#888]">Duration: {formatTime(segment.endSeconds - segment.startSeconds)}</p>

                <div className="mt-3 flex flex-wrap gap-2">
                  <button data-focusable disabled={!editable} aria-pressed={segment.state === 'accepted'} onClick={() => updateSegment(segment.id, { state: 'accepted' })} className="rounded-lg bg-[#14532d] px-3 py-2 text-sm text-[#bbf7d0] disabled:opacity-40 focus:ring-2 focus:ring-white">Approve</button>
                  <button data-focusable disabled={!editable} aria-pressed={segment.state === 'rejected'} onClick={() => updateSegment(segment.id, { state: 'rejected' })} className="rounded-lg bg-[#7f1d1d] px-3 py-2 text-sm text-[#fecaca] disabled:opacity-40 focus:ring-2 focus:ring-white">Reject</button>
                  <button data-focusable disabled={!editable} onClick={() => handleRemove(segment.id, index)} className="rounded-lg border border-white/15 px-3 py-2 text-sm text-[#ddd] disabled:opacity-40 focus:border-white">Remove</button>
                </div>
              </article>
            ))}
          </div>

          {validationErrors.length > 0 && (
            <div role="alert" className="mt-4 rounded-lg bg-[#451a1a] p-3 text-sm text-[#fecaca]">
              <p className="font-semibold">Fix these intervals before saving:</p>
              <ul className="mt-1 list-disc pl-5">
                {validationErrors.map((error) => <li key={error}>{error}</li>)}
              </ul>
            </div>
          )}

          <div className="mt-5 flex flex-wrap gap-2">
            <button
              data-focusable
              disabled={!editable || !dirty || saving}
              onClick={handleSave}
              className="rounded-lg bg-[#1d4ed8] px-5 py-2.5 font-semibold text-white disabled:opacity-40 focus:ring-2 focus:ring-white"
            >
              {saving ? 'Saving…' : 'Save intervals'}
            </button>
            {dirty && (
              <button
                data-focusable
                onClick={() => {
                  if (!metadata) return;
                  setDraftState(applyCommercialDraftLoad(beginCommercialDraft(recordingId), recordingId, metadata));
                  setValidationErrors([]);
                }}
                className="rounded-lg border border-white/15 px-5 py-2.5 text-[#ddd] focus:border-white"
              >
                Discard changes
              </button>
            )}
          </div>
        </section>

        <p className="text-xs text-[#666]">Edits save interval metadata only. The original recording is never modified.</p>
      </div>
    </FocusZone>
  );
}

export default function RecordingDetail(props: RecordingDetailProps) {
  return <RecordingDetailContent key={props.recordingId} {...props} />;
}
