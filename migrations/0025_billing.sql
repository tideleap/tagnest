-- 0025_billing.sql
--
-- Phase A of the AI managed-billing scaffold (see docs/BILLING-PHASE-A.md).
--
-- Goal: turn "self-hosted full feature, bring your own key" into a product
-- that can *sell* a hosted tier. We do NOT add a payment gateway here (deferred
-- — Stripe/Polar needs a provider choice + credentials). What we add is the
-- metering substrate everything else will hang off of:
--
--   1. `ai_settings.managed_enabled`   — the user's consent to run inference on
--      TagNest's hosted model when they have no key of their own. Default on,
--      because every Pro/Team account is meant to be zero-config.
--
--   2. `subscriptions`                — one row per user. plan ∈
--      free|pro|team|admin, status ∈ none|trialing|active|canceled. Seeded by
--      the admin grant endpoints / a future checkout; never blocks inference on
--      its own (a missing row = free/none, which degrades to BYO-key).
--
--   3. `ai_credit_balances`           — the live meter. `balance` is what the
--      user can still spend; `used` is a running total for dashboards. One row
--      per user (PK), so a credit check is a single indexed point read.
--
--   4. `ai_credit_ledger`             — append-only audit trail. Every
--      decrement is a row here, so any dispute ("I had 200, where did they go?")
--      is reconstructable and the meter is auditable, not just a counter.
--
-- Units: 1 credit = 1 bookmark analysed by the hosted model. Token-based
-- metering is more "fair" but Phase A optimises for predictability — a user
-- knows exactly how many bookmarks a run will cost before they start it.

/* ------------------------------------------------------------------ *
 * 1) User consent for hosted inference
 * ------------------------------------------------------------------ */
ALTER TABLE ai_settings ADD COLUMN managed_enabled INTEGER NOT NULL DEFAULT 1;

/* ------------------------------------------------------------------ *
 * 2) Subscription / plan state (one row per user)
 * ------------------------------------------------------------------ */
CREATE TABLE IF NOT EXISTS subscriptions (
  user_id         TEXT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  plan            TEXT NOT NULL DEFAULT 'free',   -- free | pro | team | admin
  status          TEXT NOT NULL DEFAULT 'none',    -- none | trialing | active | canceled
  trial_ends_at   TEXT,                            -- ISO; null when not trialing
  period_ends_at  TEXT,                            -- ISO; null for free/none
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_plan ON subscriptions (plan);

/* ------------------------------------------------------------------ *
 * 3) Live credit meter (one row per user)
 * ------------------------------------------------------------------ */
CREATE TABLE IF NOT EXISTS ai_credit_balances (
  user_id   TEXT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  balance   INTEGER NOT NULL DEFAULT 0,
  used      INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

/* ------------------------------------------------------------------ *
 * 4) Append-only ledger for every deduction
 * ------------------------------------------------------------------ */
CREATE TABLE IF NOT EXISTS ai_credit_ledger (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  delta       INTEGER NOT NULL,   -- always negative for a spend
  reason      TEXT NOT NULL,      -- e.g. 'ai.tagging', 'ai.aliases', 'ai.save'
  ref         TEXT,               -- optional: job_id / bookmark_id
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ledger_user ON ai_credit_ledger (user_id, created_at);
