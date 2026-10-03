// Bound concurrent catalogue streams, not providers: each stream starts its
// entire provider batch in parallel and leaves HTTP/1.1 capacity for the UI.
export function createModelDiscoveryQueue() {
  let active = 0;
  const waiting: Array<() => void> = [];

  function drain(): void {
    while (active < 2 && waiting.length) waiting.shift()!();
  }

  return function schedule<T>(run: () => Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const cancel = () => {
        const index = waiting.indexOf(start);
        if (index !== -1) waiting.splice(index, 1);
        reject(new Error('Model discovery cancelled'));
      };
      const release = () => { active -= 1; drain(); };
      const start = () => {
        signal.removeEventListener('abort', cancel);
        active += 1;
        try {
          run().then(
            value => { release(); resolve(value); },
            error => { release(); reject(error); }
          );
        } catch (error) { release(); reject(error); }
      };
      if (signal.aborted) { cancel(); return; }
      signal.addEventListener('abort', cancel, { once: true });
      waiting.push(start);
      drain();
    });
  };
}
