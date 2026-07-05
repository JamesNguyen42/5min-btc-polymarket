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

function apiCredsFromEnv() {
  const key = process.env.POLYMARKET_API_KEY || "";
  const secret = process.env.POLYMARKET_API_SECRET || "";
  const passphrase = process.env.POLYMARKET_API_PASSPHRASE || "";
  return key && secret && passphrase ? { key, secret, passphrase } : null;
}

function normalizePrivateKey(value) {
  return value.startsWith("0x") ? value : `0x${value}`;
}

async function main() {
  const input = JSON.parse(await readStdin());
  const privateKey = normalizePrivateKey(requireEnv("POLYMARKET_PRIVATE_KEY", process.env.PRIVATE_KEY || ""));
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

  const signatureType = Number(process.env.POLYMARKET_SIGNATURE_TYPE || 3);
  if (![0, 1, 2, 3].includes(signatureType)) {
    throw new Error("POLYMARKET_SIGNATURE_TYPE must be 0, 1, 2, or 3");
  }
  const funderAddress = process.env.POLYMARKET_FUNDER_ADDRESS || (signatureType === 0 ? account.address : "");
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

  process.stdout.write(
    JSON.stringify({
      ok: true,
      order,
      tokenId: String(input.tokenId),
      side,
      amount,
      price,
      marketSlug: input.marketSlug || null,
      strategy: input.strategy || null,
    }),
  );
}

main().catch((err) => {
  process.stderr.write(`${err.stack || err.message || String(err)}\n`);
  process.exit(1);
});
