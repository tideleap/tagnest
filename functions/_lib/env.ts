import type { ApiKeyScope, User } from '../../shared/types';

export interface Env {
  DB: D1Database;
  /** HMAC secret for access tokens. Set via `wrangler pages secret put`. */
  JWT_SECRET?: string;
  /** Overrides the PBKDF2 cost; see auth.ts for the trade-off. */
  PBKDF2_ITERATIONS?: string;
  /** Set to "true" to reject new registrations on a private instance. */
  DISABLE_SIGNUP?: string;
  /**
   * Optional allowlist for open-but-gated registration: comma-separated exact
   * emails (case-insensitive) or domain wildcards ("*@example.com"). Empty or
   * unset leaves registration fully open. Ignored when DISABLE_SIGNUP=true.
   */
  ALLOWED_EMAILS?: string;
  /**
   * Optional invite-code gate. When set, registration requires a matching
   * `inviteCode` in the POST body (constant-time compared). A single shared
   * secret is simpler to operate than an email allowlist when the instance is
   * mostly private but a handful of people need accounts. Empty or unset
   * disables the gate. Can be combined with ALLOWED_EMAILS.
   */
  INVITE_CODE?: string;
  /**
   * Optional edge cache for public share pages. Absent in local dev and on
   * deployments that skip the binding; every read path degrades to D1.
   */
  SHARE_CACHE?: KVNamespace;
  /**
   * R2 bucket holding generated website snapshots. Absent in local dev and on
   * deployments that skip the binding; the snapshot pipeline degrades to a
   * plain (no-snapshot) bookmark when it is missing.
   */
  SNAPSHOT_BUCKET?: R2Bucket;
  /**
   * Optional Cloudflare Browser Run binding (`browser` in wrangler.toml).
   * When present and SNAPSHOT_API_URL is unset, snapshots are captured
   * self-hosted on Cloudflare's network via `env.BROWSER.quickAction(...)` —
   * no third party, no API key. Requires compatibility_date >= 2026-03-24.
   */
  BROWSER?: BrowserRun;
  /**
   * Base URL of a third-party screenshot API used to generate a snapshot
   * image. Optional — when set it takes priority over Browser Run. Supports a
   * `{url}` token that is replaced with the (encoded) target URL. After a
   * dashboard change, a FRESH deploy is required for Pages to bind it (env
   * vars are applied per-deployment).
   */
  SNAPSHOT_API_URL?: string;
  /**
   * Optional auth secret sent as `Authorization: Bearer <key>` to the snapshot
   * API. Absent when the service needs no auth.
   */
  SNAPSHOT_API_KEY?: string;
  /** Minimum severity emitted by the structured logger (default 'info'). */
  LOG_LEVEL?: string;
}

/** Populated by the API middleware once a request is authenticated. */
export interface RequestData extends Record<string, unknown> {
  user?: User;
  userId?: string;
  /** Present only when the caller authenticated with a personal access key. */
  apiKeyId?: string;
  apiKeyScopes?: ApiKeyScope[];
}

export type Ctx = EventContext<Env, string, RequestData>;
