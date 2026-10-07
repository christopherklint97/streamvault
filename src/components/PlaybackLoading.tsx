import { useEffect, useState } from 'react';

export default function PlaybackLoading({ live, onRetry }: { live: boolean; onRetry: () => void }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const started = Date.now();
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, []);
  const slow = elapsed >= 8;
  return (
    <div data-playback-loading className="absolute z-[4] top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 flex flex-col items-center gap-3 text-center text-[#aaa] animate-fade-in w-[min(88%,360px)] p-4 rounded-xl bg-black/70">
      <div aria-hidden="true" className="w-10 h-10 border-[3px] border-[#333] border-t-accent rounded-full animate-spin-fast" />
      <span role="status" className="text-base lg:text-20">{live ? 'Starting live stream…' : 'Loading playback…'}</span>
      <span className="text-sm text-[#888] tabular-nums">{elapsed}s</span>
      {slow && <>
        <p className="text-sm">Taking longer than usual.{live ? ' Retry or choose another channel.' : ' You can retry.'}</p>
        <button type="button" onClick={(event) => { event.stopPropagation(); onRetry(); }}
          className="py-3 px-7 rounded-lg bg-accent text-black font-semibold tap-none active:opacity-80">Retry now</button>
      </>}
    </div>
  );
}
