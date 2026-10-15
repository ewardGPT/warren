import { describe, it, expect } from "vitest";
import { daemonStartArgs } from "../src/crash-cart/start-daemon.js";
import { resolveCrashCartKey } from "../src/crash-cart/keys.js";

describe("local startup target", () => {
  it("starts only the intended local daemon, leaving occupant selection to the user", () => {
    expect(daemonStartArgs("http://127.0.0.1:17433")).toEqual([
      "daemon", "start", "--no-kernel", "--host", "127.0.0.1", "--port", "17433",
    ]);
  });
  it.each(["https://example.test", "http://10.0.0.2:7433", "http://user:password@localhost:7433", "http://localhost:7433/other"])(
    "does not turn %s into local startup authority", (target) => {
      expect(() => daemonStartArgs(target)).toThrow("no local daemon was started");
    },
  );
  it("unavailable prerequisites permit inspection/retry but no recovery effects", () => {
    const opts = { unavailable: "native load failed" };
    expect(resolveCrashCartKey("r", opts)).toBe("retry");
    expect(resolveCrashCartKey("d", opts)).toBe("details");
    for (const key of ["s", "n", "enter", "i"]) expect(resolveCrashCartKey(key, opts)).toBeNull();
  });
});
