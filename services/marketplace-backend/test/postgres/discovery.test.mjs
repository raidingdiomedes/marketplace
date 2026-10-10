import { test } from "node:test";
import assert from "node:assert/strict";
import { testDatabase } from "./helpers.mjs";
import { migrate } from "../../src/postgres/migrate.mjs";
import { PgStore } from "../../src/postgres/store.mjs";
import { PgDiscoveryStore } from "../../src/postgres/discovery-store.mjs";
import {
  scanDiscovery,
  scanDiscoveryToHead,
  discoveryStatus,
} from "../../src/discovery.mjs";
import {
  discoveryScenarios,
  historyFixture,
} from "../fixtures/discovery-scenarios.mjs";

async function fixture(t) {
  const db = await testDatabase(t),
    pool = db.pool();
  await migrate(pool);
  return { pool, store: new PgDiscoveryStore(pool) };
}

discoveryScenarios("postgres", async (t) => (await fixture(t)).store);

const options = (chain, store) => ({
  rpc: chain.rpc,
  store,
  chain: "SN_MAIN",
  chainId: "0x534e5f4d41494e",
});

test("postgres: a crash while writing a batch leaves discoveries and checkpoint at the previous commit", async (t) => {
  const { store } = await fixture(t),
    chain = historyFixture();
  await scanDiscovery({ ...options(chain, store), maxBlocks: 2 });
  const committed = await discoveryStatus(store, "SN_MAIN");
  const snapshot = await store.listDiscoveredContracts("SN_MAIN");
  const query = store.query.bind(store);
  let writes = 0;
  store.query = (sql, params) => {
    if (/^UPDATE chain\.discovery_scans/.test(sql) && ++writes === 1)
      throw Object.assign(new Error("simulated crash"), { code: "CRASH" });
    return query(sql, params);
  };
  await assert.rejects(
    scanDiscoveryToHead(options(chain, store)),
    (e) => e.code === "CRASH",
  );
  store.query = query;
  assert.deepEqual(await discoveryStatus(store, "SN_MAIN"), committed);
  assert.deepEqual(await store.listDiscoveredContracts("SN_MAIN"), snapshot);
  await scanDiscoveryToHead(options(chain, store));
  assert.equal((await discoveryStatus(store, "SN_MAIN")).checkpoint.number, 5);
});

test("postgres: discovery does not wait on, or write to, the marketplace projection writer", async (t) => {
  const { pool, store } = await fixture(t),
    marketplace = new PgStore(pool),
    chain = historyFixture();
  const before = (
    await pool.query("SELECT COUNT(*)::int AS n FROM chain.blocks")
  ).rows[0].n;
  let release;
  const held = marketplace.transaction(
    () => new Promise((resolve) => (release = resolve)),
  );
  while (!release) await new Promise((r) => setTimeout(r, 5));
  let result, timer;
  try {
    result = await Promise.race([
      scanDiscoveryToHead(options(chain, store)),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("blocked by marketplace writer")),
          5000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
    release();
    await held;
  }
  assert.equal(result.checkpoint.number, 5);
  assert.equal(
    (await pool.query("SELECT COUNT(*)::int AS n FROM chain.blocks")).rows[0].n,
    before,
  );
});

test("postgres: migration 5 is additive and leaves existing marketplace tables untouched", async (t) => {
  const { pool } = await fixture(t);
  const tables = (
    await pool.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema='chain' AND (table_name LIKE 'discover%' OR table_name='contract_discoveries') ORDER BY 1",
    )
  ).rows.map((r) => r.table_name);
  assert.deepEqual(tables, [
    "contract_discoveries",
    "discovered_contracts",
    "discovery_blocks",
    "discovery_scans",
  ]);
  await migrate(pool);
  assert.equal(
    (
      await pool.query(
        "SELECT COUNT(*)::int AS n FROM public.marketplace_migrations",
      )
    ).rows[0].n,
    5,
  );
});
