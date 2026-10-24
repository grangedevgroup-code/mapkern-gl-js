export type Listener<T> = (event: T) => void;

export class Emitter<Events extends object> {
  private readonly listeners = new Map<keyof Events, Set<Listener<never>>>();

  on<K extends keyof Events>(type: K, listener: Listener<Events[K]>): this {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener as Listener<never>);
    return this;
  }

  off<K extends keyof Events>(type: K, listener: Listener<Events[K]>): this {
    const set = this.listeners.get(type);
    if (set) {
      set.delete(listener as Listener<never>);
      if (set.size === 0) this.listeners.delete(type);
    }
    return this;
  }

  once<K extends keyof Events>(type: K, listener?: Listener<Events[K]>): Promise<Events[K]> {
    return new Promise((resolve) => {
      const wrapper: Listener<Events[K]> = (event) => {
        this.off(type, wrapper);
        listener?.(event);
        resolve(event);
      };
      this.on(type, wrapper);
    });
  }

  listens(type: keyof Events): boolean {
    return (this.listeners.get(type)?.size ?? 0) > 0;
  }

  protected emit<K extends keyof Events>(type: K, event: Events[K]): void {
    const set = this.listeners.get(type);
    if (!set) return;
    for (const listener of [...set]) {
      try {
        (listener as Listener<Events[K]>)(event);
      } catch (error) {
        reportListenerError(error);
      }
    }
  }

  protected removeAllListeners(): void {
    this.listeners.clear();
  }
}

function reportListenerError(error: unknown): void {
  setTimeout(() => {
    throw error;
  }, 0);
}
