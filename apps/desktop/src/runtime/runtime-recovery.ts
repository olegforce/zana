/** A backend crash requires a deliberate restart: surviving sessions must not be killed silently. */
export function createRuntimeRecovery(deps: {
  showDialog(service: string): Promise<boolean>;
  restart(): void;
  log(service: string): void;
}): { notify(service: string): void; dispose(): void } {
  let notified = false;
  let disposed = false;
  return {
    notify(service) {
      if (disposed || notified) return;
      notified = true;
      deps.log(service);
      void deps.showDialog(service).then(restart => {
        if (restart && !disposed) deps.restart();
      }).catch(() => { notified = false; });
    },
    dispose() { disposed = true; }
  };
}
