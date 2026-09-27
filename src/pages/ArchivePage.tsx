import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../services/api';
import { getArchiveChannels, getArchivePlayback, setArchiveChannel, type ArchiveChannel } from '../services/archivePlayback';
import { useChannelStore } from '../stores/channelStore';
import { usePlayerStore } from '../stores/playerStore';
import { useAppStore } from '../stores/appStore';
import type { Channel } from '../types';

interface ArchiveProgram { title: string; startTime: number; endTime: number }
function when(ms: number | null): string { return ms == null ? 'No captured media yet' : new Date(ms).toLocaleString(); }
function size(bytes: number): string { return `${(bytes / 1_000_000_000).toFixed(1)} GB`; }

export default function ArchivePage() {
  const apiBaseUrl = useChannelStore(s => s.apiBaseUrl);
  const setChannel = usePlayerStore(s => s.setChannel);
  const navigate = useAppStore(s => s.navigate);
  const showToast = useAppStore(s => s.showToastMessage);
  const [archives, setArchives] = useState<ArchiveChannel[]>([]);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Channel[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [programs, setPrograms] = useState<Record<string, ArchiveProgram[]>>({});
  const [offsets, setOffsets] = useState<Record<string, number>>({});

  const refresh = useCallback(async () => {
    try {
      const response = await getArchiveChannels(apiBaseUrl);
      setArchives(response);
      setError('');
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }, [apiBaseUrl]);

  useEffect(() => {
    const initial = setTimeout(() => { void refresh(); }, 0);
    const interval = setInterval(() => { void refresh(); }, 15_000);
    return () => { clearTimeout(initial); clearInterval(interval); };
  }, [refresh]);

  useEffect(() => {
    if (!query.trim()) return;
    let active = true;
    const timer = setTimeout(async () => {
      try {
        const data = await apiFetch<{ channels: Channel[] }>(apiBaseUrl,
          `/api/search?q=${encodeURIComponent(query.trim())}&type=livetv`);
        if (active) setResults((data.channels ?? []).filter(c => c.contentType === 'livetv').slice(0, 15));
      } catch (cause) { if (active) setError(cause instanceof Error ? cause.message : String(cause)); }
    }, 300);
    return () => { active = false; clearTimeout(timer); };
  }, [apiBaseUrl, query]);

  useEffect(() => {
    let active = true;
    for (const archive of archives) {
      if (!archive.enabled || archive.availableFrom === null || archive.availableTo === null) continue;
      void apiFetch<{ programs: ArchiveProgram[] }>(apiBaseUrl,
        `/api/archives/${encodeURIComponent(archive.channelId)}/programs?from=${archive.availableFrom}&to=${archive.availableTo}`)
        .then(data => { if (active) setPrograms(current => ({ ...current, [archive.channelId]: data.programs ?? [] })); })
        .catch(() => { /* Guide gaps do not prevent time-based playback. */ });
    }
    return () => { active = false; };
  }, [apiBaseUrl, archives]);

  const toggle = async (channel: { id: string; name: string }, enabled: boolean) => {
    setBusy(true); setError('');
    try {
      await setArchiveChannel(apiBaseUrl, channel.id, { channelName: channel.name, enabled, retentionHours: 24 });
      setQuery(''); setResults([]); await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };

  const play = async (archive: ArchiveChannel, from?: number, to?: number) => {
    setBusy(true); setError('');
    try {
      const snapshot = await getArchivePlayback({ apiBaseUrl, channelId: archive.channelId,
        startTime: from ?? archive.availableFrom ?? 0,
        endTime: to ?? archive.availableTo ?? 0 });
      setChannel({ id: `archive_${archive.channelId}_${from ?? snapshot.startTime}`, name: archive.channelName,
        url: snapshot.url, logo: '', group: 'Archive', region: '', contentType: 'movies',
        duration: snapshot.duration, dvrHls: true,
        initialSeekSeconds: snapshot.startOffsetSeconds ?? 0 });
      if (snapshot.gaps?.length) showToast('This archive has capture gaps; missing broadcasts are skipped.');
      navigate('player');
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message); showToast(`Unable to play archive: ${message}`);
    } finally { setBusy(false); }
  };

  return <section className="pb-8 text-[#d1d5db]">
    <h2 className="text-18 font-semibold">Continuous channel archive</h2>
    <p className="text-13 text-[#9ca3af] mb-4">Save a rolling 24 hours from selected channels. Capture starts when enabled; earlier broadcasts cannot be recovered.</p>
    <label className="block text-13 mb-2" htmlFor="archive-search">Add a channel</label>
    <input id="archive-search" data-focusable value={query} onChange={event => {
      setQuery(event.target.value);
      if (!event.target.value.trim()) setResults([]);
    }}
      placeholder="Search live channels" className="w-full max-w-lg rounded border border-[#333] bg-[#1a1a2e] px-3 py-2 text-white" />
    {results.length > 0 && <div className="max-w-lg mb-4 border border-[#333] rounded">
      {results.map(channel => <button key={channel.id} disabled={busy} data-focusable
        onClick={() => { void toggle(channel, true); }} className="block w-full text-left px-3 py-2 hover:bg-[#2a2a3e]">
        Archive {channel.name}
      </button>)}
    </div>}
    {error && <p role="alert" className="my-3 text-red-300">{error}</p>}
    {archives.length === 0 && <p className="mt-4 text-[#9ca3af]">No channels archived yet.</p>}
    <div className="grid grid-cols-1 gap-4 mt-4">
      {archives.map(archive => {
        const from = archive.availableFrom;
        const to = archive.availableTo;
        const available = from !== null && to !== null && to > from;
        const selected = available ? from + Math.round((to - from) * (offsets[archive.channelId] ?? 0) / 100) : null;
        return <article key={archive.channelId} className="rounded-lg border border-[#333] bg-[#1a1a2e] p-4">
          <div className="flex items-center justify-between gap-3">
            <h3 className="font-semibold">{archive.channelName}</h3>
            <button data-focusable disabled={busy} onClick={() => { void toggle({ id: archive.channelId, name: archive.channelName }, !archive.enabled); }}
              className="rounded bg-[#333] px-3 py-1">{archive.enabled ? 'Stop archiving' : 'Resume archiving'}</button>
          </div>
          <p className="text-12 text-[#9ca3af] mt-2">{archive.status || (archive.enabled ? 'Starting' : 'Paused')} · {size(archive.diskUsageBytes)} stored · {when(from)} – {when(to)}</p>
          {archive.error && <p role="status" className="text-12 text-amber-300 mt-1">{archive.error}</p>}
          {available && <>
            <button data-focusable disabled={busy} className="mt-3 rounded bg-blue-700 px-4 py-2"
              onClick={() => { void play(archive); }}>Watch archive (seek anywhere)</button>
            <label className="block text-13 mt-4" htmlFor={`archive-seek-${archive.channelId}`}>
              Start at: {when(selected)}
            </label>
            <input id={`archive-seek-${archive.channelId}`} data-focusable type="range" min="0" max="100"
              value={offsets[archive.channelId] ?? 0} onChange={event => setOffsets(current => ({ ...current, [archive.channelId]: Number(event.target.value) }))}
              className="w-full max-w-lg" />
            <button data-focusable disabled={busy} className="rounded bg-[#333] px-3 py-2" onClick={() => { void play(archive, Math.min(selected ?? from, to - 1000), to); }}>Play from here</button>
            {(programs[archive.channelId] ?? []).length > 0 && <div className="mt-4">
              <h4 className="text-13 font-semibold">Shows in the archive</h4>
              <div className="max-h-56 overflow-y-auto flex flex-col gap-1 mt-2">
                {programs[archive.channelId].map(program => <button key={`${program.startTime}-${program.title}`}
                  data-focusable disabled={busy} className="text-left rounded px-2 py-1 hover:bg-[#333]"
                  onClick={() => { void play(archive, program.startTime, Math.min(program.endTime, to)); }}>
                  {new Date(program.startTime).toLocaleString()} — {program.title}
                </button>)}
              </div>
            </div>}
          </>}
        </article>;
      })}
    </div>
  </section>;
}
