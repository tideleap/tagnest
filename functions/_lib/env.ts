import type { User } from '../../shared/types';

export interface Env {
  DB: D1Database;
  /** HMAC secret for access tokens. Set via `wrangler pages secret put`. */
  JWT_SECRET?: string;
  /** Overrides the PBKDF2 cost; see auth.ts for the trade-off. */
  PBKDF2_ITERATIONS?: string;
  /** Set to "true" to reject new registrations on a private instance. */
  DISABLE_SIGNUP?: string;
}

/** Populated by the API middleware once a request is authenticated. */
export interface RequestData extends Record<string, unknown> {
  user?: User;
  userId?: string;
}

export type Ctx = EventContext<Env, string, RequestData>;
