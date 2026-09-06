// Fixture: minimal fake `perseus-vault serve` speaking newline-delimited JSON-RPC.
// Used by vaultClient/vaultManager tests — no real binary needed.
import { accessSync, appendFileSync } from 'node:fs';
import readline from 'node:readline';

const slowInitMs = Number(process.env.FAKE_SLOW_INIT_MS ?? 0);
const logFile = process.env.FAKE_LOG ?? '';
const initGateDir = process.env.FAKE_INIT_GATE ?? '';

function reply(id, payload) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, ...payload })}\n`);
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id === undefined) return; // notifications need no reply
  if (msg.method === 'initialize') {
    if (logFile) appendFileSync(logFile, `${process.pid}\n`);
    const send = () =>
      reply(msg.id, {
        result: {
          protocolVersion: '2025-06-18',
          serverInfo: { name: 'perseus-vault' },
        },
      });
    const answer = () => {
      if (slowInitMs > 0) setTimeout(send, slowInitMs);
      else send();
    };
    // Gate: signal receipt, hold the answer until the release file appears.
    // Proves a handshake is REALLY in flight (test controls release per step).
    if (initGateDir) {
      appendFileSync(`${initGateDir}/got-${process.pid}`, '');
      const wait = setInterval(() => {
        try {
          accessSync(`${initGateDir}/release`);
        } catch {
          return;
        }
        clearInterval(wait);
        answer();
      }, 25);
      if (wait.unref) wait.unref();
    } else answer();
    return;
  }
  if (msg.method === 'tools/call') {
    if (msg.params?.name === 'boom') {
      process.stdout.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -1, message: 'boom' } })}\n`,
      );
      return;
    }
    if (msg.params?.name === 'hang') return; // never reply: exercises client timeouts
    if (msg.params?.name === 'tool-boom') {
      process.stdout.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { isError: true, content: [{ text: 'tool failed: boom' }] } })}\n`,
      );
      return;
    }
    if (msg.params?.name === 'slow') {
      setTimeout(() => {
        process.stdout.write(
          `${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { structuredContent: { slow: true } } })}\n`,
        );
      }, 400);
      return;
    }
    if (msg.params?.name === 'big') {
      process.stdout.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { structuredContent: { blob: 'x'.repeat(9 * 1024 * 1024) } } })}\n`,
      );
      return;
    }
    process.stdout.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { structuredContent: { echo: msg.params } } })}\n`,
    );
  }
});
