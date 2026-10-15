import Database from "better-sqlite3";
import { join } from "node:path";

/** Native logs identify processes; retained CLI rows identify resumable conversations. */
export function seedCodexThreads(home: string, ids: string[]): void {
  const db = new Database(join(home, ".codex", "state_5.sqlite"));
  try {
    db.exec("CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY, source TEXT, rollout_path TEXT)");
    const insert = db.prepare("INSERT OR REPLACE INTO threads VALUES (?, 'cli', ?)");
    for (const id of ids) insert.run(id, join(home, `${id}.jsonl`));
  } finally { db.close(); }
}
