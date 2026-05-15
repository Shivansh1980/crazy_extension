import { BRIDGE_RESOLVER_TIMEOUT_MS, DEFAULT_WEBSOCKET_URL } from './constants';

export interface ResolvedBridgeEndpoint {
  targetUrl: string;
  source: 'direct' | 'resolver';
  resolverUrl: string | null;
}

export function normalizeWebSocketUrl(value: string, fallback = DEFAULT_WEBSOCKET_URL): string {
  return toWebSocketUrl(value, fallback);
}

export function normalizeOptionalWebSocketUrl(value: string): string {
  return toWebSocketUrl(value, '');
}

export function normalizeResolverUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }

  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  try {
    const parsedUrl = new URL(withProtocol);
    const hostname = parsedUrl.hostname.toLowerCase();
    if (hostname === 'pastebin.com' || hostname.endsWith('.pastebin.com')) {
      const pasteId = extractPastebinId(parsedUrl.pathname);
      if (pasteId) {
        return `https://pastebin.com/raw/${pasteId}`;
      }
    }

    if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
      return '';
    }

    return parsedUrl.toString();
  } catch {
    return '';
  }
}

export async function resolveBridgeEndpoint(
  websocketUrl: string,
  websocketResolverUrl: string
): Promise<ResolvedBridgeEndpoint> {
  const normalizedDirectUrl = normalizeWebSocketUrl(websocketUrl);
  const normalizedResolverUrl = normalizeResolverUrl(websocketResolverUrl);

  if (!normalizedResolverUrl) {
    return {
      targetUrl: normalizedDirectUrl,
      source: 'direct',
      resolverUrl: null
    };
  }

  const abortController = new AbortController();
  const timeoutHandle = window.setTimeout(() => abortController.abort(), BRIDGE_RESOLVER_TIMEOUT_MS);

  let response: Response;

  try {
    response = await fetch(normalizedResolverUrl, {
      method: 'GET',
      cache: 'no-store',
      signal: abortController.signal,
      headers: {
        Accept: 'application/json, text/plain;q=0.9, */*;q=0.8'
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown resolver fetch error.';
    throw new Error(`Resolver request failed: ${message}`);
  } finally {
    window.clearTimeout(timeoutHandle);
  }

  if (!response.ok) {
    throw new Error(`Resolver endpoint returned ${response.status} ${response.statusText}.`);
  }

  const body = (await response.text()).trim();
  const resolvedUrl = extractWebSocketUrlFromResolverPayload(body);

  if (!resolvedUrl) {
    throw new Error('Resolver response did not contain a valid ws:// or wss:// bridge URL.');
  }

  return {
    targetUrl: toWebSocketUrl(resolvedUrl, normalizedDirectUrl),
    source: 'resolver',
    resolverUrl: normalizedResolverUrl
  };
}

function extractPastebinId(pathname: string): string | null {
  const pathSegments = pathname.split('/').filter(Boolean);
  if (pathSegments.length === 0) {
    return null;
  }

  if (pathSegments[0] === 'raw') {
    return pathSegments[1] ?? null;
  }

  return pathSegments[0] ?? null;
}

function extractWebSocketUrlFromResolverPayload(payload: string): string | null {
  const jsonMatch = tryExtractFromJson(payload);
  if (jsonMatch) {
    return jsonMatch;
  }

  const regexMatch = payload.match(/(?:wss?|https?|tcp):\/\/[^\s"']+/i);
  return regexMatch?.[0] ?? null;
}

function tryExtractFromJson(payload: string): string | null {
  try {
    const parsed = JSON.parse(payload) as Record<string, unknown>;
    const candidateKeys = ['websocketUrl', 'webSocketUrl', 'bridgeUrl', 'url', 'targetUrl'];

    for (const key of candidateKeys) {
      const value = parsed[key];
      if (typeof value === 'string' && /^(?:wss?|https?|tcp):\/\//i.test(value.trim())) {
        return value.trim();
      }
    }

    return null;
  } catch {
    return null;
  }
}

function toWebSocketUrl(value: string, fallback: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return fallback;
  }

  let normalized = trimmed;

  if (/^tcp:\/\//i.test(normalized)) {
    normalized = normalized.replace(/^tcp:/i, 'ws:');
  } else if (/^https:\/\//i.test(normalized)) {
    normalized = normalized.replace(/^https:/i, 'wss:');
  } else if (/^http:\/\//i.test(normalized)) {
    normalized = normalized.replace(/^http:/i, 'ws:');
  } else if (!/^(?:wss?|https?|tcp):\/\//i.test(normalized)) {
    normalized = `ws://${normalized}`;
  }

  try {
    const parsedUrl = new URL(normalized);
    if (parsedUrl.protocol !== 'ws:' && parsedUrl.protocol !== 'wss:') {
      return fallback;
    }

    return parsedUrl.toString().replace(/\/$/, '');
  } catch {
    return fallback;
  }
}