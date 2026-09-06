// Phase-0 read side-effect probe (evidence script, 2026-09-05).
// Long-lived `serve` + spaced FTS5 recalls against an isolated test DB.
// Result: retrieval_count stayed 0 at t0/t+4s/t+8s (FTS5 only; NOT a full
// write-freedom proof — see phase0-capability.md).
import { spawn } from 'node:child_process';
const DB = process.env.P0DB;
const KEY = process.env.P0KEY;
const srv = spawn('perseus-vault', ['serve', '--db', DB, '--encryption-key', KEY], {
  stdio: ['pipe', 'pipe', 'ignore'],
});
let buf = '';
const pending = new Map();
let nextId = 0;
srv.stdout.on('data', (d) => {
  buf += d.toString();
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    } catch {
      // ignore non-JSON frames
    }
  }
});
function rpc(method, params, timeoutMs = 30000) {
  return new Promise((res, rej) => {
    const id = nextId++;
    const t = setTimeout(() => {
      pending.delete(id);
      rej(new Error(`RPC timeout: ${method}`));
    }, timeoutMs);
    pending.set(id, (m) => {
      clearTimeout(t);
      res(m);
    });
    srv.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function countOf(m) {
  const sc = m.result && m.result.structuredContent;
  if (sc && sc.items && sc.items[0])
    return { c: sc.items[0].retrieval_count, la: sc.items[0].last_accessed_unix_ms };
  const j = JSON.parse(m.result.content[0].text);
  return { c: j.items[0].retrieval_count, la: j.items[0].last_accessed_unix_ms };
}
try {
  await rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'phase0', version: '0' },
  });
  srv.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  const q = { query: 'roundtrip probe', workspace_hash: 'testws', limit: 5 };
  console.log(`t0 recall: ${JSON.stringify(countOf(await rpc('tools/call', { name: 'perseus_vault_recall', arguments: q })))}`);
  await sleep(4000);
  console.log(`t+4s recall: ${JSON.stringify(countOf(await rpc('tools/call', { name: 'perseus_vault_recall', arguments: q })))}`);
  await sleep(4000);
  console.log(`t+8s recall: ${JSON.stringify(countOf(await rpc('tools/call', { name: 'perseus_vault_recall', arguments: q })))}`);
} finally {
  srv.kill();
  process.exit(0);
}
