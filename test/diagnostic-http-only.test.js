'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');

const filename = path.join(__dirname, '../diagnostic/http-only.js');
const source = fs.readFileSync(filename, 'utf8');

function onlyServer(createServer) {
  return new Proxy(Object.freeze({ createServer }), {
    get(target, name) {
      assert.equal(name, 'createServer', 'outbound HTTP API forbidden');
      return target[name];
    }
  });
}

function isolated(httpModule, cli = false) {
  const imports = [], logs = [], errors = [], writes = [];
  const module = { exports: {} };
  const sandbox = {
    module,
    require(name) {
      imports.push(name);
      assert.equal(name, 'node:http', 'production/external import forbidden');
      return httpModule;
    },
    process: new Proxy({}, {
      get() { throw new Error('process/token/environment read forbidden'); },
      set(target, key, value) {
        assert.ok(cli, 'no process writes during import');
        assert.equal(key, 'exitCode');
        assert.equal(value, 1);
        writes.push([key, value]);
        return true;
      }
    }),
    console: { log(value) { logs.push(value); }, error(value) { errors.push(value); } },
    fetch() { throw new Error('external network forbidden'); },
    WebSocket() { throw new Error('gateway forbidden'); }
  };
  if (cli) sandbox.require.main = module;
  vm.runInNewContext(source, sandbox, { filename, timeout: 1000 });
  assert.deepEqual(imports, ['node:http']);
  return { api: module.exports, logs, errors, writes };
}

function fakeServer(fail = false) {
  return {
    bindings: [],
    once(event, fn) { assert.equal(event, 'error'); this.onError = fn; },
    removeListener(event, fn) {
      assert.equal(event, 'error');
      assert.equal(fn, this.onError);
    },
    listen(options, ready) {
      this.bindings.push({ ...options });
      if (fail) this.onError(new Error('EADDRINUSE'));
      else ready();
    },
    address() { return { port: 3000 }; }
  };
}

test('import is inert and exports only guarded start', () => {
  const result = isolated(new Proxy({}, {
    get() { throw new Error('HTTP activity during import'); }
  }));
  assert.deepEqual(Object.keys(result.api), ['start']);
  assert.deepEqual(result.logs, []);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.writes, []);
});

test('handler covers health, rejection and response headers without sockets', async () => {
  let handler;
  const server = fakeServer();
  const { api } = isolated(onlyServer(fn => { handler = fn; return server; }));
  await api.start({ port: 0 });
  for (const [method, url, status, expected] of [
    ['GET', '/health', 200, { ok: true, mode: 'http-only', discord: 'disabled', google: 'disabled' }],
    ['GET', '/', 404, { error: 'not_found' }],
    ['GET', '/health?token=fake', 404, { error: 'not_found' }],
    ['POST', '/health', 405, { error: 'method_not_allowed' }],
    ['HEAD', '/health', 405, { error: 'method_not_allowed' }]
  ]) {
    const headers = {};
    let actualStatus, body;
    handler({ method, url }, {
      setHeader(key, value) { headers[key] = value; },
      writeHead(value, extra) { actualStatus = value; Object.assign(headers, extra); },
      end(value) { body = value; }
    });
    assert.equal(actualStatus, status);
    assert.deepEqual(JSON.parse(body), expected);
    assert.equal(headers['Cache-Control'], 'no-store');
    assert.equal(headers['Content-Type'], 'application/json; charset=utf-8');
    assert.equal(headers.Allow, status === 405 ? 'GET' : undefined);
    assert.ok(!body.includes('fake'));
  }
});

test('invalid host and port fail before server creation', () => {
  const { api } = isolated(onlyServer(() => { throw new Error('server must not be created'); }));
  for (const host of ['0.0.0.0', '::', 'localhost', 'discord.com', '', null, '127.0.0.2']) {
    assert.throws(() => api.start({ host }), /loopback/);
  }
  for (const port of [-1, 65536, NaN, Infinity, 1.5, '3000', null]) {
    assert.throws(() => api.start({ port }), /port/);
  }
});

test('default IPv4 and explicit IPv6 use exact loopback bindings', async () => {
  for (const [options, host, port] of [
    [undefined, '127.0.0.1', 3000],
    [{ host: '::1', port: 0 }, '::1', 0],
    [{ port: 65535 }, '127.0.0.1', 65535]
  ]) {
    const server = fakeServer();
    const { api } = isolated(onlyServer(() => server));
    await api.start(options);
    assert.deepEqual(server.bindings, [{ host, port, exclusive: true }]);
  }
});

test('listen errors reject once without retry or public fallback', async () => {
  const server = fakeServer(true);
  const { api } = isolated(onlyServer(() => server));
  await assert.rejects(api.start(), /EADDRINUSE/);
  assert.deepEqual(server.bindings, [{ host: '127.0.0.1', port: 3000, exclusive: true }]);
});

test('CLI success uses stub listener and reads no environment', async () => {
  const server = fakeServer();
  const result = isolated(onlyServer(() => server), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(server.bindings, [{ host: '127.0.0.1', port: 3000, exclusive: true }]);
  assert.deepEqual(result.logs, ['HTTP-only diagnostic listening on loopback port 3000']);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.writes, []);
});

test('CLI failure sets exitCode 1 without retry, secrets or raw errors', async () => {
  const server = fakeServer(true);
  const result = isolated(onlyServer(() => server), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(server.bindings.length, 1);
  assert.deepEqual(result.logs, []);
  assert.deepEqual(result.errors, ['HTTP-only diagnostic failed to start']);
  assert.deepEqual(result.writes, [['exitCode', 1]]);
});

// Capture real creation only in the harness; production receives no client API.
function loopbackHttp() {
  return onlyServer(handler => {
    const server = http.createServer(handler);
    const listen = server.listen.bind(server);
    server.listen = (options, ready) => {
      assert.equal(options.host, '127.0.0.1', 'test allows only IPv4 loopback');
      assert.equal(options.port, 0, 'test allows only an ephemeral port');
      assert.equal(options.exclusive, true);
      return listen(options, ready);
    };
    return server;
  });
}

test('integration guard rejects outbound APIs and public bindings before I/O', () => {
  const guarded = loopbackHttp();
  for (const name of ['request', 'get', 'Agent']) {
    assert.throws(() => guarded[name], /outbound/);
  }
  const server = guarded.createServer(() => {});
  assert.throws(() => server.listen({ host: '0.0.0.0', port: 0 }), /loopback/);
  assert.throws(() => server.listen({ host: '127.0.0.1', port: 3000 }), /ephemeral/);
  assert.equal(server.listening, false);
});

test('real HTTP health uses ephemeral loopback and closes its listener', async () => {
  const { api } = isolated(loopbackHttp());
  const server = await api.start({ port: 0 });
  try {
    assert.equal(server.address().address, '127.0.0.1');
    const result = await new Promise((resolve, reject) => {
      // Harness-only client: fixed literal loopback and the allocated test port.
      const request = http.get({
        hostname: '127.0.0.1', port: server.address().port, path: '/health', agent: false
      }, response => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', chunk => { body += chunk; });
        response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body }));
        response.on('error', reject);
      });
      request.setTimeout(2000, () => request.destroy(new Error('timeout')));
      request.on('error', reject);
    });
    assert.equal(result.status, 200);
    assert.equal(result.headers['content-type'], 'application/json; charset=utf-8');
    assert.equal(result.headers['cache-control'], 'no-store');
    assert.deepEqual(JSON.parse(result.body), {
      ok: true, mode: 'http-only', discord: 'disabled', google: 'disabled'
    });
  } finally {
    await new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  }
  assert.equal(server.listening, false);
});
