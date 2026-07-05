import process from "node:process";
import { pathToFileURL } from "node:url";
import { AssetType, ClobClient } from "@polymarket/clob-client-v2";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";

const PUSD_DECIMALS = 1_000_000n;

function requireEnv(name, fallback = "") {
  const value = process.env[name] || fallback;
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function envAny(names, fallback = "") {
  for (const name of names) {
    if (process.env[name]) return process.env[name];
  }
  return fallback;
}

function apiCredsFromEnv() {
  const key = envAny(["POLYMARKET_API_KEY", "PM_API"]);
  const secret = envAny(["POLYMARKET_API_SECRET", "PM_API_SECRET_KEY"]);
  const passphrase = envAny(["POLYMARKET_API_PASSPHRASE", "PM_API_PASSPHRASE", "PM_API_PASS_PHRASE"]);
  return key && secret && passphrase ? { key, secret, passphrase } : null;
}

function normalizePrivateKey(value) {
  return value.startsWith("0x") ? value : `0x${value}`;
}

function decimalStringToNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function microUnitsToNumber(units) {
  const sign = units < 0n ? -1 : 1;
  const absUnits = units < 0n ? -units : units;
  const whole = absUnits / PUSD_DECIMALS;
  const fraction = absUnits % PUSD_DECIMALS;
  const parsed = Number(`${whole}.${fraction.toString().padStart(6, "0")}`);
  return Number.isFinite(parsed) ? parsed * sign : null;
}

export function collateralUnits(raw, unit = process.env.POLYMARKET_BALANCE_UNIT || "auto") {
  if (raw === null || raw === undefined || raw === "") return null;
  const text = String(raw).trim();
  if (!text) return null;
  if (text.includes(".") || text.toLowerCase().includes("e")) {
    return decimalStringToNumber(text);
  }
  try {
    const units = BigInt(text);
    const normalizedUnit = String(unit || "auto").toLowerCase();
    if (normalizedUnit === "micro" || normalizedUnit === "microusd" || normalizedUnit === "raw") {
      return microUnitsToNumber(units);
    }
    if (normalizedUnit === "dollars" || normalizedUnit === "usd") {
      return decimalStringToNumber(text);
    }

    // CLOB versions have returned collateral either as direct pUSD strings
    // ("8") or 6-decimal token units ("8000000"). Values with 6+ integer
    // digits are treated as token units; smaller whole numbers are dollars.
    if (text.replace(/^-/, "").length >= 6) {
      return microUnitsToNumber(units);
    }
    return decimalStringToNumber(text);
  } catch {
    return decimalStringToNumber(text);
  }
}

async function main() {
  const privateKey = normalizePrivateKey(
    requireEnv("POLYMARKET_PRIVATE_KEY", envAny(["PM_PRIVATE_KEY", "PRIVATE_KEY"])),
  );
  const account = privateKeyToAccount(privateKey);
  const host = (process.env.POLYMARKET_CLOB_BASE_URL || "https://clob.polymarket.com").replace(/\/$/, "");
  const chainId = Number(process.env.POLYMARKET_CHAIN_ID || 137);
  const chain = chainId === polygon.id ? polygon : { ...polygon, id: chainId };
  const signer = createWalletClient({ account, chain, transport: http() });

  let creds = apiCredsFromEnv();
  let apiCredsSource = "env";
  if (!creds) {
    const keyClient = new ClobClient({ host, chain: chainId, signer });
    creds = await keyClient.createOrDeriveApiKey();
    apiCredsSource = "derived";
  }

  const signatureType = Number(envAny(["POLYMARKET_SIGNATURE_TYPE", "PM_SIGNATURE_TYPE"], "3"));
  if (![0, 1, 2, 3].includes(signatureType)) {
    throw new Error("POLYMARKET_SIGNATURE_TYPE must be 0, 1, 2, or 3");
  }
  const funderAddress = envAny(["POLYMARKET_FUNDER_ADDRESS", "PM_FUNDER_ADDRESS"], signatureType === 0 ? account.address : "");
  if (!funderAddress) {
    throw new Error("POLYMARKET_FUNDER_ADDRESS is required unless POLYMARKET_SIGNATURE_TYPE=0");
  }

  const client = new ClobClient({
    host,
    chain: chainId,
    signer,
    creds,
    signatureType,
    funderAddress,
  });
  const balanceParams = { asset_type: AssetType.COLLATERAL };
  let balance = await client.getBalanceAllowance(balanceParams);
  let refreshed = false;
  let refreshError = null;

  if (collateralUnits(balance.balance) === 0 || process.env.POLYMARKET_REFRESH_BALANCE_ON_READ === "1") {
    try {
      await client.updateBalanceAllowance(balanceParams);
      refreshed = true;
      balance = await client.getBalanceAllowance(balanceParams);
    } catch (err) {
      refreshError = err.message || String(err);
    }
  }

  const rawAllowance =
    balance.allowance ??
    (balance.allowances && Object.values(balance.allowances).find((value) => value !== undefined && value !== null)) ??
    null;

  process.stdout.write(
    JSON.stringify({
      ok: true,
      balance,
      availableCash: collateralUnits(balance.balance),
      allowance: collateralUnits(rawAllowance),
      rawBalance: balance.balance ?? null,
      rawAllowance,
      refreshed,
      refreshError,
      signerAddress: account.address,
      funderAddress,
      signatureType,
      apiCredsSource,
      checkedAt: new Date().toISOString(),
    }),
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    process.stderr.write(`${err.stack || err.message || String(err)}\n`);
    process.exit(1);
  });
}
