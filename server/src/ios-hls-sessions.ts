export interface IosHlsSessionDescriptor {
  channelId: string;
  createdAt: number;
  expiresAt: number;
}

// Native Safari can prefetch several minutes of HLS segments, leaving no
// requests while it drains that buffer. Keep the backing files longer than
// that quiet window; global session, lifetime, and storage caps still apply.
export const IOS_HLS_IDLE_TIMEOUT_MS = 10 * 60_000;

export interface ReusableIosHlsSession {
  key: string;
  expiresAt: number;
  state?: 'running' | 'complete' | 'failed';
}

export function iosHlsProcessExitState(
  code: number | null,
  signal: NodeJS.Signals | null,
): 'complete' | 'failed' {
  return code === 0 && signal === null ? 'complete' : 'failed';
}

export function iosHlsSessionKey(channelId: string, sourceUrl: string, startSeconds: number): string {
  return `${channelId}\n${sourceUrl}\n${Math.floor(startSeconds)}`;
}

export function findReusableIosHlsSession(
  sessions: ReadonlyMap<string, ReusableIosHlsSession>,
  key: string,
  now = Date.now(),
): string | null {
  for (const [sessionId, session] of sessions) {
    if (session.key === key && session.expiresAt > now && session.state !== 'failed') return sessionId;
  }
  return null;
}

export function iosHlsSessionLimitReason(
  session: IosHlsSessionDescriptor,
  now: number,
  storageBytes: number,
  maximumLifetimeMs: number,
  maximumStorageBytes: number,
): 'lifetime' | 'storage' | null {
  if (now - session.createdAt > maximumLifetimeMs) return 'lifetime';
  if (storageBytes > maximumStorageBytes) return 'storage';
  return null;
}

/** Choose sessions that must stop before a new bounded HLS session starts. */
export function selectIosHlsSessionsToRetire(
  sessions: ReadonlyMap<string, IosHlsSessionDescriptor>,
  incomingChannelId: string,
  maxSessions: number,
): string[] {
  const retire = new Set<string>();
  const survivors: Array<[string, IosHlsSessionDescriptor]> = [];
  for (const entry of sessions) {
    if (entry[1].channelId === incomingChannelId) retire.add(entry[0]);
    else survivors.push(entry);
  }

  const survivorLimit = Math.max(1, Math.floor(maxSessions)) - 1;
  survivors.sort((a, b) => a[1].expiresAt - b[1].expiresAt);
  for (let index = 0; index < survivors.length - survivorLimit; index++) {
    retire.add(survivors[index][0]);
  }
  return [...retire];
}
