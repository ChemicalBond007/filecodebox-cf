CREATE TABLE IF NOT EXISTS maintenance_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  next_run INTEGER NOT NULL
);
