-- 0027_partition_dedup.sql
--
-- B-17（第二轮审计）: server-side partition idempotency.
--
-- The parallel-partition run path trusts the client's {from,to} slice
-- declaration. A replayed partition (malicious or a buggy retry) would
-- double-count `processed` (potentially triggering finalizing early while
-- other partitions' suggestions are still in flight) and double-charge
-- `consumeAiCredit`.
--
-- This table records every partition that has been claimed for a job. The
-- composite primary key (job_id, partition_from) makes the claim atomic:
-- `INSERT OR IGNORE` succeeds exactly once per (job, from) pair, and a
-- replayed partition sees `meta.changes = 0` and short-circuits.
--
-- Rows are tiny and short-lived (a job has at most a few dozen partitions);
-- they are never read after the run completes, so no index beyond the PK is
-- needed. Cleanup is opportunistic — the table is bounded by the number of
-- jobs a user creates.

CREATE TABLE IF NOT EXISTS ai_job_partitions (
  job_id TEXT NOT NULL,
  partition_from INTEGER NOT NULL,
  partition_to INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (job_id, partition_from)
);
