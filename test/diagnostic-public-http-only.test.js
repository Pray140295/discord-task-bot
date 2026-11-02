'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const source = fs.readFileSync(path.join(__dirname, '../diagnostic/public-http-only.js'), 'utf8');

// Never load node:http. Every product import and process access crosses a guard.
function harness(options = {}) {
  const calls = { imports: [], creates: [], listens: [], exits: [], logs: [], errors: [], reads: [], timers: [], clears: [], closes: 0, forces: 0 };
  const server = new EventEmitter();
  server.listen = (port, host, callback) => {
    calls.listens.push([port, host]);
    server.listenCallback = callback;
    if (options.listenPending) return server;
    if (options.listenThrow) throw Error('PRIVATE_DETAIL');
    if (options.listenError) queueMicrotask(() => server.emit('error', Error('PRIVATE_DETAIL')));
    else queueMicrotask(() => {
      callback();
      if (options.handoffError) server.emit('error', Error('PRIVATE_DETAIL'));
    });
    return server;
  };
  server.close = (callback) => {
    calls.closes++;
    if (options.closeThrow) throw Error('PRIVATE_DETAIL');
    server.closedCallback = callback;
    if (options.closeSync) callback(options.closeError ? Error('PRIVATE_DETAIL') : undefined);
  };
  server.closeAllConnections = () => {
    calls.forces++;
    if (options.forceThrow) throw Error('PRIVATE_DETAIL');
  };
  if (options.noForce) delete server.closeAllConnections;
  const proc = new EventEmitter();
  proc.env = new Proxy({}, { get(_, key) {
    calls.reads.push(key);
    assert.equal(key, 'PORT');
    return options.port === undefined ? '10000' : options.port;
  } });
  proc.exit = code => calls.exits.push(code);
  const module = { exports: {} };
  const requireGuard = name => {
    calls.imports.push(name);
    assert.equal(name, 'node:http');
    return { createServer(...args) {
      calls.creates.push(args);
      if (options.createThrow) throw Error('PRIVATE_DETAIL');
      return server;
    } };
  };
  requireGuard.main = options.cli ? module : {};
  vm.runInNewContext(source, {
    module, require: requireGuard,
    process: new Proxy(proc, {
      get(target, key) {
        assert.ok(['env', 'exit', 'exitCode', 'once', 'on', 'removeListener'].includes(key), `unexpected process access: ${String(key)}`);
        const value = target[key];
        return typeof value === 'function' ? value.bind(target) : value;
      },
      set(target, key, value) { assert.equal(key, 'exitCode'); target[key] = value; return true; }
    }),
    console: { log: value => calls.logs.push(value), error: value => calls.errors.push(value) },
    setTimeout(callback, ms) { const timer = { callback, ms }; calls.timers.push(timer); return timer; },
    clearTimeout(timer) { calls.clears.push(timer); }
  }, { filename: 'public-http-only.js' });
  return { target: module.exports, server, proc, calls };
}
async function flush() { for (let i = 0; i < 6; i++) await Promise.resolve(); }

test('import is inert with guarded imports, process, timers and server factory', () => {
  const h = harness();
  assert.deepEqual(h.calls.imports, ['node:http']);
  for (const key of ['creates', 'listens', 'exits', 'logs', 'errors', 'reads', 'timers']) assert.equal(h.calls[key].length, 0);
  assert.equal(h.proc.eventNames().length, 0);
  assert.deepEqual(Object.keys(h.target).sort(), ['handleRequest', 'start', 'validatePort']);
});

test('strict PORT boundaries and rejection before factory creation', () => {
  const h = harness();
  for (const port of ['1', '10000', '65535']) assert.equal(h.target.validatePort(port), Number(port));
  for (const value of [undefined, null, '', '0', '65536', '999999', 'abc', ' 1', '1 ', '1\n', '-1', '+1', '1.0', '1e3', '01', '0x10', 1, NaN, {}, [], true]) {
    assert.throws(() => h.target.start(value), /^Error: INVALID_PORT$/);
  }
  assert.equal(h.calls.creates.length, 0);
});

test('factory options, handler, public bind and every configured limit', async () => {
  const h = harness();
  assert.equal(await h.target.start('65535'), h.server);
  assert.equal(JSON.stringify(h.calls.creates[0][0]), '{"maxHeaderSize":8192}');
  assert.equal(h.calls.creates[0][1], h.target.handleRequest);
  assert.deepEqual(h.calls.listens, [[65535, '0.0.0.0']]);
  for (const [key, value] of Object.entries({ headersTimeout: 5000, requestTimeout: 10000, keepAliveTimeout: 5000, maxRequestsPerSocket: 100 })) assert.equal(h.server[key], value);
  assert.equal(h.server.listenerCount('error'), 1);
});

for (const mode of ['createThrow', 'listenThrow', 'listenError']) {
  test(`startup ${mode} is sanitized, no retry, cleanup and late error safe`, async () => {
    const h = harness({ [mode]: true });
    await assert.rejects(h.target.start('10000'), new RegExp(`^Error: ${mode === 'createThrow' ? 'SERVER_CREATE_FAILED' : 'LISTEN_FAILED'}$`));
    assert.equal(h.calls.creates.length, 1);
    assert.equal(h.calls.listens.length, mode === 'createThrow' ? 0 : 1);
    if (mode !== 'createThrow') {
      assert.equal(h.calls.closes, 1);
      assert.equal(h.calls.forces, 1);
      h.server.emit('error', Error('late'));
    }
    assert.equal(h.calls.exits.length, 0);
    if (mode !== 'createThrow') {
      assert.equal(h.calls.timers[0].ms, 5000);
      h.calls.timers[0].callback();
      assert.deepEqual(h.calls.exits, [1]);
    }
  });
}

test('HTTP contract exact for GET, unknown paths and method precedence including HEAD', () => {
  const h = harness();
  for (const url of ['/health', '/', '/other', '/health/', '/health?x=1']) {
    for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH']) {
      const result = {};
      h.target.handleRequest({ method, url }, { writeHead(status, headers) { Object.assign(result, { status, headers }); }, end(body) { result.body = body; } });
      const expectedStatus = method !== 'GET' ? 405 : url === '/health' ? 200 : 404;
      assert.equal(result.status, expectedStatus);
      assert.deepEqual(JSON.parse(JSON.stringify(result.headers)), {
        'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
        ...(expectedStatus === 405 ? { Allow: 'GET' } : {})
      });
      assert.equal(result.body, method === 'HEAD' ? undefined : expectedStatus === 200
        ? '{"ok":true,"mode":"public-http-only","discord":"disabled","google":"disabled"}'
        : expectedStatus === 404 ? '{"error":"not_found"}' : '{"error":"method_not_allowed"}');
    }
  }
});

test('CLI reads only PORT, ready and signals; duplicate shutdown and runtime error upgrade failure', async () => {
  const h = harness({ cli: true });
  await flush();
  assert.deepEqual(h.calls.reads, ['PORT']);
  assert.deepEqual(h.calls.logs, ['DIAGNOSTIC_HTTP_READY']);
  h.proc.emit('SIGTERM');
  h.proc.emit('SIGINT');
  h.server.emit('error', Error('PRIVATE_DETAIL'));
  assert.equal(h.calls.closes, 1);
  assert.equal(h.calls.forces, 1);
  assert.equal(h.calls.timers.length, 1);
  assert.equal(h.calls.timers[0].ms, 5000);
  h.server.closedCallback();
  assert.deepEqual(h.calls.exits, [1]);
  assert.equal(h.calls.clears.length, 1);
  h.calls.timers[0].callback();
  assert.deepEqual(h.calls.exits, [1]);
  assert.deepEqual(h.calls.errors, ['DIAGNOSTIC_RUNTIME_FAILED']);
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  test(`${signal} graceful close exits zero once`, async () => {
    const h = harness({ cli: true, closeSync: true });
    await flush();
    h.proc.emit(signal);
    assert.deepEqual(h.calls.exits, [0]);
    assert.equal(h.calls.forces, 1);
    assert.equal(h.calls.clears.length, 1);
  });
}

test('deadline forces exit 1; late close cannot exit twice', async () => {
  const h = harness({ cli: true, noForce: true });
  await flush();
  h.proc.emit('SIGINT');
  assert.equal(h.calls.exits.length, 0);
  h.calls.timers[0].callback();
  h.server.closedCallback();
  assert.deepEqual(h.calls.exits, [1]);
});

for (const option of ['closeThrow', 'forceThrow', 'closeError']) {
  test(`shutdown ${option} fails closed without uncaught error`, async () => {
    const h = harness({ cli: true, closeSync: true, [option]: true });
    await flush();
    h.proc.emit('SIGTERM');
    assert.deepEqual(h.calls.exits, [1]);
  });
}

test('handoff runtime error handled before await resumes, no false ready', async () => {
  const h = harness({ cli: true, handoffError: true, closeSync: true });
  await flush();
  assert.deepEqual(h.calls.errors, ['DIAGNOSTIC_RUNTIME_FAILED']);
  assert.deepEqual(h.calls.exits, [1]);
  assert.deepEqual(h.calls.logs, []);
});

test('exported start retains runtime handler and process shutdown ownership', async () => {
  const h = harness({ closeSync: true });
  await h.target.start('1');
  h.server.emit('error', Error('PRIVATE_DETAIL'));
  assert.deepEqual(h.calls.exits, [1]);
});

for (const options of [{ port: 'invalid' }, { createThrow: true }, { listenThrow: true }, { listenError: true }]) {
  test(`CLI startup failure sanitized ${JSON.stringify(options)}`, async () => {
    const h = harness({ cli: true, ...options });
    await flush();
    assert.equal(h.proc.exitCode, 1);
    assert.deepEqual(h.calls.errors, ['DIAGNOSTIC_START_FAILED']);
    assert.deepEqual(h.calls.logs, []);
    assert.equal(h.proc.eventNames().length, options.port || options.createThrow ? 0 : 2);
  });
}

for (const signal of ['SIGTERM', 'SIGINT']) {
  test('startup ' + signal + ' aborts with bounded cleanup and ignores late success', async () => {
    const h = harness({ cli: true, listenPending: true });
    assert.equal(h.proc.listenerCount(signal), 1);
    h.proc.emit(signal);
    h.proc.emit(signal);
    h.server.listenCallback();
    await flush();
    assert.deepEqual(h.calls.logs, []);
    assert.deepEqual(h.calls.errors, []);
    assert.equal(h.calls.closes, 1);
    assert.equal(h.calls.forces, 1);
    assert.equal(h.calls.timers[0].ms, 5000);
    h.calls.timers[0].callback();
    h.server.closedCallback();
    assert.deepEqual(h.calls.exits, [1]);
  });
}

test('exported pending start rejects on signal, graceful abort exits zero', async () => {
  const h = harness({ listenPending: true, closeSync: true });
  const pending = h.target.start('10000');
  const rejected = assert.rejects(pending, /^Error: START_ABORTED$/);
  h.proc.emit('SIGTERM');
  h.server.listenCallback();
  await rejected;
  assert.deepEqual(h.calls.exits, [0]);
});

for (const options of [{ closeThrow: true }, { forceThrow: true }, { closeError: true }]) {
  test('startup cleanup failure bounded ' + JSON.stringify(options), async () => {
    const h = harness({ listenError: true, ...options });
    await assert.rejects(h.target.start('10000'), /^Error: LISTEN_FAILED$/);
    h.server.listenCallback();
    assert.equal(h.calls.closes, 1);
    assert.equal(h.calls.forces, 1);
    assert.equal(h.calls.timers[0].ms, 5000);
    if (options.closeThrow) assert.deepEqual(h.calls.exits, [1]);
    else {
      assert.deepEqual(h.calls.exits, []);
      h.server.closedCallback(options.closeError ? Error('PRIVATE_DETAIL') : undefined);
      assert.deepEqual(h.calls.exits, [1]);
    }
    h.calls.timers[0].callback();
    assert.deepEqual(h.calls.exits, [1]);
  });
}

test('failed startup stays rejected after late success; pending cleanup hits deadline', async () => {
  const h = harness({ listenError: true });
  await assert.rejects(h.target.start('10000'), /^Error: LISTEN_FAILED$/);
  h.server.listenCallback();
  h.server.emit('error', Error('late'));
  assert.deepEqual(h.calls.exits, []);
  h.calls.timers[0].callback();
  h.server.closedCallback();
  assert.deepEqual(h.calls.exits, [1]);
  assert.equal(h.calls.closes, 1);
});

test('running force-close failure with pending close retains deadline', async () => {
  const h = harness({ cli: true, forceThrow: true });
  await flush();
  h.proc.emit('SIGTERM');
  assert.deepEqual(h.calls.exits, []);
  h.calls.timers[0].callback();
  h.server.closedCallback(Error('late'));
  assert.deepEqual(h.calls.exits, [1]);
});

// P9.4K: signals arrive only after startup has failed and cleanup is pending.
for (const signal of ['SIGTERM', 'SIGINT']) {
  for (const completion of ['close', 'deadline']) {
    for (const forceThrow of [false, true]) {
      test('failed-start cleanup signals ' + signal + '/' + completion + '/forceThrow=' + forceThrow, async () => {
        const h = harness({ listenError: true, forceThrow });
        const pending = h.target.start('10000');
        await assert.rejects(pending, /^Error: LISTEN_FAILED$/);
        assert.deepEqual(h.calls.exits, []);
        assert.equal(h.proc.listenerCount('SIGTERM'), 1);
        assert.equal(h.proc.listenerCount('SIGINT'), 1);
        assert.equal(h.calls.timers.length, 1);
        const deadline = h.calls.timers[0];
        assert.equal(deadline.ms, 5000);
        h.proc.emit(signal);
        h.proc.emit(signal);
        h.proc.emit(signal === 'SIGTERM' ? 'SIGINT' : 'SIGTERM');
        h.server.listenCallback();
        await assert.rejects(pending, /^Error: LISTEN_FAILED$/);
        assert.equal(h.calls.closes, 1);
        assert.equal(h.calls.forces, 1);
        assert.equal(h.calls.timers.length, 1);
        assert.equal(h.calls.timers[0], deadline);
        assert.deepEqual(h.calls.clears, []);
        assert.deepEqual(h.calls.exits, []);
        assert.deepEqual(h.calls.logs, []);
        if (completion === 'close') h.server.closedCallback();
        else deadline.callback();
        assert.deepEqual(h.calls.exits, [1]);
        assert.deepEqual(h.calls.clears, [deadline]);
        // Exercise both stale callbacks and signals after the first exit stub.
        h.server.listenCallback();
        h.server.closedCallback();
        deadline.callback();
        h.proc.emit(signal);
        assert.deepEqual(h.calls.exits, [1]);
        assert.equal(h.calls.closes, 1);
        assert.equal(h.calls.forces, 1);
        assert.equal(h.calls.timers.length, 1);
        assert.deepEqual(h.calls.clears, [deadline]);
        assert.deepEqual(h.calls.logs, []);
      });
    }
  }
}
