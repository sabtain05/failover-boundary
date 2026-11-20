import type { BoundaryEvent, BoundaryEventListener } from './types.js';

export class BoundaryEmitter<T> {
  private readonly listeners = new Set<BoundaryEventListener<T>>();

  public subscribe(listener: BoundaryEventListener<T>): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  public emit(event: BoundaryEvent<T>): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        continue;
      }
    }
  }

  public clear(): void {
    this.listeners.clear();
  }
}
