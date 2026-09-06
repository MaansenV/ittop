#!/usr/bin/env node
// Zero-dependency stdio <-> socket relay for ittop memory bridge.
// Authenticates with ITTOP_MCP_TOKEN before streaming stdin.
const net = require('node:net');

const socketPath = process.env.ITTOP_MCP_SOCKET || process.argv[2];
const token = process.env.ITTOP_MCP_TOKEN || process.argv[3];

if (!socketPath) {
  process.stderr.write('ittop-mcp: error: ITTOP_MCP_SOCKET environment variable or argument required\n');
  process.exit(1);
}
if (!token) {
  process.stderr.write('ittop-mcp: error: ITTOP_MCP_TOKEN environment variable or argument required\n');
  process.exit(1);
}

const client = net.createConnection(socketPath, () => {
  // 1. Authenticate with the bridge
  const authMsg = JSON.stringify({
    jsonrpc: '2.0',
    id: '__ittop_auth__',
    method: 'ittop/auth',
    params: { token },
  }) + '\n';
  client.write(authMsg);
});

let authenticated = false;
let authBuffer = '';

const onInitialData = (chunk) => {
  if (authenticated) return;
  authBuffer += chunk.toString('utf8');
  const newline = authBuffer.indexOf('\n');
  if (newline !== -1) {
    const line = authBuffer.slice(0, newline);
    const remainder = authBuffer.slice(newline + 1);
    try {
      const resp = JSON.parse(line);
      if (resp.id === '__ittop_auth__' && resp.result && resp.result.ok) {
        authenticated = true;
        client.removeListener('data', onInitialData);
        // Forward any remaining bytes from socket to stdout
        if (remainder.length > 0) {
          process.stdout.write(remainder);
        }
        client.pipe(process.stdout);
        // Start streaming stdin to the socket
        process.stdin.pipe(client);
        return;
      }
      process.stderr.write(`ittop-mcp: authentication failed: ${JSON.stringify(resp.error || resp)}\n`);
      process.exit(1);
    } catch (e) {
      process.stderr.write(`ittop-mcp: auth parse error: ${e.message}\n`);
      process.exit(1);
    }
  }
};

client.on('data', onInitialData);

client.on('error', (err) => {
  process.stderr.write(`ittop-mcp: socket error: ${err.message}\n`);
  process.exit(1);
});

client.on('close', () => {
  process.exit(0);
});

process.stdin.on('end', () => {
  client.end();
});
