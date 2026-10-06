import { createServer, type IncomingMessage } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { BridgeError, isCompactionRequest, requestSchema, preparePrompt, validateDecision, type RunStep } from './contracts.js';
import { completedResponse, completionEvents, responseEnvelope } from './adapter.js';
import { ROUTER_TOKEN_HEADER, forwardedResponseHeaders, portableAgentMessages, type ForwardOpenAI } from './openai.js';
import { VERSION } from './version.js';

export interface ServerOptions {
  // timeoutMs / compactionTimeoutMs: longest stretch without model activity; maxStepMs: hard cap for any Claude step.
  token: string; run: RunStep; timeoutMs?: number; compactionTimeoutMs?: number; maxStepMs?: number; heartbeatMs?: number; maxBytes?: number; concurrency?: number;
  openai?: {models: ReadonlySet<string>; forward: ForwardOpenAI; idleTimeoutMs?: number};
}

async function body(request: IncomingMessage, maxBytes: number) {
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
  const bytes = Buffer.concat(parts);
  try { return {bytes, json: JSON.parse(bytes.toString('utf8')) as unknown}; }
  catch { throw new BridgeError(400, 'invalid_json', 'Request body is not valid JSON.'); }
}

export function bridgeServer(options: ServerOptions) {
  let active = 0;
  return createServer(async (req, res) => {
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
      if (req.method !== 'POST' || !['/v1/responses', '/v1/responses/compact'].includes(req.url ?? '')) throw new BridgeError(404, 'not_found', 'Endpoint not found.');
      if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') throw new BridgeError(415, 'content_encoding', 'The router expects uncompressed JSON requests.');
      if (active >= (options.concurrency ?? 6)) throw new BridgeError(429, 'busy', 'Claude bridge concurrency limit reached.');
      acquired = true; active++;
      // Inline screenshots make long Codex histories large; GPT steps are forwarded as-is and must not be capped below a direct request.
      const payload = await body(req, options.maxBytes ?? 64 * 1024 * 1024);
      const model = payload.json && typeof payload.json === 'object' && 'model' in payload.json ? payload.json.model : undefined;
      if (typeof model !== 'string') throw new BridgeError(400, 'invalid_request', 'A model is required.');
      if (options.openai?.models.has(model)) {
        if (!routerAuth || legacyAuth) throw new BridgeError(401, 'chatgpt_login_required', 'GPT requests require router authentication and a separate Codex ChatGPT credential.');
        forwarding = true;
        timer = setTimeout(() => controller.abort(), options.openai.idleTimeoutMs ?? 300000);
        // A Claude parent writes plain text where OpenAI expects its own ciphertext; see portableAgentMessages.
        const forwardBody = portableAgentMessages(payload.json) ?? payload.bytes;
        const upstream = await options.openai.forward({path: req.url!, headers: req.headers, body: forwardBody, signal: controller.signal});
        res.writeHead(upstream.status, forwardedResponseHeaders(upstream.headers));
        if (!upstream.body) {res.end(); return;}
        const idle = options.openai.idleTimeoutMs ?? 300000;
        await pipeline(Readable.fromWeb(upstream.body as import('node:stream/web').ReadableStream), async function* (source) {
          for await (const chunk of source) {
            clearTimeout(timer); timer = setTimeout(() => controller.abort(), idle);
            yield chunk;
          }
        }, res, {signal: controller.signal});
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
      // A step fails only after a stretch with no model activity, or at the hard cap. A fixed 180 s limit cut off
      // slow but active steps, such as one large patch written over a 460k-token context at high effort.
      const stallLimit = compaction ? (options.compactionTimeoutMs ?? 300000) : (options.timeoutMs ?? 180000);
      const hardLimit = options.maxStepMs ?? 900000;
      let stall: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        const fail = (message: string) => {controller.abort(); reject(new BridgeError(504, 'timeout', message));};
        const what = compaction ? 'Claude compaction' : 'Claude step';
        const arm = () => {clearTimeout(stall); stall = setTimeout(() => fail(`${what} timed out: no model activity for ${Math.round(stallLimit / 1000)} s.`), stallLimit);};
        progress = arm; arm();
        timer = setTimeout(() => fail(`${what} timed out after ${Math.round(hardLimit / 60000)} min.`), hardLimit);
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
      const failure = error instanceof BridgeError ? error : new BridgeError(502, 'bridge_failed', 'Claude bridge failed. Run doctor to check the local runtime and login.');
      const details = {code: failure.code, message: failure.message};
      if (!res.destroyed) {
        if (res.headersSent && forwarding) res.destroy();
        else if (res.headersSent) {event({type: 'response.failed', response: {...base, status: 'failed', error: details}}); res.end();}
        else res.writeHead(failure.status, {'content-type': 'application/json'}).end(JSON.stringify({error: details}));
      }
    } finally {if (acquired) active--; clearTimeout(timer); clearInterval(heartbeat);}
  });
}
