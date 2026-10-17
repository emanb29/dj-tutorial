// A small typed event emitter. Listeners run synchronously; nothing is queued. A listener that throws
// does not stop the others: its error is rethrown in a microtask, so it still surfaces as uncaught.

export type Unsubscribe = () => void;

export class Emitter<Events extends object> {
  private readonly listeners = new Map<keyof Events, Set<(payload: never) => void>>();

  on<Name extends keyof Events>(name: Name, listener: (payload: Events[Name]) => void): Unsubscribe {
    const set = this.listeners.get(name) ?? new Set();
    set.add(listener);
    this.listeners.set(name, set);
    return () => {
      set.delete(listener);
    };
  }

  emit<Name extends keyof Events>(name: Name, payload: Events[Name]): void {
    for (const listener of this.listeners.get(name) ?? []) {
      try {
        (listener as (payload: Events[Name]) => void)(payload);
      } catch (error) {
        queueMicrotask(() => {
          throw error;
        });
      }
    }
  }
}
