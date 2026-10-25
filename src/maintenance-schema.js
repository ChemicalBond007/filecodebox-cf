// 同步维护 migrations/0004_access_cleanup.sql。
export const MAINTENANCE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS maintenance_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  next_run INTEGER NOT NULL
);
`;
