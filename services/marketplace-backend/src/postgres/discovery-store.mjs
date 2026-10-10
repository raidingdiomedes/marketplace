import { AsyncLocalStorage } from "node:async_hooks";
import { ApiError } from "../domain.mjs";
import {
  blocksToApply,
  projectContract,
  sameProjection,
} from "../discovery.mjs";

const position = (value) => {
  const number = Number(value);
  if (!Number.isSafeInteger(number))
    throw new Error("Database position exceeds safe integer range");
  return number;
};
const record = (r) => ({
  ordinal: r.ordinal,
  kind: r.kind,
  address: r.address,
  classHash: r.class_hash,
  evidence: r.evidence,
  transactionIndex: r.transaction_index,
  transactionHash: r.transaction_hash,
  eventIndex: r.event_index,
});
const contract = (r) => ({
  address: r.address,
  source: r.source,
  classHash: r.class_hash,
  firstSeenBlock: position(r.first_seen_block),
  deployment: r.deployment,
  classSince: r.class_since,
  revision: position(r.revision),
});

/**
 * PostgreSQL store for contract discovery. Writes take their own advisory lock,
 * not the marketplace projection lock, so discovery never stalls the scanner
 * that serves registered collections.
 */
export class PgDiscoveryStore {
  constructor(pool) {
    this.pool = pool;
    this.context = new AsyncLocalStorage();
  }
  query(sql, params = []) {
    return (this.context.getStore()?.client ?? this.pool).query(sql, params);
  }
  async transaction(chain, work) {
    if (this.context.getStore()) return work();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext('biblio-discovery'),hashtext($1))",
        [chain],
      );
      const result = await this.context.run({ client }, work);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  async discoveryState(chain) {
    const row = (
      await this.query("SELECT * FROM chain.discovery_scans WHERE chain=$1", [
        chain,
      ])
    ).rows[0];
    if (!row) return null;
    return {
      coverageStart: position(row.coverage_start),
      firstAvailable: position(row.first_available),
      gaps: row.gaps,
      probe: row.probe,
      checkpoint:
        row.block_number === null
          ? null
          : { number: position(row.block_number), hash: row.block_hash },
      revision: position(row.revision),
    };
  }
  async initializeDiscovery(
    chain,
    { coverageStart, firstAvailable, gaps, probe },
  ) {
    return this.transaction(chain, async () => {
      await this.query(
        "INSERT INTO chain.discovery_scans(chain,coverage_start,first_available,gaps,probe) VALUES($1,$2,$3,$4,$5) ON CONFLICT (chain) DO NOTHING",
        [
          chain,
          coverageStart,
          firstAvailable,
          JSON.stringify(gaps),
          JSON.stringify(probe),
        ],
      );
      const state = await this.discoveryState(chain);
      if (state.coverageStart !== coverageStart)
        throw new ApiError(
          "DISCOVERY_COVERAGE_CHANGED",
          "Coverage start differs.",
          409,
        );
      return state;
    });
  }
  async discoveryBlockHash(chain, n) {
    return (
      (
        await this.query(
          "SELECT hash FROM chain.discovery_blocks WHERE chain=$1 AND number=$2",
          [chain, n],
        )
      ).rows[0]?.hash ?? null
    );
  }
  async lockedState(chain) {
    await this.query(
      "SELECT 1 FROM chain.discovery_scans WHERE chain=$1 FOR UPDATE",
      [chain],
    );
    return this.discoveryState(chain);
  }
  /** Recompute projections for `addresses` from the journal; returns the revision counter. */
  async reproject(chain, addresses, revision) {
    if (!addresses.length) return revision;
    const rows = (
      await this.query(
        `SELECT d.*, b.hash AS block_hash FROM chain.contract_discoveries d
         JOIN chain.discovery_blocks b ON b.chain=d.chain AND b.number=d.block_number
         WHERE d.chain=$1 AND d.address=ANY($2) ORDER BY d.address, d.block_number, d.ordinal`,
        [chain, addresses],
      )
    ).rows;
    const current = new Map(
      (
        await this.query(
          "SELECT * FROM chain.discovered_contracts WHERE chain=$1 AND address=ANY($2)",
          [chain, addresses],
        )
      ).rows.map((r) => [r.address, contract(r)]),
    );
    const journal = new Map(addresses.map((a) => [a, []]));
    for (const r of rows)
      journal.get(r.address).push({
        ...record(r),
        blockNumber: position(r.block_number),
        blockHash: r.block_hash,
      });
    const changed = [],
      removed = [];
    for (const [address, history] of journal) {
      const next = projectContract(address, history),
        existing = current.get(address);
      if (!next) {
        if (existing) removed.push(address);
      } else if (!existing || !sameProjection(existing, next))
        changed.push({ ...next, revision: ++revision });
    }
    if (removed.length)
      await this.query(
        "DELETE FROM chain.discovered_contracts WHERE chain=$1 AND address=ANY($2)",
        [chain, removed],
      );
    if (changed.length)
      await this.query(
        `INSERT INTO chain.discovered_contracts(chain,address,source,class_hash,first_seen_block,deployment,class_since,revision)
         SELECT $1,x.address,x.source,x."classHash",x."firstSeenBlock",x.deployment,x."classSince",x.revision
         FROM jsonb_to_recordset($2::jsonb) AS x(address text,source text,"classHash" text,"firstSeenBlock" bigint,deployment jsonb,"classSince" jsonb,revision bigint)
         ON CONFLICT (chain,address) DO UPDATE SET source=EXCLUDED.source,class_hash=EXCLUDED.class_hash,
           first_seen_block=EXCLUDED.first_seen_block,deployment=EXCLUDED.deployment,
           class_since=EXCLUDED.class_since,revision=EXCLUDED.revision`,
        [chain, JSON.stringify(changed)],
      );
    return revision;
  }
  async applyDiscoveryBlocks(chain, blocks) {
    return this.transaction(chain, async () => {
      const state = await this.lockedState(chain);
      const fresh = await blocksToApply(state, blocks, (n) =>
        this.discoveryBlockHash(chain, n),
      );
      if (!fresh.length) return;
      const candidates = [
        ...new Set(
          fresh.flatMap((b) =>
            b.records
              .filter((r) => r.kind === "emitter_seen")
              .map((r) => r.address),
          ),
        ),
      ];
      const known = new Set(
        (
          await this.query(
            "SELECT address FROM chain.discovered_contracts WHERE chain=$1 AND address=ANY($2)",
            [chain, candidates],
          )
        ).rows.map((r) => r.address),
      );
      const journal = [];
      for (const block of fresh)
        for (const r of block.records) {
          if (r.kind === "emitter_seen" && known.has(r.address)) continue;
          known.add(r.address);
          journal.push({ ...r, blockNumber: block.number });
        }
      await this.query(
        `INSERT INTO chain.discovery_blocks(chain,number,hash,parent,timestamp)
         SELECT $1,x.number,x.hash,x."parentHash",x.timestamp
         FROM jsonb_to_recordset($2::jsonb) AS x(number bigint,hash text,"parentHash" text,timestamp bigint)`,
        [
          chain,
          JSON.stringify(
            fresh.map((b) => ({
              number: b.number,
              hash: b.hash,
              parentHash: b.parentHash,
              timestamp: b.timestamp,
            })),
          ),
        ],
      );
      if (journal.length)
        await this.query(
          `INSERT INTO chain.contract_discoveries(chain,block_number,ordinal,kind,address,class_hash,evidence,transaction_index,transaction_hash,event_index)
           SELECT $1,x."blockNumber",x.ordinal,x.kind,x.address,x."classHash",x.evidence,x."transactionIndex",x."transactionHash",x."eventIndex"
           FROM jsonb_to_recordset($2::jsonb) AS x("blockNumber" bigint,ordinal integer,kind text,address text,"classHash" text,evidence text,"transactionIndex" integer,"transactionHash" text,"eventIndex" integer)`,
          [chain, JSON.stringify(journal)],
        );
      const revision = await this.reproject(
        chain,
        [...new Set(journal.map((r) => r.address))],
        state.revision,
      );
      const last = fresh.at(-1);
      await this.query(
        "UPDATE chain.discovery_scans SET block_number=$2,block_hash=$3,revision=$4 WHERE chain=$1",
        [chain, last.number, last.hash, revision],
      );
    });
  }
  async rewindDiscovery(chain, height) {
    return this.transaction(chain, async () => {
      const state = await this.lockedState(chain);
      if (!state?.checkpoint || height >= state.checkpoint.number) return;
      const affected = (
        await this.query(
          "SELECT DISTINCT address FROM chain.contract_discoveries WHERE chain=$1 AND block_number>$2",
          [chain, height],
        )
      ).rows.map((r) => r.address);
      await this.query(
        "DELETE FROM chain.discovery_blocks WHERE chain=$1 AND number>$2",
        [chain, height],
      );
      const revision = await this.reproject(chain, affected, state.revision);
      const kept = await this.discoveryBlockHash(chain, height);
      await this.query(
        "UPDATE chain.discovery_scans SET block_number=$2,block_hash=$3,revision=$4 WHERE chain=$1",
        [chain, kept === null ? null : height, kept, revision],
      );
    });
  }
  async discoveryBlocks(chain, from, to) {
    const blocks = (
      await this.query(
        "SELECT * FROM chain.discovery_blocks WHERE chain=$1 AND number BETWEEN $2 AND $3 ORDER BY number",
        [chain, from, to],
      )
    ).rows.map((b) => ({
      number: position(b.number),
      hash: b.hash,
      parentHash: b.parent,
      timestamp: position(b.timestamp),
      records: [],
    }));
    const byNumber = new Map(blocks.map((b) => [b.number, b]));
    for (const r of (
      await this.query(
        "SELECT * FROM chain.contract_discoveries WHERE chain=$1 AND block_number BETWEEN $2 AND $3 ORDER BY block_number, ordinal",
        [chain, from, to],
      )
    ).rows)
      byNumber.get(position(r.block_number)).records.push(record(r));
    return blocks;
  }
  async contractHistory(chain, address) {
    return (
      await this.query(
        `SELECT d.*, b.hash AS block_hash FROM chain.contract_discoveries d
         JOIN chain.discovery_blocks b ON b.chain=d.chain AND b.number=d.block_number
         WHERE d.chain=$1 AND d.address=$2 ORDER BY d.block_number, d.ordinal`,
        [chain, address],
      )
    ).rows.map((r) => ({
      ...record(r),
      blockNumber: position(r.block_number),
      blockHash: r.block_hash,
    }));
  }
  async listDiscoveredContracts(chain, { after = "", limit = 1000 } = {}) {
    return (
      await this.query(
        "SELECT * FROM chain.discovered_contracts WHERE chain=$1 AND address>$2 ORDER BY address LIMIT $3",
        [chain, after, limit],
      )
    ).rows.map(contract);
  }
  async discoveryCounts(chain) {
    const row = (
      await this.query(
        `SELECT
           (SELECT COUNT(*) FROM chain.discovered_contracts WHERE chain=$1) AS contracts,
           (SELECT COUNT(*) FROM chain.discovered_contracts WHERE chain=$1 AND source='emitter') AS emitter_only,
           (SELECT COUNT(*) FROM chain.contract_discoveries WHERE chain=$1 AND kind='deployed') AS deployed,
           (SELECT COUNT(*) FROM chain.contract_discoveries WHERE chain=$1 AND kind='class_replaced') AS class_replaced`,
        [chain],
      )
    ).rows[0];
    return {
      contracts: position(row.contracts),
      deployed: position(row.deployed),
      classReplaced: position(row.class_replaced),
      emitterOnly: position(row.emitter_only),
    };
  }
}
