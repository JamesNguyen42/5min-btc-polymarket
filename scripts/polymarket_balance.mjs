import process from "node:process";
import { AssetType, ClobClient } from "@polymarket/clob-client-v2";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";

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

function collateralUnits(raw) {
  if (raw === null || raw === undefined || raw === "") return null;
  const text = String(raw);
  if (text.includes(".") || text.toLowerCase().includes("e")) {
    const parsed = Number(text);
    return Number.isFinite(parsed) ? parsed : null;
  }
  try {
    const units = BigInt(text);
    const whole = units / 1_000_000n;
    const fraction = units % 1_000_000n;
    return Number(`${whole}.${fraction.toString().padStart(6, "0")}`);
  } catch {
    const parsed = Number(text);
    return Number.isFinite(parsed) ? parsed : null;
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
  if (!creds) {
    const keyClient = new ClobClient({ host, chain: chainId, signer });
    creds = await keyClient.createOrDeriveApiKey();
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
  const balance = await client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
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
      checkedAt: new Date().toISOString(),
    }),
  );
}

main().catch((err) => {
  process.stderr.write(`${err.stack || err.message || String(err)}\n`);
  process.exit(1);
});
