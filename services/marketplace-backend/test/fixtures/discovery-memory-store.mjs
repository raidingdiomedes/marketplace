import { ApiError } from "../../src/domain.mjs";
import {
  blocksToApply,
  projectContract,
  sameProjection,
} from "../../src/discovery.mjs";

/**
 * Reference model of the discovery store contract. The same scenarios run
 * against it and against PgDiscoveryStore, so the PostgreSQL store is checked
 * against an obviously-correct in-memory version.
 */
export class MemoryDiscoveryStore {
  constructor() {
    this.chains = new Map();
  }
  async discoveryState(chain) {
    const c = this.chains.get(chain);
    return c ? structuredClone(c.state) : null;
  }
  async initializeDiscovery(
    chain,
    { coverageStart, firstAvailable, gaps, probe },
  ) {
    if (!this.chains.has(chain))
      this.chains.set(chain, {
        state: {
          coverageStart,
          firstAvailable,
          gaps,
          probe,
          checkpoint: null,
          revision: 0,
        },
        blocks: new Map(),
        contracts: new Map(),
      });
    const { state } = this.chains.get(chain);
    if (state.coverageStart !== coverageStart)
      throw new ApiError(
        "DISCOVERY_COVERAGE_CHANGED",
        "Coverage start differs.",
        409,
      );
    return structuredClone(state);
  }
  async discoveryBlockHash(chain, n) {
    return this.chains.get(chain)?.blocks.get(n)?.hash ?? null;
  }
  rows(c, contract) {
    const rows = [];
    for (const block of [...c.blocks.values()].sort(
      (a, b) => a.number - b.number,
    ))
      for (const r of block.records)
        if (r.address === contract)
          rows.push({ ...r, blockNumber: block.number, blockHash: block.hash });
    return rows;
  }
  reproject(c, contracts) {
    for (const contract of contracts) {
      const next = projectContract(contract, this.rows(c, contract)),
        current = c.contracts.get(contract);
      if (!next) c.contracts.delete(contract);
      else if (!current || !sameProjection(current, next))
        c.contracts.set(contract, { ...next, revision: ++c.state.revision });
    }
  }
  async applyDiscoveryBlocks(chain, blocks) {
    const original = this.chains.get(chain);
    const fresh = await blocksToApply(original?.state, blocks, async (n) =>
      this.discoveryBlockHash(chain, n),
    );
    if (!fresh.length) return;
    const c = structuredClone(original),
      touched = new Set();
    for (const block of fresh) {
      const records = block.records.filter((r) => {
        if (r.kind !== "emitter_seen") return true;
        return !c.contracts.has(r.address) && !touched.has(r.address);
      });
      c.blocks.set(block.number, { ...block, records });
      for (const r of records) touched.add(r.address);
    }
    this.reproject(c, touched);
    const last = fresh.at(-1);
    c.state.checkpoint = { number: last.number, hash: last.hash };
    this.chains.set(chain, c);
  }
  async rewindDiscovery(chain, height) {
    const c = structuredClone(this.chains.get(chain)),
      affected = new Set();
    for (const [n, block] of c.blocks)
      if (n > height) {
        for (const r of block.records) affected.add(r.address);
        c.blocks.delete(n);
      }
    this.reproject(c, affected);
    const kept = c.blocks.get(height);
    c.state.checkpoint = kept ? { number: kept.number, hash: kept.hash } : null;
    this.chains.set(chain, c);
  }
  async discoveryBlocks(chain, from, to) {
    return [...this.chains.get(chain).blocks.values()]
      .filter((b) => b.number >= from && b.number <= to)
      .sort((a, b) => a.number - b.number)
      .map((b) => structuredClone(b));
  }
  async contractHistory(chain, contract) {
    return this.rows(this.chains.get(chain), contract);
  }
  async listDiscoveredContracts(chain) {
    return [...(this.chains.get(chain)?.contracts.values() ?? [])]
      .sort((a, b) => (a.address < b.address ? -1 : 1))
      .map((x) => structuredClone(x));
  }
  async discoveryCounts(chain) {
    const c = this.chains.get(chain),
      records = [...c.blocks.values()].flatMap((b) => b.records),
      contracts = [...c.contracts.values()];
    return {
      contracts: contracts.length,
      deployed: records.filter((r) => r.kind === "deployed").length,
      classReplaced: records.filter((r) => r.kind === "class_replaced").length,
      emitterOnly: contracts.filter((x) => x.source === "emitter").length,
    };
  }
}
