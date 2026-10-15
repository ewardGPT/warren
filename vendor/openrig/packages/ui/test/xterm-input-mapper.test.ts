import { describe, it, expect } from "vitest";
import { mapXtermInput } from "../src/components/terminal/FocusedTerminal.js";

describe("xterm input mapper", () => {
  it("printable text sends as type=text with no implicit Enter", () => {
    const result = mapXtermInput("hello");
    expect(result).toEqual([{ type: "text", text: "hello" }]);
  });

  it("Tab maps to type=keys Tab", () => {
    const result = mapXtermInput("\t");
    expect(result).toEqual([{ type: "keys", keys: ["Tab"] }]);
  });

  it("Ctrl-C maps to type=keys C-c", () => {
    const result = mapXtermInput("\x03");
    expect(result).toEqual([{ type: "keys", keys: ["C-c"] }]);
  });

  it("Enter maps to type=keys Enter", () => {
    const result = mapXtermInput("\r");
    expect(result).toEqual([{ type: "keys", keys: ["Enter"] }]);
  });

  it("Arrow Up maps to type=keys Up", () => {
    const result = mapXtermInput("\x1b[A");
    expect(result).toEqual([{ type: "keys", keys: ["Up"] }]);
  });

  it("Arrow Down maps to type=keys Down", () => {
    const result = mapXtermInput("\x1b[B");
    expect(result).toEqual([{ type: "keys", keys: ["Down"] }]);
  });

  it("mixed: text + Tab + text produces 3 messages", () => {
    const result = mapXtermInput("ec\t");
    expect(result).toEqual([
      { type: "text", text: "ec" },
      { type: "keys", keys: ["Tab"] },
    ]);
  });

  it("text + Enter produces text then keys", () => {
    const result = mapXtermInput("ls\r");
    expect(result).toEqual([
      { type: "text", text: "ls" },
      { type: "keys", keys: ["Enter"] },
    ]);
  });

  it("Backspace maps to BSpace", () => {
    const result = mapXtermInput("\x7f");
    expect(result).toEqual([{ type: "keys", keys: ["BSpace"] }]);
  });

  it("Ctrl-D maps to C-d", () => {
    const result = mapXtermInput("\x04");
    expect(result).toEqual([{ type: "keys", keys: ["C-d"] }]);
  });

  it("Delete key maps to DC", () => {
    const result = mapXtermInput("\x1b[3~");
    expect(result).toEqual([{ type: "keys", keys: ["DC"] }]);
  });

  it("never emits implicit Enter for printable text", () => {
    const result = mapXtermInput("abcdef");
    for (const msg of result) {
      if (msg.type === "keys") {
        expect(msg.keys).not.toContain("Enter");
        expect(msg.keys).not.toContain("C-m");
      }
    }
  });
});
