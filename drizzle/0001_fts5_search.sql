-- FTS5 virtual table for search_transactions (libSQL bundles FTS5).
-- Drizzle-kit cannot generate virtual tables, so this is a manual migration.
CREATE VIRTUAL TABLE IF NOT EXISTS transactions_fts
  USING fts5(description, content='transactions', content_rowid='rowid');

-- Keep FTS5 index in sync with the transactions table.
CREATE TRIGGER IF NOT EXISTS transactions_fts_insert
  AFTER INSERT ON transactions BEGIN
    INSERT INTO transactions_fts(rowid, description) VALUES (new.rowid, new.description);
  END;

CREATE TRIGGER IF NOT EXISTS transactions_fts_update
  AFTER UPDATE OF description ON transactions BEGIN
    INSERT INTO transactions_fts(transactions_fts, rowid, description)
      VALUES ('delete', old.rowid, old.description);
    INSERT INTO transactions_fts(rowid, description) VALUES (new.rowid, new.description);
  END;

CREATE TRIGGER IF NOT EXISTS transactions_fts_delete
  AFTER DELETE ON transactions BEGIN
    INSERT INTO transactions_fts(transactions_fts, rowid, description)
      VALUES ('delete', old.rowid, old.description);
  END;
