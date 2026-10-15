import { wrapDetailLines, type ContentLine } from "../detail.js";
import type { Screen, ViewState } from "../types.js";
import { filterPalette } from "./palette.js";
import { COMMAND_REGISTRY } from "./registry.js";

/** Help is the command palette's readable face; execution still uses its registry. */
export function helpScreen(palette: NonNullable<ViewState["palette"]>, context: string, cols: number, rows: number): Screen {
  const matches = filterPalette(palette.query, COMMAND_REGISTRY, context);
  const selection = Math.min(palette.selection, Math.max(0, matches.length - 1));
  const selected = matches[selection];
  const content: ContentLine[] = [
    { text: `help ▸ ${palette.query}▊  · type to find a command` },
    { text: "HELP · Command bar, common tasks & CLI" },
    ...wrapDetailLines([
      { text: "At cmd ▸ type then Enter; Tab completes. <arg> required, [arg] optional." },
      { text: "CLI in your terminal: rig --help · rig <command> --help · rig tui commands" },
      { text: "Recovery diagnosis in your terminal: rig doctor · rig doctor --help" },
      { text: "Startup: ? Help · w Skip · L Local · d details. Esc returns from Help." },
      { text: "After Skip: S returns to Startup; L reads locally. Down/unverified needs no recovery to read Help." },
    ], cols),
    { text: "" },
  ];
  const detail = selected ? wrapDetailLines([
    { text: selected.available ? selected.entry.description : `Unavailable here: ${selected.reason}. ${selected.entry.description}` },
    { text: `Example: ${selected.entry.sample}${selected.entry.aliases.length ? ` · aliases: ${selected.entry.aliases.join(", ")}` : ""}` },
  ], cols) : [{ text: "No matching command. Backspace edits the search; Esc returns." }];
  // Reserve the guide, selected description, and footer before sizing the list.
  const count = Math.max(1, rows - content.length - detail.length - 3);
  const start = Math.max(0, selection - count + 1);
  for (let i = start; i < Math.min(matches.length, start + count); i++) {
    const row = matches[i]!;
    const text = `${i === selection ? "›" : " "} ${row.entry.name}${row.entry.args ? " " + row.entry.args : ""}${row.available ? "" : " · unavailable here"}`.slice(0, cols);
    content.push({ text, segs: [{ text, token: row.available ? "bright" : "dim", ...(i === selection ? { bg: "selection" as const, bold: true } : {}) }] });
  }
  content.push({ text: "" }, ...detail);
  while (content.length < rows - 2) content.push({ text: "" });
  content.push({ text: "↑↓ browse · Enter runs / fills arguments · Esc return" },
    { text: `${matches.length ? selection + 1 : 0}/${matches.length} commands · ${context} · search names or aliases` });
  const segRows: NonNullable<Screen["segRows"]> = {};
  content.forEach((line, i) => { if (line.segs) segRows[i + 1] = line.segs; });
  return { lines: content.slice(0, rows).map(l => l.text.slice(0, cols).padEnd(cols)), segRows,
    explorerWidth: 0, explorerRows: [], hitMap: [], contentTargets: [], contentMaxOffset: 0 };
}
