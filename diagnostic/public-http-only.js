'use strict';

const http = require('node:http');
const HEALTH_BODY = '{"ok":true,"mode":"public-http-only","discord":"disabled","google":"disabled"}';
const shutdowns = new WeakMap();

function validatePort(value) {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,4}$/.test(value) || Number(value) > 65535) {
    throw new Error('INVALID_PORT');
  }
  return Number(value);
}

function handleRequest(req, res) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  };
  if (req.method !== 'GET') {
    res.writeHead(405, { ...headers, Allow: 'GET' });
    res.end(req.method === 'HEAD' ? undefined : '{"error":"method_not_allowed"}');
  } else if (req.url !== '/health') {
    res.writeHead(404, headers);
    res.end('{"error":"not_found"}');
  } else {
    res.writeHead(200, headers);
    res.end(HEALTH_BODY);
  }
}

// Explicit start owns signals and process termination, including exported use.
function shutdown(server, exitCode = 0) {
  const existing = shutdowns.get(server);
  if (existing) {
    if (exitCode) existing.code = 1;
    return;
  }
  const state = { code: exitCode, finished: false };
  shutdowns.set(server, state);
  const finish = (code) => {
    if (state.finished) return;
    state.finished = true;
    clearTimeout(deadline);
    process.exit(code);
  };
  const deadline = setTimeout(() => finish(1), 5000);
  let closing = true;
  let closed = false;
  try {
    server.close((error) => {
      if (error) state.code = 1;
      closed = true;
      if (!closing) finish(state.code);
    });
  } catch {
    state.code = 1;
    closed = true;
  }
  try {
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  } catch {
    state.code = 1;
  }
  closing = false;
  if (closed) finish(state.code);
}

function start(portValue) {
  const port = validatePort(portValue);
  return new Promise((resolve, reject) => {
    let server;
    let phase = 'starting';
    const detachSignals = () => {
      process.removeListener('SIGTERM', onSignal);
      process.removeListener('SIGINT', onSignal);
    };
    const onSignal = () => {
      if (phase === 'starting') {
        phase = 'stopping';
        reject(new Error('START_ABORTED'));
      } else if (phase === 'running') phase = 'stopping';
      if (server) shutdown(server);
      else { detachSignals(); process.exit(0); }
    };
    const failStartup = (message) => {
      if (phase !== 'starting') return;
      phase = 'failed';
      reject(new Error(message));
      if (!server) detachSignals();
      // Partial startup cleanup uses the same bounded shutdown as runtime.
      if (server) shutdown(server, 1);
    };
    process.on('SIGTERM', onSignal);
    process.on('SIGINT', onSignal);
    try {
      server = http.createServer({ maxHeaderSize: 8192 }, handleRequest);
      server.on('error', () => {
        if (phase === 'starting') failStartup('LISTEN_FAILED');
        else if (phase === 'running' || phase === 'stopping') {
          console.error('DIAGNOSTIC_RUNTIME_FAILED');
          shutdown(server, 1);
        }
      });
      server.headersTimeout = 5000;
      server.requestTimeout = 10000;
      server.keepAliveTimeout = 5000;
      server.maxRequestsPerSocket = 100;
    } catch {
      failStartup('SERVER_CREATE_FAILED');
      return;
    }
    try {
      server.listen(port, '0.0.0.0', () => {
        if (phase !== 'starting') return;
        phase = 'running';
        resolve(server);
      });
    } catch {
      failStartup('LISTEN_FAILED');
    }
  });
}

async function runCli() {
  try {
    const server = await start(process.env.PORT);
    if (shutdowns.has(server)) return;
    console.log('DIAGNOSTIC_HTTP_READY');
  } catch (error) {
    if (error.message === 'START_ABORTED') return;
    console.error('DIAGNOSTIC_START_FAILED');
    process.exitCode = 1;
  }
}

if (require.main === module) {
  runCli().catch(() => {
    console.error('DIAGNOSTIC_START_FAILED');
    process.exitCode = 1;
  });
}

module.exports = { validatePort, handleRequest, start };
