CREATE TABLE IF NOT EXISTS nodes (
  id            TEXT PRIMARY KEY,
  parent_id     TEXT,
  type          TEXT NOT NULL CHECK (type IN ('folder', 'file')),
  name          TEXT NOT NULL,
  kind          TEXT,
  mime          TEXT,
  size          INTEGER,
  tg_chat_id    TEXT,
  tg_message_id INTEGER,
  file_id       TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  deleted_at    INTEGER
);

CREATE INDEX IF NOT EXISTS idx_nodes_parent ON nodes(parent_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_nodes_msg ON nodes(tg_chat_id, tg_message_id) WHERE tg_message_id IS NOT NULL;
