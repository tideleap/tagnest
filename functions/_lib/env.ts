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
   * Optional edge cache for public share pages. Absent in local dev and on
   * deployments that skip the binding; every read path degrades to D1.
   */
  SHARE_CACHE?: KVNamespace;
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
