export interface IosHlsSessionDescriptor {
  channelId: string;
  createdAt: number;
  expiresAt: number;
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
