/** A scope owns one timer and at most one unsettled read. */
export function startSerialPoll(read: () => Promise<boolean | void>, intervalMs: number, immediate = true): () => void {
  let live = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = async () => {
    if (!live) return;
    let again: boolean | void = true;
    try { again = await read(); } catch { /* retry on the next bounded interval */ }
    if (live && again !== false) timer = setTimeout(() => { void run(); }, intervalMs);
  };
  if (immediate) void run();
  else timer = setTimeout(() => { void run(); }, intervalMs);
  return () => { live = false; clearTimeout(timer); };
}
