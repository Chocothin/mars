import type { AllEvents, AllEventType, ExtractEvent } from './types';

type EventHandler<T extends AllEventType = AllEventType> = (event: ExtractEvent<T>) => void;

interface IEventBus {
  emit<T extends AllEventType>(event: ExtractEvent<T>): void;
  on<T extends AllEventType>(type: T, handler: EventHandler<T>): () => void;
  once<T extends AllEventType>(type: T, handler: EventHandler<T>): () => void;
  off<T extends AllEventType>(type: T, handler: EventHandler<T>): void;
  onAny(handler: (event: AllEvents) => void): () => void;
  removeAllListeners(type?: AllEventType): void;
}

class EventBus implements IEventBus {
  private listeners = new Map<AllEventType, Set<EventHandler<AllEventType>>>();
  private anyListeners = new Set<(event: AllEvents) => void>();

  emit<T extends AllEventType>(event: ExtractEvent<T>): void {
    const handlers = this.listeners.get(event.type);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(event as AllEvents);
        } catch (err) {
          console.error(`[EventBus] handler error for "${event.type}":`, err);
        }
      }
    }

    for (const handler of this.anyListeners) {
      try {
        handler(event as AllEvents);
      } catch (err) {
        console.error(`[EventBus] wildcard handler error for "${event.type}":`, err);
      }
    }
  }

  on<T extends AllEventType>(type: T, handler: EventHandler<T>): () => void {
    let handlers = this.listeners.get(type);
    if (!handlers) {
      handlers = new Set();
      this.listeners.set(type, handlers);
    }
    handlers.add(handler as unknown as EventHandler<AllEventType>);

    return () => this.off(type, handler);
  }

  once<T extends AllEventType>(type: T, handler: EventHandler<T>): () => void {
    const wrapper = ((event: ExtractEvent<T>) => {
      this.off(type, wrapper as EventHandler<T>);
      handler(event);
    }) as EventHandler<T>;

    return this.on(type, wrapper);
  }

  off<T extends AllEventType>(type: T, handler: EventHandler<T>): void {
    const handlers = this.listeners.get(type);
    if (!handlers) return;

    handlers.delete(handler as unknown as EventHandler<AllEventType>);
    if (handlers.size === 0) {
      this.listeners.delete(type);
    }
  }

  onAny(handler: (event: AllEvents) => void): () => void {
    this.anyListeners.add(handler);
    return () => this.anyListeners.delete(handler);
  }

  removeAllListeners(type?: AllEventType): void {
    if (type) {
      this.listeners.delete(type);
    } else {
      this.listeners.clear();
      this.anyListeners.clear();
    }
  }
}

export const eventBus = new EventBus();
export type { IEventBus };
