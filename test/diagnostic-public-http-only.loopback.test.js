'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const net = require('node:net');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once, EventEmitter } = require('node:events');
const source = fs.readFileSync(path.join(__dirname, '../diagnostic/public-http-only.js'), 'utf8');

function load(proc, cli = false, deferHandler = false, trace = null) {
  let server;
  const module = { exports: {} };
  const guardedRequire = name => {
    assert.equal(name, 'node:http');
    return { createServer(options, handler) {
      server = http.createServer(options, deferHandler ? (req, res) => {
        // Instrumentation only: keep the response pending to isolate parser timeout.
        req.on('end', () => handler(req, res));
        req.resume();
      } : handler);
      const originalListen = server.listen.bind(server);
      server.listen = (port, host, callback) => {
        assert.equal(port, 10000);
        assert.equal(host, '0.0.0.0');
        return originalListen({ port: 0, host: '127.0.0.1' }, callback);
      };
      return server;
    } };
  };
  guardedRequire.main = cli ? module : {};
  vm.runInNewContext(source, { module, require: guardedRequire, process: proc,
    console: { log() {}, error() {} },
    setTimeout: trace ? (callback, delay, ...args) => {
      trace.push({ event: 'timer-register', delay, at: performance.now() });
      return setTimeout((...values) => {
        trace.push({ event: 'timer-fire', at: performance.now() });
        callback(...values);
      }, delay, ...args);
    } : setTimeout, clearTimeout });
  return { target: module.exports, get server() { return server; } };
}
function fakeProcess() {
  const proc = new EventEmitter();
  proc.env = { PORT: '10000' };
  proc.exit = () => { throw Error('UNEXPECTED_PROCESS_EXIT'); };
  return proc;
}
async function withServer(fn, deferHandler = false) {
  const h = load(fakeProcess(), false, deferHandler);
  const server = await h.target.start('10000');
  assert.equal(server.address().address, '127.0.0.1');
  try { await fn(server.address().port, server); }
  finally {
    const closed = new Promise(resolve => server.close(resolve));
    server.closeAllConnections();
    await closed;
    assert.equal(server.listening, false);
  }
}
function request(port, method, url, agent) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: url, agent }, res => {
      const chunks = [];
      res.on('data', data => chunks.push(data));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers,
        body: Buffer.concat(chunks).toString(), socket: res.socket }));
    });
    req.setTimeout(5000, () => req.destroy(Error('CLIENT_TIMEOUT')));
    req.on('error', reject);
    req.end();
  });
}
function raw(port, payload, timeout = 40000) {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const socket = net.connect({ host: '127.0.0.1', port });
    let data = '';
    const guard = setTimeout(() => socket.destroy(Error('RAW_WATCHDOG')), timeout);
    socket.on('connect', () => socket.write(payload));
    socket.on('data', chunk => { data += chunk.toString(); });
    socket.on('error', reject);
    socket.on('close', () => {
      clearTimeout(guard);
      resolve({ data, ms: Math.round(performance.now() - started) });
    });
  });
}

if (process.argv[2] === '--timing-worker') {
  const trace = [];
  const actualExit = process.exit.bind(process);
  const proc = new Proxy(process, { get(target, key) {
    if (key === 'exit') return code => {
      trace.push({ event: 'exit-call', code, at: performance.now() });
      fs.writeSync(1, JSON.stringify(trace) + '\n');
      actualExit(code);
    };
    const value = target[key];
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  const h = load(proc, true, false, trace);
  h.server.on('connection', socket => {
    socket.on('close', () => trace.push({ event: 'server-socket-close', at: performance.now() }));
  });
  (async () => {
    await once(h.server, 'listening');
    const socket = net.connect({ host: '127.0.0.1', port: h.server.address().port });
    await once(socket, 'connect');
    socket.on('close', () => trace.push({ event: 'peer-close', at: performance.now() }));
    socket.write('GET /health HTTP/1.1\r\nHost: localhost\r\n');
    if (process.argv[3] === 'deadline') {
      h.server.close = () => h.server;
      h.server.closeAllConnections = () => {};
    }
    process.once('message', () => {
      trace.push({ event: 'trigger-received', at: performance.now() });
      process.emit('SIGTERM');
    });
    process.send({ ready: true });
  })().catch(error => { console.error(error); actualExit(2); });
} else if (process.argv[2] === '--cleanup-worker') {
  const actualExit = process.exit.bind(process);
  let intent;
  const proc = new Proxy(process, { get(target, key) {
    if (key === 'exit') return code => {
      assert.equal(intent, undefined, 'duplicate exit intent');
      intent = code;
      process.send({ type: 'intent', code, listening: h.server.listening });
    };
    const value = target[key];
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  const h = load(proc, true);
  (async () => {
    await once(h.server, 'listening');
    process.on('message', message => {
      if (message.type === 'release') {
        assert.notEqual(intent, undefined);
        actualExit(intent);
      } else if (message.type === 'trigger') {
        h.server.getConnections((error, count) => {
          assert.ifError(error); assert.ok(count > 0, 'no active socket before trigger');
          if (process.argv[3] === 'runtime') h.server.emit('error', Error('INJECTED_RUNTIME_ERROR'));
          else process.emit(process.argv[3] === 'sigint' ? 'SIGINT' : 'SIGTERM');
        });
      }
    });
    process.send({ type: 'ready', port: h.server.address().port });
  })().catch(error => { console.error(error); actualExit(2); });
} else if (process.argv[2] === '--worker') {
  // Real child exit/timers/sockets; signals are explicitly synthetic JS events.
  const h = load(process, true);
  const mode = process.argv[3];
  (async () => {
    await once(h.server, 'listening');
    const socket = net.connect({ host: '127.0.0.1', port: h.server.address().port });
    await once(socket, 'connect');
    socket.write('GET /health HTTP/1.1\r\nHost: localhost\r\n');
    if (mode === 'deadline') {
      h.server.close = () => h.server;
      h.server.closeAllConnections = () => {};
    }
    process.send({ ready: true });
    process.once('message', () => {
      if (mode === 'runtime') h.server.emit('error', Error('INJECTED_RUNTIME_ERROR'));
      else process.emit(mode === 'sigint' ? 'SIGINT' : 'SIGTERM');
    });
  })().catch(error => { console.error(error); process.exit(2); });
} else {
  const test = require('node:test');
  test('wire status, exact bodies, headers and HEAD without body', async () => {
    await withServer(async port => {
      for (const [method, url, status, body] of [
        ['GET', '/health', 200, '{"ok":true,"mode":"public-http-only","discord":"disabled","google":"disabled"}'],
        ['GET', '/health?x=1', 404, '{"error":"not_found"}'],
        ['POST', '/health', 405, '{"error":"method_not_allowed"}'],
        ['HEAD', '/health', 405, ''], ['HEAD', '/other', 405, '']
      ]) {
        const r = await request(port, method, url, false);
        assert.equal(r.status, status); assert.equal(r.body, body);
        assert.equal(r.headers['content-type'], 'application/json; charset=utf-8');
        assert.equal(r.headers['cache-control'], 'no-store');
        assert.equal(r.headers['x-content-type-options'], 'nosniff');
        if (status === 405) assert.equal(r.headers.allow, 'GET');
      }
    });
  });
  test('oversize headers rejected by real parser before request event', async () => {
    await withServer(async (port, server) => {
      let requests = 0; server.on('request', () => requests++);
      const r = await raw(port, 'GET /health HTTP/1.1\r\nHost: localhost\r\nX-Large: ' + 'x'.repeat(9000) + '\r\n\r\n');
      assert.match(r.data, /^HTTP\/1\.1 431 /); assert.equal(requests, 0);
    });
  });
  test('100th request on one socket announces close; next uses a new socket', async () => {
    await withServer(async port => {
      const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
      const sockets = new Set(); agent.on('free', socket => sockets.add(socket));
      try {
        for (let i = 1; i <= 100; i++) {
          const r = await request(port, 'GET', '/health', agent);
          assert.equal(r.status, 200);
          if (i === 100) assert.equal(r.headers.connection, 'close');
        }
        assert.equal(sockets.size, 1);
        assert.equal((await request(port, 'GET', '/health', agent)).status, 200);
        assert.equal(sockets.size, 2);
      } finally { agent.destroy(); }
    });
  });
  test('partial headers timeout independently', { timeout: 45000 }, async t => {
    await withServer(async port => {
      const r = await raw(port, 'GET /health HTTP/1.1\r\nHost: localhost\r\n');
      t.diagnostic(JSON.stringify(r));
      assert.match(r.data, /^HTTP\/1\.1 408 /);
      assert.ok(r.ms >= 4500 && r.ms < 40000);
    });
  });
  test('original handler partial-body behavior: early response then bounded close', { timeout: 45000 }, async t => {
    await withServer(async port => {
      const r = await raw(port, 'GET /health HTTP/1.1\r\nHost: localhost\r\nContent-Length: 100\r\n\r\nx');
      t.diagnostic(JSON.stringify(r));
      assert.match(r.data, /^HTTP\/1\.1 200 /);
      assert.doesNotMatch(r.data, /HTTP\/1\.1 408 /);
      assert.ok(r.ms >= 4500 && r.ms < 9000);
      // Characterization only; does not establish original handler requestTimeout enforcement.
    });
  });
  test('isolated parser body timeout with deferred handler (instrumented)', { timeout: 45000 }, async t => {
    await withServer(async port => {
      const r = await raw(port, 'GET /health HTTP/1.1\r\nHost: localhost\r\nContent-Length: 100\r\n\r\nx');
      t.diagnostic(JSON.stringify(r));
      assert.match(r.data, /^HTTP\/1\.1 408 /);
      assert.ok(r.ms >= 9500 && r.ms < 40000);
    }, true);
  });
  test('idle keepalive timeout independently', { timeout: 12000 }, async t => {
    await withServer(async port => {
      const r = await raw(port, 'GET /health HTTP/1.1\r\nHost: localhost\r\n\r\n');
      t.diagnostic(JSON.stringify(r));
      assert.match(r.data, /^HTTP\/1\.1 200 /);
      assert.ok(r.ms >= 4500 && r.ms < 9000);
    });
  });
  for (const mode of ['sigterm', 'sigint', 'runtime', 'deadline']) {
    test('child real socket/process cleanup: ' + mode, { timeout: 12000 }, async t => {
      const child = spawn(process.execPath, [__filename, '--worker', mode], {
        env: { SystemRoot: process.env.SystemRoot, PORT: '10000' },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true
      });
      let stderr = ''; child.stderr.on('data', data => { stderr += data; });
      const exit = once(child, 'exit');
      let guard;
      try {
        await Promise.race([once(child, 'message'), exit.then(() => { throw Error('EARLY_EXIT: ' + stderr); }),
          new Promise((_, reject) => { guard = setTimeout(() => { child.kill(); reject(Error('CHILD_WATCHDOG')); }, 10000); })]);
        const started = performance.now(); child.send({ trigger: true });
        const [code, signal] = await exit;
        const ms = Math.round(performance.now() - started);
        t.diagnostic(JSON.stringify({ mode, code, signal, ms }));
        assert.equal(signal, null); assert.equal(code, mode === 'sigterm' || mode === 'sigint' ? 0 : 1);
        if (mode === 'deadline') { assert.ok(ms >= 4900); assert.ok(ms <= 5500, 'deadline scheduling tolerance exceeded'); }
        else assert.ok(ms <= 5000, 'shutdown exceeded 5s');
      } finally { clearTimeout(guard); if (child.exitCode === null && child.signalCode === null) { child.kill(); await exit; } }
    });
  }
  for (const mode of ['sigterm', 'sigint', 'runtime']) {
    test('real peer/listener cleanup before held exit: ' + mode, { timeout: 12000 }, async t => {
      const child = spawn(process.execPath, [__filename, '--cleanup-worker', mode], {
        env: { SystemRoot: process.env.SystemRoot, PORT: '10000' },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true
      });
      let stderr = ''; child.stderr.on('data', data => { stderr += data; });
      const exited = once(child, 'exit');
      let peer, watchdog;
      const failure = new Promise((_, reject) => {
        watchdog = setTimeout(() => reject(Error('CLEANUP_WATCHDOG')), 10000);
      });
      const work = async () => {
        const [ready] = await once(child, 'message');
        assert.equal(ready.type, 'ready');
        peer = net.connect({ host: '127.0.0.1', port: ready.port });
        await once(peer, 'connect');
        const peerClosed = new Promise((resolve, reject) => {
          peer.on('error', error => { if (error.code !== 'ECONNRESET') reject(error); });
          peer.once('close', resolve);
        });
        peer.write('GET /health HTTP/1.1\r\nHost: localhost\r\n');
        const intentMessage = once(child, 'message');
        const started = performance.now();
        child.send({ type: 'trigger' });
        const [[intent]] = await Promise.all([intentMessage, peerClosed]);
        assert.equal(intent.type, 'intent');
        assert.equal(intent.code, mode === 'runtime' ? 1 : 0);
        assert.equal(intent.listening, false);
        assert.equal(child.exitCode, null); assert.equal(child.signalCode, null);
        const probeError = await new Promise((resolve, reject) => {
          const probe = net.connect({ host: '127.0.0.1', port: ready.port });
          const timer = setTimeout(() => probe.destroy(Error('PROBE_WATCHDOG')), 2000);
          probe.once('connect', () => { probe.destroy(); reject(Error('LISTENER_STILL_ACCEPTS')); });
          probe.once('error', resolve);
          probe.once('close', () => clearTimeout(timer));
        });
        assert.equal(probeError.code, 'ECONNREFUSED');
        assert.equal(child.exitCode, null); assert.equal(child.signalCode, null);
        const ms = Math.round(performance.now() - started);
        assert.ok(ms <= 5000, 'pre-exit cleanup exceeded 5s');
        t.diagnostic(JSON.stringify({ mode, intent: intent.code, peerClosed: true, refused: true, childAliveBeforeRelease: true, ms }));
        child.send({ type: 'release' });
        const [code, signal] = await exited;
        assert.equal(code, intent.code); assert.equal(signal, null);
      };
      let released = false;
      // Early exit cannot satisfy peer-close/refusal evidence.
      const earlyExit = exited.then(() => { if (!released) throw Error('EARLY_CHILD_EXIT: ' + stderr); return new Promise(() => {}); });
      // Mark release on outbound IPC, before the child can actually exit.
      const send = child.send.bind(child);
      child.send = message => { if (message.type === 'release') released = true; return send(message); };
      try { await Promise.race([work(), failure, earlyExit]); }
      finally {
        clearTimeout(watchdog); peer?.destroy();
        if (child.exitCode === null && child.signalCode === null) { child.kill(); await exited; }
      }
    });
  }
  test('P9.4N original body timeline without timeout listeners', { timeout: 12000 }, async t => {
    await withServer(async (port, server) => {
      const events = [];
      const record = (event, extra = {}) => events.push({ event, at: performance.now(), ...extra });
      const observe = (emitter, prefix, names) => {
        const emit = emitter.emit;
        emitter.emit = function(name, ...args) {
          if (names.includes(name)) record(prefix + name);
          return Reflect.apply(emit, this, [name, ...args]);
        };
      };
      observe(server, 'server:', ['timeout', 'close', 'clientError']);
      server.prependListener('connection', socket => observe(socket, 'socket:', ['timeout', 'close', 'error', 'end']));
      let request;
      server.prependListener('request', req => {
        request = req; record('request', { complete: req.complete });
        observe(req, 'request:', ['end', 'aborted', 'close', 'error']);
      });
      const socket = net.connect({ host: '127.0.0.1', port });
      const guard = setTimeout(() => socket.destroy(Error('BODY_TIMELINE_WATCHDOG')), 10000);
      let data = '';
      try {
        await once(socket, 'connect');
        socket.on('data', chunk => { record('response-data'); data += chunk.toString(); });
        record('send-headers');
        socket.write('GET /health HTTP/1.1\r\nHost: localhost\r\nContent-Length: 100\r\n\r\n');
        record('send-partial-body'); socket.write('x');
        await once(socket, 'close'); record('client-close');
        assert.match(data, /^HTTP\/1\.1 200 /); assert.doesNotMatch(data, /HTTP\/1\.1 408 /);
        assert.equal(request.complete, false);
        assert.equal(events.some(e => e.event === 'request:end'), false);
        assert.ok(events.some(e => e.event === 'socket:timeout'));
        assert.ok(events.some(e => e.event === 'response-data'));
        // P9.4O: regress the observed ordering, not only event presence.
        const responseIndex = events.findIndex(e => e.event === 'response-data');
        const timeoutIndex = events.findIndex(e => e.event === 'socket:timeout');
        assert.ok(responseIndex >= 0, 'response-data missing');
        assert.ok(timeoutIndex >= 0, 'socket timeout missing');
        assert.ok(responseIndex < timeoutIndex, 'response-data must precede socket timeout');
        assert.ok(events[responseIndex].at <= events[timeoutIndex].at,
          'response timestamp must not exceed socket timeout timestamp');
        assert.equal(server.listenerCount('timeout'), 0);
        const duration = events.at(-1).at - events.find(e => e.event === 'send-partial-body').at;
        assert.ok(duration >= 4500 && duration < 9000);
        t.diagnostic(JSON.stringify({ duration, requestComplete: request.complete, events }));
      } finally { clearTimeout(guard); socket.destroy(); }
    });
  });
  for (const mode of ['real-close', 'deadline']) {
    test('P9.4N shutdown timer contract ' + mode, { timeout: 12000 }, async t => {
      const child = spawn(process.execPath, [__filename, '--timing-worker', mode], {
        env: { SystemRoot: process.env.SystemRoot, PORT: '10000' },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true
      });
      let output = '', errors = ''; child.stdout.on('data', data => { output += data; });
      child.stderr.on('data', data => { errors += data; });
      const closed = once(child, 'close');
      let watchdog, sent;
      const failure = new Promise((_, reject) => { watchdog = setTimeout(() => reject(Error('TIMING_WATCHDOG')), 10000); });
      try {
        const run = async () => {
          await Promise.race([once(child, 'message'), closed.then(() => { throw Error('EARLY_EXIT ' + errors); })]);
          sent = performance.now(); child.send({ trigger: true });
          const [code, signal] = await closed;
          const wallMs = performance.now() - sent;
          assert.equal(signal, null); assert.equal(code, mode === 'deadline' ? 1 : 0);
          const trace = JSON.parse(output.trim());
          const trigger = trace.find(e => e.event === 'trigger-received');
          const timers = trace.filter(e => e.event === 'timer-register');
          assert.equal(timers.length, 1); assert.equal(timers[0].delay, 5000);
          assert.ok(timers[0].at >= trigger.at);
          const exit = trace.find(e => e.event === 'exit-call');
          const fire = trace.find(e => e.event === 'timer-fire');
          if (mode === 'deadline') {
            assert.ok(fire); assert.ok(fire.at - timers[0].at >= 4990, 'timer fired materially early');
            assert.ok(exit.at >= fire.at); assert.equal(exit.code, 1);
          } else { assert.equal(fire, undefined); assert.equal(exit.code, 0); }
          t.diagnostic(JSON.stringify({ mode, wallMs, childTriggerToExitCallMs: exit.at - trigger.at,
            registrationLagMs: timers[0].at - trigger.at, trace }));
        };
        await Promise.race([run(), failure]);
      } finally { clearTimeout(watchdog); if (child.exitCode === null && child.signalCode === null) { child.kill(); await closed; } }
    });
  }
  test('actual OS SIGTERM/SIGINT graceful delivery', { skip: 'Windows signals are not POSIX graceful delivery; EVIDENCE MISSING. JS emit tests are synthetic.' }, () => {});
}
