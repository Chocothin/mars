import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { eventBus } from '../../events/bus';
import type { AllEvents } from '../../events/types';

afterEach(() => {
  eventBus.removeAllListeners();
});

describe('EventBus', () => {
  describe('on / emit', () => {
    it('delivers event to registered handler', () => {
      const received: AllEvents[] = [];
      eventBus.on('run:created', (e) => received.push(e));

      eventBus.emit({ type: 'run:created', runId: 'r1', projectId: 'p1' });

      expect(received).toHaveLength(1);
      expect(received[0]!.type).toBe('run:created');
    });

    it('does not deliver events of a different type', () => {
      const received: AllEvents[] = [];
      eventBus.on('run:started', (e) => received.push(e));

      eventBus.emit({ type: 'run:created', runId: 'r1', projectId: 'p1' });

      expect(received).toHaveLength(0);
    });

    it('supports multiple handlers for the same event type', () => {
      let count = 0;
      eventBus.on('run:started', () => { count++; });
      eventBus.on('run:started', () => { count++; });

      eventBus.emit({ type: 'run:started', runId: 'r1' });

      expect(count).toBe(2);
    });
  });

  describe('off', () => {
    it('removes a specific handler', () => {
      let count = 0;
      const handler = () => { count++; };
      eventBus.on('run:started', handler);

      eventBus.emit({ type: 'run:started', runId: 'r1' });
      expect(count).toBe(1);

      eventBus.off('run:started', handler);
      eventBus.emit({ type: 'run:started', runId: 'r2' });
      expect(count).toBe(1);
    });

    it('is safe to call off for an unregistered handler', () => {
      const handler = () => {};
      expect(() => eventBus.off('run:started', handler)).not.toThrow();
    });
  });

  describe('on() returns unsubscribe function', () => {
    it('unsubscribes when called', () => {
      let count = 0;
      const unsub = eventBus.on('run:started', () => { count++; });

      eventBus.emit({ type: 'run:started', runId: 'r1' });
      expect(count).toBe(1);

      unsub();
      eventBus.emit({ type: 'run:started', runId: 'r2' });
      expect(count).toBe(1);
    });
  });

  describe('once', () => {
    it('fires handler only once', () => {
      let count = 0;
      eventBus.once('run:started', () => { count++; });

      eventBus.emit({ type: 'run:started', runId: 'r1' });
      eventBus.emit({ type: 'run:started', runId: 'r2' });

      expect(count).toBe(1);
    });

    it('returns an unsubscribe function that prevents the single fire', () => {
      let count = 0;
      const unsub = eventBus.once('run:started', () => { count++; });

      unsub();
      eventBus.emit({ type: 'run:started', runId: 'r1' });

      expect(count).toBe(0);
    });
  });

  describe('onAny', () => {
    it('receives events of all types', () => {
      const received: AllEvents[] = [];
      eventBus.onAny((e) => received.push(e));

      eventBus.emit({ type: 'run:created', runId: 'r1', projectId: 'p1' });
      eventBus.emit({ type: 'run:started', runId: 'r1' });
      eventBus.emit({ type: 'task:progress', taskId: 't1', chunk: 'hello' });

      expect(received).toHaveLength(3);
      expect(received.map((e) => e.type)).toEqual([
        'run:created',
        'run:started',
        'task:progress',
      ]);
    });

    it('returns an unsubscribe function', () => {
      const received: AllEvents[] = [];
      const unsub = eventBus.onAny((e) => received.push(e));

      eventBus.emit({ type: 'run:started', runId: 'r1' });
      unsub();
      eventBus.emit({ type: 'run:started', runId: 'r2' });

      expect(received).toHaveLength(1);
    });
  });

  describe('removeAllListeners', () => {
    it('removes all listeners when called without argument', () => {
      let typeCount = 0;
      let anyCount = 0;
      eventBus.on('run:started', () => { typeCount++; });
      eventBus.onAny(() => { anyCount++; });

      eventBus.removeAllListeners();

      eventBus.emit({ type: 'run:started', runId: 'r1' });
      expect(typeCount).toBe(0);
      expect(anyCount).toBe(0);
    });

    it('removes only listeners for the specified type', () => {
      let startedCount = 0;
      let createdCount = 0;
      let anyCount = 0;

      eventBus.on('run:started', () => { startedCount++; });
      eventBus.on('run:created', () => { createdCount++; });
      eventBus.onAny(() => { anyCount++; });

      eventBus.removeAllListeners('run:started');

      eventBus.emit({ type: 'run:started', runId: 'r1' });
      eventBus.emit({ type: 'run:created', runId: 'r2', projectId: 'p1' });

      expect(startedCount).toBe(0);
      expect(createdCount).toBe(1);
      expect(anyCount).toBe(2);
    });
  });

  describe('error isolation', () => {
    it('does not throw when a handler throws — other handlers still fire', () => {
      let secondCalled = false;
      eventBus.on('run:started', () => { throw new Error('boom'); });
      eventBus.on('run:started', () => { secondCalled = true; });

      expect(() =>
        eventBus.emit({ type: 'run:started', runId: 'r1' }),
      ).not.toThrow();

      expect(secondCalled).toBe(true);
    });

    it('does not throw when an onAny handler throws', () => {
      eventBus.onAny(() => { throw new Error('any boom'); });

      expect(() =>
        eventBus.emit({ type: 'run:started', runId: 'r1' }),
      ).not.toThrow();
    });
  });
});
