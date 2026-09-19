/** Serialize durable mirror writes while coalescing bursts to the latest state. */
export function createLatestWriteQueue<T>(
  write: (value: T) => Promise<unknown>,
): (value: T) => void {
  let pending: T | null = null;
  let draining = false;

  const drain = async () => {
    if (draining) return;
    draining = true;
    try {
      while (pending !== null) {
        const next = pending;
        pending = null;
        try {
          await write(next);
        } catch {
          // A mirror failure must never break the live renderer state.
        }
      }
    } finally {
      draining = false;
      if (pending !== null) void drain();
    }
  };

  return (value) => {
    pending = value;
    void drain();
  };
}
