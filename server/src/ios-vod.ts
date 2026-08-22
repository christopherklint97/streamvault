export interface IosVodCandidate {
  name: string;
}

const FOUR_K_SUFFIX = /\s*\[4K\]\s*$/i;

/**
 * iPhones that cannot decode a 4K HEVC edition should use the identical
 * non-4K catalogue edition when the provider exposes one.
 */
export function selectIosVodFallback<T extends IosVodCandidate>(requested: T, candidates: T[]): T {
  const compatibleName = requested.name.replace(FOUR_K_SUFFIX, '');
  if (compatibleName === requested.name) return requested;
  return candidates.find(candidate => candidate.name === compatibleName) ?? requested;
}
