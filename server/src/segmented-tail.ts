export async function waitForSharedArchiveTail(
  publishedEnd: () => number | null,
  showEnd: number,
  maxWaitMs = 30_000,
  intervalMs = 2_000,
): Promise<boolean> {
  const deadline = Date.now() + maxWaitMs;
  // The archive writer does not close at a show boundary. Its next committed
  // segment may contain the final seconds; never finalize from an open .tmp.
  while ((publishedEnd() ?? 0) < showEnd - 2_000) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await new Promise<void>(resolve => setTimeout(resolve, Math.min(intervalMs, remaining)));
  }
  return true;
}
