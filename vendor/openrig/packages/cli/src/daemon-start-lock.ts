import fs from "node:fs";
import path from "node:path";

export interface DaemonStartLock {
  recordChild(pid: number): void;
  release(preserve?: boolean): void;
}

/** One supported local launch owns pre-bind initialization through publication.
 * ponytail: no age-based takeover — a dead launcher can leave a live unbound child.
 * Hard-crash recovery inspects the recorded PIDs before archiving this file. */
export function acquireDaemonStartLock(home: string): DaemonStartLock {
  fs.mkdirSync(home, { recursive: true });
  const file = path.join(home, "daemon-start.lock");
  let fd: number;
  try {
    fd = fs.openSync(file, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    throw new Error(`Daemon startup is already reserved: ${file}. Inspect its launcher/child PIDs, daemon.json and daemon.log. If the launch was abandoned, prove both processes are absent before archiving the reservation and retrying; no child spawned.`);
  }
  const identity = fs.fstatSync(fd);
  const release = (preserve = false): void => {
    try {
      if (!preserve) {
        const current = fs.statSync(file);
        if (current.dev === identity.dev && current.ino === identity.ino) fs.unlinkSync(file);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    } finally {
      fs.closeSync(fd);
    }
  };
  try {
    fs.writeSync(fd, JSON.stringify({ launcherPid: process.pid, startedAt: new Date().toISOString() }) + "\n");
  } catch (error) {
    release();
    throw error;
  }
  return {
    recordChild: (pid) => { fs.writeSync(fd, JSON.stringify({ childPid: pid }) + "\n"); },
    release,
  };
}
