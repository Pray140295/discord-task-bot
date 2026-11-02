'use strict';

// Deliberately independent of production code, dependencies and environment.
const http = require('node:http');

function createServer() {
  return http.createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    if (req.method !== 'GET') {
      res.writeHead(405, { Allow: 'GET' });
      res.end('{"error":"method_not_allowed"}');
      return;
    }
    if (req.url !== '/health') {
      res.writeHead(404);
      res.end('{"error":"not_found"}');
      return;
    }
    res.writeHead(200);
    res.end('{"ok":true,"mode":"http-only","discord":"disabled","google":"disabled"}');
  });
}

function start(options = {}) {
  const { host = '127.0.0.1', port = 3000 } = options;
  if (host !== '127.0.0.1' && host !== '::1') {
    throw new Error('Only literal loopback addresses are allowed');
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('Invalid port');
  }
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host, port, exclusive: true }, () => {
      server.removeListener('error', reject);
      resolve(server);
    });
  });
}

module.exports = { start };

if (require.main === module) {
  start().then(server => {
    console.log('HTTP-only diagnostic listening on loopback port ' + server.address().port);
  }).catch(() => {
    console.error('HTTP-only diagnostic failed to start');
    process.exitCode = 1;
  });
}
