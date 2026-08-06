// Synchronous event bus.
//
// Synchronous on purpose: an event emitted during a fixed simulation step has to
// be fully handled inside that same step, or the simulation stops being
// deterministic and the automated critics can no longer reproduce a run.

export type Listener<T = unknown> = (payload: T) => void;
export type Unsubscribe = () => void;

export interface EventBus {
  on<T = unknown>(event: string, fn: Listener<T>): Unsubscribe;
  once<T = unknown>(event: string, fn: Listener<T>): Unsubscribe;
  off(event: string, fn: Listener<never>): void;
  emit<T = unknown>(event: string, payload?: T): void;
  clear(): void;
  inspect(): Record<string, number>;
}

export function createBus(): EventBus {
  const listeners = new Map<string, Listener<never>[]>();
  let depth = 0;
  const pendingRemovals: Array<[string, Listener<never>]> = [];

  function off(event: string, fn: Listener<never>): void {
    const set = listeners.get(event);
    if (!set) return;
    // Removing mid-dispatch would reindex the array we are iterating, so defer.
    if (depth > 0) { pendingRemovals.push([event, fn]); return; }
    const i = set.indexOf(fn);
    if (i >= 0) set.splice(i, 1);
    if (set.length === 0) listeners.delete(event);
  }

  const bus: EventBus = {
    on<T>(event: string, fn: Listener<T>): Unsubscribe {
      let set = listeners.get(event);
      if (!set) listeners.set(event, (set = []));
      set.push(fn as Listener<never>);
      return () => off(event, fn as Listener<never>);
    },

    once<T>(event: string, fn: Listener<T>): Unsubscribe {
      const wrapped: Listener<T> = (payload) => {
        off(event, wrapped as Listener<never>);
        fn(payload);
      };
      return bus.on(event, wrapped);
    },

    off,

    emit<T>(event: string, payload?: T): void {
      const set = listeners.get(event);
      if (!set || set.length === 0) return;
      depth++;
      // Iterate a copy: handlers commonly subscribe or unsubscribe as a side effect.
      const snapshot = set.slice();
      for (let i = 0; i < snapshot.length; i++) {
        try {
          (snapshot[i] as Listener<T | undefined>)(payload);
        } catch (err) {
          console.error(`[bus] listener for "${event}" threw:`, err);
        }
      }
      depth--;
      if (depth === 0 && pendingRemovals.length) {
        for (const [e, f] of pendingRemovals.splice(0)) off(e, f);
      }
    },

    clear(): void {
      listeners.clear();
      pendingRemovals.length = 0;
    },

    /** Debug aid — what is anyone actually listening to? */
    inspect(): Record<string, number> {
      const out: Record<string, number> = {};
      for (const [k, v] of listeners) out[k] = v.length;
      return out;
    },
  };

  return bus;
}
