import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
/** Only the migration connection runs DDL. Runtime roles receive explicit grants. */
export async function migrate(pool) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('biblio-schema'), 1)",
    );
    await client.query(
      "CREATE TABLE IF NOT EXISTS public.marketplace_migrations(version integer PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    for (const [version, name] of [
      [1, "001-initial.sql"],
      [2, "002-history-ranges.sql"],
      [3, "003-image-sources.sql"],
      [4, "004-image-source-hashes.sql"],
      [5, "005-contract-discovery.sql"],
    ]) {
      const sql = readFileSync(new URL(`./${name}`, import.meta.url), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const existing = (
        await client.query(
          "SELECT checksum FROM public.marketplace_migrations WHERE version=$1",
          [version],
        )
      ).rows[0];
      if (existing && existing.checksum !== checksum)
        throw new Error(
          "Migration checksum mismatch; add a new migration instead of changing applied SQL.",
        );
      if (!existing) {
        await client.query(sql);
        await client.query(
          "INSERT INTO public.marketplace_migrations(version,checksum) VALUES($1,$2)",
          [version, checksum],
        );
      }
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
