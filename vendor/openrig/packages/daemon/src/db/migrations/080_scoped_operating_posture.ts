import type { Migration } from "../migrate.js";

/** Extend the existing binding store, preserving every legacy row and its identity. */
export const scopedOperatingPostureSchema: Migration = {
  name: "080_scoped_operating_posture.sql",
  sql: `
    CREATE TABLE operator_context_mode_bindings_next (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL CHECK (scope IN ('global_host', 'rig', 'project', 'mission', 'workstream', 'qitem')),
      qualifier TEXT,
      mode TEXT NOT NULL CHECK (mode IN ('sleep', 'desk', 'mobile', 'away', 'focus', 'debug', 'human-led', 'delegated')),
      record_json TEXT NOT NULL,
      set_at TEXT NOT NULL,
      set_by TEXT NOT NULL CHECK (set_by = 'operator')
    );
    INSERT INTO operator_context_mode_bindings_next SELECT * FROM operator_context_mode_bindings;
    DROP TABLE operator_context_mode_bindings;
    ALTER TABLE operator_context_mode_bindings_next RENAME TO operator_context_mode_bindings;
    CREATE UNIQUE INDEX idx_operator_context_mode_bindings_scope_qualifier
      ON operator_context_mode_bindings(scope, qualifier);
  `,
};
