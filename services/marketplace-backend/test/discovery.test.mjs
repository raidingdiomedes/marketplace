import { test } from "node:test";
import assert from "node:assert/strict";
import {
  probeDiscovery,
  scanDiscovery,
  scanDiscoveryToHead,
  discoveryStatus,
} from "../src/discovery.mjs";
import { MemoryDiscoveryStore } from "./fixtures/discovery-memory-store.mjs";
import { discoveryScenarios } from "./fixtures/discovery-scenarios.mjs";
import { fakeChain, hex } from "./fixtures/discovery-chain.mjs";

discoveryScenarios("memory", async () => new MemoryDiscoveryStore());

const options = (chain, extra = {}) => ({
  rpc: chain.rpc,
  store: new MemoryDiscoveryStore(),
  chain: "SN_MAIN",
  chainId: "0x534e5f4d41494e",
  ...extra,
});

test("probe reports RPC capabilities and finds the first available block in logarithmic requests", async () => {
  const chain = fakeChain({ specVersion: "0.8.1" }).empty(5000);
  chain.firstAvailable = 3071;
  const probe = await probeDiscovery({ rpc: chain.rpc, startBlock: 0 });
  assert.equal(probe.specVersion, "0.8.1");
  assert.equal(probe.head, 4999);
  assert.equal(probe.firstAvailable, 3071);
  assert.deepEqual(probe.methods, {
    starknet_getStateUpdate: true,
    starknet_getBlockWithReceipts: true,
  });
  assert.deepEqual(probe.gaps, [
    { from: 0, to: 3070, reason: "history_unavailable" },
  ]);
  assert.ok(
    chain.requests <= 20,
    `expected a bounded search, used ${chain.requests}`,
  );
});

test("probe starting inside available history records no gap", async () => {
  const chain = fakeChain().empty(50);
  const probe = await probeDiscovery({ rpc: chain.rpc, startBlock: 10 });
  assert.equal(probe.firstAvailable, 10);
  assert.deepEqual(probe.gaps, []);
});

test("a provider without state updates is refused instead of scanned partially", async () => {
  const chain = fakeChain({ unsupported: ["starknet_getStateUpdate"] }).empty(
    5,
  );
  const probe = await probeDiscovery({ rpc: chain.rpc, startBlock: 0 });
  assert.equal(probe.methods.starknet_getStateUpdate, false);
  await assert.rejects(
    scanDiscovery(options(chain)),
    (e) => e.code === "RPC_CAPABILITY_MISSING",
  );
});

test("a provider on another chain is refused", async () => {
  const chain = fakeChain({ chainId: "0x534e5f5345504f4c4941" }).empty(3);
  await assert.rejects(
    scanDiscovery(options(chain)),
    (e) => e.code === "CHAIN_MISMATCH",
  );
});

test("an existing scan cannot silently change its coverage start", async () => {
  const chain = fakeChain().empty(10),
    opts = options(chain, { startBlock: 2 });
  await scanDiscoveryToHead(opts);
  await assert.rejects(
    scanDiscovery({ ...opts, startBlock: 0 }),
    (e) => e.code === "DISCOVERY_COVERAGE_CHANGED",
  );
});

test("a state update that belongs to another block is rejected and nothing is applied", async () => {
  const chain = fakeChain().empty(3);
  chain.add({ deployed: [[hex(0x1), hex(0x2)]], stateHash: "0xdead" });
  const opts = options(chain);
  await assert.rejects(
    scanDiscoveryToHead(opts),
    (e) => e.code === "CHAIN_CONFLICT",
  );
  const status = await discoveryStatus(opts.store, "SN_MAIN");
  assert.equal(status.checkpoint, null);
  assert.equal(status.counts.contracts, 0);
});

test("a malformed deployment entry fails the batch rather than dropping the contract", async () => {
  const chain = fakeChain().empty(2);
  chain.add({ deployed: [["not-an-address", hex(0x2)]] });
  const opts = options(chain);
  await assert.rejects(
    scanDiscoveryToHead(opts),
    (e) => e.code === "INVALID_INTEGER",
  );
  assert.equal((await discoveryStatus(opts.store, "SN_MAIN")).checkpoint, null);
});

test("benchmark: historical acquisition stays within the request budget", async (t) => {
  const chain = fakeChain();
  for (let n = 0; n < 4000; n++)
    chain.add(
      n % 10 === 0
        ? {
            deployed: [[hex(0x10000 + n), hex(0xc0 + (n % 7))]],
            transactions: [
              {
                hash: hex(0xf0000 + n),
                events: [[hex(0x10000 + n), ["0x1"], []]],
              },
            ],
          }
        : {},
    );
  const opts = options(chain, { maxBlocks: 500, batchBlocks: 32 }),
    started = performance.now();
  const result = await scanDiscoveryToHead(opts);
  const seconds = (performance.now() - started) / 1000,
    status = await discoveryStatus(opts.store, "SN_MAIN");
  assert.equal(result.checkpoint.number, 3999);
  assert.equal(status.counts.deployed, 400);
  // Two calls per block in batches of 64 calls, plus a small fixed cost per round.
  const budget = Math.ceil(4000 / 32) + 8 * Math.ceil(4000 / 500) + 20;
  assert.ok(
    chain.requests <= budget,
    `${chain.requests} requests exceeds ${budget}`,
  );
  t.diagnostic(
    `blocks=4000 requests=${chain.requests} calls=${chain.calls} seconds=${seconds.toFixed(3)} blocksPerSecond=${Math.round(4000 / seconds)}`,
  );
});
