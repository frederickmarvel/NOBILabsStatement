import Database from "better-sqlite3";

export const DEFAULT_DB_PATH = "data/nobi-ledger.sqlite";

export function openDb(dbPath = process.env.NOBI_LEDGER_DB || DEFAULT_DB_PATH) {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
}

export function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS wallets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      label TEXT NOT NULL,
      address TEXT NOT NULL COLLATE NOCASE,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(address)
    );

    CREATE TABLE IF NOT EXISTS chains (
      chain_name TEXT PRIMARY KEY,
      chain_id INTEGER,
      label TEXT,
      category_label TEXT,
      is_testnet INTEGER NOT NULL DEFAULT 0,
      first_seen_at TEXT,
      last_seen_at TEXT,
      raw_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS wallet_chains (
      wallet_id INTEGER NOT NULL,
      chain_name TEXT NOT NULL,
      first_seen_at TEXT,
      last_seen_at TEXT,
      PRIMARY KEY (wallet_id, chain_name),
      FOREIGN KEY (wallet_id) REFERENCES wallets(id) ON DELETE CASCADE,
      FOREIGN KEY (chain_name) REFERENCES chains(chain_name) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wallet_id INTEGER NOT NULL,
      chain_name TEXT NOT NULL,
      tx_hash TEXT NOT NULL,
      block_signed_at TEXT NOT NULL,
      block_height INTEGER,
      block_hash TEXT,
      tx_offset INTEGER,
      successful INTEGER,
      from_address TEXT COLLATE NOCASE,
      to_address TEXT COLLATE NOCASE,
      native_value_raw TEXT,
      native_value_quote REAL,
      fees_paid_raw TEXT,
      gas_quote REAL,
      gas_quote_rate REAL,
      raw_json TEXT NOT NULL,
      synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(wallet_id, chain_name, tx_hash),
      FOREIGN KEY (wallet_id) REFERENCES wallets(id) ON DELETE CASCADE,
      FOREIGN KEY (chain_name) REFERENCES chains(chain_name) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_transactions_statement
      ON transactions(wallet_id, chain_name, block_signed_at);

    CREATE TABLE IF NOT EXISTS token_transfers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      transaction_id INTEGER NOT NULL,
      wallet_id INTEGER NOT NULL,
      chain_name TEXT NOT NULL,
      tx_hash TEXT NOT NULL,
      log_key TEXT NOT NULL,
      block_signed_at TEXT NOT NULL,
      from_address TEXT COLLATE NOCASE,
      to_address TEXT COLLATE NOCASE,
      contract_address TEXT COLLATE NOCASE,
      contract_name TEXT,
      contract_ticker_symbol TEXT,
      contract_decimals INTEGER,
      transfer_type TEXT,
      delta_raw TEXT,
      balance_raw TEXT,
      quote_rate REAL,
      delta_quote REAL,
      balance_quote REAL,
      raw_json TEXT NOT NULL,
      UNIQUE(wallet_id, chain_name, tx_hash, log_key),
      FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE CASCADE,
      FOREIGN KEY (wallet_id) REFERENCES wallets(id) ON DELETE CASCADE,
      FOREIGN KEY (chain_name) REFERENCES chains(chain_name) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_token_transfers_statement
      ON token_transfers(wallet_id, chain_name, block_signed_at, contract_address);

    CREATE TABLE IF NOT EXISTS balance_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wallet_id INTEGER NOT NULL,
      chain_name TEXT NOT NULL,
      snapshot_type TEXT NOT NULL CHECK(snapshot_type IN ('opening', 'closing', 'custom')),
      as_of_date TEXT NOT NULL,
      quote_currency TEXT NOT NULL DEFAULT 'USD',
      total_quote REAL NOT NULL DEFAULT 0,
      source_updated_at TEXT,
      raw_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(wallet_id, chain_name, snapshot_type, as_of_date, quote_currency),
      FOREIGN KEY (wallet_id) REFERENCES wallets(id) ON DELETE CASCADE,
      FOREIGN KEY (chain_name) REFERENCES chains(chain_name) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS balance_snapshot_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      snapshot_id INTEGER NOT NULL,
      contract_address TEXT COLLATE NOCASE,
      contract_name TEXT,
      contract_ticker_symbol TEXT,
      contract_decimals INTEGER,
      is_native_token INTEGER,
      token_type TEXT,
      is_spam INTEGER,
      balance_raw TEXT,
      quote_rate REAL,
      quote REAL,
      pretty_quote TEXT,
      raw_json TEXT NOT NULL,
      FOREIGN KEY (snapshot_id) REFERENCES balance_snapshots(id) ON DELETE CASCADE
    );
  `);
}

export function upsertWallet(db, { label, address }) {
  db.prepare(`
    INSERT INTO wallets (label, address)
    VALUES (@label, @address)
    ON CONFLICT(address) DO UPDATE SET label = excluded.label
  `).run({ label, address });

  return db.prepare("SELECT * FROM wallets WHERE address = ? COLLATE NOCASE").get(address);
}

export function upsertChain(db, chainName, activityItem = {}) {
  const ext = activityItem.extends || activityItem || {};
  db.prepare(`
    INSERT INTO chains (chain_name, chain_id, label, category_label, is_testnet, first_seen_at, last_seen_at, raw_json)
    VALUES (@chain_name, @chain_id, @label, @category_label, @is_testnet, @first_seen_at, @last_seen_at, @raw_json)
    ON CONFLICT(chain_name) DO UPDATE SET
      chain_id = excluded.chain_id,
      label = excluded.label,
      category_label = excluded.category_label,
      is_testnet = excluded.is_testnet,
      first_seen_at = COALESCE(excluded.first_seen_at, chains.first_seen_at),
      last_seen_at = COALESCE(excluded.last_seen_at, chains.last_seen_at),
      raw_json = excluded.raw_json
  `).run({
    chain_name: chainName,
    chain_id: Number(ext.chain_id) || null,
    label: ext.label || ext.name || chainName,
    category_label: ext.category_label || null,
    is_testnet: ext.is_testnet ? 1 : 0,
    first_seen_at: activityItem.first_seen_at || null,
    last_seen_at: activityItem.last_seen_at || null,
    raw_json: JSON.stringify(activityItem),
  });
}
