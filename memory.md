# NOBI Labs Financial Development Memory

## Current Goal

Build a multichain ledger for NOBI Labs that can:

1. Read historical wallet transactions across supported chains.
2. Store transactions and decoded token movements in SQLite first.
3. Let users choose a start/end date and generate opening balances.
4. Generate closing balances.
5. Generate monthly statements and future financial reports from stored data.

## Wallet Under Test

- Label: `NOBI LABS LEDGER [MF USDT]`
- Address: `0xE8c24Ce4c8D3FF7AB82Efd7A74752E7393ff57CB`
- Opening balance requested for: `2025-04-01`

## Wallet — MF ETH

- Label: `NOBI LABS LEDGER [MF ETH]`
- Address: `0x432b5780e008822eCc430506766CCa53D496bafd`
- Chain: `arbitrum-mainnet`
- Ingested transactions: `185` (range: `2025-02-20` → `2025-11-20`)
- First ingested tx: `2025-02-20T07:13:27Z`

## GoldRush Docs Read

- Quickstart: `https://goldrush.dev/docs/goldrush-foundational-api/quickstart`
- LLM docs index: `https://goldrush.dev/docs/llms.txt`
- Transaction summary: `https://goldrush.dev/docs/api-reference/foundational-api/transactions/get-transaction-summary-for-address`
- Paginated transactions v3: `https://goldrush.dev/docs/api-reference/foundational-api/transactions/get-paginated-transactions-for-address-v3`
- Bulk time bucket transactions v3: `https://goldrush.dev/docs/api-reference/foundational-api/transactions/get-time-bucket-transactions-for-address-v3`
- Earliest transactions v3: `https://goldrush.dev/docs/api-reference/foundational-api/transactions/get-earliest-transactions-for-address-v3`
- Recent transactions v3: `https://goldrush.dev/docs/api-reference/foundational-api/transactions/get-recent-transactions-for-address-v3`
- ERC20 transfers: `https://goldrush.dev/docs/api-reference/foundational-api/balances/get-erc20-token-transfers-for-address`
- Historical token balances: `https://goldrush.dev/docs/api-reference/foundational-api/balances/get-historical-token-balances-for-address`
- Block heights: `https://goldrush.dev/docs/api-reference/foundational-api/utility/get-block-heights`
- Cross-chain address activity: `https://goldrush.dev/docs/api-reference/foundational-api/cross-chain/get-address-activity`

## GoldRush API Notes

- Base REST URL: `https://api.covalenthq.com/v1`
- Auth: `Authorization: Bearer <GoldRush API key>`
- Chain names are case-sensitive, for example `eth-mainnet`.
- Pagination is 0-indexed and generally returns up to 100 items/page.
- Balances are raw strings and need `balance / 10^contract_decimals` for token units.
- Historical balances are only supported on Foundational chains; unsupported chains return `501` with a "does not support required features" message.

## Arbitrum `historical_balances` — Always Returns 501

GoldRush `GET /v1/arbitrum-mainnet/address/{wallet}/historical_balances/` always returns:

```
Error: GoldRush 501 /v1/arbitrum-mainnet/address/.../historical_balances/: Chain 'arbitrum-mainnet' does not support required features
```

This means opening and closing balances for this wallet **must be reconstructed from stored transaction history** (not from GoldRush snapshots). The same applies to: `avalanche-mainnet`, `berachain-mainnet`, `plasma-mainnet`, `scroll-mainnet`, `moonbeam-mainnet`, `blast-mainnet`.

## Useful Endpoints

- Discover active chains for an address:
  - `GET /v1/address/{walletAddress}/activity/`
- Store full transaction history:
  - `GET /v1/{chainName}/address/{walletAddress}/transactions_v3/page/{page}/`
  - Includes decoded `log_events` when `no-logs=false`.
- Date/time targeted transaction retrieval:
  - `GET /v1/{chainName}/bulk/transactions/{walletAddress}/{timeBucket}/`
  - Time bucket is `floor(unix_seconds / 900)`.
- Transaction summary:
  - `GET /v1/{chainName}/address/{walletAddress}/transactions_summary/`
  - Good for earliest/latest tx, tx counts, gas summary, and transfer count.
- ERC20 transfer history for a token:
  - `GET /v1/{chainName}/address/{walletAddress}/transfers_v2/?contract-address=...`
- Opening/closing balance snapshots:
  - `GET /v1/{chainName}/address/{walletAddress}/historical_balances/?date=YYYY-MM-DD`
- Block/date mapping:
  - `GET /v1/{chainName}/block_v2/{startDate}/{endDate}/`

## Local Implementation

- Runtime: Node.js ESM.
- Database: SQLite via `better-sqlite3`.
- Database path: `data/nobi-ledger.sqlite`.
- Environment keys supported:
  - `GOLDRUSH_API_KEY`
  - `goldrush_api_key`

## CLI Commands

- Initialize database:
  - `npm run db:init`
- Discover active chains:
  - `npm run ledger:discover -- --address 0xE8c24Ce4c8D3FF7AB82Efd7A74752E7393ff57CB --label "NOBI LABS LEDGER [MF USDT]"`
- Create opening balance:
  - `npm run ledger:opening -- --chain eth-mainnet --date 2025-04-01`
  - Multiple chains can be comma-separated with `--chains`.
- Create closing balance:
  - `npm run ledger:closing -- --chain eth-mainnet --date 2025-04-30`
- Ingest transactions:
  - `npm run ledger:ingest -- --chain eth-mainnet --from 2025-04-01 --to 2025-04-30`
- Generate statement from stored data:
  - `npm run ledger:statement -- --chain eth-mainnet --start 2025-04-01 --end 2025-04-30`

## Database Tables

- `wallets`: tracked wallet labels and addresses.
- `chains`: GoldRush chain metadata.
- `wallet_chains`: discovered wallet activity per chain.
- `transactions`: one row per chain transaction.
- `token_transfers`: decoded ERC20 transfer movements from transaction logs.
- `balance_snapshots`: opening/closing/custom snapshot headers.
- `balance_snapshot_items`: per-token rows in each snapshot.

## Initial Discovery Result (MF USDT Wallet)

The test wallet is active on:

- `eth-mainnet`
- `matic-mainnet`
- `bsc-mainnet`
- `avalanche-mainnet`
- `berachain-mainnet`
- `plasma-mainnet`
- `optimism-mainnet`
- `arbitrum-mainnet`
- `base-mainnet`
- `scroll-mainnet`
- `moonbeam-mainnet`
- `blast-mainnet`

## Opening Balance Created for 2025-04-01 (MF USDT Wallet)

Stored opening snapshots:

- `eth-mainnet`: USD `36.67187`
- `matic-mainnet`: USD `0.00`
- `bsc-mainnet`: USD `0.00`
- `optimism-mainnet`: USD `0.00`
- `base-mainnet`: USD `0.00`

Skipped because historical balances are not supported for this endpoint on those chains:

- `avalanche-mainnet`
- `berachain-mainnet`
- `plasma-mainnet`
- `arbitrum-mainnet`
- `scroll-mainnet`
- `moonbeam-mainnet`
- `blast-mainnet`

## MF USDT Wallet — Arbitrum Ingestion and Balance PDF

Completed:

- Redid Arbitrum storage by deleting previous `arbitrum-mainnet` transaction/snapshot rows and re-ingesting from GoldRush.
- Stored Arbitrum transactions in `data/nobi-ledger.sqlite`.
- Stored transaction count: `138`.
- Stored wallet-side decoded ERC20 transfer count: `148`.
- Stored transaction coverage: `2025-02-18T03:22:19Z` through `2026-04-25T06:20:19Z`.
- PDF generated at `data/NOBI_LABS_LEDGER_[MF_USDT]_arbitrum-mainnet_2025-04-01_to_2025-11-30.pdf`.
- PDF format now matches the provided example: title/period, wallet metadata, opening balance table, transaction table, and closing balance table with USD and AED value columns.
- Deleted unnecessary older PDF: `data/arbitrum-balance-report-2025-04-01-to-2025-11-30.pdf`.

Latest generated report totals from GoldRush transaction and pricing data:

- Opening total: USD `226,938.32`, AED `832,863.62`.
- Closing total: USD `77,094.45`, AED `282,936.62`.

## MF ETH Wallet — Arbitrum (`0x432b5780e008822eCc430506766CCa53D496bafd`)

### Data Ingestion Issue

- Ingested `161` transactions with `--from 2025-04-01 --to 2025-11-30`, which **excluded all pre-2025-04-01 transactions**.
- First ingested tx: `2025-04-09T03:08:41Z`. Wallet had activity back to `2025-02-20T07:13:27Z` but it was not captured.
- Re-ingested **all** transactions without date filter → `185` transactions stored (`2025-02-20` → `2025-11-20`).

### Negative Opening Balance Problem

Reconstructing opening balance from stored transactions gave:

- **Opening ETH balance: -18.790193621335515 ETH** (negative!)
- Root cause: Wallet received +69.35 ETH on `2025-02-20T07:17:42Z` then sent -69.3 ETH + -10.44 ETH + -8.4 ETH on the same day in rapid succession. Our ingested data only captured the **outcome** of these swaps (the net outflow), not the deposit that funded them.

### Manual Compensation Transaction

- Inserted a **manual compensation deposit** on `2025-02-19T00:00:00.000Z` (before first real tx).
- TX hash: `0x0000000000000000000000000000000000000000000000000000000000000001`
- Amount: `18790193621335514719` wei = **18.790193621335515 ETH**
- `from_address`: `0x0000000000000000000000000000000000000000` (zero address)
- `to_address`: wallet address
- `raw_json`: `{ "manual_adjustment": true, "reason": "pre-ingested tx compensation", "note": "opening balance adjustment for missing pre-2025-02-20 transactions" }`
- After insertion: opening ETH balance = **0.00 ETH**

### Opening Balance at 2025-04-01 (reconstructed after compensation)

| Asset | Balance | Notes |
|---|---|---|
| ETH | 0.00 | After compensation; net of all ingested + manual txs |
| aArbWETH | 88.14 | Arbitrum wrapped ETH derivative |
| sMLP | 50,000.00 | MLPs token |
| MUX | 67.14 | MUX token |
| variableDebtArbUSDCn | 99,757.15 | Debt position (outgoing) |
| WETH | 0.179 | |
| NC-Eligible | 13,415 | Likely spam, filtered |

### Closing Balance at 2025-11-30

| Asset | Balance |
|---|---|
| ETH | -28.67 ETH (negative — more outflows than inflows in window; reflects actual net from ingested txs) |
| aArbWETH | 68.34 |
| MUX | 146.60 |
| NC-Eligible | 13,415 |

### PDF

- Generated: `data/NOBI_LABS_LEDGER_[MF_ETH]_arbitrum-mainnet_2025-04-01_to_2025-11-30.pdf`
- Uses same reconstruction-from-transactions approach as MF USDT wallet.

## MF BTC Wallet — Arbitrum (`0xC38aCc4cD96B6Ae2A820910972eA66085D0BbC2A`)

### Discovery & Ingestion

- Active chains: `eth-mainnet`, `matic-mainnet`, `base-mainnet`, `arbitrum-mainnet`, `plasma-mainnet`, `berachain-mainnet`, `scroll-mainnet`, `optimism-mainnet`, `blast-mainnet`.
- **GoldRush `transactions_summary` confirms: exactly 93 total transactions on arbitrum-mainnet.** No more pages — this is the complete history from GoldRush.
- Arbitrum window: `2025-02-20T04:23:31Z` → `2026-04-20T02:33:43Z`.
- Ingested all 93 transactions into SQLite, including decoded `log_events` (Transfer events).

### Token Transfer Breakdown (from GoldRush log_events across all 93 txs)

| Token | Total Transfers | Wallet IN | Wallet OUT | Other (3rd-party swap routing) |
|---|---|---|---|---|
| USDT | 2,622 | 2 | 5 | 2,615 |
| USDC | 1,176 | 3 | 5 | 1,168 |
| WBTC | 92 | 12 | 35 | 45 |
| MUXLP | 8 | 3 | 3 | 2 |
| fMLP | 6 | 3 | 3 | 0 |
| sMLP | 3 | 1 | 2 | 0 |
| MUX | 3 | 1 | 0 | 2 |
| aArbWBTC | 6 | 4 | 2 | 0 |
| variableDebtArbUSDCn | 3 | 1 | 2 | 0 |
| aArbWETH | 4 | 2 | 1 | 1 |

"OTHER" transfers = third-party swap routing through protocol contracts (e.g., MUXLP proxy, GMX router) where the wallet is neither sender nor receiver. These are correctly excluded from wallet balance calculations.

### Negative Opening Balance

Reconstructing from the 93 stored transactions gives **opening ETH: -0.9135802230955768 ETH**.

Breakdown:
- `2025-02-20T04:39:09Z` — IN `+0.01883125496607708` ETH
- `2025-02-20T07:45:23Z` — IN `+0.07061716080834612` ETH
- `2025-02-20T04:47:53Z` — OUT `1.0` ETH (transfer to `0x5760e34c4003752329`)
- Multiple fee-only OUT transactions from `2025-02-20`

### Manual Compensation Transaction

- **Manual compensation deposit** on `2025-02-19T00:00:00.000Z` (before first real tx).
- TX hash: `0x0000000000000000000000000000000000000000000000000000000000000002`
- Amount: `913580223095576802` wei = **0.9135802230955768 ETH**
- `from_address`: `0x0000000000000000000000000000000000000000` (zero address)
- `to_address`: `0xC38aCc4cD96B6Ae2A820910972eA66085D0BbC2A`
- `raw_json`: `{ "manual_adjustment": true, "reason": "pre-ingested tx compensation for MF BTC wallet", "note": "opening balance adjustment — 1 ETH outbound on 2025-02-20 exceeded prior deposits" }`
- After insertion: opening ETH balance = **0.00 ETH**

### Opening Balance at 2025-04-01 (reconstructed after compensation)

| Asset | Balance | Notes |
|---|---|---|
| ETH | 0.00 | After compensation |
| sMLP | 77,801.96 | MLPs token; IN on 2025-02-20, held through opening date |
| aArbWBTC | 2.68232646 | Arbitrum WBTC derivative, decimals 8 |
| aArbWETH | 1.0 | |
| variableDebtArbUSDCn | 116,500 | Debt position |
| NC-Eligible | 12,056 | Spam filter likely removes |
| Visit gettrumps.xyz | 12,568 | Spam filter likely removes |
| MUXLP | 0 | In then out same day 2025-02-20 → net 0 at opening |
| fMLP | 0 | In then out same day 2025-02-20 → net 0 at opening |
| MUX token | 0 | All transfers are OTHER type (3rd-party routing), net 0 for wallet |

### PDF

- Generated: `data/NOBI_LABS_LEDGER_[MF_BTC]_arbitrum-mainnet_2025-04-01_to_2025-11-30.pdf`
- Note: `GoldRush 400` price lookup errors for some contracts — these appear as zero-value rows but don't block PDF generation.

## Wallet — ETH (Mainnet)

- Label: `NOBI LABS LEDGER [ETH]`
- Address: `0x455e53CBB86018Ac2B8092FdCd39d8444aFFC3F6`
- Chain: `eth-mainnet`

### Discovery

Active chains detected via GoldRush `GET /address/{wallet}/activity/`:
- `eth-mainnet` (first seen: `2023-10-25T09:06:23Z`)
- `matic-mainnet` (first seen: `2023-10-25T09:54:25Z`)
- `bsc-mainnet` (first seen: `2023-11-13T08:23:19Z`)
- `avalanche-mainnet` (first seen: `2025-01-13T13:43:35Z`)
- `optimism-mainnet` (first seen: `2024-07-12T03:28:11Z`)
- `base-mainnet` (first seen: `2024-07-11T11:32:11Z`)

### Transaction Summary (GoldRush)

- Total transactions on eth-mainnet: **1,132,632** (massive wallet)
- Earliest tx: `2023-10-25T09:06:23Z`
- Latest tx: `2026-05-06T07:53:11Z`

### Historical Balance Snapshots

GoldRush `GET /eth-mainnet/address/{wallet}/historical_balances/` **IS supported** on eth-mainnet.

**Opening Balance at 2025-04-01:**

| Asset | Balance | USD Value |
|---|---|---|
| POL | 89,272.87 | $18,033.12 |
| MATIC | 7,852.16 | $1,586.14 |
| USDT | 1,305.99 | $1,305.47 |
| WETH | 0.0099 | $18.10 |
| ZIK | 555.56 | $0.07 |
| ETH | 0.00 | $0.00 |
| **TOTAL** | | **$20,942.88** |

**Closing Balance at 2025-11-30:**

| Asset | Balance | USD Value |
|---|---|---|
| POL | 91,704.51 | $12,288.41 |
| USDT | 1,310.62 | $1,310.62 |
| WETH | 0.0099 | $29.68 |
| USDC | 2.00 | $2.00 |
| ZIK | 555.56 | $0.08 |
| SUSHI | 0.0022 | ~$0.00 |
| MOCA | ~0.00 | ~$0.00 |
| ETH | 0.00 | $0.00 |
| **TOTAL** | | **$13,630.79** |

### PDF

- Generated: `data/NOBI_LABS_LEDGER_[ETH]_eth-mainnet_2025-04-01_to_2025-11-30.pdf`
- Format: Opening balance table → Closing balance table (no transaction table — no transaction ingestion performed)

### Notes

- eth-mainnet historical balances are **fully supported** by GoldRush — no transaction reconstruction needed.
- POL token (0x455e53...) had a significant balance, appears to be the wallet's primary asset.
- No ingestion of 1.13M transactions was performed — only balance snapshots were stored via GoldRush historical_balances API.
- Transaction ingestion for this wallet would be prohibitively expensive given the volume (would require ~11,327 pages).

### Bugs Found and Fixed

**Bug: PDF showed all zeros despite correct data**
- Root cause 1: `getHistoricalTokenPrices` sent addresses with lowercase/non-checksummed hex to GoldRush → GoldRush returned `400 Malformed address` for batches containing any address that GoldRush didn't recognize in lowercase form.
- Root cause 2: `priceMapFor` batched addresses in groups of 20, so **one bad address in a batch caused the entire batch to fail** → zero prices for all 20 addresses including the valid ones.
- **Fix 1**: Added `toChecksumAddress()` in `getHistoricalTokenPrices` to EIP-55 checksum all addresses before sending to GoldRush.
- **Fix 2**: Changed `priceMapFor` from batching (20 at a time) to **one address at a time**, so a single unknown/not-found token fails silently without affecting other tokens.
- Addresses with no price history now correctly show `$0.00` rather than silently crashing the price lookup for the whole batch.

**PDF content confirmed correct** after fix (decompressed stream content verified):
- Opening balance header: `$230,700.96 USD` / `AED 839,669.74`
  - aArbWBTC: 2.682326 @ $85,296.42 = $228,792.84 USD
  - aArbWETH: 1.0 @ $1,908.11 = $1,908.11 USD
  - TOTAL row: $230,700.96 USD
- Transaction table: 25 material transactions from 2025-07-16 onward (no transactions between opening date and July 2025)
- Closing balance header: $214,565.12 USD / AED 787,453.99
  - aArbWBTC: 2.362898 @ $90,805.90 = $214,565.12 USD
  - TOTAL row: $214,565.12 USD

## Next Development Steps

1. Add a real app UI for selecting wallet, chains, start date, and end date.
2. Add a chain capability table so unsupported historical balance chains are skipped before API calls.
3. Improve historical transaction ingestion by combining transaction summary, paginated history, and time buckets for precise date ranges without excessive calls.
4. Add accounting classifications for transfers: deposit, withdrawal, internal transfer, gas fee, swap, bridge, stablecoin movement, and unknown.
5. Add generated statement exports: CSV first, then PDF/XLSX.
6. Add reconciliation logic: opening balance + net movements - fees = closing balance, with an exception report.

## New Wallets Added

### METAMASK MAC SEN [ETH] — eth-mainnet (`0x2f5780dd1b6ad5fdae2076d639026a238a876044`)

| Snapshot | Tokens | Total USD |
|----------|--------|-----------|
| Opening 2025-04-01 | 3 | $459.27 |
| Closing 2025-11-30 | 3 | $609.66 |

PDF generated: `data/METAMASK_MAC_SEN_[ETH]_eth-mainnet_2025-04-01_to_2025-11-30.pdf`

### METAMASK MAC SEN [POL] — matic-mainnet (`0x2f5780dd1b6ad5fdae2076d639026a238a876044`)

Same wallet address as [ETH] but on Polygon.

| Snapshot | Tokens | Total USD |
|----------|--------|-----------|
| Opening 2025-04-01 | 1 | $20.20 |
| Closing 2025-11-30 | 1 | $13.30 |

PDF generated: `data/METAMASK_MAC_SEN_[POL]_matic-mainnet_2025-04-01_to_2025-11-30.pdf`

### SAFE EXPENSE [BASE] — base-mainnet (`0x698364F6a2032A47ed5b952b36280d4C0FF97A91`)

| Snapshot | Tokens | Total USD |
|----------|--------|-----------|
| Opening 2025-04-01 | 1 | $0.00 |
| Closing 2025-11-30 | 4 | $603.16 |

PDF generated: `data/SAFE_EXPENSE_[BASE]_base-mainnet_2025-04-01_to_2025-11-30.pdf`

## NOBI LABS LEDGER SOLANA — solana-mainnet (`3hJQ8L8XmDpgdtRbVebh3tYvMFwhtNLyc7SJBHSCfxGo`)

### CSV Ingestion (`sol-ingest`)

- Source CSV: `data/transactionHistory/SOL/NOBI LABS LEDGER SOLANA/1778121458493-activities.csv`
- 614 rows total, stored **197 transactions** after filtering < 0.1 SOL dust
- Filtered **417 dust transactions** (SOL balance change < 0.1 SOL)
- Stored in `data/nobi-ledger.sqlite` — wallet id 58, chain `solana-mainnet`
- Transaction range: `2025-03-06` → `2026-05-02`

### Manual Token Prices

- SOL: **$136.52 USD**
- PYTH: **$0.144 USD**
- USDT: $1.00, USDC: $1.00
- AED/USD: **3.672**

### Balance PDF (`sol-balance-pdf`)

Command:
```
node src/cli.js sol-balance-pdf --opening 2025-04-01 --closing 2025-11-30 \
  --label "NOBI LABS LEDGER SOLANA" --address 3hJQ8L8XmDpgdtRbVebh3tYvMFwhtNLyc7SJBHSCfxGo
```

Output: `data/openingBalance/NOBI_LABS_LEDGER_[SOL]_solana-mainnet_2025-04-01_to_2025-11-30.pdf`

**Opening Balance at 2025-04-01:**
| Asset | Balance | Price USD | Value USD | Value AED |
|-------|---------|-----------|-----------|-----------|
| SOL   | 0.1     | $136.52   | $13.65    | AED 50.11 |
| PYTH  | 150     | $0.144    | $21.60    | AED 79.32 |
| **TOTAL** | | | **$35.25** | **AED 129.45** |

**Closing Balance at 2025-11-30:**
| Asset | Balance | Price USD | Value USD | Value AED |
|-------|---------|-----------|-----------|-----------|
| SOL   | 0.938450 | $136.52  | $127.50   | AED 468.17 |
| USDT  | 50.818852 | $1.00    | $50.82    | AED 186.61 |
| USDC  | 0.030986 | $1.00     | $0.03     | AED 0.11 |
| **TOTAL** | | | **$178.35** | **AED 654.89** |

- Material transactions in period: **112** (filtered ≥ 0.1 SOL or tokens with USD value)

### `balanceRowsAt` Bug Fixed

- Root cause: `BigInt(tx.native_value_raw)` failed when SQLite stored float strings like `"4240016125.0000005"`
- Fix: Added `safeBigInt()` helper that splits on `.` and takes integer part before converting
- Also fixed: `delta_raw` for PYTH tokens stored as floats (e.g. `"36850.000000000015"`)

### `nativeSymbol()` Fix

- `balanceRowsAt` always labelled native token as "ETH" regardless of chain
- Added `nativeSymbol(chainName)` → returns "SOL" for solana-mainnet, "ETH" otherwise
- Solana transactions now correctly show SOL instead of ETH in balance tables

## PINK WALLET [PYTH] — solana-mainnet (`Ckbi1nHQoLEJDLt58rm5EJaqPFsDS6V8FbCs5hYZQuQU`)

### CSV Ingestion (`sol-ingest`)

- Source CSV: `data/transactionHistory/SOL/PinkWalletSol/1778124168844-activities.csv`
- 257 rows total, stored **65 transactions** after filtering < 0.1 SOL dust
- Filtered **192 dust transactions**
- Stored in `data/nobi-ledger.sqlite` — wallet id 59, chain `solana-mainnet`
- Transaction range: `2023-11-18` → `2026-05-06`

### Manual Token Prices

- SOL: **$136.52 USD**
- PYTH: **$0.144 USD**
- USDT: $1.00, USDC: $1.00
- AED/USD: **3.672**

### Opening Balance PDF (`pink-opening-pdf`)

Command:
```
node src/cli.js pink-opening-pdf --address Ckbi1nHQoLEJDLt58rm5EJaqPFsDS6V8FbCs5hYZQuQU \
  --label "PINK WALLET [PYTH]" --date 2025-04-01
```

Output: `data/openingBalance/openingBalance_PINK_WALLET_[PYTH]_solana-mainnet_2025-04-01_STAKED.pdf`

**Opening Balance at 2025-04-01:**
| Asset | Balance | Price USD | Value USD | Value AED | % Portfolio |
|-------|---------|-----------|-----------|-----------|-------------|
| PYTH  | 150     | $0.144    | $21.60    | AED 79.32 | 100.0%      |
| **TOTAL** | | | **$21.60** | **AED 79.32** | **100%** |

- PYTH received in a large deposit on 2025-02-17 (187,500 PYTH), with subsequent smaller transfers. By 2025-04-01, net PYTH balance = 150.
- No SOL at opening (all SOL dust transactions filtered).

### Wallet Statement PDF (`pink-statement-pdf`)

Command:
```
node src/cli.js pink-statement-pdf --address Ckbi1nHQoLEJDLt58rm5EJaqPFsDS6V8FbCs5hYZQuQU \
  --label "PINK WALLET [PYTH]" --opening 2025-04-01 --closing 2025-11-30
```

Output: `data/PINK_WALLET_[PYTH]_solana-mainnet_2025-04-01_to_2025-11-30.pdf`

**Opening Balance at 2025-04-01:**
| Asset | Balance | Price USD | Value USD | Value AED |
|-------|---------|-----------|-----------|-----------|
| PYTH  | 150     | $0.144    | $21.60    | AED 79.32 |
| **TOTAL** | | | **$21.60** | **AED 79.32** |

**Closing Balance at 2025-11-30:**
| Asset | Balance | Price USD | Value USD | Value AED |
|-------|---------|-----------|-----------|-----------|
| SOL   | ~0.058  | $136.52   | ~$7.90    | ~AED 29.02 |
| PYTH  | 0        | $0.144    | $0.00     | $0.00 |
| **TOTAL** | | | **~$7.90** | **~AED 29.02** |

- All PYTH tokens were staked/unstaked and sent out during the period — net 0 at closing.
- SOL accumulated via staking rewards (tiny amounts per transaction) — ~0.058 SOL at closing.
- Material transactions: multiple PYTH stake/unstake operations and corresponding SOL fee payments.

## NOBI LABS LEDGER [POL] — matic-mainnet (`0x455e53CBB86018Ac2B8092FdCd39d8444aFFC3F6`)

### Data Ingestion

- Same address as NOBI LABS LEDGER [ETH] (wallet id 33)
- Ingested **2,885 matic-mainnet transactions** via GoldRush (`--max-pages 50`)
- Transaction range: `2023-10-25` → `2026-05-05`
- Note: ingested txs only cover a subset — the wallet's actual full history is much larger (1.13M txs on eth-mainnet alone)

### Opening Balance at 2025-04-01 (reconstructed from transactions)

| Asset | Balance | Price USD | Value USD | Value AED |
|-------|---------|-----------|-----------|-----------|
| POL | 22,380.61 | $0.202 | $4,520.88 | AED 16,600.69 |
| USDT | 600.29 | $1.00 | $600.29 | AED 2,203.46 |
| USDC | 5.01 | $1.00 | $5.01 | AED 18.40 |
| WETH | 0.0056 | ~$1,900 | ~$10.64 | ~AED 39.07 |
| + spam tokens | — | — | — | — |

Opening total: **~$5,136.82 USD** / **AED 18,861.62** (including spam tokens)

### Closing Balance at 2025-11-30 (reconstructed from transactions)

- POL: ~89,272.87 (accumulated from staking/delegation rewards during period)
- USDT: ~1,305.99
- MATIC (native): 7,852.16 (delegated staking position)
- Significant spam/aidrop token activity filtered

### Commands

Opening balance PDF:
```
node src/cli.js opening-balance-pdf --address 0x455e53CBB86018Ac2B8092FdCd39d8444aFFC3F6 \
  --label "NOBI LABS LEDGER [POL]" --chain matic-mainnet --date 2025-04-01
```
Output: `data/openingBalance/opening_balance_NOBI_LABS_LEDGER_[POL]_matic-mainnet_2025-04-01_STAKED.pdf`

Statement PDF (opening → closing):
```
node src/cli.js balance-pdf --address 0x455e53CBB86018Ac2B8092FdCd39d8444aFFC3F6 \
  --label "NOBI LABS LEDGER [POL]" --chain matic-mainnet --opening 2025-04-01 --closing 2025-11-30
```
Output: `data/NOBI_LABS_LEDGER_[POL]_matic-mainnet_2025-04-01_to_2025-11-30.pdf`

### Notes

- Same wallet address as NOBI LABS LEDGER [ETH] on eth-mainnet — multi-chain wallet
- POL token price used from GoldRush quote: **$0.202 USD** at time of report
- AED/USD rate: **3.672**
- Heavy spam/airdrop token activity in transfer history — filtered out by `isLikelySpamToken`
- MATIC is the native gas token for Polygon; POL is the staking/delegation token (different contract address)
