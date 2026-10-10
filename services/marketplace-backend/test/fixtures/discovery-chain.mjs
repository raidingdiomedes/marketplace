import { ApiError } from "../../src/domain.mjs";

export const MAINNET = "0x534e5f4d41494e";
export const CONTRACT_DEPLOYED =
  "0x26b160f10156dea0639bec90696772c640b9706a47f5b8c52ea1abe5858b34d";
export const UPGRADED =
  "0x2db340e6c609371026731f47050d3976552c89b4fbb012941663841c59d1af3";
export const hex = (n) => "0x" + BigInt(n).toString(16);

/**
 * A deterministic Starknet RPC double. Blocks carry the two shapes discovery
 * reads (state update and receipts) and can be forked to simulate reorgs or
 * pruned to simulate nodes without early history.
 */
export function fakeChain({
  chainId = MAINNET,
  firstAvailable = 0,
  unsupported = [],
  specVersion = "0.8.1",
} = {}) {
  const blocks = [];
  let branch = 1;
  const chain = {
    blocks,
    requests: 0,
    calls: 0,
    firstAvailable,
    hashOf: (n) => hex((BigInt(branch) << 40n) | BigInt(n + 1)),
    /** Append a block; `spec` holds deployed, replaced and transactions. */
    add(spec = {}) {
      const number = blocks.length;
      blocks.push({
        number,
        hash: spec.hash ?? chain.hashOf(number),
        parent: number ? blocks[number - 1].hash : "0x0",
        timestamp: 1_700_000_000 + number,
        deployed: spec.deployed ?? [],
        replaced: spec.replaced ?? [],
        transactions: spec.transactions ?? [],
        stateHash: spec.stateHash,
      });
      return chain;
    },
    empty(count) {
      for (let i = 0; i < count; i++) chain.add();
      return chain;
    },
    /** Replace every block above `height` with a new branch. */
    fork(height) {
      blocks.length = height + 1;
      branch++;
      return chain;
    },
    response(method, params) {
      chain.calls++;
      if (unsupported.includes(method))
        throw new ApiError("RPC_CONTRACT_ERROR", "Method not found", 502, {
          rpcCode: -32601,
        });
      if (method === "starknet_chainId") return chainId;
      if (method === "starknet_specVersion") return specVersion;
      if (method === "starknet_blockNumber") return blocks.length - 1;
      const id = params.block_id,
        n =
          id === "latest"
            ? blocks.length - 1
            : (id.block_number ??
              blocks.findIndex(
                (b) => BigInt(b.hash) === BigInt(id.block_hash),
              ));
      const block = blocks[n];
      if (!block || n < chain.firstAvailable)
        throw new ApiError("RPC_CONTRACT_ERROR", "Block not found", 502, {
          rpcCode: 24,
        });
      const header = {
        status: "ACCEPTED_ON_L2",
        block_hash: block.hash,
        parent_hash: block.parent,
        block_number: block.number,
        timestamp: block.timestamp,
      };
      if (method === "starknet_getBlockWithTxHashes")
        return {
          ...header,
          transactions: block.transactions.map((t) => t.hash),
        };
      if (method === "starknet_getStateUpdate")
        return {
          block_hash: block.stateHash ?? block.hash,
          old_root: "0x1",
          new_root: "0x2",
          state_diff: {
            storage_diffs: [],
            deprecated_declared_classes: [],
            declared_classes: [],
            nonces: [],
            deployed_contracts: block.deployed.map(([address, class_hash]) => ({
              address,
              class_hash,
            })),
            replaced_classes: block.replaced.map(
              ([contract_address, class_hash]) => ({
                contract_address,
                class_hash,
              }),
            ),
          },
        };
      if (method === "starknet_getBlockWithReceipts")
        return {
          ...header,
          transactions: block.transactions.map((t) => ({
            transaction: { transaction_hash: t.hash, type: t.type ?? "INVOKE" },
            receipt: {
              type: t.type ?? "INVOKE",
              transaction_hash: t.hash,
              execution_status: t.reverted ? "REVERTED" : "SUCCEEDED",
              finality_status: "ACCEPTED_ON_L2",
              ...(t.contractAddress
                ? { contract_address: t.contractAddress }
                : {}),
              events: (t.events ?? []).map(([from_address, keys, data]) => ({
                from_address,
                keys,
                data: data ?? [],
              })),
            },
          })),
        };
      throw new Error(`Unexpected RPC method ${method}`);
    },
    rpc: {
      async call(method, params) {
        chain.requests++;
        return chain.response(method, params);
      },
      async batch(calls) {
        if (!calls.length || calls.length > 64)
          throw new Error("RPC batch requires 1–64 read calls");
        chain.requests++;
        return calls.map((c) => chain.response(c.method, c.params));
      },
    },
  };
  return chain;
}
