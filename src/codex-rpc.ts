import { spawn } from 'node:child_process';

export type CodexRpc = <T>(method: string, params: unknown) => Promise<T>;

// Setup and the helper scripts must talk to the same Codex executable: CODEX_BIN, else the one on PATH.
export const codexBin = () => process.env.CODEX_BIN || 'codex';

export async function withCodexRpc<T>(home: string, cwd: string, action: (rpc: CodexRpc) => Promise<T>): Promise<T> {
  const child = spawn(codexBin(), ['app-server', '--stdio', '--disable', 'remote_plugin', '--disable', 'apps', '--disable', 'plugins'],
    {cwd, env: {...process.env, CODEX_HOME: home}, stdio: ['pipe', 'pipe', 'pipe']});
  let sequence = 0, buffer = '';
  const pending = new Map<number, {resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>}>();
  const rpc: CodexRpc = (method, params) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => {pending.delete(id); reject(new Error(`Codex ${method} timed out.`));}, 20000);
    pending.set(id, {resolve, reject, timer});
    child.stdin.write(`${JSON.stringify({id, method, params})}\n`);
  });
  const fail = () => {
    for (const p of pending.values()) {clearTimeout(p.timer); p.reject(new Error('Codex app-server stopped during setup.'));}
    pending.clear();
  };
  child.on('error', fail); child.on('exit', fail); child.stderr.resume();
  child.stdout.on('data', chunk => {
    buffer += chunk;
    while (buffer.includes('\n')) {
      const end = buffer.indexOf('\n'); const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      let message;
      try {message = JSON.parse(line);} catch {fail(); child.kill(); return;}
      const waiting = pending.get(message.id);
      if (!waiting) continue;
      pending.delete(message.id); clearTimeout(waiting.timer);
      if (message.error) waiting.reject(new Error(`Codex configuration request failed: ${message.error.message}`));
      else waiting.resolve(message.result);
    }
  });
  try {
    await rpc('initialize', {clientInfo: {name: 'codex-claude-models-setup', version: '0.2.0'}, capabilities: {experimentalApi: true}});
    child.stdin.write(`${JSON.stringify({method: 'initialized'})}\n`);
    return await action(rpc);
  } finally {fail(); child.stdin.end(); child.kill();}
}
