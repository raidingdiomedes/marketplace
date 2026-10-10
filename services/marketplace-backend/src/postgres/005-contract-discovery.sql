-- Chain-wide contract discovery (#110). Chain-derived and rebuildable: the
-- journal can be replayed from the chain, and the projection from the journal.
-- Separate from the marketplace projection tables and lock.
CREATE TABLE chain.discovery_scans (
  chain text PRIMARY KEY CHECK(chain IN ('SN_MAIN','SN_SEPOLIA','LOCAL')),
  coverage_start bigint NOT NULL CHECK(coverage_start>=0),
  first_available bigint NOT NULL CHECK(first_available>=coverage_start),
  gaps jsonb NOT NULL CHECK(jsonb_typeof(gaps)='array'),
  probe jsonb NOT NULL,
  block_number bigint CHECK(block_number>=first_available),
  block_hash text,
  revision bigint NOT NULL DEFAULT 0 CHECK(revision>=0),
  CHECK((block_number IS NULL)=(block_hash IS NULL))
);
CREATE TABLE chain.discovery_blocks (
  chain text NOT NULL REFERENCES chain.discovery_scans(chain),
  number bigint NOT NULL CHECK(number>=0),
  hash text NOT NULL,
  parent text NOT NULL,
  timestamp bigint NOT NULL,
  PRIMARY KEY(chain,number)
);
CREATE TABLE chain.contract_discoveries (
  chain text NOT NULL,
  block_number bigint NOT NULL,
  ordinal integer NOT NULL CHECK(ordinal>=0),
  kind text NOT NULL CHECK(kind IN ('deployed','class_replaced','emitter_seen')),
  address text NOT NULL,
  class_hash text,
  evidence text NOT NULL CHECK(evidence IN ('deploy_transaction','deploy_account_transaction','udc_event','contract_event','upgraded_event','receipt_event','state_diff')),
  transaction_index integer,
  transaction_hash text,
  event_index integer,
  PRIMARY KEY(chain,block_number,ordinal),
  FOREIGN KEY(chain,block_number) REFERENCES chain.discovery_blocks(chain,number) ON DELETE CASCADE,
  CHECK((kind='emitter_seen')=(class_hash IS NULL)),
  CHECK((transaction_index IS NULL)=(transaction_hash IS NULL))
);
CREATE INDEX contract_discoveries_address ON chain.contract_discoveries(chain,address,block_number,ordinal);
-- Current view per contract. `revision` comes from a per-chain counter and
-- changes whenever the row changes (including on reorg), so a classifier that
-- stores the revision it evaluated can detect stale results.
CREATE TABLE chain.discovered_contracts (
  chain text NOT NULL REFERENCES chain.discovery_scans(chain),
  address text NOT NULL,
  source text NOT NULL CHECK(source IN ('state_diff','emitter')),
  class_hash text,
  first_seen_block bigint NOT NULL,
  deployment jsonb,
  class_since jsonb,
  revision bigint NOT NULL CHECK(revision>0),
  PRIMARY KEY(chain,address),
  CHECK((source='emitter')=(class_hash IS NULL))
);
CREATE INDEX discovered_contracts_class ON chain.discovered_contracts(chain,class_hash) WHERE class_hash IS NOT NULL;
