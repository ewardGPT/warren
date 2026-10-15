// OPR.0.4.1.11.1 (FR-3 + For-You) — EventSource stub. The static twin does not hold a live
// SSE connection, but the For-You feed + topology activity are SSE-DRIVEN (useActivityFeed /
// useGlobalEvents subscribe to /api/events), not cache-seed. So this stub: (a) for any other
// stream, is an inert no-op; (b) for /api/events, EMITS a fixed set of seeded activity events
// once, so the feed renders cards 1:1. Installed before any SSE-touching module imports.

import { feedEvents } from "./fixtures.js";

type MsgListener = (ev: { data: string }) => void;

class TwinEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSED = 2;
  readyState = 0;
  url = "";
  withCredentials = false;
  onopen: ((ev: unknown) => unknown) | null = null;
  onmessage: ((ev: unknown) => unknown) | null = null;
  onerror: ((ev: unknown) => unknown) | null = null;

  private listeners = new Map<string, Set<MsgListener>>();
  private closed = false;

  constructor(url: string | URL) {
    this.url = String(url);
    // Async (setTimeout 0) so the subscriber's addEventListener calls — which run
    // synchronously right after `new EventSource(...)` — are registered before we emit.
    if (this.url.includes("/api/events")) {
      setTimeout(() => this.emitSeeded(), 0);
    }
  }

  addEventListener(type: string, fn: MsgListener): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(fn);
  }

  removeEventListener(type: string, fn: MsgListener): void {
    this.listeners.get(type)?.delete(fn);
  }

  dispatchEvent(): boolean {
    return false;
  }

  close(): void {
    this.closed = true;
  }

  private fire(type: string, ev: { data?: string }): void {
    if (this.closed) return;
    for (const fn of this.listeners.get(type) ?? []) fn(ev as { data: string });
    if (type === "open" && this.onopen) this.onopen(ev);
    if (type === "message" && this.onmessage) this.onmessage(ev);
  }

  private emitSeeded(): void {
    this.readyState = 1;
    this.fire("open", {});
    for (const evt of feedEvents) {
      this.fire("message", { data: JSON.stringify(evt) });
    }
  }
}

(globalThis as unknown as { EventSource: unknown }).EventSource = TwinEventSource;

export {};
