// 同步维护 migrations/0003_share_security.sql。
export const SHARE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS claim_receipts (
  code TEXT NOT NULL REFERENCES shares(code) ON DELETE CASCADE,
  key_hash TEXT NOT NULL,
  nonce TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (code, key_hash)
);
CREATE INDEX IF NOT EXISTS idx_claim_receipts_expiry ON claim_receipts(expires_at);
CREATE TABLE IF NOT EXISTS share_attempts (
  id TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_share_attempts_expiry ON share_attempts(expires_at);
`;
