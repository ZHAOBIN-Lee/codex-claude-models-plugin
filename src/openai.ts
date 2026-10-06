import type { IncomingHttpHeaders } from 'node:http';
import { BridgeError } from './contracts.js';

const routes: Record<string, string> = {
  '/v1/responses': 'https://chatgpt.com/backend-api/codex/responses',
  '/v1/responses/compact': 'https://chatgpt.com/backend-api/codex/responses/compact',
};
const requestHeaders = new Set(['authorization', 'chatgpt-account-id', 'content-type', 'accept',
  'user-agent', 'originator', 'session-id', 'thread-id', 'x-client-request-id']);
export const ROUTER_TOKEN_HEADER = 'x-codex-router-token';
export interface OpenAIRequest {path: string; headers: IncomingHttpHeaders; body: Buffer; signal: AbortSignal}
export type ForwardOpenAI = (request: OpenAIRequest) => Promise<Response>;

export function openaiForwarder(fetchImpl: typeof fetch = fetch): ForwardOpenAI {
  return async request => {
    const url = routes[request.path];
    if (!url) throw new BridgeError(404, 'unsupported_route', 'Unsupported OpenAI route.');
    if (!request.headers.authorization?.startsWith('Bearer ') || !request.headers['chatgpt-account-id']) {
      throw new BridgeError(401, 'chatgpt_login_required', 'GPT routing requires your Codex ChatGPT login. Run codex login. No API-key fallback is configured.');
    }
    const headers = new Headers();
    for (const [key, value] of Object.entries(request.headers)) {
      if (value && key !== ROUTER_TOKEN_HEADER && (requestHeaders.has(key) || /^x-(codex|openai)-/.test(key))) {
        headers.set(key, Array.isArray(value) ? value.join(',') : value);
      }
    }
    const response = await fetchImpl(url, {method: 'POST', headers, body: new Uint8Array(request.body),
      signal: request.signal, redirect: 'manual'});
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new BridgeError(502, 'upstream_redirect', 'OpenAI returned a redirect; the router will not forward credentials to another destination.');
    }
    return response;
  };
}

export function forwardedResponseHeaders(headers: Headers): Record<string, string> {
  const excluded = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
    'te', 'trailer', 'transfer-encoding', 'upgrade', 'content-encoding', 'content-length', 'set-cookie']);
  for (const name of (headers.get('connection') ?? '').split(',')) excluded.add(name.trim().toLowerCase());
  return Object.fromEntries([...headers].filter(([name]) => !excluded.has(name)));
}

// OpenAI-encrypted payloads are Fernet-style base64url tokens.
const OPENAI_CIPHERTEXT = /^gAAAAA[A-Za-z0-9_-]+=*$/;

/**
 * Codex's v2 multi-agent protocol stores a spawn/send message in an `encrypted_content` part. When a Claude
 * parent spawns a GPT sub-agent, that part holds plain text, and OpenAI rejects the whole request with
 * "Encrypted function output content could not be decrypted or decoded". Turn such parts into ordinary
 * input_text. Real ciphertext is kept. Returns undefined when nothing needs changing, so the original
 * bytes are forwarded untouched.
 */
export function portableAgentMessages(json: unknown): Buffer | undefined {
  if (!json || typeof json !== 'object' || !Array.isArray((json as {input?: unknown}).input)) return undefined;
  let changed = false;
  const input = ((json as {input: unknown[]}).input).map(item => {
    if (!item || typeof item !== 'object' || (item as {type?: unknown}).type !== 'agent_message') return item;
    const content = (item as {content?: unknown}).content;
    if (!Array.isArray(content)) return item;
    let local = false;
    const parts = content.map(part => {
      const p = part as {type?: unknown; encrypted_content?: unknown};
      if (p && typeof p === 'object' && p.type === 'encrypted_content' && typeof p.encrypted_content === 'string'
          && !OPENAI_CIPHERTEXT.test(p.encrypted_content)) {
        local = true;
        return {type: 'input_text', text: p.encrypted_content};
      }
      return part;
    });
    if (!local) return item;
    changed = true;
    return {...(item as object), content: parts};
  });
  return changed ? Buffer.from(JSON.stringify({...(json as object), input})) : undefined;
}
