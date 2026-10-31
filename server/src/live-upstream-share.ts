import { PassThrough, type Readable } from 'node:stream';

const TS_PACKET = 188;
const TS_SYNC = 0x47;

export interface ShareableUpstream {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: Readable & { dump(): Promise<unknown> };
  finalUrl: string;
}

interface Subscriber { stream: PassThrough & { dump(): Promise<void> }; aligned: boolean }
interface Hub {
  meta: Omit<ShareableUpstream, 'body'>;
  source: Readable;
  subscribers: Set<Subscriber>;
  mpegTs: boolean | null;
  /** Bytes received so far; an MPEG-TS packet starts at every multiple of 188. */
  offset: number;
  closed: boolean;
}

/**
 * The provider counts each open live stream as a connection. Every viewer,
 * recording and archive writer of one channel subscribes to a single upstream
 * response instead of opening its own. The upstream closes with its last
 * subscriber, so leaving a channel still frees the connection immediately.
 */
export function createLiveUpstreamShare(options: { maxSubscriberBufferBytes?: number } = {}) {
  const maxBuffered = options.maxSubscriberBufferBytes ?? 32 * 1024 * 1024;
  const hubs = new Map<string, Promise<Hub | null>>();

  function close(key: string, hub: Hub, pending: Promise<Hub | null>) {
    if (hub.closed) return;
    hub.closed = true;
    if (hubs.get(key) === pending) hubs.delete(key);
    hub.source.destroy();
  }

  function attach(key: string, hub: Hub, pending: Promise<Hub | null>, fromStart: boolean): ShareableUpstream {
    const stream = Object.assign(new PassThrough(), {
      dump: async () => { stream.destroy(); },
    });
    const subscriber: Subscriber = { stream, aligned: fromStart };
    hub.subscribers.add(subscriber);
    stream.once('close', () => {
      hub.subscribers.delete(subscriber);
      if (!hub.subscribers.size) close(key, hub, pending);
    });
    return { ...hub.meta, body: stream };
  }

  function broadcast(hub: Hub, chunk: Buffer) {
    hub.mpegTs ??= chunk[0] === TS_SYNC;
    // A late joiner starts on a packet boundary, not mid-packet.
    const packetStart = hub.mpegTs ? (TS_PACKET - hub.offset % TS_PACKET) % TS_PACKET : 0;
    hub.offset += chunk.length;
    for (const subscriber of hub.subscribers) {
      let data = chunk;
      if (!subscriber.aligned) {
        if (packetStart >= chunk.length) continue;
        data = chunk.subarray(packetStart);
        subscriber.aligned = true;
      }
      subscriber.stream.write(data);
      // Live media cannot wait for one stalled consumer; drop it instead of
      // holding back every other subscriber or buffering without bound.
      if (subscriber.stream.writableLength + subscriber.stream.readableLength > maxBuffered) subscriber.stream.destroy();
    }
  }

  return {
    /** Live channels currently held open upstream. */
    get size() { return hubs.size; },
    /**
     * Join `key`'s open upstream, or open it with `connect`. Responses that
     * `shareable` rejects (errors, HTML, playlists) go to this caller alone.
     */
    async open(key: string, connect: () => Promise<ShareableUpstream>,
      shareable: (upstream: ShareableUpstream) => boolean): Promise<ShareableUpstream> {
      for (let existing = hubs.get(key); existing; existing = hubs.get(key)) {
        const hub = await existing;
        if (hub && !hub.closed) return attach(key, hub, existing, false);
        if (hubs.get(key) === existing) hubs.delete(key);
      }
      let settle!: (hub: Hub | null) => void;
      const pending = new Promise<Hub | null>(resolve => { settle = resolve; });
      hubs.set(key, pending);
      let upstream: ShareableUpstream;
      try {
        upstream = await connect();
      } catch (error) {
        if (hubs.get(key) === pending) hubs.delete(key);
        settle(null);
        throw error;
      }
      if (!shareable(upstream)) {
        if (hubs.get(key) === pending) hubs.delete(key);
        settle(null);
        return upstream;
      }
      const { body: source, ...meta } = upstream;
      const hub: Hub = { meta, source, subscribers: new Set(), mpegTs: null, offset: 0, closed: false };
      const first = attach(key, hub, pending, true);
      source.on('data', (chunk: Buffer) => broadcast(hub, chunk));
      source.once('end', () => {
        hub.closed = true;
        if (hubs.get(key) === pending) hubs.delete(key);
        for (const { stream } of hub.subscribers) stream.end();
      });
      // Never surface provider error text; subscribers see a generic failure.
      source.on('error', () => {
        const closedBefore = hub.closed;
        hub.closed = true;
        if (hubs.get(key) === pending) hubs.delete(key);
        if (!closedBefore) for (const { stream } of hub.subscribers) stream.destroy(new Error('Live upstream failed'));
      });
      settle(hub);
      return first;
    },
  };
}
