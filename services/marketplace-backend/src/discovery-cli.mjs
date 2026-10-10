/**
 * Operator entry point for contract discovery (#110). Discovery is opt-in and
 * writes only its own chain.discovery_* / contract tables; it never registers
 * collections or changes trading policy.
 *
 *   node src/discovery-cli.mjs probe            # provider capabilities and history availability
 *   node src/discovery-cli.mjs scan [toHead]    # one bounded step, or repeat until caught up
 *   node src/discovery-cli.mjs status           # coverage, gaps and counts
 *
 * It needs only its own migration (005), not the marketplace registry identity.
 * Env: DATABASE_URL (PostgreSQL), MARKETPLACE_CHAIN (SN_MAIN or SN_SEPOLIA),
 * MARKETPLACE_RPC_URL and optional MARKETPLACE_RPC_FALLBACK_URL,
 * DISCOVERY_START_BLOCK (default 0), DISCOVERY_MAX_BLOCKS (default 500),
 * DISCOVERY_BATCH_BLOCKS (default 32), DISCOVERY_MAX_REORG_DEPTH (default 64).
 */
import pg from "pg";
import { RpcClient } from "./rpc.mjs";
import { PgDiscoveryStore } from "./postgres/discovery-store.mjs";
import {
  discoveryStatus,
  probeDiscovery,
  scanDiscovery,
  scanDiscoveryToHead,
} from "./discovery.mjs";

const integer = (name, fallback) => {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error(`${name} must be a nonnegative integer.`);
  return value;
};
const command = process.argv[2] ?? "status";
if (!["probe", "scan", "status"].includes(command))
  throw new Error("Choose probe, scan or status.");
const chain = process.env.MARKETPLACE_CHAIN ?? "SN_MAIN",
  chainId = {
    SN_MAIN: "0x534e5f4d41494e",
    SN_SEPOLIA: "0x534e5f5345504f4c4941",
  }[chain];
if (!chainId) throw new Error("Discovery runs on SN_MAIN or SN_SEPOLIA.");
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required.");
const urls = [
  process.env.MARKETPLACE_RPC_URL,
  process.env.MARKETPLACE_RPC_FALLBACK_URL,
].filter(Boolean);
const rpc = urls.length ? new RpcClient(urls) : null,
  pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    max: 2,
    application_name: "marketplace-discovery",
  });
try {
  const store = new PgDiscoveryStore(pool),
    startBlock = integer("DISCOVERY_START_BLOCK", 0);
  if (command !== "status" && !rpc)
    throw new Error("MARKETPLACE_RPC_URL is required.");
  let output;
  if (command === "probe") output = await probeDiscovery({ rpc, startBlock });
  else if (command === "status") output = await discoveryStatus(store, chain);
  else {
    const options = {
      rpc,
      store,
      chain,
      chainId,
      startBlock,
      maxBlocks: integer("DISCOVERY_MAX_BLOCKS", 500),
      batchBlocks: integer("DISCOVERY_BATCH_BLOCKS", 32),
      maxReorgDepth: integer("DISCOVERY_MAX_REORG_DEPTH", 64),
    };
    const started = performance.now();
    output = await (process.argv[3] === "toHead"
      ? scanDiscoveryToHead(options)
      : scanDiscovery(options));
    output.seconds = Number(((performance.now() - started) / 1000).toFixed(3));
    output.rpcRateLimits = rpc.rateLimits;
  }
  console.log(JSON.stringify(output, null, 2));
} finally {
  await pool.end();
}
