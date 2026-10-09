import { createServer, type IncomingMessage } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { BridgeError, isCompactionRequest, requestSchema, preparePrompt, validateDecision, type RunStep } from './contracts.js';
import { completedResponse, completionEvents, responseEnvelope } from './adapter.js';
import { IMAGE_ROUTES, ROUTER_TOKEN_HEADER, forwardedResponseHeaders, portableAgentMessages, type ForwardOpenAI } from './openai.js';
import { VERSION } from './version.js';

export interface ServerOptions {
  // timeoutMs / compactionTimeoutMs: longest stretch without model activity; maxStepMs: hard cap for any Claude step.
  // concurrency: Claude steps running at once. queueMs: how long an extra Claude step waits for a slot before failing as busy.
  // heavyTimeoutMs: stall limit for a large request (heavyBytes or more) or xhigh/max effort, where Opus can think for minutes before its first output.
  token: string; run: RunStep; timeoutMs?: number; compactionTimeoutMs?: number; maxStepMs?: number; heartbeatMs?: number; maxBytes?: number; concurrency?: number; queueMs?: number;
  heavyTimeoutMs?: number; heavyBytes?: number;
  openai?: {models: ReadonlySet<string>; forward: ForwardOpenAI; idleTimeoutMs?: number};
}

async function rawBody(request: IncomingMessage, maxBytes: number) {
  if (Number(request.headers['content-length'] ?? 0) > maxBytes) {
    request.resume();
    throw new BridgeError(413, 'body_limit', 'Request exceeds the bridge body limit.');
  }
  const parts: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new BridgeError(413, 'body_limit', 'Request exceeds the bridge body limit.');
    parts.push(Buffer.from(chunk));
  }
  return Buffer.concat(parts);
}

async function body(request: IncomingMessage, maxBytes: number) {
  const bytes = await rawBody(request, maxBytes);
  try { return {bytes, json: JSON.parse(bytes.toString('utf8')) as unknown}; }
  catch { throw new BridgeError(400, 'invalid_json', 'Request body is not valid JSON.'); }
}

// A GPT request that failed before OpenAI answered: say so, instead of the generic Claude failure text.
function upstreamFailure(error: unknown, idle: boolean) {
  if (idle) return new BridgeError(504, 'openai_idle_timeout', 'OpenAI sent no data for this GPT request within the router idle limit. Retry the step.');
  const cause = (error as {cause?: {code?: unknown}} | null)?.cause?.code;
  const code = typeof cause === 'string' && /^[A-Z0-9_]{1,32}$/.test(cause) ? ` (${cause})` : '';
  return new BridgeError(502, 'openai_upstream_failed', `The router could not reach OpenAI for this GPT request${code}. Retry; if it keeps failing, check the network or run codex login.`);
}

export function bridgeServer(options: ServerOptions) {
  let active = 0;
  // Requests in flight, for a restart that lets them finish (drain) instead of cutting them off.
  let inflight = 0, draining = false, settle = () => {};
  const limit = options.concurrency ?? 6;
  const waiting: (() => void)[] = [];
  // A finished step hands its slot straight to the oldest waiter, so `active` only drops when nobody is queued.
  const release = () => {const next = waiting.shift(); if (next) next(); else active--;};
  const acquire = (signal: AbortSignal, waitMs: number) => new Promise<void>((resolve, reject) => {
    if (active < limit) {active++; resolve(); return;}
    if (waitMs <= 0 || signal.aborted) {reject(new BridgeError(429, 'busy', 'Claude bridge concurrency limit reached.')); return;}
    const cleanup = () => {clearTimeout(timer); signal.removeEventListener('abort', cancelled);};
    const grant = () => {cleanup(); resolve();};
    const fail = (error: BridgeError) => {
      cleanup();
      const index = waiting.indexOf(grant);
      if (index >= 0) waiting.splice(index, 1);
      reject(error);
    };
    const cancelled = () => fail(new BridgeError(499, 'cancelled', 'The request was cancelled while waiting for a Claude slot.'));
    const timer = setTimeout(() => fail(new BridgeError(429, 'busy',
      `Claude bridge concurrency limit reached; no slot became free within ${Math.round(waitMs / 1000)} s.`)), waitMs);
    signal.addEventListener('abort', cancelled, {once: true});
    waiting.push(grant);
  });
  const server = createServer(async (req, res) => {
    inflight++;
    res.on('close', () => {inflight--; settle();});
    if (draining) res.setHeader('connection', 'close');
    let timer: ReturnType<typeof setTimeout> | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let acquired = false;
    let sequence = 0;
    let base: ReturnType<typeof responseEnvelope> | undefined;
    let forwarding = false;
    let progress = () => {};
    const controller = new AbortController();
    const event = (value: Record<string, unknown>) => res.write(`data: ${JSON.stringify({...value, sequence_number: sequence++})}\n\n`);
    res.on('close', () => controller.abort());
    try {
      const equalsToken = (value: unknown, expected: string) => {
        if (typeof value !== 'string') return false;
        const a = Buffer.from(value), b = Buffer.from(expected);
        return a.length === b.length && timingSafeEqual(a, b);
      };
      const routerAuth = equalsToken(req.headers[ROUTER_TOKEN_HEADER], options.token);
      const legacyAuth = equalsToken(req.headers.authorization, `Bearer ${options.token}`);
      if (req.headers.origin || (!routerAuth && !legacyAuth)) {
        throw new BridgeError(401, 'unauthorized', 'Local bridge authentication required.');
      }
      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, {'content-type': 'application/json'}).end(JSON.stringify({service: 'codex-claude-models', version: VERSION, pid: process.pid}));
        return;
      }
      const imageRoute = IMAGE_ROUTES.has(req.url ?? '');
      if (req.method !== 'POST' || !(imageRoute || ['/v1/responses', '/v1/responses/compact'].includes(req.url ?? ''))) throw new BridgeError(404, 'not_found', 'Endpoint not found.');
      if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') throw new BridgeError(415, 'content_encoding', 'The router expects uncompressed JSON requests.');
      // GPT chat and image requests are a plain proxy to OpenAI with the caller's own ChatGPT credential.
      const proxy = async (bytes: Buffer) => {
        if (!options.openai) throw new BridgeError(404, 'not_found', 'Endpoint not found.');
        if (!routerAuth || legacyAuth) throw new BridgeError(401, 'chatgpt_login_required', 'GPT requests require router authentication and a separate Codex ChatGPT credential.');
        forwarding = true;
        const idle = options.openai.idleTimeoutMs ?? 300000;
        timer = setTimeout(() => controller.abort(), idle);
        const upstream = await options.openai.forward({path: req.url!, headers: req.headers, body: bytes, signal: controller.signal});
        res.writeHead(upstream.status, forwardedResponseHeaders(upstream.headers));
        if (!upstream.body) {res.end(); return;}
        await pipeline(Readable.fromWeb(upstream.body as import('node:stream/web').ReadableStream), async function* (source) {
          for await (const chunk of source) {
            clearTimeout(timer); timer = setTimeout(() => controller.abort(), idle);
            yield chunk;
          }
        }, res, {signal: controller.signal});
      };
      if (imageRoute) {
        if (!options.openai) throw new BridgeError(404, 'not_found', 'Image generation needs the GPT router.');
        await proxy(await rawBody(req, options.maxBytes ?? 64 * 1024 * 1024));
        return;
      }
      // Inline screenshots make long Codex histories large; GPT steps are forwarded as-is and must not be capped below a direct request.
      const payload = await body(req, options.maxBytes ?? 64 * 1024 * 1024);
      const model = payload.json && typeof payload.json === 'object' && 'model' in payload.json ? payload.json.model : undefined;
      if (typeof model !== 'string') throw new BridgeError(400, 'invalid_request', 'A model is required.');
      if (options.openai?.models.has(model)) {
        // A Claude parent writes plain text where OpenAI expects its own ciphertext; see portableAgentMessages.
        await proxy(portableAgentMessages(payload.json) ?? payload.bytes);
        return;
      }
      if (!model.startsWith('claude-sdk-') && options.openai) throw new BridgeError(400, 'unknown_model', 'Model is not in the installed router catalog. Run install to refresh it.');
      if (req.url !== '/v1/responses') throw new BridgeError(400, 'unsupported_compaction', 'Claude does not support remote compaction.');
      const parsed = requestSchema.safeParse(payload.json);
      if (!parsed.success) throw new BridgeError(400, 'invalid_request', 'Invalid Responses request.');
      const request = parsed.data;
      preparePrompt(request);
      const compaction = isCompactionRequest(request);
      const envelope = base = responseEnvelope(request.model);
      if (request.stream) {
        res.writeHead(200, {'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'connection': 'keep-alive'});
        event({type: 'response.created', response: envelope});
        event({type: 'response.in_progress', response: envelope});
        // Codex resets its stream idle timer only on parsed SSE events; comment lines do not count.
        heartbeat = setInterval(() => {
          if (!res.destroyed && !res.writableEnded) event({type: 'response.in_progress', response: envelope});
        }, options.heartbeatMs ?? 10000);
      }
      // Only Claude steps hold a slot: each one runs an SDK subprocess. GPT requests are a plain proxy, and once
      // chats are migrated to the router every GPT request passes here, so counting them starved Claude and GPT alike.
      // Extra Claude steps wait in order (a streamed request keeps receiving heartbeats) and fail as busy only after queueMs.
      await acquire(controller.signal, options.queueMs ?? 120000);
      acquired = true;
      // A step fails only after a stretch with no model activity, or at the hard cap. A fixed 180 s limit cut off
      // slow but active steps, such as one large patch written over a 460k-token context at high effort.
      const heavy = ['xhigh', 'max'].includes(String(request.reasoning?.effort ?? '')) || payload.bytes.length >= (options.heavyBytes ?? 1200000);
      const stallLimit = compaction ? (options.compactionTimeoutMs ?? 300000) : heavy ? (options.heavyTimeoutMs ?? 300000) : (options.timeoutMs ?? 180000);
      const hardLimit = options.maxStepMs ?? 900000;
      let stall: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        // The abort reason tells the SDK runner (and its receipt) that this was a timeout, not a user cancel.
        const fail = (message: string, limit: 'stall' | 'hard') => {
          const error = new BridgeError(504, 'timeout', message, {limit});
          controller.abort(error); reject(error);
        };
        const what = compaction ? 'Claude compaction' : 'Claude step';
        const arm = () => {clearTimeout(stall); stall = setTimeout(() => fail(`${what} timed out: no model activity for ${Math.round(stallLimit / 1000)} s.`, 'stall'), stallLimit);};
        progress = arm; arm();
        timer = setTimeout(() => fail(`${what} timed out after ${Math.round(hardLimit / 60000)} min.`, 'hard'), hardLimit);
      });
      // Codex has no model fallback for local compaction, so one retry keeps the user's turn from failing.
      const step = async () => {
        try {return await options.run(request, controller.signal, progress);}
        catch (error) {
          const retryable = error instanceof BridgeError ? error.status === 502 : true;
          if (!compaction || controller.signal.aborted || !retryable) throw error;
          return options.run(request, controller.signal, progress);
        }
      };
      const result = await Promise.race([step(), timeout]).finally(() => clearTimeout(stall));
      validateDecision(result.decision, request);
      const completed = completedResponse(base, request, result);
      if (request.stream) {for (const value of completionEvents(completed)) event(value); res.end();}
      else res.writeHead(200, {'content-type': 'application/json'}).end(JSON.stringify(completed));
    } catch (error) {
      const failure = error instanceof BridgeError ? error : forwarding ? upstreamFailure(error, controller.signal.aborted)
        : new BridgeError(502, 'bridge_failed', 'Claude bridge failed. Run doctor to check the local runtime and login.');
      const details = {code: failure.code, message: failure.message};
      if (!res.destroyed) {
        if (res.headersSent && forwarding) res.destroy();
        else if (res.headersSent) {event({type: 'response.failed', response: {...base, status: 'failed', error: details}}); res.end();}
        else res.writeHead(failure.status, {'content-type': 'application/json'}).end(JSON.stringify({error: details}));
      }
    } finally {if (acquired) release(); clearTimeout(timer); clearInterval(heartbeat);}
  });
  // Restart without cutting off work: stop listening at once (the port is free for the next router), close idle
  // keep-alive sockets, let requests in flight finish, then resolve. maxMs bounds a step that never ends.
  const drain = (maxMs = 16 * 60000) => new Promise<void>(resolve => {
    draining = true;
    server.close();
    const cap = setTimeout(() => {server.closeAllConnections(); resolve();}, maxMs);
    cap.unref();
    settle = () => {server.closeIdleConnections(); if (inflight === 0) {clearTimeout(cap); resolve();}};
    settle();
  });
  return Object.assign(server, {drain});
}
