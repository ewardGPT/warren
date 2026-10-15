import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigStore } from "./config-store.js";
import { getOpenRigHome } from "./openrig-compat.js";
import { validateHostRegistry } from "./host-registry.js";

/** Read the boot-minted identity without requiring the local daemon or minting a replacement. */
export function readLocalOrigin(): string | undefined {
  let db: Database.Database | undefined;
  try {
    const configured = new ConfigStore().resolveWithSource("db.path");
    let dbPath = configured.value as string;
    // An explicit configured DB wins. Otherwise retain the last launch's --db selection.
    if (configured.source === "default") {
      try {
        const state = JSON.parse(readFileSync(join(getOpenRigHome(), "daemon.json"), "utf8"));
        if (typeof state.db === "string" && state.db.length > 0) dbPath = state.db;
      } catch { /* No launch record: use the configured default, never search other homes. */ }
    }
    db = new Database(dbPath, { readonly: true, fileMustExist: true, timeout: 100 });
    const row = db.prepare("SELECT host_id FROM self_host_identity WHERE singleton = 1").get() as { host_id?: unknown } | undefined;
    const id = row?.host_id;
    if (typeof id !== "string" || id === "localhost") return undefined;
    const valid = validateHostRegistry({ hosts: [{ id, transport: "ssh", target: "identity-validation" }] }, "<local-origin>");
    return valid.ok ? id : undefined;
  } catch {
    return undefined;
  } finally {
    db?.close();
  }
}
