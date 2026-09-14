import { createServer, type IncomingMessage } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { BridgeError, requestSchema, preparePrompt, validateDecision, type RunStep } from './contracts.js';
import { completedResponse, completionEvents, responseEnvelope } from './adapter.js';

export interface ServerOptions {token: string; run: RunStep; timeoutMs?: number; maxBytes?: number; concurrency?: number}

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
  try { return JSON.parse(Buffer.concat(parts).toString('utf8')) as unknown; }
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
    const controller = new AbortController();
    const event = (value: Record<string, unknown>) => res.write(`data: ${JSON.stringify({...value, sequence_number: sequence++})}\n\n`);
    res.on('close', () => controller.abort());
    try {
      const supplied = Buffer.from(req.headers.authorization ?? '');
      const expected = Buffer.from(`Bearer ${options.token}`);
      if (req.headers.origin || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
        throw new BridgeError(401, 'unauthorized', 'Local bridge authentication required.');
      }
      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, {'content-type': 'application/json'}).end(JSON.stringify({service: 'codex-claude-models', version: '0.1.0', pid: process.pid}));
        return;
      }
      if (req.method !== 'POST' || req.url !== '/v1/responses') throw new BridgeError(404, 'not_found', 'Endpoint not found.');
      if (active >= (options.concurrency ?? 6)) throw new BridgeError(429, 'busy', 'Claude bridge concurrency limit reached.');
      acquired = true; active++;
      const parsed = requestSchema.safeParse(await body(req, options.maxBytes ?? 8 * 1024 * 1024));
      if (!parsed.success) throw new BridgeError(400, 'invalid_request', 'Invalid Responses request.');
      const request = parsed.data;
      preparePrompt(request);
      base = responseEnvelope(request.model);
      if (request.stream) {
        res.writeHead(200, {'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'connection': 'keep-alive'});
        event({type: 'response.created', response: base});
        event({type: 'response.in_progress', response: base});
        heartbeat = setInterval(() => res.write(': keepalive\n\n'), 10000);
      }
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {controller.abort(); reject(new BridgeError(504, 'timeout', 'Claude step timed out.'));}, options.timeoutMs ?? 180000);
      });
      const result = await Promise.race([options.run(request, controller.signal), timeout]);
      validateDecision(result.decision, request);
      const completed = completedResponse(base, request, result);
      if (request.stream) {for (const value of completionEvents(completed)) event(value); res.end();}
      else res.writeHead(200, {'content-type': 'application/json'}).end(JSON.stringify(completed));
    } catch (error) {
      const failure = error instanceof BridgeError ? error : new BridgeError(502, 'bridge_failed', 'Claude bridge failed. Run doctor to check the local runtime and login.');
      const details = {code: failure.code, message: failure.message};
      if (!res.destroyed) {
        if (res.headersSent) {event({type: 'response.failed', response: {...base, status: 'failed', error: details}}); res.end();}
        else res.writeHead(failure.status, {'content-type': 'application/json'}).end(JSON.stringify({error: details}));
      }
    } finally {if (acquired) active--; clearTimeout(timer); clearInterval(heartbeat);}
  });
}
