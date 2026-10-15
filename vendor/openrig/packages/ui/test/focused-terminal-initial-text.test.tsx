// @vitest-environment jsdom

// OPR.0.4.4.20 delta-C — FocusedTerminal initialText: EXACTLY ONE text frame
// on first connect, NO Enter/keys frame, never re-sent on reconnect (BR-12:
// the terminal is the chat surface; the only new wiring is this prop).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, act } from "@testing-library/react";
import React from "react";

const instances: MockWS[] = [];

class MockWS {
  url: string;
  readyState = 1;
  onopen: ((evt?: unknown) => void) | null = null;
  onclose: ((evt: { code: number; reason: string }) => void) | null = null;
  onmessage: ((evt: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];

  constructor(url: string) {
    this.url = url;
    instances.push(this);
    setTimeout(() => this.onopen?.(), 0);
  }
  send(data: string) { this.sent.push(data); }
  close() { this.readyState = 3; }
  static OPEN = 1;
}

vi.stubGlobal("WebSocket", MockWS);

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    child: HTMLElement | null = null;
    open(el: HTMLElement) {
      this.child = document.createElement("div");
      el.appendChild(this.child);
    }
    write(_data: string) {}
    onData(_cb: (data: string) => void) {}
    onResize(_cb: (size: { cols: number; rows: number }) => void) {}
    focus() {}
    scrollToBottom() {}
    attachCustomWheelEventHandler(_h: (ev: WheelEvent) => boolean) {}
    dispose() { this.child?.remove(); this.child = null; }
    loadAddon() {}
    cols = 90;
    rows = 27;
  },
}));

import { FocusedTerminal } from "../src/components/terminal/FocusedTerminal.js";

const PREAMBLE =
  "[review:slice-x qitem-abc] Standing contract: record the outcome on the qitem. user message begins here: ";

function textFrames(ws: MockWS): Array<{ type: string; text?: string }> {
  return ws.sent.map((s) => JSON.parse(s) as { type: string; text?: string }).filter((f) => f.type === "text");
}
function keysFrames(ws: MockWS): Array<{ type: string }> {
  return ws.sent.map((s) => JSON.parse(s) as { type: string }).filter((f) => f.type === "keys");
}

describe("FocusedTerminal initialText (delta-C)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    instances.length = 0;
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("sends exactly ONE text frame on connect, ending with the begins-here suffix, and NO keys frame", async () => {
    render(<FocusedTerminal sessionName="dev-a@rig" initialText={PREAMBLE} />);
    await act(async () => { await vi.runOnlyPendingTimersAsync(); });
    expect(instances).toHaveLength(1);
    const frames = textFrames(instances[0]!);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.text).toBe(PREAMBLE);
    expect(frames[0]!.text!.endsWith("user message begins here: ")).toBe(true);
    expect(keysFrames(instances[0]!)).toHaveLength(0); // no Enter, ever
  });

  it("does NOT re-send the preamble on reconnect", async () => {
    render(<FocusedTerminal sessionName="dev-a@rig" initialText={PREAMBLE} />);
    await act(async () => { await vi.runOnlyPendingTimersAsync(); });
    const first = instances[0]!;
    expect(textFrames(first)).toHaveLength(1);
    // Drop the socket; the component schedules a reconnect.
    await act(async () => {
      first.onclose?.({ code: 1006, reason: "drop" });
      await vi.advanceTimersByTimeAsync(5000);
    });
    const total = instances.reduce((n, ws) => n + textFrames(ws).length, 0);
    expect(total).toBe(1); // once per mount, never per connection
  });

  it("sends no text frame at all without initialText", async () => {
    render(<FocusedTerminal sessionName="dev-a@rig" />);
    await act(async () => { await vi.runOnlyPendingTimersAsync(); });
    expect(textFrames(instances[0]!)).toHaveLength(0);
    expect(keysFrames(instances[0]!)).toHaveLength(0);
  });
});
