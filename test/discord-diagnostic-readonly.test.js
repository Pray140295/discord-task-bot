'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const BOT_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'bot.js'), 'utf8');

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

function makeMessage(id, requestId, channel) {
  return {
    id: String(id),
    url: `https://discord.test/messages/${id}`,
    author: { id: 'bot-user' },
    channel,
    embeds: [{ fields: [{ name: 'Request ID', value: requestId }] }]
  };
}

function makeChannel(initial = []) {
  const channel = { id: 'new-channel', sent: 0, messageFetches: 0, deletes: 0 };
  const stored = initial.map(item => makeMessage(item.id, item.requestId, channel));
  channel.messages = {
    async fetch(arg) {
      channel.messageFetches += 1;
      if (typeof arg === 'string') {
        const exact = stored.find(message => message.id === arg);
        if (!exact) throw new Error('Unknown message');
        return exact;
      }
      const start = arg.before
        ? stored.findIndex(message => message.id === arg.before) + 1
        : 0;
      const page = stored.slice(start, start + arg.limit);
      const collection = new Map(page.map(message => [message.id, message]));
      collection.last = () => page[page.length - 1];
      return collection;
    },
    async delete() {
      channel.deletes += 1;
      throw new Error('Unexpected message delete');
    }
  };
  channel.send = async payload => {
    channel.sent += 1;
    const requestId = payload.embeds[0].data.fields.find(field => field.name === 'Request ID').value;
    const message = makeMessage(`sent-${channel.sent}`, requestId, channel);
    stored.unshift(message);
    return message;
  };
  return channel;
}

const BASE_ENV = {
  DISCORD_TOKEN: 'discord-token',
  GOOGLE_SCRIPT_URL: 'https://apps-script.test/exec',
  GOOGLE_SCRIPT_TOKEN: 'x'.repeat(32),
  MANAGER_ROLE_ID: 'manager',
  CHANNEL_TASK_NEW: 'new-channel',
  CHANNEL_REVIEW: 'review-channel',
  CHANNEL_DONE: 'done-channel',
  DISCORD_SYNC_SEND_ENABLED: 'true',
  DISCORD_SYNC_ALLOWLIST: 'TASK-DIAG'
};

function loadBot({ channel = makeChannel(), env = {}, apiHandler } = {}) {
  const handlers = {};
  const restHandlers = {};
  const logs = [];
  const axiosCalls = [];
  const timers = [];
  let channelFetches = 0;

  const client = {
    user: { id: 'bot-user', tag: 'bot#0001' },
    channels: {
      fetch: async () => {
        channelFetches += 1;
        return channel;
      }
    },
    on: (event, handler) => { handlers[event] = handler; },
    once: (event, handler) => { handlers[event] = handler; },
    rest: { on: (event, handler) => { restHandlers[event] = handler; } },
    login: async () => undefined,
    isReady: () => true,
    ws: { status: 0, shards: new Map() }
  };

  const sandbox = {
    require(name) {
      if (name === 'dotenv') return { config() {} };
      if (name === 'axios') {
        return {
          post: async (_url, body) => {
            axiosCalls.push(body);
            if (!apiHandler) return { data: { success: true } };
            return { data: await apiHandler(body) };
          }
        };
      }
      if (name === 'express') return () => ({ get() {}, listen() {} });
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
    process: { env: { ...BASE_ENV, ...env }, exitCode: 0 },
    console: {
      log: (...args) => logs.push(['log', ...args]),
      warn: (...args) => logs.push(['warn', ...args]),
      error: (...args) => logs.push(['error', ...args])
    },
    setTimeout(fn, ms) { timers.push(ms); return timers.length; },
    clearTimeout() {}
  };

  vm.createContext(sandbox);
  vm.runInContext(BOT_SOURCE, sandbox, { filename: 'bot.js' });

  return {
    poll: sandbox.poll,
    startPolling: sandbox.startPolling,
    duplicateReport: sandbox.duplicateReport,
    api: sandbox.api,
    handlers,
    restHandlers,
    logs,
    axiosCalls,
    timers,
    channel,
    get channelFetches() { return channelFetches; }
  };
}

function makeInteraction(customId) {
  const calls = {
    deferReply: 0, editReply: 0, reply: 0, messageEdit: 0, roleFetch: 0
  };
  const interaction = {
    customId,
    user: { id: 'user-1' },
    message: {
      embeds: [{ fields: [{ name: 'Request ID', value: 'TASK-DIAG' }] }],
      edit: async () => { calls.messageEdit += 1; return interaction.message; }
    },
    isButton: () => true,
    inGuild: () => true,
    guild: { members: { fetch: async () => { calls.roleFetch += 1; return { roles: { cache: new Map() } }; } } },
    deferReply: async () => { calls.deferReply += 1; },
    editReply: async () => { calls.editReply += 1; },
    reply: async () => { calls.reply += 1; },
    deferred: false,
    replied: false
  };
  return { interaction, calls };
}

function makeMessage(content) {
  const calls = { reply: 0 };
  const message = {
    author: { bot: false },
    content,
    member: { roles: { cache: { has: () => true } } },
    reply: async () => { calls.reply += 1; }
  };
  return { message, calls };
}

const CODES = ['assign', 'status', 'claimSync', 'discordInfo'];

test('defaults to read-only when DISCORD_DIAGNOSTIC_READ_ONLY is absent', async () => {
  // Send settings are deliberately permissive: they must not lift the guard.
  const bot = loadBot();
  await bot.poll();
  bot.startPolling();

  assert.equal(bot.axiosCalls.length, 0);
  assert.equal(bot.channel.sent, 0);
  assert.equal(bot.channel.messageFetches, 0);
  assert.equal(bot.timers.filter(ms => ms === 15000).length, 0);
  assert.ok(bot.logs.some(([, message]) => message === 'DISCORD_DIAGNOSTIC_READ_ONLY'));
});

for (const value of ['', '0', 'yes', 'true', 'TRUE']) {
  test(`fails closed for non-false value ${JSON.stringify(value)}`, async () => {
    const bot = loadBot({ env: { DISCORD_DIAGNOSTIC_READ_ONLY: value } });
    await bot.poll();
    assert.equal(bot.axiosCalls.length, 0);
    assert.equal(bot.channel.sent, 0);
  });
}

test('explicit DISCORD_DIAGNOSTIC_READ_ONLY=false restores the sync path', async () => {
  const channel = makeChannel();
  const bot = loadBot({
    channel,
    env: { DISCORD_DIAGNOSTIC_READ_ONLY: 'false' },
    apiHandler: body => {
      if (body.action === 'unsynced') {
        return [{
          requestId: 'TASK-DIAG', sender: 's', team: 't', brand: 'b', category: 'c',
          deadline: 'd', priority: 'p', format: 'f', quantity: 1, brief: 'x',
          fileRef: '', designer: '', status: 'New', round: '1'
        }];
      }
      if (body.action === 'designers') return [{ name: 'DESIGNER' }];
      if (body.action === 'claimSync') return { claimed: true, claimId: 'claim-token-00000001' };
      if (body.action === 'discordInfo') return { success: true };
      if (body.action === 'syncContract') {
        return { version: 'SYNC-SAFETY-03A/1', claimId: true, fencing: true, postingNoRetry: true, idempotentDiscordInfo: true };
      }
    }
  });
  await bot.poll();
  assert.equal(channel.sent, 1);
  assert.equal(bot.axiosCalls.some(body => body.action === 'claimSync'), true);
});

test('startup performs no duplicate audit and no polling in read-only mode', async () => {
  const bot = loadBot();
  await bot.handlers.clientReady();

  assert.equal(bot.channelFetches, 0);
  assert.equal(bot.channel.messageFetches, 0);
  assert.equal(bot.channel.sent, 0);
  assert.equal(bot.axiosCalls.length, 0);
  assert.equal(bot.timers.filter(ms => ms === 15000).length, 0);
  assert.ok(bot.logs.some(([, message]) =>
    message === 'DISCORD_DIAGNOSTIC_READ_ONLY_ACTIVE: duplicate audit and polling disabled'));
});

test('duplicateReport is a no-op in read-only mode', async () => {
  const bot = loadBot();
  assert.equal(await bot.duplicateReport(), 0);
  assert.equal(bot.channelFetches, 0);
  assert.equal(bot.channel.messageFetches, 0);
});

for (const content of ['!checkdup', '!cleandup', '!notify TASK-DIAG', '!reconcile TASK-DIAG']) {
  test(`chat command ${content} is blocked without reply or API call`, async () => {
    const bot = loadBot();
    const { message, calls } = makeMessage(content);
    await bot.handlers.messageCreate(message);

    assert.equal(calls.reply, 0);
    assert.equal(bot.axiosCalls.length, 0);
    assert.equal(bot.channel.sent, 0);
  });
}

for (const customId of ['assign_DESIGNER', 'status:doing:TASK-DIAG', 'status_Done_TASK-DIAG']) {
  test(`button ${customId} is blocked before any Discord or API write`, async () => {
    const bot = loadBot();
    const { interaction, calls } = makeInteraction(customId);
    await bot.handlers.interactionCreate(interaction);

    assert.deepEqual(calls, {
      deferReply: 0, editReply: 0, reply: 0, messageEdit: 0, roleFetch: 0
    });
    assert.equal(bot.axiosCalls.length, 0);
    assert.equal(bot.channel.sent, 0);
  });
}

test('write API actions are refused before axios, including direct calls', async () => {
  const bot = loadBot();
  for (const action of CODES) {
    await assert.rejects(bot.api(action, { requestId: 'TASK-DIAG' }), /DIAGNOSTIC_READ_ONLY/);
  }
  assert.equal(bot.axiosCalls.length, 0);
});

test('read-only actions remain available to diagnostics', async () => {
  const bot = loadBot();
  await bot.api('task', { requestId: 'TASK-DIAG' });
  assert.equal(bot.axiosCalls.length, 1);
  assert.equal(bot.axiosCalls[0].action, 'task');
});

test('Gateway diagnostic logging still works in read-only mode', () => {
  const bot = loadBot();
  const headers = {
    get(name) {
      return {
        'retry-after': null,
        'x-ratelimit-scope': 'user',
        'x-ratelimit-global': null,
        'content-type': 'application/json'
      }[name] ?? null;
    },
    has(name) { return name === 'cf-ray'; }
  };
  bot.restHandlers.response({ path: '/gateway/bot?foo=1' }, { status: 200, ok: true, headers });
  bot.restHandlers.rateLimited({ route: '/gateway/bot', retryAfter: 100, scope: 'user', global: false });

  const messages = bot.logs.map(([, message]) => message);
  assert.ok(messages.includes('DISCORD_GATEWAY_REST_RESPONSE'));
  assert.ok(messages.includes('DISCORD_GATEWAY_RATE_LIMITED'));
});

test('bot source blocks every diagnostic write action', () => {
  assert.match(BOT_SOURCE, /DISCORD_DIAGNOSTIC_READ_ONLY/);
  assert.match(BOT_SOURCE, /DIAGNOSTIC_WRITE_ACTIONS = new Set\(\['assign','status','claimSync','discordInfo'\]\)/);
  assert.doesNotMatch(BOT_SOURCE, /\.messages\.delete\(/);
});
