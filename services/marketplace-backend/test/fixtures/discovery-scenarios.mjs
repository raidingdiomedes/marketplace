import { test } from "node:test";
import assert from "node:assert/strict";
import {
  discoveryStatus,
  scanDiscovery,
  scanDiscoveryToHead,
} from "../../src/discovery.mjs";
import { address } from "../../src/domain.mjs";
import {
  fakeChain,
  CONTRACT_DEPLOYED,
  UPGRADED,
  hex,
} from "./discovery-chain.mjs";

const A = (n) => address(n),
  felt = (n) => "0x" + BigInt(n).toString(16).padStart(64, "0");
const options = (chain, extra = {}) => ({
  rpc: chain.rpc,
  chain: "SN_MAIN",
  chainId: "0x534e5f4d41494e",
  maxBlocks: 1000,
  ...extra,
});
const byAddress = async (store) =>
  Object.fromEntries(
    (await store.listDiscoveredContracts("SN_MAIN")).map((c) => [c.address, c]),
  );

/** A short history with every provenance path discovery must handle. */
export function historyFixture() {
  const chain = fakeChain();
  chain.add(); // 0: genesis, empty
  chain.add({
    // 1: legacy DEPLOY transaction plus a factory deploy_syscall with no events
    deployed: [
      [hex(0x100), hex(0xc1)],
      [hex(0x101), hex(0xc2)],
      [hex(0x103), hex(0xc2)],
    ],
    transactions: [
      { hash: "0xa1", type: "DEPLOY", contractAddress: hex(0x100) },
    ],
  });
  chain.add({
    // 2: UDC deployment whose constructor emits its own event first
    deployed: [[hex(0x102), hex(0xc3)]],
    transactions: [
      { hash: "0xb0" },
      {
        hash: "0xb1",
        events: [
          [hex(0x102), ["0x99"], ["0x1"]],
          [
            hex(0x4a),
            [CONTRACT_DEPLOYED],
            [hex(0x102), hex(0x9), "0x0", hex(0xc3)],
          ],
        ],
      },
    ],
  });
  chain.add(); // 3: empty
  chain.add({
    // 4: class replacements announced by an Upgraded event, by a custom event
    // carrying the new class hash, and by nothing at all
    replaced: [
      [hex(0x100), hex(0xd1)],
      [hex(0x101), hex(0xd2)],
      [hex(0x103), hex(0xd3)],
    ],
    transactions: [
      { hash: "0xc1", events: [[hex(0x100), [UPGRADED], [hex(0xd1)]]] },
      { hash: "0xc2", events: [[hex(0x103), ["0x2b2d"], [hex(0xd3)]]] },
    ],
  });
  chain.add({
    // 5: emitters: an older contract never seen deployed, a known one, and a
    // reverted transaction that must not count
    transactions: [
      { hash: "0xd1", events: [[hex(0x500), ["0x7"], []]] },
      { hash: "0xd2", events: [[hex(0x102), ["0x7"], []]] },
      { hash: "0xd3", reverted: true, events: [[hex(0x501), ["0x7"], []]] },
    ],
  });
  return chain;
}

export function discoveryScenarios(label, makeStore) {
  test(`${label}: deployments, replacements and emitters keep block, transaction and event provenance`, async (t) => {
    const store = await makeStore(t),
      chain = historyFixture();
    const result = await scanDiscoveryToHead({ ...options(chain), store });
    assert.equal(result.checkpoint.number, 5);
    const c = await byAddress(store);
    assert.deepEqual(
      Object.keys(c).sort(),
      [A(0x4a), A(0x100), A(0x101), A(0x102), A(0x103), A(0x500)].sort(),
    );
    assert.deepEqual(c[A(0x100)].deployment, {
      blockNumber: 1,
      blockHash: chain.blocks[1].hash,
      evidence: "deploy_transaction",
      transactionIndex: 0,
      transactionHash: "0xa1",
      eventIndex: null,
    });
    assert.equal(c[A(0x101)].deployment.evidence, "state_diff");
    assert.equal(c[A(0x101)].deployment.transactionIndex, null);
    assert.deepEqual(c[A(0x102)].deployment, {
      blockNumber: 2,
      blockHash: chain.blocks[2].hash,
      evidence: "udc_event",
      transactionIndex: 1,
      transactionHash: "0xb1",
      eventIndex: 1,
    });
    assert.equal(c[A(0x100)].classHash, felt(0xd1));
    assert.equal(c[A(0x100)].classSince.evidence, "upgraded_event");
    assert.equal(c[A(0x100)].classSince.blockNumber, 4);
    assert.equal(c[A(0x101)].classHash, felt(0xd2));
    assert.equal(c[A(0x101)].classSince.evidence, "state_diff");
    assert.deepEqual(c[A(0x103)].classSince, {
      blockNumber: 4,
      blockHash: chain.blocks[4].hash,
      evidence: "contract_event",
      transactionIndex: 1,
      transactionHash: "0xc2",
      eventIndex: 0,
    });
    assert.deepEqual(
      (await store.contractHistory("SN_MAIN", A(0x100))).map((r) => [
        r.kind,
        r.classHash,
        r.blockNumber,
      ]),
      [
        ["deployed", felt(0xc1), 1],
        ["class_replaced", felt(0xd1), 4],
      ],
    );
    // The deployer itself was deployed before this history: it is a candidate.
    assert.equal(c[A(0x4a)].source, "emitter");
    assert.equal(c[A(0x500)].source, "emitter");
    assert.equal(c[A(0x500)].classHash, null);
    assert.equal(c[A(0x500)].firstSeenBlock, 5);
    assert.equal((await store.contractHistory("SN_MAIN", A(0x102))).length, 1);
    const status = await discoveryStatus(store, "SN_MAIN");
    assert.deepEqual(status.counts, {
      contracts: 6,
      deployed: 4,
      classReplaced: 3,
      emitterOnly: 2,
    });
    assert.equal(status.historyComplete, true);
  });

  test(`${label}: events never invent deployments or class changes absent from the state diff`, async (t) => {
    const store = await makeStore(t),
      chain = fakeChain();
    chain.add().add({
      transactions: [
        {
          hash: "0x1",
          events: [
            [
              hex(0x4a),
              [CONTRACT_DEPLOYED],
              [hex(0x777), hex(0x9), "0x0", hex(0xc9)],
            ],
            [hex(0x778), [UPGRADED], [hex(0xd9)]],
          ],
        },
      ],
    });
    await scanDiscoveryToHead({ ...options(chain), store });
    const c = await byAddress(store);
    assert.equal(c[A(0x777)], undefined);
    assert.equal(c[A(0x778)].source, "emitter");
    assert.equal(c[A(0x778)].classHash, null);
    assert.equal(c[A(0x4a)].source, "emitter");
  });

  test(`${label}: scans are bounded, batched and resumable after restart with identical results`, async (t) => {
    const chain = historyFixture().empty(60),
      whole = await makeStore(t),
      resumed = await makeStore(t);
    await scanDiscoveryToHead({ ...options(chain), store: whole });
    let rounds = 0,
      result;
    do {
      // A fresh call per round stands in for a process restart.
      result = await scanDiscovery({
        ...options(chain),
        store: resumed,
        maxBlocks: 7,
      });
      assert.ok(result.blocks <= 7);
      rounds++;
    } while (!result.caughtUp);
    assert.ok(rounds >= 10);
    assert.deepEqual(
      await resumed.listDiscoveredContracts("SN_MAIN"),
      await whole.listDiscoveredContracts("SN_MAIN"),
    );
    assert.deepEqual(
      (await discoveryStatus(resumed, "SN_MAIN")).checkpoint,
      (await discoveryStatus(whole, "SN_MAIN")).checkpoint,
    );
    const before = chain.requests;
    const idle = await scanDiscovery({ ...options(chain), store: resumed });
    assert.equal(idle.blocks, 0);
    assert.ok(
      chain.requests - before <= 3,
      "an idle poll costs a few requests",
    );
  });

  test(`${label}: empty blocks advance the checkpoint without discoveries`, async (t) => {
    const store = await makeStore(t),
      chain = fakeChain().empty(25);
    await scanDiscoveryToHead({ ...options(chain), store });
    const status = await discoveryStatus(store, "SN_MAIN");
    assert.deepEqual(status.checkpoint, {
      number: 24,
      hash: chain.blocks[24].hash,
    });
    assert.equal(status.counts.contracts, 0);
  });

  test(`${label}: duplicate input is idempotent and conflicting duplicates are rejected`, async (t) => {
    const store = await makeStore(t),
      chain = historyFixture();
    await scanDiscoveryToHead({ ...options(chain), store });
    const snapshot = await store.listDiscoveredContracts("SN_MAIN");
    const replay = await store.discoveryBlocks("SN_MAIN", 1, 5);
    await store.applyDiscoveryBlocks("SN_MAIN", replay);
    await store.applyDiscoveryBlocks("SN_MAIN", replay.slice(2, 4));
    assert.deepEqual(await store.listDiscoveredContracts("SN_MAIN"), snapshot);
    await assert.rejects(
      store.applyDiscoveryBlocks("SN_MAIN", [{ ...replay[1], hash: "0xbad" }]),
      (e) => e.code === "DISCOVERY_CONFLICT",
    );
    await assert.rejects(
      store.applyDiscoveryBlocks("SN_MAIN", [
        { ...replay[0], number: 9, parentHash: "0x123" },
      ]),
      (e) => e.code === "DISCOVERY_GAP",
    );
    assert.deepEqual(await store.listDiscoveredContracts("SN_MAIN"), snapshot);
    assert.equal(
      (await discoveryStatus(store, "SN_MAIN")).checkpoint.number,
      5,
    );
  });

  test(`${label}: a reorg rewinds discovery and invalidates dependent classification`, async (t) => {
    const store = await makeStore(t),
      chain = historyFixture();
    await scanDiscoveryToHead({ ...options(chain), store });
    const before = await byAddress(store);
    // Blocks 4 and 5 are replaced: 0x100's upgrade and the 0x500 sighting vanish,
    // and a different contract is deployed on the new branch.
    chain
      .fork(3)
      .add({ deployed: [[hex(0x600), hex(0xc6)]] })
      .add();
    const result = await scanDiscoveryToHead({ ...options(chain), store });
    assert.equal(result.rewoundTo, 3);
    const after = await byAddress(store);
    assert.equal(after[A(0x500)], undefined);
    assert.equal(after[A(0x600)].deployment.blockHash, chain.blocks[4].hash);
    assert.equal(after[A(0x100)].classHash, felt(0xc1));
    assert.equal(after[A(0x100)].classSince.blockNumber, 1);
    assert.ok(
      after[A(0x100)].revision > before[A(0x100)].revision,
      "class change must invalidate classification",
    );
    assert.equal(
      after[A(0x102)].revision,
      before[A(0x102)].revision,
      "untouched contracts keep their classification",
    );
    assert.deepEqual((await discoveryStatus(store, "SN_MAIN")).checkpoint, {
      number: 5,
      hash: chain.blocks[5].hash,
    });
  });

  test(`${label}: a reorg deeper than the configured bound stops without changing state`, async (t) => {
    const store = await makeStore(t),
      chain = historyFixture().empty(10);
    await scanDiscoveryToHead({ ...options(chain), store });
    const snapshot = await store.listDiscoveredContracts("SN_MAIN");
    chain.fork(1).empty(20);
    await assert.rejects(
      scanDiscovery({ ...options(chain), store, maxReorgDepth: 5 }),
      (e) => e.code === "REORG_TOO_DEEP",
    );
    assert.deepEqual(await store.listDiscoveredContracts("SN_MAIN"), snapshot);
    assert.equal(
      (await discoveryStatus(store, "SN_MAIN")).checkpoint.number,
      15,
    );
  });

  test(`${label}: pruned history is recorded as a gap, never as completeness`, async (t) => {
    const store = await makeStore(t),
      chain = historyFixture().empty(200);
    chain.firstAvailable = 137;
    const result = await scanDiscoveryToHead({ ...options(chain), store });
    const status = await discoveryStatus(store, "SN_MAIN");
    assert.equal(result.checkpoint.number, 205);
    assert.equal(status.coverageStart, 0);
    assert.equal(status.firstAvailable, 137);
    assert.deepEqual(status.gaps, [
      { from: 0, to: 136, reason: "history_unavailable" },
    ]);
    assert.equal(status.historyComplete, false);
    assert.equal(status.counts.contracts, 0);
  });
}
