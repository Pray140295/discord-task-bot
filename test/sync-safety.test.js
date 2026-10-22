const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const BOT_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'bot.js'), 'utf8');
const APPS_SCRIPT_SOURCE = fs.readFileSync(
  path.join(__dirname, '..', '..', 'sources', 'DiscordAPI.gs.txt'),
  'utf8'
);
const SYNC_03A_SOURCE = fs.readFileSync(
  path.join(__dirname, '..', 'apps-script', 'SyncSafety03A.gs'),
  'utf8'
);

class ChainBuilder {
  constructor() { this.data = { fields: [] }; }
  setTitle(value) { this.data.title = value; return this; }
  setColor(value) { this.data.color = value; return this; }
  addFields(...fields) { this.data.fields.push(...fields); return this; }
  setCustomId(value) { this.data.customId = value; return this; }
  setLabel(value) { this.data.label = value; return this; }
  setStyle(value) { this.data.style = value; return this; }
  addComponents(component) { (this.data.components ||= []).push(component); return this; }
}

function requestIdFromPayload(payload) {
  return payload.embeds[0].data.fields.find(field => field.name === 'Request ID').value;
}

function makeMessage(id, requestId, channel) {
  return {
    id: String(id),
    url: `https://discord.test/messages/${id}`,
    author: { id: 'bot-user' },
    channel,
    embeds: [{ fields: [{ name: 'Request ID', value: requestId }] }]
  };
}

function makeChannel(initial = [], sendBehavior) {
  const channel = { id: 'new-channel', sent: 0, stored: [] };
  channel.stored = initial.map(item => makeMessage(item.id, item.requestId, channel));
  channel.messages = {
    async fetch(arg) {
      if (typeof arg === 'string') {
        const exact = channel.stored.find(message => message.id === arg);
        if (!exact) throw new Error('Unknown message');
        return exact;
      }
      const start = arg.before
        ? channel.stored.findIndex(message => message.id === arg.before) + 1
        : 0;
      const page = channel.stored.slice(start, start + arg.limit);
      const collection = new Map(page.map(message => [message.id, message]));
      collection.last = () => page[page.length - 1];
      return collection;
    }
  };
  channel.send = async payload => {
    channel.sent += 1;
    const message = makeMessage(`sent-${channel.sent}`, requestIdFromPayload(payload), channel);
    channel.stored.unshift(message);
    if (sendBehavior) await sendBehavior(message, channel.sent);
    return message;
  };
  return channel;
}

const TEST_ALLOWLIST = [
  'TASK-LOCAL-RACE','TASK-ATOMIC','TASK-NONATOMIC','TASK-CLAIM-TIMEOUT',
  'TASK-SEND-TIMEOUT','TASK-INFO-TIMEOUT','TASK-POSTING','TASK-TOO-OLD',
  'TASK-GATE','TASK-CONTRACT','TASK-UNKNOWN','TASK-CONFLICT'
].join(',');
const CONTRACT = {
  version: 'SYNC-SAFETY-03A/1', claimId: true, fencing: true,
  postingNoRetry: true, idempotentDiscordInfo: true
};

function loadBot({ channel, apiHandler, sendEnabled = true, allowlist = TEST_ALLOWLIST, contract = CONTRACT, autoClaimId = true }) {
  const handlers = {};
  const logs = [];
  const client = {
    user: { id: 'bot-user', tag: 'bot#0001' },
    channels: { fetch: async () => channel },
    on: (event, handler) => { handlers[event] = handler; },
    once: (event, handler) => { handlers[event] = handler; },
    login: async () => undefined,
    isReady: () => true
  };
  const sandbox = {
    require(name) {
      if (name === 'dotenv') return { config() {} };
      if (name === 'axios') return { post: async (_url, body) => {
        if (body.action === 'syncContract') return { data: contract };
        const data = await apiHandler(body);
        if (autoClaimId && body.action === 'claimSync' && data?.claimed && !data.claimId)
          data.claimId = 'test-claim-id-0001';
        return { data };
      } };
      if (name === 'express') {
        return () => ({ get() {}, listen() {} });
      }
      if (name === 'discord.js') {
        return {
          Client: function Client() { return client; },
          GatewayIntentBits: { Guilds: 1, GuildMessages: 2, MessageContent: 4 },
          ActionRowBuilder: ChainBuilder,
          ButtonBuilder: ChainBuilder,
          ButtonStyle: { Primary: 1, Success: 2, Secondary: 3, Danger: 4 },
          EmbedBuilder: ChainBuilder
        };
      }
      throw new Error(`Unexpected module: ${name}`);
    },
    process: {
      env: {
        DISCORD_TOKEN: 'discord-token',
        GOOGLE_SCRIPT_URL: 'https://apps-script.test/exec',
        GOOGLE_SCRIPT_TOKEN: 'x'.repeat(32),
        MANAGER_ROLE_ID: 'manager',
        CHANNEL_TASK_NEW: 'new-channel',
        CHANNEL_REVIEW: 'review-channel',
        CHANNEL_DONE: 'done-channel',
        DISCORD_SYNC_SEND_ENABLED: sendEnabled ? 'true' : '',
        DISCORD_SYNC_ALLOWLIST: allowlist
      },
      exitCode: 0
    },
    console: {
      log: (...args) => logs.push(['log', ...args]),
      error: (...args) => logs.push(['error', ...args])
    },
    setTimeout() {},
    clearTimeout() {}
  };
  vm.createContext(sandbox);
  vm.runInContext(BOT_SOURCE, sandbox, { filename: 'bot.js' });
  return { poll: sandbox.poll, logs };
}

const task = requestId => ({
  requestId,
  sender: 'sender', team: 'team', brand: 'brand', category: 'category',
  deadline: 'deadline', priority: 'normal', format: 'format', quantity: 1,
  brief: 'brief', fileRef: '', designer: '', status: 'New', round: 'Round 1'
});

function basicApi(requestId, claim) {
  return async body => {
    if (body.action === 'unsynced') return [task(requestId)];
    if (body.action === 'designers') return [{ name: 'DESIGNER' }];
    if (body.action === 'claimSync') return claim(body);
    if (body.action === 'discordInfo') return { success: true };
    throw new Error(`Unexpected action: ${body.action}`);
  };
}

function loadSync03A() {
  const properties = new Map();
  const record = ['', '', '', '', '', '', ''];
  const state = { record, flushes: 0 };
  const sheet = {
    getRange(_row, column, _rows, columns) {
      return {
        getValues: () => [columns === 7 ? record.slice() : ['']],
        setValue(value) {
          if (column === 28) record[5] = value;
          if (column === 29) record[6] = value;
          return this;
        },
        setValues(values) { values[0].forEach((value, index) => { record[index] = value; }); return this; }
      };
    }
  };
  let uuid = 0;
  const sandbox = {
    JSON, Date,
    console: { error() {} },
    COL: { MESSAGE_ID: 23, SYNC_STATUS: 28, LAST_UPDATE: 29 },
    apiLock: fn => fn(),
    findTaskRow: () => 5,
    getTaskSheet: () => sheet,
    getSpreadsheet: () => ({}),
    dispatchToDesigner() {},
    apiFailure: (message, code) => ({ success: false, message, code }),
    SpreadsheetApp: { flush: () => { state.flushes += 1; } },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: key => properties.get(key) || null,
      setProperty: (key, value) => properties.set(key, value),
      deleteProperty: key => properties.delete(key)
    }) },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'SHA_256' },
      computeDigest: (_algorithm, text) => Array.from(Buffer.from(String(text).padEnd(32, '0')).subarray(0, 32)),
      base64EncodeWebSafe: bytes => Buffer.from(bytes).toString('base64url'),
      getUuid: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, '0')}`
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(SYNC_03A_SOURCE, sandbox, { filename: 'SyncSafety03A.gs' });
  return { sandbox, state, properties };
}

test('one process suppresses overlapping poll loops', async () => {
  const channel = makeChannel();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const bot = loadBot({
    channel,
    apiHandler: async body => {
      if (body.action === 'unsynced') { await gate; return [task('TASK-LOCAL-RACE')]; }
      if (body.action === 'designers') return [{ name: 'DESIGNER' }];
      if (body.action === 'claimSync') return { claimed: true };
      if (body.action === 'discordInfo') return { success: true };
    }
  });
  const first = bot.poll();
  const second = bot.poll();
  release();
  await Promise.all([first, second]);
  assert.equal(channel.sent, 1);
});

test('two bot instances are safe only when claimSync is atomic', async () => {
  const channel = makeChannel();
  let claimed = false;
  const apiHandler = basicApi('TASK-ATOMIC', async () => {
    if (claimed) return { claimed: false };
    claimed = true;
    return { claimed: true };
  });
  const a = loadBot({ channel, apiHandler });
  const b = loadBot({ channel, apiHandler });
  await Promise.all([a.poll(), b.poll()]);
  assert.equal(channel.sent, 1);
});

test('two bot instances duplicate when claimSync grants both claims', async () => {
  const channel = makeChannel();
  const apiHandler = basicApi('TASK-NONATOMIC', async () => ({ claimed: true }));
  const a = loadBot({ channel, apiHandler });
  const b = loadBot({ channel, apiHandler });
  await Promise.all([a.poll(), b.poll()]);
  assert.equal(channel.sent, 2);
});

test('ambiguous claimSync timeout does not send a Discord message', async () => {
  const channel = makeChannel();
  const bot = loadBot({
    channel,
    apiHandler: basicApi('TASK-CLAIM-TIMEOUT', async () => { throw new Error('ETIMEDOUT'); })
  });
  await bot.poll();
  assert.equal(channel.sent, 0);
});

test('send timeout after Discord accepted is reconciled on the next poll', async () => {
  let firstSend = true;
  const channel = makeChannel([], async () => {
    if (firstSend) { firstSend = false; throw new Error('ETIMEDOUT'); }
  });
  let infoWrites = 0;
  const bot = loadBot({
    channel,
    apiHandler: async body => {
      if (body.action === 'unsynced') return [task('TASK-SEND-TIMEOUT')];
      if (body.action === 'designers') return [{ name: 'DESIGNER' }];
      if (body.action === 'claimSync') return { claimed: true };
      if (body.action === 'discordInfo') { infoWrites += 1; return { success: true }; }
    }
  });
  await bot.poll();
  await bot.poll();
  assert.equal(channel.sent, 1);
  assert.equal(infoWrites, 1);
});

test('discordInfo timeout is retried by scanning without reposting', async () => {
  const channel = makeChannel();
  let infoAttempts = 0;
  const bot = loadBot({
    channel,
    apiHandler: async body => {
      if (body.action === 'unsynced') return [task('TASK-INFO-TIMEOUT')];
      if (body.action === 'designers') return [{ name: 'DESIGNER' }];
      if (body.action === 'claimSync') return { claimed: true };
      if (body.action === 'discordInfo') {
        infoAttempts += 1;
        if (infoAttempts === 1) throw new Error('ETIMEDOUT');
        return { success: true };
      }
    }
  });
  await bot.poll();
  await bot.poll();
  assert.equal(channel.sent, 1);
  assert.equal(infoAttempts, 2);
});

test('POSTING payload prevents an automatic repost', async () => {
  const channel = makeChannel();
  let claimCalls = 0;
  const postingTask = { ...task('TASK-POSTING'), syncStatus: 'POSTING' };
  const bot = loadBot({
    channel,
    apiHandler: async body => {
      if (body.action === 'unsynced') return [postingTask];
      if (body.action === 'claimSync') { claimCalls += 1; return { claimed: true }; }
      throw new Error(`Unexpected action: ${body.action}`);
    }
  });
  await bot.poll();
  assert.equal(channel.sent, 0);
  assert.equal(claimCalls, 0);
});

test('kill switch defaults to OFF and does not claim or send', async () => {
  const channel = makeChannel();
  let claimCalls = 0;
  const bot = loadBot({
    channel,
    sendEnabled: false,
    apiHandler: async body => {
      if (body.action === 'unsynced') return [task('TASK-GATE')];
      if (body.action === 'claimSync') claimCalls += 1;
      throw new Error(`Unexpected action: ${body.action}`);
    }
  });
  await bot.poll();
  assert.equal(channel.sent, 0);
  assert.equal(claimCalls, 0);
});

test('kill switch OFF also blocks discordInfo reconciliation writes', async () => {
  const channel = makeChannel([{ id: '900', requestId: 'TASK-GATE' }]);
  let infoWrites = 0;
  const bot = loadBot({
    channel,
    sendEnabled: false,
    apiHandler: async body => {
      if (body.action === 'unsynced') return [task('TASK-GATE')];
      if (body.action === 'discordInfo') { infoWrites += 1; return { success: true }; }
      throw new Error(`Unexpected action: ${body.action}`);
    }
  });
  await bot.poll();
  assert.equal(infoWrites, 0);
  assert.equal(channel.sent, 0);
});

test('allowlist is deny-by-default', async () => {
  const channel = makeChannel();
  let claimCalls = 0;
  const bot = loadBot({
    channel,
    allowlist: '',
    apiHandler: async body => {
      if (body.action === 'unsynced') return [task('TASK-GATE')];
      if (body.action === 'claimSync') claimCalls += 1;
      throw new Error(`Unexpected action: ${body.action}`);
    }
  });
  await bot.poll();
  assert.equal(channel.sent, 0);
  assert.equal(claimCalls, 0);
});

test('contract handshake mismatch fails closed before claim', async () => {
  const channel = makeChannel();
  let claimCalls = 0;
  const bot = loadBot({
    channel,
    contract: { ...CONTRACT, fencing: false },
    apiHandler: async body => {
      if (body.action === 'unsynced') return [task('TASK-CONTRACT')];
      if (body.action === 'claimSync') claimCalls += 1;
      throw new Error(`Unexpected action: ${body.action}`);
    }
  });
  await bot.poll();
  assert.equal(channel.sent, 0);
  assert.equal(claimCalls, 0);
});

test('claimed response without a valid claimId fails closed', async () => {
  const channel = makeChannel();
  const bot = loadBot({
    channel,
    autoClaimId: false,
    apiHandler: basicApi('TASK-UNKNOWN', async () => ({ claimed: true }))
  });
  await bot.poll();
  assert.equal(channel.sent, 0);
});

test('Discord REST retries are disabled for ambiguous create-message outcomes', () => {
  assert.match(BOT_SOURCE, /rest:\{retries:0\}/);
});

for (const failure of ['HTTP 500 after accepted', 'ECONNRESET after accepted']) {
  test(`${failure} leaves one discoverable message and never reposts`, async () => {
    let firstSend = true;
    const channel = makeChannel([], async () => {
      if (firstSend) { firstSend = false; throw new Error(failure); }
    });
    let infoWrites = 0;
    const bot = loadBot({
      channel,
      apiHandler: async body => {
        if (body.action === 'unsynced') return [task('TASK-UNKNOWN')];
        if (body.action === 'designers') return [{ name: 'DESIGNER' }];
        if (body.action === 'claimSync') return { claimed: true, claimId: 'claim-token-00000001' };
        if (body.action === 'discordInfo') { infoWrites += 1; return { success: true }; }
      }
    });
    await bot.poll();
    await bot.poll();
    assert.equal(channel.sent, 1);
    assert.equal(infoWrites, 1);
  });
}

test('candidate concurrent claims produce one fenced winner', () => {
  const { sandbox, state } = loadSync03A();
  const first = sandbox.claimDiscordSync('TASK-CLAIM');
  const second = sandbox.claimDiscordSync('TASK-CLAIM');
  assert.equal(first.claimed, true);
  assert.match(first.claimId, /^[A-Za-z0-9_-]{16,128}$/);
  assert.equal(second.claimed, false);
  assert.equal(second.reason, 'NEEDS_RECONCILIATION');
  assert.equal(state.record[5], 'POSTING');
});

test('candidate discordInfo is fenced, idempotent, and conflict preserving', () => {
  const { sandbox, state } = loadSync03A();
  const claim = sandbox.claimDiscordSync('TASK-FENCE');
  const wrong = sandbox.saveDiscordInfo({
    requestId: 'TASK-FENCE', claimId: 'stale-claim-token',
    messageId: '123456789012345678', channelId: '223456789012345678'
  });
  assert.equal(wrong.code, 'CLAIM_CONFLICT');
  const saved = sandbox.saveDiscordInfo({
    requestId: 'TASK-FENCE', claimId: claim.claimId,
    messageId: '123456789012345678', channelId: '223456789012345678'
  });
  assert.equal(saved.changed, true);
  const same = sandbox.saveDiscordInfo({
    requestId: 'TASK-FENCE', claimId: '',
    messageId: '123456789012345678', channelId: '223456789012345678'
  });
  assert.equal(same.idempotent, true);
  const conflict = sandbox.saveDiscordInfo({
    requestId: 'TASK-FENCE', claimId: claim.claimId,
    messageId: '323456789012345678', channelId: '223456789012345678'
  });
  assert.equal(conflict.code, 'MESSAGE_CONFLICT');
  assert.equal(state.record[0], '123456789012345678');
});

test('candidate source and bot contain no credential literals', () => {
  for (const source of [BOT_SOURCE, SYNC_03A_SOURCE]) {
    assert.doesNotMatch(source, /(?:discord|google)[_-]?(?:token|secret)\s*[:=]\s*['\"][A-Za-z0-9_-]{24,}/i);
  }
});

test('a message outside the 300-message scan window can be reposted if the claim layer fails', async () => {
  const newer = Array.from({ length: 300 }, (_, index) => ({
    id: String(1000 - index),
    requestId: `TASK-OTHER-${index}`
  }));
  const channel = makeChannel([...newer, { id: '1', requestId: 'TASK-TOO-OLD' }]);
  const bot = loadBot({
    channel,
    apiHandler: basicApi('TASK-TOO-OLD', async () => ({ claimed: true }))
  });
  await bot.poll();
  assert.equal(channel.sent, 1);
});

test('available Apps Script snapshot has no claimSync implementation or lock', () => {
  assert.equal(/claimSync/.test(APPS_SCRIPT_SOURCE), false);
  assert.equal(/LockService/.test(APPS_SCRIPT_SOURCE), false);
  assert.equal(/POSTING/.test(APPS_SCRIPT_SOURCE), false);
});

test('available Apps Script unsynced payload omits reconciliation fields', () => {
  const functionBody = APPS_SCRIPT_SOURCE.slice(
    APPS_SCRIPT_SOURCE.indexOf('function getUnsyncedTasks()'),
    APPS_SCRIPT_SOURCE.indexOf('function getTaskById')
  );
  assert.equal(/syncStatus\s*:/.test(functionBody), false);
  assert.equal(/messageId\s*:/.test(functionBody), false);
  assert.equal(/messageUrl\s*:/.test(functionBody), false);
});

test('available Apps Script snapshot does not validate apiToken', () => {
  assert.equal(/apiToken/.test(APPS_SCRIPT_SOURCE), false);
});
