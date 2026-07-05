import process from "node:process";
import { ClobClient, OrderType, Side } from "@polymarket/clob-client-v2";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";

function readStdin() {
  return new Promise((resolve, reject) => {
    let body = "";
    process.stdin.on("data", (chunk) => {
      body += chunk.toString();
    });
    process.stdin.on("end", () => resolve(body));
    process.stdin.on("error", reject);
  });
}

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

function arrayValue(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (value === undefined || value === null || value === "") return [];
  return [value];
}

function rawUsdcValue(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n / 1_000_000 : null;
}

function orderFillSummary(order) {
  const status = String(order?.status || "").toLowerCase();
  const success = order?.success === true;
  const errorMsg = String(order?.errorMsg || order?.error || "").trim();
  const transactionHashes = arrayValue(order?.transactionsHashes || order?.transactionHashes);
  const tradeIds = arrayValue(order?.tradeIDs || order?.tradeIds);
  const filledCostUsd = rawUsdcValue(order?.makingAmount);
  const filledContracts = rawUsdcValue(order?.takingAmount);
  const hasFillAmounts =
    Number.isFinite(filledCostUsd) && filledCostUsd > 0 && Number.isFinite(filledContracts) && filledContracts > 0;
  const hasExecutionIds = transactionHashes.length > 0 || tradeIds.length > 0;
  const filled = success && status === "matched" && hasFillAmounts && hasExecutionIds;
  const accepted = success && !errorMsg;
  return {
    accepted,
    filled,
    status: status || (success ? "accepted" : "rejected"),
    success,
    errorMsg,
    orderId: order?.orderID || order?.orderId || order?.id || null,
    transactionHashes,
    tradeIds,
    filledCostUsd: filled ? Number(filledCostUsd.toFixed(6)) : 0,
    filledContracts: filled ? Number(filledContracts.toFixed(6)) : 0,
    averagePrice: filled && filledContracts > 0 ? Number((filledCostUsd / filledContracts).toFixed(6)) : null,
    reason: filled
      ? "matched"
      : errorMsg || (status ? `CLOB status ${status}` : "CLOB response did not report a matched fill"),
  };
}

async function main() {
  const input = JSON.parse(await readStdin());
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
  const side = String(input.side || "BUY").toUpperCase() === "SELL" ? Side.SELL : Side.BUY;
  const tickSize = String(input.tickSize || "0.01");
  const amount = Number(input.amount);
  const price = Number(input.price);
  if (!input.tokenId) throw new Error("tokenId is required");
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("amount must be positive");
  if (!Number.isFinite(price) || price <= 0 || price >= 1) throw new Error("price must be between 0 and 1");

  const order = await client.createAndPostMarketOrder(
    {
      tokenID: String(input.tokenId),
      side,
      amount,
      price,
    },
    {
      tickSize,
      negRisk: input.negRisk === true,
    },
    OrderType.FOK,
  );
  const fill = orderFillSummary(order);

  process.stdout.write(
    JSON.stringify({
      ok: fill.accepted,
      order,
      fill,
      tokenId: String(input.tokenId),
      side,
      amount,
      price,
      marketSlug: input.marketSlug || null,
      strategy: input.strategy || null,
      apiCredsSource,
    }),
  );
}

main().catch((err) => {
  process.stderr.write(`${err.stack || err.message || String(err)}\n`);
  process.exit(1);
});
