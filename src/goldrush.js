import "dotenv/config";

const API_BASE = "https://api.covalenthq.com/v1";

export function getApiKey() {
  const key = process.env.GOLDRUSH_API_KEY || process.env.goldrush_api_key;
  if (!key) {
    throw new Error("Missing GoldRush API key. Set GOLDRUSH_API_KEY or goldrush_api_key in .env.");
  }
  return key.trim();
}

export async function goldrushGet(path, params = {}) {
  const url = new URL(`${API_BASE}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${getApiKey()}`,
      Accept: "application/json",
    },
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.error) {
    const message = payload.error_message || payload.message || response.statusText;
    throw new Error(`GoldRush ${response.status} ${url.pathname}: ${message}`);
  }

  return payload.data || payload;
}

export function normalizeChainName(activityItem) {
  const ext = activityItem.extends || activityItem;
  return ext.name || ext.db_schema_name || ext.label;
}

export async function getAddressActivity(walletAddress, { testnets = false } = {}) {
  return goldrushGet(`/address/${walletAddress}/activity/`, { testnets });
}

export async function getTransactionPage(chainName, walletAddress, page, options = {}) {
  return goldrushGet(`/${chainName}/address/${walletAddress}/transactions_v3/page/${page}/`, {
    "quote-currency": options.quoteCurrency || "USD",
    "no-logs": options.noLogs ?? false,
    "block-signed-at-asc": options.asc ?? true,
  });
}

export async function getHistoricalBalances(chainName, walletAddress, date, options = {}) {
  return goldrushGet(`/${chainName}/address/${walletAddress}/historical_balances/`, {
    "quote-currency": options.quoteCurrency || "USD",
    "no-spam": options.noSpam ?? true,
    date,
  });
}

export function toChecksumAddress(address) {
  if (!address || address.length !== 42 || !address.startsWith("0x")) {
    return address;
  }
  const addr = address.slice(2).toLowerCase();
  const hash = Buffer.from(addr, "hex");
  let checksum = "0x";
  for (let i = 0; i < addr.length; i++) {
    const c = addr[i];
    if (c >= "0" && c <= "9") {
      checksum += c;
    } else {
      const bytePos = Math.floor(i / 2);
      const bitPos = i % 2 === 0 ? 7 : 3;
      const hashByte = hash[bytePos] || 0;
      const bit = (hashByte >> bitPos) & 1;
      checksum += bit ? c.toUpperCase() : c;
    }
  }
  return checksum;
}

export async function getHistoricalTokenPrices(chainName, contractAddresses, options = {}) {
  const rawAddresses = Array.isArray(contractAddresses)
    ? contractAddresses
    : [contractAddresses];
  const addresses = rawAddresses.map(toChecksumAddress).join(",");
  return goldrushGet(
    `/pricing/historical_by_addresses_v2/${chainName}/${options.quoteCurrency || "USD"}/${addresses}/`,
    {
      from: options.from,
      to: options.to,
      "prices-at-asc": options.asc ?? true,
    }
  );
}
