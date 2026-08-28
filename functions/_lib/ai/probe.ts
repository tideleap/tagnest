import type { AiProvider } from '../../../shared/types';
import { DEFAULT_ENDPOINTS } from './providers';

/**
 * Connection probing for user-supplied AI endpoints.
 *
 * Pure request builders and response parsers — the network lives in the
 * `test-connection` endpoint so this module stays unit-testable without fetch.
 *
 * Two probes, in order:
 *  1. The provider's model-list endpoint (`GET /models` for OpenAI-compatible
 *     and Anthropic, `GET /models?key=` for Gemini). Success proves the URL is
 *     reachable AND the key authenticates, and yields the model catalogue.
 *  2. Fallback when the list endpoint 404s (some gateways omit it): one
 *     minimal chat completion with `max_tokens: 1`. Proves the key works but
 *     cannot enumerate models.
 */

export interface ProbeRequest {
  url: string;
  headers: Record<string, string>;
  /** Present only for the inference fallback (POST). */
  body?: unknown;
  method: 'GET' | 'POST';
}

/** Cap on models returned to the client; a gateway with thousands of routing
 * aliases is noise, not a picker. */
export const MAX_MODELS_RETURNED = 200;

/**
 * Resolves the base endpoint exactly like inference does, so a probe never
 * succeeds against a URL the real calls would not use.
 */
export function resolveProbeEndpoint(provider: AiProvider, baseUrl: string | null): string | null {
  const base = baseUrl?.trim().replace(/\/+$/, '');
  if (provider === 'custom') return base || null;
  if (provider === 'none') return null;
  return base || DEFAULT_ENDPOINTS[provider] || null;
}

/** Builds the model-list request for a provider, or null when impossible. */
export function buildModelsRequest(
  provider: AiProvider,
  baseUrl: string | null,
  apiKey: string,
): ProbeRequest | null {
  const endpoint = resolveProbeEndpoint(provider, baseUrl);
  if (!endpoint) return null;

  if (provider === 'gemini') {
    return {
      method: 'GET',
      url: `${endpoint}/models?key=${encodeURIComponent(apiKey)}`,
      headers: { accept: 'application/json' },
    };
  }

  if (provider === 'anthropic') {
    return {
      method: 'GET',
      url: `${endpoint}/models`,
      headers: {
        accept: 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
    };
  }

  // OpenAI-compatible — includes `custom` (LM Studio, Ollama bridge,
  // OpenRouter, corporate gateways…).
  return {
    method: 'GET',
    url: `${endpoint}/models`,
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
  };
}

/**
 * Builds the minimal inference request used when the model-list endpoint is
 * missing. Deliberately tiny (one token out) so the probe costs nothing.
 */
export function buildMinimalInferenceRequest(
  provider: AiProvider,
  baseUrl: string | null,
  apiKey: string,
  model: string,
): ProbeRequest | null {
  const endpoint = resolveProbeEndpoint(provider, baseUrl);
  if (!endpoint || !model.trim()) return null;

  if (provider === 'anthropic') {
    return {
      method: 'POST',
      url: `${endpoint}/messages`,
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: { model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] },
    };
  }

  if (provider === 'gemini') {
    return {
      method: 'POST',
      url: `${endpoint}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
      headers: { 'content-type': 'application/json' },
      body: {
        contents: [{ parts: [{ text: 'ping' }] }],
        generationConfig: { maxOutputTokens: 1 },
      },
    };
  }

  return {
    method: 'POST',
    url: `${endpoint}/chat/completions`,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: {
      model,
      max_tokens: 1,
      messages: [{ role: 'user', content: 'ping' }],
    },
  };
}

/**
 * Extracts model ids from a provider's list payload. Returns [] for shapes we
 * do not recognise — an unparseable list means "connected, catalogue
 * unavailable", never a failure.
 */
export function parseModelsPayload(provider: AiProvider, payload: unknown): string[] {
  const p = payload as Record<string, unknown> | null;
  if (!p) return [];

  let raw: unknown[] = [];
  if (provider === 'gemini') {
    raw = Array.isArray(p.models) ? p.models : [];
    const names = raw
      .map((m) => (m as { name?: unknown })?.name)
      .filter((n): n is string => typeof n === 'string' && n.trim().length > 0)
      // Gemini names arrive as "models/gemini-2.0-flash"; the API wants the bare id.
      .map((n) => n.replace(/^models\//, ''));
    return dedupe(names);
  }

  // OpenAI-compatible and Anthropic both use { data: [{ id }] }.
  raw = Array.isArray(p.data) ? p.data : [];
  const ids = raw
    .map((m) => (m as { id?: unknown })?.id)
    .filter((n): n is string => typeof n === 'string' && n.trim().length > 0);
  return dedupe(ids);
}

function dedupe(models: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of models) {
    const key = m.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
    if (out.length >= MAX_MODELS_RETURNED) break;
  }
  return out.sort((a, b) => a.localeCompare(b));
}
