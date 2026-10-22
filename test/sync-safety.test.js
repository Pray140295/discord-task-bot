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

function loadBot({ channel, apiHandler }) {
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
      if (name === 'axios') return { post: async (_url, body) => ({ data: await apiHandler(body) }) };
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
        CHANNEL_DONE: 'done-channel'
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
