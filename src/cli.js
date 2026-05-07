#!/usr/bin/env node
import { createWriteStream, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import PDFDocument from "pdfkit";
import { DEFAULT_DB_PATH, migrate, openDb, upsertChain, upsertWallet } from "./db.js";
import {
  getAddressActivity,
  getHistoricalBalances,
  getHistoricalTokenPrices,
  getTransactionPage,
  normalizeChainName,
} from "./goldrush.js";

const DEFAULT_ADDRESS = "0xE8c24Ce4c8D3FF7AB82Efd7A74752E7393ff57CB";
const DEFAULT_LABEL = "NOBI LABS LEDGER [MF USDT]";
const AED_PER_USD = 3.67;
const NATIVE_TOKEN_ADDRESS = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      args._.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

function ensureDb() {
  mkdirSync(dirname(process.env.NOBI_LEDGER_DB || DEFAULT_DB_PATH), { recursive: true });
  const db = openDb();
  migrate(db);
  return db;
}

function splitChains(value) {
  return String(value || "")
    .split(",")
    .map((chain) => chain.trim())
    .filter(Boolean);
}

function requireChain(args) {
  const chains = splitChains(args.chain || args.chains);
  if (!chains.length) {
    throw new Error("Pass --chain <chainName> or --chains <chainA,chainB>.");
  }
  return chains;
}

async function discover(args) {
  const db = ensureDb();
  const wallet = upsertWallet(db, {
    label: args.label || DEFAULT_LABEL,
    address: args.address || DEFAULT_ADDRESS,
  });

  const data = await getAddressActivity(wallet.address, { testnets: Boolean(args.testnets) });
  const insertWalletChain = db.prepare(`
    INSERT INTO wallet_chains (wallet_id, chain_name, first_seen_at, last_seen_at)
    VALUES (@wallet_id, @chain_name, @first_seen_at, @last_seen_at)
    ON CONFLICT(wallet_id, chain_name) DO UPDATE SET
      first_seen_at = excluded.first_seen_at,
      last_seen_at = excluded.last_seen_at
  `);

  const chains = [];
  for (const item of data.items || []) {
    const chainName = normalizeChainName(item);
    if (!chainName) continue;
    upsertChain(db, chainName, item);
    insertWalletChain.run({
      wallet_id: wallet.id,
      chain_name: chainName,
      first_seen_at: item.first_seen_at || null,
      last_seen_at: item.last_seen_at || null,
    });
    chains.push(chainName);
  }

  console.log(`Stored ${chains.length} active chain(s) for ${wallet.label}: ${chains.join(", ") || "none"}`);
}

function saveBalanceSnapshot(db, wallet, chainName, snapshotType, date, data) {
  upsertChain(db, chainName, { name: chainName });

  const totalQuote = (data.items || []).reduce((sum, item) => sum + (Number(item.quote) || 0), 0);
  const insertSnapshot = db.prepare(`
    INSERT INTO balance_snapshots (
      wallet_id, chain_name, snapshot_type, as_of_date, quote_currency, total_quote, source_updated_at, raw_json
    )
    VALUES (@wallet_id, @chain_name, @snapshot_type, @as_of_date, @quote_currency, @total_quote, @source_updated_at, @raw_json)
    ON CONFLICT(wallet_id, chain_name, snapshot_type, as_of_date, quote_currency) DO UPDATE SET
      total_quote = excluded.total_quote,
      source_updated_at = excluded.source_updated_at,
      raw_json = excluded.raw_json,
      created_at = CURRENT_TIMESTAMP
  `);
  insertSnapshot.run({
    wallet_id: wallet.id,
    chain_name: chainName,
    snapshot_type: snapshotType,
    as_of_date: date,
    quote_currency: data.quote_currency || "USD",
    total_quote: totalQuote,
    source_updated_at: data.updated_at || null,
    raw_json: JSON.stringify(data),
  });

  const snapshot = db.prepare(`
    SELECT id FROM balance_snapshots
    WHERE wallet_id = ? AND chain_name = ? AND snapshot_type = ? AND as_of_date = ? AND quote_currency = ?
  `).get(wallet.id, chainName, snapshotType, date, data.quote_currency || "USD");

  db.prepare("DELETE FROM balance_snapshot_items WHERE snapshot_id = ?").run(snapshot.id);
  const insertItem = db.prepare(`
    INSERT INTO balance_snapshot_items (
      snapshot_id, contract_address, contract_name, contract_ticker_symbol, contract_decimals,
      is_native_token, token_type, is_spam, balance_raw, quote_rate, quote, pretty_quote, raw_json
    )
    VALUES (
      @snapshot_id, @contract_address, @contract_name, @contract_ticker_symbol, @contract_decimals,
      @is_native_token, @token_type, @is_spam, @balance_raw, @quote_rate, @quote, @pretty_quote, @raw_json
    )
  `);

  for (const item of data.items || []) {
    insertItem.run({
      snapshot_id: snapshot.id,
      contract_address: item.contract_address || null,
      contract_name: item.contract_name || item.contract_display_name || null,
      contract_ticker_symbol: item.contract_ticker_symbol || null,
      contract_decimals: item.contract_decimals ?? null,
      is_native_token: item.is_native_token ? 1 : 0,
      token_type: item.type || null,
      is_spam: item.is_spam ? 1 : 0,
      balance_raw: item.balance || "0",
      quote_rate: item.quote_rate ?? null,
      quote: item.quote ?? null,
      pretty_quote: item.pretty_quote || null,
      raw_json: JSON.stringify(item),
    });
  }

  return { itemCount: data.items?.length || 0, totalQuote };
}

async function balanceCommand(args, snapshotType) {
  const db = ensureDb();
  const date = args.date || (snapshotType === "opening" ? "2025-04-01" : null);
  if (!date) throw new Error("Pass --date YYYY-MM-DD.");

  const wallet = upsertWallet(db, {
    label: args.label || DEFAULT_LABEL,
    address: args.address || DEFAULT_ADDRESS,
  });

  for (const chainName of requireChain(args)) {
    try {
      const data = await getHistoricalBalances(chainName, wallet.address, date, {
        quoteCurrency: args.currency || "USD",
        noSpam: args["no-spam"] !== "false",
      });
      const saved = saveBalanceSnapshot(db, wallet, chainName, snapshotType, date, data);
      console.log(`${snapshotType} ${date} ${chainName}: ${saved.itemCount} token(s), total ${data.quote_currency || "USD"} ${saved.totalQuote.toFixed(2)}`);
    } catch (error) {
      console.log(`${snapshotType} ${date} ${chainName}: skipped (${error.message})`);
    }
  }
}

function transferDirection(walletAddress, transfer) {
  const address = walletAddress.toLowerCase();
  if ((transfer.to_address || "").toLowerCase() === address) return "in";
  if ((transfer.from_address || "").toLowerCase() === address) return "out";
  return "other";
}

function transferLogKey(transfer, index) {
  return [
    transfer.contract_address || "native",
    transfer.from_address || "",
    transfer.to_address || "",
    transfer.delta || "",
    index,
  ].join(":");
}

function saveTransaction(db, wallet, chainName, tx) {
  upsertChain(db, chainName, { name: chainName });
  db.prepare(`
    INSERT INTO transactions (
      wallet_id, chain_name, tx_hash, block_signed_at, block_height, block_hash, tx_offset,
      successful, from_address, to_address, native_value_raw, native_value_quote,
      fees_paid_raw, gas_quote, gas_quote_rate, raw_json
    )
    VALUES (
      @wallet_id, @chain_name, @tx_hash, @block_signed_at, @block_height, @block_hash, @tx_offset,
      @successful, @from_address, @to_address, @native_value_raw, @native_value_quote,
      @fees_paid_raw, @gas_quote, @gas_quote_rate, @raw_json
    )
    ON CONFLICT(wallet_id, chain_name, tx_hash) DO UPDATE SET
      block_signed_at = excluded.block_signed_at,
      block_height = excluded.block_height,
      raw_json = excluded.raw_json,
      synced_at = CURRENT_TIMESTAMP
  `).run({
    wallet_id: wallet.id,
    chain_name: chainName,
    tx_hash: tx.tx_hash,
    block_signed_at: tx.block_signed_at,
    block_height: tx.block_height ?? null,
    block_hash: tx.block_hash || null,
    tx_offset: tx.tx_offset ?? null,
    successful: tx.successful ? 1 : 0,
    from_address: tx.from_address || null,
    to_address: tx.to_address || null,
    native_value_raw: tx.value || "0",
    native_value_quote: tx.value_quote ?? null,
    fees_paid_raw: tx.fees_paid || "0",
    gas_quote: tx.gas_quote ?? null,
    gas_quote_rate: tx.gas_quote_rate ?? null,
    raw_json: JSON.stringify(tx),
  });

  const row = db.prepare(`
    SELECT id FROM transactions WHERE wallet_id = ? AND chain_name = ? AND tx_hash = ?
  `).get(wallet.id, chainName, tx.tx_hash);

  const insertTransfer = db.prepare(`
    INSERT INTO token_transfers (
      transaction_id, wallet_id, chain_name, tx_hash, log_key, block_signed_at,
      from_address, to_address, contract_address, contract_name, contract_ticker_symbol,
      contract_decimals, transfer_type, delta_raw, balance_raw, quote_rate, delta_quote,
      balance_quote, raw_json
    )
    VALUES (
      @transaction_id, @wallet_id, @chain_name, @tx_hash, @log_key, @block_signed_at,
      @from_address, @to_address, @contract_address, @contract_name, @contract_ticker_symbol,
      @contract_decimals, @transfer_type, @delta_raw, @balance_raw, @quote_rate, @delta_quote,
      @balance_quote, @raw_json
    )
    ON CONFLICT(wallet_id, chain_name, tx_hash, log_key) DO UPDATE SET
      balance_raw = excluded.balance_raw,
      balance_quote = excluded.balance_quote,
      raw_json = excluded.raw_json
  `);

  let index = 0;
  for (const event of tx.log_events || []) {
    if (event.decoded?.name !== "Transfer") continue;
    const params = Object.fromEntries((event.decoded.params || []).map((param) => [param.name, param.value]));
    const transfer = {
      block_signed_at: event.block_signed_at || tx.block_signed_at,
      tx_hash: tx.tx_hash,
      from_address: params.from,
      to_address: params.to,
      contract_decimals: event.sender_contract_decimals,
      contract_name: event.sender_name,
      contract_ticker_symbol: event.sender_contract_ticker_symbol,
      contract_address: event.sender_address,
      transfer_type: transferDirection(wallet.address, { from_address: params.from, to_address: params.to }),
      delta: params.value,
    };
    insertTransfer.run({
      transaction_id: row.id,
      wallet_id: wallet.id,
      chain_name: chainName,
      tx_hash: tx.tx_hash,
      log_key: transferLogKey(transfer, index),
      block_signed_at: transfer.block_signed_at,
      from_address: transfer.from_address || null,
      to_address: transfer.to_address || null,
      contract_address: transfer.contract_address || null,
      contract_name: transfer.contract_name || null,
      contract_ticker_symbol: transfer.contract_ticker_symbol || null,
      contract_decimals: transfer.contract_decimals ?? null,
      transfer_type: transfer.transfer_type,
      delta_raw: transfer.delta || "0",
      balance_raw: null,
      quote_rate: null,
      delta_quote: null,
      balance_quote: null,
      raw_json: JSON.stringify(transfer),
    });
    index += 1;
  }
}

async function ingest(args) {
  const db = ensureDb();
  const wallet = upsertWallet(db, {
    label: args.label || DEFAULT_LABEL,
    address: args.address || DEFAULT_ADDRESS,
  });
  const from = args.from ? new Date(`${args.from}T00:00:00.000Z`) : null;
  const to = args.to ? new Date(`${args.to}T23:59:59.999Z`) : null;
  const maxPages = Number(args["max-pages"] || 20);

  for (const chainName of requireChain(args)) {
    let saved = 0;
    for (let page = Number(args.page || 0); page < maxPages; page += 1) {
      const data = await getTransactionPage(chainName, wallet.address, page, {
        quoteCurrency: args.currency || "USD",
        noLogs: args["no-logs"] === "true",
        asc: args.asc !== "false",
      });
      const items = data.items || [];
      if (!items.length) break;

      for (const tx of items) {
        const txDate = new Date(tx.block_signed_at);
        if (from && txDate < from) continue;
        if (to && txDate > to) continue;
        saveTransaction(db, wallet, chainName, tx);
        saved += 1;
      }

      if (!data.links?.next || items.length < 100) break;
    }
    console.log(`ingested ${saved} transaction(s) for ${chainName}`);
  }
}

function statement(args) {
  const db = ensureDb();
  const address = args.address || DEFAULT_ADDRESS;
  const wallet = db.prepare("SELECT * FROM wallets WHERE address = ? COLLATE NOCASE").get(address);
  if (!wallet) throw new Error(`Wallet not found in database: ${address}`);
  const chains = requireChain(args);
  const start = `${args.start || args.from}T00:00:00.000Z`;
  const end = `${args.end || args.to}T23:59:59.999Z`;

  for (const chainName of chains) {
    const rows = db.prepare(`
      SELECT
        COALESCE(contract_ticker_symbol, contract_address, 'UNKNOWN') AS asset,
        transfer_type,
        COUNT(*) AS transfer_count,
        SUM(COALESCE(delta_quote, 0)) AS delta_quote
      FROM token_transfers
      WHERE wallet_id = ? AND chain_name = ? AND block_signed_at BETWEEN ? AND ?
      GROUP BY asset, transfer_type
      ORDER BY asset, transfer_type
    `).all(wallet.id, chainName, start, end);

    const txCount = db.prepare(`
      SELECT COUNT(*) AS count, SUM(COALESCE(gas_quote, 0)) AS gas_quote
      FROM transactions
      WHERE wallet_id = ? AND chain_name = ? AND block_signed_at BETWEEN ? AND ?
    `).get(wallet.id, chainName, start, end);

    const opening = db.prepare(`
      SELECT total_quote FROM balance_snapshots
      WHERE wallet_id = ? AND chain_name = ? AND snapshot_type = 'opening' AND as_of_date = ?
    `).get(wallet.id, chainName, args.start || args.from);

    const closing = db.prepare(`
      SELECT total_quote FROM balance_snapshots
      WHERE wallet_id = ? AND chain_name = ? AND snapshot_type = 'closing' AND as_of_date = ?
    `).get(wallet.id, chainName, args.end || args.to);

    console.log(`\nMonthly statement ${chainName} ${args.start || args.from} to ${args.end || args.to}`);
    console.log(`Opening quote: ${opening ? opening.total_quote.toFixed(2) : "not stored"}`);
    console.log(`Closing quote: ${closing ? closing.total_quote.toFixed(2) : "not stored"}`);
    console.log(`Transactions: ${txCount.count}, gas quote: ${(txCount.gas_quote || 0).toFixed(2)}`);
    console.table(rows);
  }
}

function formatUnits(raw, decimals = 0) {
  const negative = String(raw).startsWith("-");
  const digits = String(raw).replace("-", "").padStart(Number(decimals) + 1, "0");
  const whole = digits.slice(0, -Number(decimals)) || "0";
  const fraction = digits.slice(-Number(decimals)).replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

function safeBigInt(val) {
  if (!val || val === "0") return 0n;
  try { return BigInt(String(val).split('.')[0]); } catch { return 0n; }
}

function nativeSymbol(chainName) {
  if (chainName === "solana-mainnet") return "SOL";
  return "ETH";
}

function balanceRowsAt(db, wallet, chainName, cutoffDate) {
  const cutoff = `${cutoffDate}T23:59:59.999Z`;
  const rows = db.prepare(`
    SELECT
      COALESCE(contract_address, 'native') AS contract_address,
      COALESCE(contract_ticker_symbol, 'UNKNOWN') AS symbol,
      COALESCE(contract_name, contract_ticker_symbol, contract_address, 'Unknown Token') AS name,
      COALESCE(contract_decimals, 0) AS decimals,
      transfer_type,
      delta_raw
    FROM token_transfers
    WHERE wallet_id = ?
      AND chain_name = ?
      AND block_signed_at <= ?
      AND transfer_type IN ('in', 'out')
    ORDER BY block_signed_at
  `).all(wallet.id, chainName, cutoff);

  const balances = new Map();

  const native = db.prepare(`
    SELECT from_address, to_address, native_value_raw, fees_paid_raw
    FROM transactions
    WHERE wallet_id = ? AND chain_name = ? AND block_signed_at <= ?
  `).all(wallet.id, chainName, cutoff).reduce((sum, tx) => {
    const walletAddress = wallet.address.toLowerCase();
    let next = sum;
    if ((tx.to_address || "").toLowerCase() === walletAddress) {
      next += safeBigInt(tx.native_value_raw);
    }
    if ((tx.from_address || "").toLowerCase() === walletAddress) {
      next -= safeBigInt(tx.native_value_raw);
      next -= safeBigInt(tx.fees_paid_raw);
    }
    return next;
  }, 0n);

  const natSym = nativeSymbol(chainName);
  if (native > 0n) {
    balances.set(`${NATIVE_TOKEN_ADDRESS}:${natSym}:18:${natSym}`, {
      contract_address: NATIVE_TOKEN_ADDRESS,
      symbol: natSym,
      name: natSym,
      decimals: 18,
      raw: native,
    });
  }

  for (const row of rows) {
    const key = `${row.contract_address}:${row.symbol}:${row.decimals}:${row.name}`;
    const current = balances.get(key) || {
      contract_address: row.contract_address,
      symbol: row.symbol,
      name: row.name,
      decimals: row.decimals,
      raw: 0n,
    };
    const amount = safeBigInt(row.delta_raw);
    current.raw += row.transfer_type === "in" ? amount : -amount;
    balances.set(key, current);
  }

  return [...balances.values()]
    .filter((row) => row.raw > 0n && !isLikelySpamToken(row))
    .map((row) => ({
      ...row,
      amount: formatUnits(row.raw.toString(), row.decimals),
    }))
    .sort((a, b) => a.symbol.localeCompare(b.symbol));
}

function isLikelySpamToken(row) {
  const text = `${row.symbol || ""} ${row.name || ""}`.toLowerCase();
  const spamPatterns = [
    "ads",
    "airdrop",
    "casino",
    "claim",
    "free token",
    "gitos",
    "maticslot",
    "redeem",
    "staked",
    "t.me",
    "visit http",
    ".io",
    ".org",
  ];
  return /[^\x20-\x7E]/.test(text) || spamPatterns.some((pattern) => text.includes(pattern));
}

function balanceSnapshotRows(db, wallet, chainName, snapshotType, date) {
  const snapshot = db.prepare(`
    SELECT id, total_quote FROM balance_snapshots
    WHERE wallet_id = ? AND chain_name = ? AND snapshot_type = ? AND as_of_date = ?
  `).get(wallet.id, chainName, snapshotType, date);

  if (!snapshot) return null;

  const rows = db.prepare(`
    SELECT
      contract_address,
      COALESCE(contract_ticker_symbol, 'UNKNOWN') AS symbol,
      COALESCE(contract_name, contract_ticker_symbol, contract_address, 'Unknown Token') AS name,
      COALESCE(contract_decimals, 0) AS decimals,
      balance_raw AS raw,
      quote_rate AS quoteRate
    FROM balance_snapshot_items
    WHERE snapshot_id = ?
    ORDER BY symbol
  `).all(snapshot.id).map((row) => ({
    ...row,
    amount: formatUnits(row.raw || "0", row.decimals),
  })).filter((row) => {
    const amount = Number(String(row.amount).replaceAll(",", ""));
    return amount > 0 && !isLikelySpamToken(row);
  });

  return { rows, totalQuote: snapshot.total_quote };
}

function transactionCoverage(db, wallet, chainName) {
  return db.prepare(`
    SELECT COUNT(*) AS count, MIN(block_signed_at) AS first_tx, MAX(block_signed_at) AS last_tx
    FROM transactions
    WHERE wallet_id = ? AND chain_name = ?
  `).get(wallet.id, chainName);
}

function transferStats(db, wallet, chainName, startDate, endDate) {
  return db.prepare(`
    SELECT
      COALESCE(contract_ticker_symbol, 'UNKNOWN') AS symbol,
      transfer_type,
      COUNT(*) AS count
    FROM token_transfers
    WHERE wallet_id = ?
      AND chain_name = ?
      AND block_signed_at BETWEEN ? AND ?
      AND transfer_type IN ('in', 'out')
    GROUP BY symbol, transfer_type
    ORDER BY symbol, transfer_type
  `).all(wallet.id, chainName, `${startDate}T00:00:00.000Z`, `${endDate}T23:59:59.999Z`);
}

function drawTable(doc, title, headers, rows, widths) {
  doc.moveDown(0.7).font("Helvetica-Bold").fontSize(12).text(title);
  const left = doc.page.margins.left;
  let y = doc.y + 8;
  const rowHeight = 22;

  function drawRow(values, bold = false) {
    if (y + rowHeight > doc.page.height - doc.page.margins.bottom) {
      doc.addPage();
      y = doc.page.margins.top;
    }
    let x = left;
    doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(9);
    values.forEach((value, index) => {
      doc.text(String(value ?? ""), x, y, { width: widths[index], height: rowHeight - 4, ellipsis: true });
      x += widths[index];
    });
    y += rowHeight;
    doc.moveTo(left, y - 4).lineTo(doc.page.width - doc.page.margins.right, y - 4).strokeColor("#dddddd").stroke();
    doc.strokeColor("#000000");
  }

  drawRow(headers, true);
  if (!rows.length) {
    drawRow(["No non-zero balances found from stored wallet transfer history.", "", "", ""].slice(0, headers.length));
  } else {
    for (const row of rows) drawRow(row);
  }
  doc.y = y;
}

function usd(value) {
  return `$${Number(value || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function aed(valueUsd) {
  return `AED ${(Number(valueUsd || 0) * AED_PER_USD).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function shortAddress(address) {
  return `${address.slice(0, 20)}...${address.slice(-10)}`.toLowerCase();
}

function reportFileName(walletLabel, chainName, openingDate, closingDate) {
  const safeLabel = walletLabel.replaceAll(" ", "_");
  return `data/${safeLabel}_${chainName}_${openingDate}_to_${closingDate}.pdf`;
}

async function priceMapFor(chainName, contractAddresses, openingDate, closingDate) {
  const unique = [...new Set(contractAddresses.map((address) => address?.toLowerCase()).filter(Boolean))];
  const prices = new Map();
  if (!unique.length) return prices;

  // Process addresses one at a time to avoid a single bad address
  // (e.g., unknown token, wrong checksum) from taking down an entire batch of 20
  for (const address of unique) {
    try {
      const data = await getHistoricalTokenPrices(chainName, [address], {
        quoteCurrency: "USD",
        from: openingDate,
        to: closingDate,
        asc: true,
      });
      for (const token of Array.isArray(data) ? data : [data]) {
        const byDate = new Map();
        for (const item of token.items || []) {
          byDate.set(String(item.date).slice(0, 10), Number(item.price) || 0);
        }
        prices.set(token.contract_address.toLowerCase(), byDate);
      }
    } catch (error) {
      // Skip unknown/not-found tokens silently — they'll just show $0 in the report
    }
  }
  return prices;
}

function priceFor(prices, contractAddress, date) {
  return prices.get(contractAddress.toLowerCase())?.get(date) || 0;
}

function balanceValuationRows(rows, prices, date) {
  return rows.map((row) => {
    const amountNumber = Number(String(row.amount).replaceAll(",", ""));
    // Use stored quoteRate from snapshots if available, otherwise look up price
    const priceUsd = row.quoteRate != null ? Number(row.quoteRate) : priceFor(prices, row.contract_address, date);
    return {
      asset: row.symbol,
      amount: amountNumber.toLocaleString("en-US", { maximumFractionDigits: 6 }),
      priceUsd,
      valueUsd: amountNumber * priceUsd,
      contract_address: row.contract_address,
    };
  }).filter((row) => row.valueUsd > 0 || row.priceUsd > 0);
}

function materialTransactions(db, wallet, chainName, startDate, endDate, prices) {
  const rows = db.prepare(`
    SELECT block_signed_at, transfer_type, contract_ticker_symbol, contract_name, contract_address, delta_raw, contract_decimals, tx_hash
    FROM token_transfers
    WHERE wallet_id = ?
      AND chain_name = ?
      AND block_signed_at BETWEEN ? AND ?
      AND transfer_type IN ('in', 'out')
      AND COALESCE(delta_raw, '0') != '0'
    ORDER BY block_signed_at
  `).all(wallet.id, chainName, `${startDate}T00:00:00.000Z`, `${endDate}T23:59:59.999Z`);

  return rows
    .filter((row) => !isLikelySpamToken({ symbol: row.contract_ticker_symbol, name: row.contract_name }))
    .filter((row) => priceFor(prices, row.contract_address, row.block_signed_at.slice(0, 10)) > 0)
    .map((row) => ({
      date: row.block_signed_at.slice(0, 10),
      type: row.transfer_type.toUpperCase(),
      amount: Number(formatUnits(row.delta_raw, row.contract_decimals)).toLocaleString("en-US", { maximumFractionDigits: 6 }),
      asset: row.contract_ticker_symbol || "UNKNOWN",
      hash: `${row.tx_hash.slice(0, 10)}...`,
    }));
}

function drawHeaderValue(doc, label, value, x, y) {
  doc.font("Helvetica-Bold").fontSize(10).text(label, x, y, { width: 80 });
  doc.font("Helvetica").fontSize(10).text(value, x + 72, y, { width: 430 });
}

function drawReportTable(doc, title, headers, rows, widths) {
  const left = doc.page.margins.left;
  doc.x = left;
  doc.moveDown(0.75).font("Helvetica-Bold").fontSize(13).text(title, left, doc.y, {
    width: doc.page.width - doc.page.margins.left - doc.page.margins.right,
  });
  let y = doc.y + 8;
  const rowHeight = 21;
  const bottom = doc.page.height - doc.page.margins.bottom;

  function pageBreakIfNeeded() {
    if (y + rowHeight > bottom) {
      doc.addPage();
      y = doc.page.margins.top;
    }
  }

  function draw(values, bold = false) {
    pageBreakIfNeeded();
    let x = left;
    doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(9);
    values.forEach((value, index) => {
      doc.text(String(value ?? ""), x, y, { width: widths[index], height: rowHeight - 3, ellipsis: true });
      x += widths[index];
    });
    y += rowHeight;
  }

  draw(headers, true);
  rows.forEach((row) => draw(row));
  doc.y = y;
}

async function balancePdf(args) {
  const db = ensureDb();
  const address = args.address || DEFAULT_ADDRESS;
  const chainName = args.chain || "arbitrum-mainnet";
  const openingDate = args.opening || "2025-04-01";
  const closingDate = args.closing || "2025-11-30";
  const output = args.output || reportFileName(args.label || DEFAULT_LABEL, chainName, openingDate, closingDate);
  mkdirSync(dirname(output), { recursive: true });

  const wallet = upsertWallet(db, {
    label: args.label || DEFAULT_LABEL,
    address,
  });

  // Try stored balance snapshots first; fall back to transaction reconstruction
  const openingSnapshot = balanceSnapshotRows(db, wallet, chainName, "opening", openingDate);
  const closingSnapshot = balanceSnapshotRows(db, wallet, chainName, "closing", closingDate);
  const useSnapshots = openingSnapshot !== null || closingSnapshot !== null;

  let openingBalances, closingBalances, openingRows, closingRows, openingTotalUsd, closingTotalUsd;

  if (useSnapshots) {
    openingBalances = openingSnapshot ? openingSnapshot.rows : [];
    closingBalances = closingSnapshot ? closingSnapshot.rows : [];
    openingTotalUsd = openingSnapshot ? openingSnapshot.totalQuote : 0;
    closingTotalUsd = closingSnapshot ? closingSnapshot.totalQuote : 0;
  } else {
    openingBalances = balanceRowsAt(db, wallet, chainName, openingDate);
    closingBalances = balanceRowsAt(db, wallet, chainName, closingDate);
  }

  const transferContracts = db.prepare(`
    SELECT DISTINCT contract_address
    FROM token_transfers
    WHERE wallet_id = ?
      AND chain_name = ?
      AND block_signed_at BETWEEN ? AND ?
      AND transfer_type IN ('in', 'out')
      AND contract_address IS NOT NULL
  `).all(wallet.id, chainName, `${openingDate}T00:00:00.000Z`, `${closingDate}T23:59:59.999Z`)
    .map((row) => row.contract_address);

  const priceContracts = [
    ...openingBalances.map((row) => row.contract_address),
    ...closingBalances.map((row) => row.contract_address),
    ...transferContracts,
  ];
  const prices = await priceMapFor(chainName, priceContracts, openingDate, closingDate);

  // Convert balances to valuation rows (adds price and value columns)
  openingRows = balanceValuationRows(openingBalances, prices, openingDate);
  closingRows = balanceValuationRows(closingBalances, prices, closingDate);

  if (!useSnapshots) {
    openingTotalUsd = openingRows.reduce((sum, row) => sum + row.valueUsd, 0);
    closingTotalUsd = closingRows.reduce((sum, row) => sum + row.valueUsd, 0);
  }

  const transactionRows = materialTransactions(db, wallet, chainName, openingDate, closingDate, prices);
  const openingTotalAed = openingTotalUsd * AED_PER_USD;
  const closingTotalAed = closingTotalUsd * AED_PER_USD;

  const doc = new PDFDocument({ size: "A4", margin: 46 });
  doc.pipe(createWriteStream(output));

  doc.font("Helvetica-Bold").fontSize(18).text("Transaction History & Balance Report", { align: "center" });
  doc.moveDown(0.2).font("Helvetica").fontSize(12).text(`${openingDate} to ${closingDate}`, { align: "center" });
  doc.moveDown(1);

  const metaY = doc.y;
  drawHeaderValue(doc, "Wallet:", wallet.label, 46, metaY);
  drawHeaderValue(doc, "Address:", shortAddress(wallet.address), 46, metaY + 18);
  drawHeaderValue(doc, "Network:", chainName, 46, metaY + 36);
  drawHeaderValue(doc, "Period:", `${openingDate} to ${closingDate}`, 46, metaY + 54);
  doc.y = metaY + 76;

  drawReportTable(
    doc,
    `Opening Balance (${openingDate})`,
    ["Asset", "Amount", "Price (USD)", "Value (USD)", "Value (AED)"],
    [
      ...openingRows.map((row) => [row.asset, row.amount, usd(row.priceUsd), usd(row.valueUsd), aed(row.valueUsd)]),
      ["TOTAL", "", "", usd(openingTotalUsd), `AED ${openingTotalAed.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`],
    ],
    [78, 110, 95, 110, 120],
  );

  drawReportTable(
    doc,
    `Transactions (${transactionRows.length} total)`,
    ["Date", "Type", "Amount", "Asset", "Hash"],
    transactionRows.map((row) => [row.date, row.type === "IN" ? "v IN" : "^ OUT", row.amount, row.asset, row.hash]),
    [88, 62, 110, 80, 170],
  );

  drawReportTable(
    doc,
    `Closing Balance (${closingDate})`,
    ["Asset", "Amount", "Price (USD)", "Value (USD)", "Value (AED)"],
    [
      ...closingRows.map((row) => [row.asset, row.amount, usd(row.priceUsd), usd(row.valueUsd), aed(row.valueUsd)]),
      ["TOTAL", "", "", usd(closingTotalUsd), `AED ${closingTotalAed.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`],
    ],
    [78, 110, 95, 110, 120],
  );

  doc.moveDown(0.7);
  doc.end();

  console.log(`PDF written to ${output}`);
}

async function openingBalancePdf(args) {
  const db = ensureDb();
  const address = args.address || DEFAULT_ADDRESS;
  const chainName = args.chain || "eth-mainnet";
  const openingDate = args.date || "2025-04-01";
  const output = args.output || `data/openingBalance/opening_balance_${(args.label || DEFAULT_LABEL).replaceAll(" ", "_")}_${chainName}_${openingDate}_STAKED.pdf`;
  mkdirSync(dirname(output), { recursive: true });

  const wallet = upsertWallet(db, {
    label: args.label || DEFAULT_LABEL,
    address,
  });

  // Get opening balance snapshot
  const openingSnapshot = balanceSnapshotRows(db, wallet, chainName, "opening", openingDate);
  const openingBalances = openingSnapshot ? openingSnapshot.rows : [];
  const openingTotalUsd = openingSnapshot ? openingSnapshot.totalQuote : 0;

  // Get transactions before opening date for history
  const transactions = db.prepare(`
    SELECT block_signed_at, transfer_type, contract_ticker_symbol, contract_name, delta_raw, contract_decimals, tx_hash
    FROM token_transfers
    WHERE wallet_id = ?
      AND chain_name = ?
      AND block_signed_at < ?
      AND transfer_type IN ('in', 'out')
    ORDER BY block_signed_at DESC
  `).all(wallet.id, chainName, `${openingDate}T00:00:00.000Z`);

  // Get price for opening date
  const contractAddresses = [...new Set(openingBalances.map((row) => row.contract_address).filter(Boolean))];
  const prices = await priceMapFor(chainName, contractAddresses, openingDate, openingDate);
  
  const openingRows = openingBalances.map((row) => {
    const amountNumber = Number(String(row.amount).replaceAll(",", ""));
    const priceUsd = row.quoteRate != null ? Number(row.quoteRate) : priceFor(prices, row.contract_address, openingDate);
    return {
      asset: row.symbol,
      amount: amountNumber,
      priceUsd,
      valueUsd: amountNumber * priceUsd,
    };
  }).filter((row) => row.valueUsd > 0 || row.priceUsd > 0);

  const openingTotalAed = openingTotalUsd * AED_PER_USD;

  const doc = new PDFDocument({ size: "A4", margin: 46 });
  doc.pipe(createWriteStream(output));

  // Title
  doc.font("Helvetica-Bold").fontSize(18).text("BLOCKCHAIN ACCOUNT", { align: "center" });
  doc.font("Helvetica-Bold").fontSize(18).text("STATEMENT", { align: "center" });
  doc.moveDown(0.2).font("Helvetica-Bold").fontSize(16).text("OPENING BALANCE", { align: "center" });
  doc.moveDown(1);

  // Account Details
  doc.font("Helvetica-Bold").fontSize(12).text("ACCOUNT DETAILS");
  const metaY = doc.y;
  drawHeaderValue(doc, "Blockchain", chainName.toUpperCase(), 46, metaY);
  drawHeaderValue(doc, "Wallet Address", wallet.address, 46, metaY + 18);
  drawHeaderValue(doc, "Opening Balance Date", openingDate, 46, metaY + 36);
  doc.y = metaY + 58;
  doc.moveDown(0.5);

  // Opening Balance Table
  drawReportTable(
    doc,
    `Opening Balance as of ${openingDate}`,
    ["Asset", "Balance", "USD Value", "AED Value", "% of Portfolio"],
    [
      ...openingRows.map((row) => {
        const usdVal = row.valueUsd;
        const aedVal = usdVal * AED_PER_USD;
        const pct = openingTotalUsd > 0 ? ((usdVal / openingTotalUsd) * 100).toFixed(1) : "0.0";
        return [row.asset, row.amount.toLocaleString("en-US", { maximumFractionDigits: 6 }), usd(usdVal), aed(aedVal), `${pct}%`];
      }),
      ["TOTAL VALUE", "", usd(openingTotalUsd), aed(openingTotalUsd), "100%"],
    ],
    [100, 100, 100, 110, 80],
  );

  // Transaction History
  doc.moveDown(0.7).font("Helvetica-Bold").fontSize(12).text("Transaction History (Used for Opening Balance Calculation)");
  doc.font("Helvetica").fontSize(10).text(`All transactions up to ${openingDate} that contributed to the opening balance calculation.`, { continued: false });
  doc.moveDown(0.5);

  const txRows = transactions
    .filter((tx) => !isLikelySpamToken({ symbol: tx.contract_ticker_symbol, name: tx.contract_name }))
    .map((tx) => {
      const amount = Number(formatUnits(tx.delta_raw, tx.contract_decimals));
      const typeLabel = tx.transfer_type === "in" ? "INCOMING" : "OUTGOING";
      return [tx.block_signed_at.slice(0, 16), typeLabel, amount.toLocaleString("en-US", { maximumFractionDigits: 6 }), tx.contract_ticker_symbol || "UNKNOWN", "", ""];
    });

  drawReportTable(
    doc,
    "",
    ["Date", "Type", "Amount", "Token", "Value in USD", "Value in AED"],
    txRows.slice(0, 50), // Limit to 50 most recent
    [90, 80, 100, 80, 100, 100],
  );

  // Footer
  doc.moveDown(1);
  const now = new Date();
  doc.font("Helvetica").fontSize(9).text(`Generated on ${now.toLocaleDateString("en-US")} at ${now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}`);
  doc.font("Helvetica").fontSize(9).text(`Exchange Rate: 1 USD = ${AED_PER_USD} AED`);
  doc.font("Helvetica").fontSize(9).text(`Opening Balance Date: ${openingDate}`);

  doc.end();
  console.log(`Opening balance PDF written to ${output}`);
}

async function solIngest(args) {
  const db = ensureDb();
  const address = args.address || "3hJQ8L8XmDpgdtRbVebh3tYvMFwhtNLyc7SJBHSCfxGo";
  const label = args.label || "NOBI LABS LEDGER SOLANA";

  const wallet = upsertWallet(db, { label, address });
  upsertChain(db, "solana-mainnet", { name: "solana-mainnet", label: "Solana" });

  const csvPath = args.csv;
  if (!csvPath) throw new Error("Pass --csv /path/to/activities.csv");

  const { parse } = await import("csv-parse");
  const fs = await import("fs");
  const input = fs.readFileSync(csvPath, "utf8");

  let saved = 0;
  let skipped = 0;

  const insertTx = db.prepare(`
    INSERT INTO transactions (
      wallet_id, chain_name, tx_hash, block_signed_at, block_height, block_hash, tx_offset,
      successful, from_address, to_address, native_value_raw, native_value_quote,
      fees_paid_raw, gas_quote, gas_quote_rate, raw_json
    )
    VALUES (
      @wallet_id, @chain_name, @tx_hash, @block_signed_at, @block_height, @block_hash, @tx_offset,
      @successful, @from_address, @to_address, @native_value_raw, @native_value_quote,
      @fees_paid_raw, @gas_quote, @gas_quote_rate, @raw_json
    )
    ON CONFLICT(wallet_id, chain_name, tx_hash) DO UPDATE SET
      block_signed_at = excluded.block_signed_at,
      block_height = excluded.block_height,
      raw_json = excluded.raw_json,
      synced_at = CURRENT_TIMESTAMP
  `);

  const insertTransfer = db.prepare(`
    INSERT INTO token_transfers (
      transaction_id, wallet_id, chain_name, tx_hash, log_key, block_signed_at,
      from_address, to_address, contract_address, contract_name, contract_ticker_symbol,
      contract_decimals, transfer_type, delta_raw, balance_raw, quote_rate, delta_quote,
      balance_quote, raw_json
    )
    VALUES (
      @transaction_id, @wallet_id, @chain_name, @tx_hash, @log_key, @block_signed_at,
      @from_address, @to_address, @contract_address, @contract_name, @contract_ticker_symbol,
      @contract_decimals, @transfer_type, @delta_raw, @balance_raw, @quote_rate, @delta_quote,
      @balance_quote, @raw_json
    )
    ON CONFLICT(wallet_id, chain_name, tx_hash, log_key) DO UPDATE SET
      balance_raw = excluded.balance_raw,
      balance_quote = excluded.balance_quote,
      raw_json = excluded.raw_json
  `);

  const parser = parse(input, { columns: true, skip_empty_lines: true });

  for await (const row of parser) {
    const signature = row.signature;
    const blockTime = row.blockTime;
    const success = row.success === "true" || row.success === true;
    const fees = parseFloat(row.fees) || 0;
    const ticker = row.ticker || "SOL";
    const tokenAddress = row.address || "11111111111111111111111111111111";
    const preBalance = parseFloat(row.preBalance) || 0;
    const postBalance = parseFloat(row.postBalance) || 0;
    const balanceChange = parseFloat(row.balanceChange) || 0;

    // Filter out transactions with balance change < 0.1 SOL (dust)
    if (Math.abs(balanceChange) < 0.1 && ticker === "SOL") {
      skipped += 1;
      continue;
    }

    // Determine transfer direction
    let transferType = "other";
    let fromAddr = null;
    let toAddr = null;
    let deltaRaw = "0";

    if (ticker === "SOL") {
      if (balanceChange > 0) {
        transferType = "in";
        toAddr = address;
      } else {
        transferType = "out";
        fromAddr = address;
      }
      deltaRaw = String(Math.abs(balanceChange * 1e9)); // SOL to lamports
    } else {
      // Token transfers - determine in/out based on pre/post balance
      if (postBalance > preBalance) {
        transferType = "in";
        deltaRaw = String(Math.abs(postBalance - preBalance));
        toAddr = address;
      } else {
        transferType = "out";
        deltaRaw = String(Math.abs(preBalance - postBalance));
        fromAddr = address;
      }
    }

    // Get existing tx or insert
    let txRow = db.prepare(`
      SELECT id FROM transactions WHERE wallet_id = ? AND chain_name = ? AND tx_hash = ?
    `).get(wallet.id, "solana-mainnet", signature);

    if (!txRow) {
      insertTx.run({
        wallet_id: wallet.id,
        chain_name: "solana-mainnet",
        tx_hash: signature,
        block_signed_at: blockTime,
        block_height: null,
        block_hash: null,
        tx_offset: null,
        successful: success ? 1 : 0,
        from_address: fromAddr,
        to_address: toAddr,
        native_value_raw: ticker === "SOL" ? deltaRaw : "0",
        native_value_quote: null,
        fees_paid_raw: String(Math.round(fees * 1e9)),
        gas_quote: null,
        gas_quote_rate: null,
        raw_json: JSON.stringify({ csv_row: row }),
      });
      txRow = db.prepare(`
        SELECT id FROM transactions WHERE wallet_id = ? AND chain_name = ? AND tx_hash = ?
      `).get(wallet.id, "solana-mainnet", signature);
    }

    // Insert transfer record
    const logKey = `${tokenAddress}:${fromAddr || ""}:${toAddr || ""}:${deltaRaw}:0`;
    insertTransfer.run({
      transaction_id: txRow.id,
      wallet_id: wallet.id,
      chain_name: "solana-mainnet",
      tx_hash: signature,
      log_key: logKey,
      block_signed_at: blockTime,
      from_address: fromAddr,
      to_address: toAddr,
      contract_address: tokenAddress,
      contract_name: ticker,
      contract_ticker_symbol: ticker,
      contract_decimals: ticker === "SOL" ? 9 : 0,
      transfer_type: transferType,
      delta_raw: deltaRaw,
      balance_raw: String(Math.round(postBalance * (ticker === "SOL" ? 1e9 : 1))),
      quote_rate: null,
      delta_quote: null,
      balance_quote: null,
      raw_json: JSON.stringify({ csv_row: row }),
    });

    saved += 1;
  }

  console.log(`SOL ingest: ${saved} transactions stored, ${skipped} filtered (<0.1 SOL dust)`);
}

async function solBalancePdf(args) {
  const db = ensureDb();
  const address = args.address || "3hJQ8L8XmDpgdtRbVebh3tYvMFwhtNLyc7SJBHSCfxGo";
  const label = args.label || "NOBI LABS LEDGER SOLANA";
  const openingDate = args.opening || "2025-04-01";
  const closingDate = args.closing || "2025-11-30";
  const chainName = "solana-mainnet";

  const SOL_PRICE_USD = 136.52;
  const PYTH_PRICE_USD = 0.144;
  const USDT_PRICE_USD = 1.0;
  const USDC_PRICE_USD = 1.0;
  const priceMap = {
    "SOL": SOL_PRICE_USD,
    "PYTH": PYTH_PRICE_USD,
    "USDT": USDT_PRICE_USD,
    "USDC": USDC_PRICE_USD,
  };

  const wallet = upsertWallet(db, { label, address });

  const openingBalances = balanceRowsAt(db, wallet, chainName, openingDate);
  const closingBalances = balanceRowsAt(db, wallet, chainName, closingDate);

  function valuate(rows) {
    return rows.map((row) => {
      const amt = Number(String(row.amount).replaceAll(",", ""));
      const price = priceMap[row.symbol] || 0;
      return {
        asset: row.symbol,
        amount: amt,
        priceUsd: price,
        valueUsd: amt * price,
        contract_address: row.contract_address,
      };
    });
  }

  const openingRows = valuate(openingBalances, openingDate);
  const closingRows = valuate(closingBalances, closingDate);
  const openingTotalUsd = openingRows.reduce((s, r) => s + r.valueUsd, 0);
  const closingTotalUsd = closingRows.reduce((s, r) => s + r.valueUsd, 0);
  const openingTotalAed = openingTotalUsd * AED_PER_USD;
  const closingTotalAed = closingTotalUsd * AED_PER_USD;

  // Get material transactions in period
  const txRows = db.prepare(`
    SELECT block_signed_at, transfer_type, contract_ticker_symbol, contract_name,
           delta_raw, contract_decimals, tx_hash
    FROM token_transfers
    WHERE wallet_id = ?
      AND chain_name = ?
      AND block_signed_at BETWEEN ? AND ?
      AND transfer_type IN ('in', 'out')
    ORDER BY block_signed_at
  `).all(wallet.id, chainName,
    `${openingDate}T00:00:00.000Z`,
    `${closingDate}T23:59:59.999Z`)
    .filter((row) => !isLikelySpamToken({ symbol: row.contract_ticker_symbol, name: row.contract_name }))
    .map((row) => {
      const amt = Number(formatUnits(row.delta_raw, row.contract_decimals));
      return {
        date: row.block_signed_at.slice(0, 10),
        type: row.transfer_type.toUpperCase(),
        amount: amt,
        asset: row.contract_ticker_symbol || "UNKNOWN",
        hash: `${row.tx_hash.slice(0, 10)}...`,
        valueUsd: amt * (priceMap[row.contract_ticker_symbol] || 0),
      };
    })
    .filter((row) => Math.abs(row.amount) >= 0.1 || row.valueUsd > 0);

  const output = args.output || `data/openingBalance/NOBI_LABS_LEDGER_[SOL]_solana-mainnet_${openingDate}_to_${closingDate}.pdf`;
  mkdirSync(dirname(output), { recursive: true });

  const doc = new PDFDocument({ size: "A4", margin: 46 });
  doc.pipe(createWriteStream(output));

  doc.font("Helvetica-Bold").fontSize(18).text("Transaction History & Balance Report", { align: "center" });
  doc.moveDown(0.2).font("Helvetica").fontSize(12).text(`${openingDate} to ${closingDate}`, { align: "center" });
  doc.moveDown(1);

  const metaY = doc.y;
  drawHeaderValue(doc, "Wallet:", wallet.label, 46, metaY);
  drawHeaderValue(doc, "Address:", address, 46, metaY + 18);
  drawHeaderValue(doc, "Network:", "SOLANA", 46, metaY + 36);
  drawHeaderValue(doc, "Period:", `${openingDate} to ${closingDate}`, 46, metaY + 54);
  doc.y = metaY + 76;

  drawReportTable(
    doc,
    `Opening Balance (${openingDate})`,
    ["Asset", "Amount", "Price (USD)", "Value (USD)", "Value (AED)"],
    [
      ...openingRows.map((row) => [row.asset, row.amount.toLocaleString("en-US", { maximumFractionDigits: 6 }), usd(row.priceUsd), usd(row.valueUsd), aed(row.valueUsd)]),
      ["TOTAL", "", "", usd(openingTotalUsd), `AED ${openingTotalAed.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`],
    ],
    [78, 110, 95, 110, 120],
  );

  drawReportTable(
    doc,
    `Transactions (${txRows.length} total)`,
    ["Date", "Type", "Amount", "Asset", "Hash"],
    txRows.map((row) => [row.date, row.type === "IN" ? "v IN" : "^ OUT", row.amount.toLocaleString("en-US", { maximumFractionDigits: 6 }), row.asset, row.hash]),
    [88, 62, 110, 80, 170],
  );

  drawReportTable(
    doc,
    `Closing Balance (${closingDate})`,
    ["Asset", "Amount", "Price (USD)", "Value (USD)", "Value (AED)"],
    [
      ...closingRows.map((row) => [row.asset, row.amount.toLocaleString("en-US", { maximumFractionDigits: 6 }), usd(row.priceUsd), usd(row.valueUsd), aed(row.valueUsd)]),
      ["TOTAL", "", "", usd(closingTotalUsd), `AED ${closingTotalAed.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`],
    ],
    [78, 110, 95, 110, 120],
  );

  doc.moveDown(0.7);
  const now = new Date();
  doc.font("Helvetica").fontSize(9).text(`Generated on ${now.toLocaleDateString("en-US")} at ${now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })} | Prices: SOL $${SOL_PRICE_USD} | PYTH $${PYTH_PRICE_USD} | AED/USD ${AED_PER_USD}`);
  doc.end();
  console.log(`SOL balance PDF written to ${output}`);
}

async function pinkWalletOpeningPdf(args) {
  const db = ensureDb();
  const address = args.address || "Ckbi1nHQoLEJDLt58rm5EJaqPFsDS6V8FbCs5hYZQuQU";
  const label = args.label || "PINK WALLET [PYTH]";
  const openingDate = args.date || "2025-04-01";
  const chainName = "solana-mainnet";

  const SOL_PRICE_USD = 136.52;
  const PYTH_PRICE_USD = 0.144;
  const USDT_PRICE_USD = 1.0;
  const USDC_PRICE_USD = 1.0;
  const priceMap = {
    "SOL": SOL_PRICE_USD,
    "PYTH": PYTH_PRICE_USD,
    "USDT": USDT_PRICE_USD,
    "USDC": USDC_PRICE_USD,
  };

  const wallet = upsertWallet(db, { label, address });

  // Reconstruct opening balance at openingDate
  const openingBalances = balanceRowsAt(db, wallet, chainName, openingDate);

  function valuate(rows) {
    return rows.map((row) => {
      const amt = Number(String(row.amount).replaceAll(",", ""));
      const price = priceMap[row.symbol] || 0;
      return {
        asset: row.symbol,
        amount: amt,
        priceUsd: price,
        valueUsd: amt * price,
        contract_address: row.contract_address,
      };
    });
  }

  const openingRows = valuate(openingBalances);
  const openingTotalUsd = openingRows.reduce((s, r) => s + r.valueUsd, 0);
  const openingTotalAed = openingTotalUsd * AED_PER_USD;

  // Get transactions before opening date
  const preTxs = db.prepare(`
    SELECT block_signed_at, transfer_type, contract_ticker_symbol, contract_name,
           delta_raw, contract_decimals, tx_hash
    FROM token_transfers
    WHERE wallet_id = ?
      AND chain_name = ?
      AND block_signed_at < ?
      AND transfer_type IN ('in', 'out')
    ORDER BY block_signed_at DESC
  `).all(wallet.id, chainName, `${openingDate}T00:00:00.000Z`)
    .filter((row) => !isLikelySpamToken({ symbol: row.contract_ticker_symbol, name: row.contract_name }))
    .map((row) => {
      const amt = Number(formatUnits(row.delta_raw, row.contract_decimals));
      return {
        date: row.block_signed_at.slice(0, 16),
        type: row.transfer_type === "in" ? "INCOMING" : "OUTGOING",
        amount: amt,
        asset: row.contract_ticker_symbol || "UNKNOWN",
        hash: row.tx_hash.slice(0, 10),
        valueUsd: Math.abs(amt) * (priceMap[row.contract_ticker_symbol] || 0),
      };
    });

  const output = args.output || `data/openingBalance/openingBalance_PINK_WALLET_[PYTH]_solana-mainnet_${openingDate}_STAKED.pdf`;
  mkdirSync(dirname(output), { recursive: true });

  const doc = new PDFDocument({ size: "A4", margin: 46 });
  doc.pipe(createWriteStream(output));

  // Title
  doc.font("Helvetica-Bold").fontSize(18).text("BLOCKCHAIN ACCOUNT", { align: "center" });
  doc.font("Helvetica-Bold").fontSize(18).text("STATEMENT", { align: "center" });
  doc.moveDown(0.2).font("Helvetica-Bold").fontSize(16).text("OPENING BALANCE", { align: "center" });
  doc.moveDown(1);

  // Account Details
  doc.font("Helvetica-Bold").fontSize(12).text("ACCOUNT DETAILS");
  const metaY = doc.y;
  drawHeaderValue(doc, "Blockchain", "SOLANA", 46, metaY);
  drawHeaderValue(doc, "Wallet Address", wallet.address, 46, metaY + 18);
  drawHeaderValue(doc, "Opening Balance Date", openingDate, 46, metaY + 36);
  doc.y = metaY + 58;
  doc.moveDown(0.5);

  // Opening Balance Table
  drawReportTable(
    doc,
    `Opening Balance as of ${openingDate}`,
    ["Asset", "Balance", "USD Value", "AED Value", "% of Portfolio"],
    [
      ...openingRows.map((row) => {
        const usdVal = row.valueUsd;
        const aedVal = usdVal * AED_PER_USD;
        const pct = openingTotalUsd > 0 ? ((usdVal / openingTotalUsd) * 100).toFixed(1) : "0.0";
        return [row.asset, row.amount.toLocaleString("en-US", { maximumFractionDigits: 6 }), usd(usdVal), aed(aedVal), `${pct}%`];
      }),
      ["TOTAL VALUE", "", usd(openingTotalUsd), aed(openingTotalUsd), "100%"],
    ],
    [100, 100, 100, 110, 80],
  );

  // Transaction History before opening date
  doc.moveDown(0.7).font("Helvetica-Bold").fontSize(12).text("Transaction History (Used for Opening Balance Calculation)");
  doc.font("Helvetica").fontSize(10).text(`All transactions up to ${openingDate} that contributed to the opening balance calculation.`, { continued: false });
  doc.moveDown(0.5);

  drawReportTable(
    doc,
    "",
    ["Date", "Type", "Amount", "Token", "Value in USD", "Value in AED"],
    preTxs.slice(0, 50).map((row) => [
      row.date,
      row.type,
      row.amount.toLocaleString("en-US", { maximumFractionDigits: 6 }),
      row.asset,
      usd(row.valueUsd),
      aed(row.valueUsd),
    ]),
    [90, 80, 100, 80, 100, 100],
  );

  // Footer
  doc.moveDown(1);
  const now = new Date();
  doc.font("Helvetica").fontSize(9).text(`Generated on ${now.toLocaleDateString("en-US")} at ${now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}`);
  doc.font("Helvetica").fontSize(9).text(`Exchange Rate: 1 USD = ${AED_PER_USD} AED`);
  doc.font("Helvetica").fontSize(9).text(`Prices: SOL $${SOL_PRICE_USD} | PYTH $${PYTH_PRICE_USD}`);

  doc.end();
  console.log(`Pink Wallet opening balance PDF written to ${output}`);
}

async function pinkWalletStatementPdf(args) {
  const db = ensureDb();
  const address = args.address || "Ckbi1nHQoLEJDLt58rm5EJaqPFsDS6V8FbCs5hYZQuQU";
  const label = args.label || "PINK WALLET [PYTH]";
  const openingDate = args.opening || "2025-04-01";
  const closingDate = args.closing || "2025-11-30";
  const chainName = "solana-mainnet";

  const SOL_PRICE_USD = 136.52;
  const PYTH_PRICE_USD = 0.144;
  const USDT_PRICE_USD = 1.0;
  const USDC_PRICE_USD = 1.0;
  const priceMap = {
    "SOL": SOL_PRICE_USD,
    "PYTH": PYTH_PRICE_USD,
    "USDT": USDT_PRICE_USD,
    "USDC": USDC_PRICE_USD,
  };

  const wallet = upsertWallet(db, { label, address });

  const openingBalances = balanceRowsAt(db, wallet, chainName, openingDate);
  const closingBalances = balanceRowsAt(db, wallet, chainName, closingDate);

  function valuate(rows) {
    return rows.map((row) => {
      const amt = Number(String(row.amount).replaceAll(",", ""));
      const price = priceMap[row.symbol] || 0;
      return {
        asset: row.symbol,
        amount: amt,
        priceUsd: price,
        valueUsd: amt * price,
        contract_address: row.contract_address,
      };
    });
  }

  const openingRows = valuate(openingBalances);
  const closingRows = valuate(closingBalances);
  const openingTotalUsd = openingRows.reduce((s, r) => s + r.valueUsd, 0);
  const closingTotalUsd = closingRows.reduce((s, r) => s + r.valueUsd, 0);
  const openingTotalAed = openingTotalUsd * AED_PER_USD;
  const closingTotalAed = closingTotalUsd * AED_PER_USD;

  // Get material transactions in period
  const txRows = db.prepare(`
    SELECT block_signed_at, transfer_type, contract_ticker_symbol, contract_name,
           delta_raw, contract_decimals, tx_hash
    FROM token_transfers
    WHERE wallet_id = ?
      AND chain_name = ?
      AND block_signed_at BETWEEN ? AND ?
      AND transfer_type IN ('in', 'out')
    ORDER BY block_signed_at
  `).all(wallet.id, chainName,
    `${openingDate}T00:00:00.000Z`,
    `${closingDate}T23:59:59.999Z`)
    .filter((row) => !isLikelySpamToken({ symbol: row.contract_ticker_symbol, name: row.contract_name }))
    .map((row) => {
      const amt = Number(formatUnits(row.delta_raw, row.contract_decimals));
      return {
        date: row.block_signed_at.slice(0, 10),
        type: row.transfer_type.toUpperCase(),
        amount: amt,
        asset: row.contract_ticker_symbol || "UNKNOWN",
        hash: `${row.tx_hash.slice(0, 10)}...`,
        valueUsd: Math.abs(amt) * (priceMap[row.contract_ticker_symbol] || 0),
      };
    })
    .filter((row) => Math.abs(row.amount) >= 0.1 || row.valueUsd > 0);

  const output = args.output || `data/PINK_WALLET_[PYTH]_solana-mainnet_${openingDate}_to_${closingDate}.pdf`;
  mkdirSync(dirname(output), { recursive: true });

  const doc = new PDFDocument({ size: "A4", margin: 46 });
  doc.pipe(createWriteStream(output));

  doc.font("Helvetica-Bold").fontSize(18).text("Transaction History & Balance Report", { align: "center" });
  doc.moveDown(0.2).font("Helvetica").fontSize(12).text(`${openingDate} to ${closingDate}`, { align: "center" });
  doc.moveDown(1);

  const metaY = doc.y;
  drawHeaderValue(doc, "Wallet:", wallet.label, 46, metaY);
  drawHeaderValue(doc, "Address:", address, 46, metaY + 18);
  drawHeaderValue(doc, "Network:", "SOLANA", 46, metaY + 36);
  drawHeaderValue(doc, "Period:", `${openingDate} to ${closingDate}`, 46, metaY + 54);
  doc.y = metaY + 76;

  drawReportTable(
    doc,
    `Opening Balance (${openingDate})`,
    ["Asset", "Amount", "Price (USD)", "Value (USD)", "Value (AED)"],
    [
      ...openingRows.map((row) => [row.asset, row.amount.toLocaleString("en-US", { maximumFractionDigits: 6 }), usd(row.priceUsd), usd(row.valueUsd), aed(row.valueUsd)]),
      ["TOTAL", "", "", usd(openingTotalUsd), `AED ${openingTotalAed.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`],
    ],
    [78, 110, 95, 110, 120],
  );

  drawReportTable(
    doc,
    `Transactions (${txRows.length} total)`,
    ["Date", "Type", "Amount", "Asset", "Hash"],
    txRows.map((row) => [row.date, row.type === "IN" ? "v IN" : "^ OUT", row.amount.toLocaleString("en-US", { maximumFractionDigits: 6 }), row.asset, row.hash]),
    [88, 62, 110, 80, 170],
  );

  drawReportTable(
    doc,
    `Closing Balance (${closingDate})`,
    ["Asset", "Amount", "Price (USD)", "Value (USD)", "Value (AED)"],
    [
      ...closingRows.map((row) => [row.asset, row.amount.toLocaleString("en-US", { maximumFractionDigits: 6 }), usd(row.priceUsd), usd(row.valueUsd), aed(row.valueUsd)]),
      ["TOTAL", "", "", usd(closingTotalUsd), `AED ${closingTotalAed.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`],
    ],
    [78, 110, 95, 110, 120],
  );

  doc.moveDown(0.7);
  const now = new Date();
  doc.font("Helvetica").fontSize(9).text(`Generated on ${now.toLocaleDateString("en-US")} at ${now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })} | Prices: SOL $${SOL_PRICE_USD} | PYTH $${PYTH_PRICE_USD} | AED/USD ${AED_PER_USD}`);
  doc.end();
  console.log(`Pink Wallet statement PDF written to ${output}`);
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);

  if (command === "init-db") {
    ensureDb().close();
    console.log(`Initialized SQLite database at ${process.env.NOBI_LEDGER_DB || DEFAULT_DB_PATH}`);
  } else if (command === "discover") {
    await discover(args);
  } else if (command === "sol-ingest") {
    await solIngest(args);
  } else if (command === "sol-balance-pdf") {
    await solBalancePdf(args);
  } else if (command === "pink-opening-pdf") {
    await pinkWalletOpeningPdf(args);
  } else if (command === "pink-statement-pdf") {
    await pinkWalletStatementPdf(args);
  } else if (command === "opening-balance") {
    await balanceCommand(args, "opening");
  } else if (command === "closing-balance") {
    await balanceCommand(args, "closing");
  } else if (command === "ingest") {
    await ingest(args);
  } else if (command === "statement") {
    statement(args);
  } else if (command === "balance-pdf") {
    await balancePdf(args);
  } else if (command === "opening-balance-pdf") {
    await openingBalancePdf(args);
  } else {
    console.log(`Usage:
  node src/cli.js init-db
  node src/cli.js discover --address ${DEFAULT_ADDRESS}
  node src/cli.js sol-ingest --csv /path/to/activities.csv
  node src/cli.js sol-opening-balance-pdf --date 2025-04-01
  node src/cli.js opening-balance --chain eth-mainnet --date 2025-04-01
  node src/cli.js closing-balance --chain eth-mainnet --date 2025-04-30
  node src/cli.js ingest --chain eth-mainnet --from 2025-04-01 --to 2025-04-30
  node src/cli.js statement --chain eth-mainnet --start 2025-04-01 --end 2025-04-30
  node src/cli.js balance-pdf --chain arbitrum-mainnet --opening 2025-04-01 --closing 2025-11-30`);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
