// OPR.0.4.1.11.2 (FR-3) — CLI-medium capture, zero-dep asciicast v2.
// asciinema is not guaranteed on the host (it is absent on this one), so instead of faking a
// capture we emit the documented asciicast v2 format directly: a JSON header line then
// [time, "o", data] output-event lines (https://docs.asciinema.org/manual/asciicast/v2/). The pure
// builder is deterministic (no wall-clock unless a timestamp is passed); captureCommandCast wraps a
// non-interactive command's output into a valid cast everywhere. Real interactive `asciinema rec`
// remains available where the binary is installed — see the FR-5 convention doc for that path.
import { spawnSync } from "node:child_process";

export interface AsciicastEvent {
  /** Seconds since cast start. */
  time: number;
  /** Output chunk. */
  data: string;
}

export interface AsciicastInput {
  width: number;
  height: number;
  events: AsciicastEvent[];
  /** Optional unix timestamp; omitted from the header when absent so output stays deterministic. */
  timestamp?: number;
}

/** Build a valid asciicast v2 document (header line + output-event lines). Pure + deterministic. */
export function buildAsciicast(input: AsciicastInput): string {
  const header: Record<string, unknown> = { version: 2, width: input.width, height: input.height };
  if (input.timestamp !== undefined) header.timestamp = input.timestamp;
  const lines = [JSON.stringify(header)];
  for (const ev of input.events) lines.push(JSON.stringify([ev.time, "o", ev.data]));
  return lines.join("\n") + "\n";
}

export interface CommandCastInput {
  command: string;
  args?: string[];
  width?: number;
  height?: number;
}

/**
 * Zero-dep CLI capture: run a non-interactive command and wrap its combined output into a single
 * output event in a valid asciicast. Deterministic given deterministic command output. For an
 * interactive/timed recording, install asciinema and use `asciinema rec` (the cast format is identical).
 */
export function captureCommandCast(input: CommandCastInput): string {
  const r = spawnSync(input.command, input.args ?? [], { encoding: "utf8" });
  const data = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  return buildAsciicast({
    width: input.width ?? 80,
    height: input.height ?? 24,
    events: data ? [{ time: 0, data }] : [],
  });
}
