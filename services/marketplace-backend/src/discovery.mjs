/**
 * Chain-wide contract discovery (issue #110).
 *
 * The state diff of each accepted block is the source of truth: it lists every
 * deployment (transaction, UDC or deploy_syscall from any factory) and every
 * replace_class, whether or not an event was emitted. Receipts only add
 * positions (transaction/event index) and event-emitter candidates. Events
 * alone never create a deployment or a class change.
 */
import { ApiError, address, uint } from "./domain.mjs";

/** starknet_keccak("ContractDeployed"), emitted by the Universal Deployer. */
export const CONTRACT_DEPLOYED_SELECTOR =
  "0x26b160f10156dea0639bec90696772c640b9706a47f5b8c52ea1abe5858b34d";
/** starknet_keccak("Upgraded"), the OpenZeppelin upgradeable component event. */
export const UPGRADED_SELECTOR =
  "0x2db340e6c609371026731f47050d3976552c89b4fbb012941663841c59d1af3";
const CHAINS = ["SN_MAIN", "SN_SEPOLIA", "LOCAL"];
const BLOCK_NOT_FOUND = 24,
  METHOD_NOT_FOUND = -32601;
const REQUIRED_METHODS = [
  "starknet_getStateUpdate",
  "starknet_getBlockWithReceipts",
];

export const classHash = (value) =>
  "0x" + BigInt(uint(value, 252)).toString(16).padStart(64, "0");
export const hash = (value) => "0x" + BigInt(uint(value, 256)).toString(16);
const equal = (a, b) => BigInt(a) === BigInt(b);
const rpcCode = (error) => error?.details?.rpcCode;
const tryAddress = (value) => {
  try {
    return address(value);
  } catch {
    return null;
  }
};
const tryClassHash = (value) => {
  try {
    return classHash(value);
  } catch {
    return null;
  }
};

/**
 * Turn one block's state update and receipts into ordered discovery records.
 * Throws if the two responses describe different blocks.
 */
export function extractBlockDiscoveries(stateUpdate, block) {
  if (!["ACCEPTED_ON_L2", "ACCEPTED_ON_L1"].includes(block?.status))
    throw new ApiError("UNACCEPTED_BLOCK", "Discovery reads accepted blocks.");
  if (
    !stateUpdate?.block_hash ||
    !equal(stateUpdate.block_hash, block.block_hash)
  )
    throw new ApiError(
      "CHAIN_CONFLICT",
      `State update does not belong to block ${block.block_number}.`,
    );
  const diff = stateUpdate.state_diff;
  if (
    !Array.isArray(diff?.deployed_contracts) ||
    !Array.isArray(diff?.replaced_classes)
  )
    throw new ApiError("INVALID_STATE_UPDATE", "State diff is incomplete.");
  if (!Array.isArray(block.transactions))
    throw new ApiError("INVALID_RPC_BLOCK", "Block receipts are missing.");

  const deployTransactions = new Map(),
    udcEvents = new Map(),
    firstEvents = new Map(),
    upgradedEvents = new Map(),
    classMentions = new Map();
  for (const [transactionIndex, entry] of block.transactions.entries()) {
    const receipt = entry.receipt;
    if (!receipt || !Array.isArray(receipt.events))
      throw new ApiError("INVALID_RECEIPT", "Missing ordered receipt events.");
    if (receipt.execution_status === "REVERTED") continue;
    const rawHash =
      receipt.transaction_hash ?? entry.transaction?.transaction_hash;
    if (!rawHash)
      throw new ApiError(
        "INVALID_RECEIPT",
        "Receipt transaction identity missing.",
      );
    const at = { transactionIndex, transactionHash: hash(rawHash) };
    if (
      ["DEPLOY", "DEPLOY_ACCOUNT"].includes(receipt.type) &&
      receipt.contract_address
    ) {
      const deployed = address(receipt.contract_address);
      if (!deployTransactions.has(deployed))
        deployTransactions.set(deployed, {
          ...at,
          eventIndex: null,
          evidence:
            receipt.type === "DEPLOY"
              ? "deploy_transaction"
              : "deploy_account_transaction",
        });
    }
    for (const [eventIndex, event] of receipt.events.entries()) {
      const emitter = address(event.from_address),
        position = { ...at, eventIndex };
      if (!firstEvents.has(emitter)) firstEvents.set(emitter, position);
      for (const value of [
        ...(event.keys ?? []).slice(1),
        ...(event.data ?? []),
      ]) {
        const mentioned = tryClassHash(value),
          key = `${emitter}:${mentioned}`;
        if (mentioned && !classMentions.has(key))
          classMentions.set(key, { ...position, evidence: "contract_event" });
      }
      const selector = event.keys?.[0];
      if (selector === undefined) continue;
      if (equal(selector, CONTRACT_DEPLOYED_SELECTOR)) {
        // Arbitrary contracts can emit this name; it only locates a deployment
        // that the state diff already proves.
        const deployed = tryAddress(event.data?.[0]);
        if (deployed && !udcEvents.has(deployed))
          udcEvents.set(deployed, { ...position, evidence: "udc_event" });
      } else if (equal(selector, UPGRADED_SELECTOR)) {
        const target = tryClassHash(event.data?.[0] ?? event.keys?.[1]);
        if (target)
          upgradedEvents.set(emitter, [
            ...(upgradedEvents.get(emitter) ?? []),
            { ...position, classHash: target, evidence: "upgraded_event" },
          ]);
      }
    }
  }

  const unpositioned = {
    transactionIndex: null,
    transactionHash: null,
    eventIndex: null,
    evidence: "state_diff",
  };
  const records = [],
    deployedHere = new Set();
  const push = (kind, contract, cls, position) =>
    records.push({
      ordinal: records.length,
      kind,
      address: contract,
      classHash: cls,
      evidence: position.evidence,
      transactionIndex: position.transactionIndex,
      transactionHash: position.transactionHash,
      eventIndex: position.eventIndex,
    });
  for (const entry of diff.deployed_contracts) {
    const contract = address(entry.address),
      constructorEvent = firstEvents.get(contract);
    deployedHere.add(contract);
    push(
      "deployed",
      contract,
      classHash(entry.class_hash),
      deployTransactions.get(contract) ??
        udcEvents.get(contract) ??
        (constructorEvent
          ? { ...constructorEvent, evidence: "contract_event" }
          : unpositioned),
    );
  }
  for (const entry of diff.replaced_classes) {
    const contract = address(entry.contract_address),
      cls = classHash(entry.class_hash);
    // Prefer the standard Upgraded event; otherwise any event of the contract
    // in this block that carries the new class hash (custom upgrade events).
    const announced =
      (upgradedEvents.get(contract) ?? []).findLast(
        (e) => e.classHash === cls,
      ) ??
      classMentions.get(`${contract}:${cls}`) ??
      unpositioned;
    push("class_replaced", contract, cls, announced);
  }
  for (const [emitter, position] of firstEvents)
    if (!deployedHere.has(emitter))
      push("emitter_seen", emitter, null, {
        ...position,
        evidence: "receipt_event",
      });
  return {
    number: Number(block.block_number),
    hash: hash(block.block_hash),
    parentHash: hash(block.parent_hash),
    timestamp: Number(block.timestamp),
    records,
  };
}

/**
 * Derive one contract's current catalog view from its journal rows, ordered by
 * block number then ordinal. Stores call this on apply and on rewind so the
 * projection is always rebuildable from the journal.
 */
export function projectContract(contract, rows) {
  if (!rows.length) return null;
  const provenance = (r) => ({
    blockNumber: r.blockNumber,
    blockHash: r.blockHash,
    evidence: r.evidence,
    transactionIndex: r.transactionIndex,
    transactionHash: r.transactionHash,
    eventIndex: r.eventIndex,
  });
  let deployment = null,
    classSince = null,
    cls = null;
  for (const row of rows) {
    if (row.kind === "deployed" && !deployment) deployment = provenance(row);
    if (row.kind !== "emitter_seen") {
      cls = row.classHash;
      classSince = provenance(row);
    }
  }
  return {
    address: contract,
    source: cls ? "state_diff" : "emitter",
    classHash: cls,
    firstSeenBlock: rows[0].blockNumber,
    deployment,
    classSince,
  };
}

const canonical = (value) =>
  JSON.stringify(value, (_, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)),
        )
      : v,
  );
/** True when two projections differ only by revision (key order ignored). */
export const sameProjection = (a, b) =>
  canonical({ ...a, revision: 0 }) === canonical({ ...b, revision: 0 });

/**
 * Shared batch validation for stores. Blocks at or below the checkpoint must
 * match what is stored (idempotent replay); the rest must extend it exactly.
 * Returns only the blocks that still need applying.
 */
export async function blocksToApply(state, blocks, storedHash) {
  if (!state)
    throw new ApiError(
      "DISCOVERY_UNINITIALIZED",
      "Discovery scan not initialized.",
    );
  const fresh = [];
  for (const block of blocks) {
    if (state.checkpoint && block.number <= state.checkpoint.number) {
      const stored = await storedHash(block.number);
      if (stored === null || !equal(stored, block.hash))
        throw new ApiError(
          "DISCOVERY_CONFLICT",
          `Block ${block.number} differs from the recorded discovery; rewind first.`,
          409,
        );
      continue;
    }
    const previous = fresh.at(-1) ?? state.checkpoint;
    const expected = previous ? previous.number + 1 : state.firstAvailable;
    if (
      block.number !== expected ||
      (previous && !equal(block.parentHash, previous.hash))
    )
      throw new ApiError(
        "DISCOVERY_GAP",
        `Block ${block.number} does not extend the discovery checkpoint.`,
        409,
      );
    fresh.push(block);
  }
  return fresh;
}

async function optionalCall(rpc, method, params) {
  try {
    return { supported: true, result: await rpc.call(method, params) };
  } catch (error) {
    if (rpcCode(error) === METHOD_NOT_FOUND) return { supported: false };
    throw error;
  }
}

async function available(rpc, n) {
  try {
    await rpc.call("starknet_getStateUpdate", {
      block_id: { block_number: n },
    });
    return true;
  } catch (error) {
    if (rpcCode(error) === BLOCK_NOT_FOUND) return false;
    throw error;
  }
}

/**
 * Record what the provider can serve. Missing early history becomes an
 * explicit gap; the search assumes pruning removes a prefix of history.
 */
export async function probeDiscovery({ rpc, startBlock = 0 }) {
  if (!Number.isSafeInteger(startBlock) || startBlock < 0)
    throw new ApiError(
      "INVALID_START_BLOCK",
      "Start block must be a nonnegative integer.",
    );
  const spec = await optionalCall(rpc, "starknet_specVersion", []);
  const head = Number(await rpc.call("starknet_blockNumber", []));
  const methods = {};
  for (const method of REQUIRED_METHODS)
    methods[method] = (
      await optionalCall(rpc, method, { block_id: { block_number: head } })
    ).supported;
  const probe = {
    specVersion: spec.supported ? String(spec.result) : null,
    head,
    methods,
    firstAvailable: null,
    gaps: [],
  };
  if (!Object.values(methods).every(Boolean) || startBlock > head) return probe;
  let first = startBlock;
  if (!(await available(rpc, startBlock))) {
    let low = startBlock + 1,
      high = head;
    if (!(await available(rpc, head)))
      throw new ApiError(
        "HISTORY_UNAVAILABLE",
        "Provider serves no state updates.",
        503,
      );
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (await available(rpc, middle)) high = middle;
      else low = middle + 1;
    }
    first = low;
  }
  probe.firstAvailable = first;
  if (first > startBlock)
    probe.gaps.push({
      from: startBlock,
      to: first - 1,
      reason: "history_unavailable",
    });
  return probe;
}

async function canonicalHash(rpc, n) {
  try {
    return (
      await rpc.call("starknet_getBlockWithTxHashes", {
        block_id: { block_number: n },
      })
    ).block_hash;
  } catch (error) {
    if (rpcCode(error) === BLOCK_NOT_FOUND) return null;
    throw error;
  }
}

/**
 * Run one bounded discovery step: initialize on first use, rewind any reorg,
 * then read at most `maxBlocks` accepted blocks and commit them atomically
 * with the checkpoint.
 */
export async function scanDiscovery({
  rpc,
  store,
  chain,
  chainId,
  startBlock = 0,
  maxBlocks = 500,
  batchBlocks = 32,
  maxReorgDepth = 64,
}) {
  if (!CHAINS.includes(chain))
    throw new ApiError("INVALID_CHAIN", "Unknown chain.");
  if (!(batchBlocks >= 1 && batchBlocks <= 32 && maxBlocks >= 1))
    throw new ApiError(
      "INVALID_DISCOVERY_OPTIONS",
      "Discovery bounds are invalid.",
    );
  if (!equal(await rpc.call("starknet_chainId", []), chainId))
    throw new ApiError("CHAIN_MISMATCH", "RPC is on another chain.");
  let state = await store.discoveryState(chain);
  if (!state) {
    const probe = await probeDiscovery({ rpc, startBlock });
    if (!Object.values(probe.methods).every(Boolean))
      throw new ApiError(
        "RPC_CAPABILITY_MISSING",
        "Discovery requires starknet_getStateUpdate and starknet_getBlockWithReceipts.",
        503,
        { methods: probe.methods },
      );
    state = await store.initializeDiscovery(chain, {
      coverageStart: startBlock,
      firstAvailable: probe.firstAvailable ?? startBlock,
      gaps: probe.gaps,
      probe: {
        specVersion: probe.specVersion,
        methods: probe.methods,
        head: probe.head,
      },
    });
  } else if (state.coverageStart !== startBlock)
    throw new ApiError(
      "DISCOVERY_COVERAGE_CHANGED",
      `Discovery for ${chain} started at block ${state.coverageStart}; reset it explicitly to change coverage.`,
      409,
    );

  let rewoundTo = null;
  if (state.checkpoint) {
    let n = state.checkpoint.number,
      depth = 0;
    while (n >= state.firstAvailable) {
      const stored =
        n === state.checkpoint.number
          ? state.checkpoint.hash
          : await store.discoveryBlockHash(chain, n);
      const canonical = await canonicalHash(rpc, n);
      if (canonical !== null && stored !== null && equal(canonical, stored))
        break;
      if (++depth > maxReorgDepth)
        throw new ApiError(
          "REORG_TOO_DEEP",
          `Discovery diverged more than ${maxReorgDepth} blocks below ${state.checkpoint.number}.`,
          409,
        );
      n--;
    }
    if (n !== state.checkpoint.number) {
      await store.rewindDiscovery(chain, n);
      rewoundTo = n;
      state = await store.discoveryState(chain);
    }
  }

  const head = Number(await rpc.call("starknet_blockNumber", []));
  const from = state.checkpoint
    ? state.checkpoint.number + 1
    : state.firstAvailable;
  if (from > head)
    return {
      from,
      to: from - 1,
      blocks: 0,
      discoveries: 0,
      checkpoint: state.checkpoint,
      rewoundTo,
      head,
      caughtUp: true,
    };
  const to = Math.min(head, from + maxBlocks - 1),
    blocks = [];
  for (let start = from; start <= to; start += batchBlocks) {
    const heights = [];
    for (let n = start; n <= Math.min(to, start + batchBlocks - 1); n++)
      heights.push(n);
    const responses = await rpc.batch(
      heights.flatMap((n) => [
        {
          method: "starknet_getStateUpdate",
          params: { block_id: { block_number: n } },
        },
        {
          method: "starknet_getBlockWithReceipts",
          params: { block_id: { block_number: n } },
        },
      ]),
    );
    heights.forEach((n, i) => {
      const block = extractBlockDiscoveries(
        responses[2 * i],
        responses[2 * i + 1],
      );
      if (block.number !== n)
        throw new ApiError("INVALID_RPC_BLOCK", `Expected block ${n}.`);
      const previous = blocks.at(-1) ?? state.checkpoint;
      if (previous && !equal(block.parentHash, previous.hash))
        throw new ApiError(
          "CHAIN_CONFLICT",
          `Block ${n} does not extend block ${previous.number}; the chain changed while reading.`,
        );
      blocks.push(block);
    });
  }
  await store.applyDiscoveryBlocks(chain, blocks);
  const last = blocks.at(-1);
  return {
    from,
    to,
    blocks: blocks.length,
    discoveries: blocks.reduce((sum, b) => sum + b.records.length, 0),
    checkpoint: { number: last.number, hash: last.hash },
    rewoundTo,
    head,
    caughtUp: to >= head,
  };
}

/** Repeat bounded steps until the checkpoint reaches the observed head. */
export async function scanDiscoveryToHead(options) {
  let rewoundTo = null,
    result;
  do {
    result = await scanDiscovery(options);
    rewoundTo ??= result.rewoundTo;
  } while (!result.caughtUp);
  return { ...result, rewoundTo };
}

/** Coverage and counts as recorded, without claiming more than was scanned. */
export async function discoveryStatus(store, chain) {
  const state = await store.discoveryState(chain);
  const counts = state
    ? await store.discoveryCounts(chain)
    : { contracts: 0, deployed: 0, classReplaced: 0, emitterOnly: 0 };
  return {
    chain,
    coverageStart: state?.coverageStart ?? null,
    firstAvailable: state?.firstAvailable ?? null,
    checkpoint: state?.checkpoint ?? null,
    gaps: state?.gaps ?? [],
    probe: state?.probe ?? null,
    historyComplete: Boolean(
      state && state.coverageStart === 0 && state.gaps.length === 0,
    ),
    counts,
  };
}
