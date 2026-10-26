/**
 * THISKYHALL Discord Bot v3.0 (discord.js v14)
 * Requires: npm install discord.js axios express dotenv
 * Required environment: DISCORD_TOKEN, GOOGLE_SCRIPT_URL, GOOGLE_SCRIPT_TOKEN,
 * MANAGER_ROLE_ID, CHANNEL_TASK_NEW, CHANNEL_REVIEW, CHANNEL_DONE.
 * SETTINGS column E = designer channel ID; column C = designer Discord user ID.
 */
require('dotenv').config();
const { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');
const express = require('express');
const axios = require('axios');

const ENV_KEYS = ['DISCORD_TOKEN','GOOGLE_SCRIPT_URL','GOOGLE_SCRIPT_TOKEN','MANAGER_ROLE_ID','CHANNEL_TASK_NEW','CHANNEL_REVIEW','CHANNEL_DONE'];
const missing = ENV_KEYS.filter(k => !process.env[k]);
if (missing.length) throw new Error(`Missing .env variables: ${missing.join(', ')}`);
if (process.env.GOOGLE_SCRIPT_TOKEN.length < 32) throw new Error('GOOGLE_SCRIPT_TOKEN must contain at least 32 characters');

const cfg = {
  url: process.env.GOOGLE_SCRIPT_URL, token: process.env.GOOGLE_SCRIPT_TOKEN,
  managerRoleId: process.env.MANAGER_ROLE_ID,
  newChannel: process.env.CHANNEL_TASK_NEW,
  reviewChannel: process.env.CHANNEL_REVIEW,
  doneChannel: process.env.CHANNEL_DONE
};
// DIAG-06E RECOVERY-07A - read-only guard. Fail closed: absent, empty, unrecognized => guard ON.
// Only an explicit DISCORD_DIAGNOSTIC_READ_ONLY=false may lift it.
// Task-send settings (DISCORD_SYNC_SEND_ENABLED / DISCORD_SYNC_ALLOWLIST) never affect this flag.
const DIAGNOSTIC_WRITE_ACTIONS = new Set(['assign','status','claimSync','discordInfo']);
const diagnosticReadOnly = (() => {
  const value = process.env.DISCORD_DIAGNOSTIC_READ_ONLY;
  if (value === undefined || value === null || String(value).trim() === '') return true;
  return String(value).trim().toLowerCase() !== 'false';
})();
console.log('DISCORD_DIAGNOSTIC_READ_ONLY', { enabled: diagnosticReadOnly });
const client = new Client({intents:[GatewayIntentBits.Guilds,GatewayIntentBits.GuildMessages,GatewayIntentBits.MessageContent],rest:{retries:0}});
const app = express();
app.get('/', (_req,res) => res.send('Bot Online'));
app.get('/ping', (_req,res) => res.status(client.isReady()?200:503).send(client.isReady()?'pong':'Discord not connected'));
app.listen(Number(process.env.PORT) || 3000, () => console.log('Health server ready'));

function apiProblem(action, data) {
  let msg = data?.message || data?.code || 'API returned an invalid response';
  throw new Error(`${action}: ${msg}`);
}
async function api(action, data = {}) {
  if (diagnosticReadOnly && DIAGNOSTIC_WRITE_ACTIONS.has(action)) {
    throw new Error(`DIAGNOSTIC_READ_ONLY: write action blocked (${action})`);
  }
  const res = await axios.post(cfg.url, { ...data, action, apiToken: cfg.token }, {
    timeout: 30000, maxRedirects: 5, headers:{'Content-Type':'application/json'}
  });
  if (typeof res.data !== 'object' || res.data === null || typeof res.data === 'string') apiProblem(action, res.data);
  if (res.data.success === false) apiProblem(action, res.data);
  return res.data;
}
let designerCache = [], designerCacheAt = 0;
async function getDesigners(force=false) {
  if (!force && designerCache.length && Date.now()-designerCacheAt < 120000) return designerCache;
  try {
    const list = await api('designers');
    if (!Array.isArray(list)) throw new Error('Designer list is not an array');
    designerCache = list.filter(d => d && typeof d.name === 'string' && d.name.trim());
    designerCacheAt = Date.now();
  } catch (err) {
    console.error('Designer fetch failed:', err.message);
    if (!designerCache.length) throw err;
  }
  return designerCache;
}
const idOf = x => String(x || '').trim();
const short = (x,limit=200) => {
  const value = String(x === null || x === undefined || x === '' ? '-' : x);
  return value.length > limit ? value.slice(0,limit-1)+'…' : value;
};
function createTaskEmbed(task, title='📋 TASK') {
  let url = String(task.fileRef || '').trim();
  let file = /^https?:\/\/\S+$/i.test(url) && url.length <= 850 ? `[Mở File](${url.replace(/[)\\]/g, '')})` : short(url || '-', 850);
  return new EmbedBuilder().setTitle(title).setColor('#5865F2').addFields(
    {name:'Request ID',value:short(task.requestId)},
    {name:'Người gửi',value:short(task.sender)},
    {name:'Team',value:short(task.team)},
    {name:'Thương hiệu',value:short(task.brand)},
    {name:'Phân loại',value:short(task.category)},
    {name:'Deadline',value:short(task.deadline)},
    {name:'Độ gấp',value:short(task.priority)},
    {name:'Kích thước',value:short(task.format)},
    {name:'Số lượng',value:short(task.quantity)},
    {name:'Brief',value:short(task.brief,850)},
    {name:'File tham khảo',value:file},
    {name:'Designer',value:short(task.designer)},
    {name:'Trạng thái',value:short(task.status)},
    {name:'Round',value:short(task.round)}
  );
}
function assignRows(designers) {
  if (!designers.length) throw new Error('No designers in SETTINGS; refuse to send unassignable task');
  if (designers.length > 25) throw new Error('Discord supports at most 25 buttons; reduce designer list/use select menu');
  const rows=[];
  designers.forEach((d,index) => {
    if (!d.name || d.name.length > 80 || `assign_${d.name}`.length > 100) throw new Error('Designer name exceeds Discord button limits');
    if (index % 5 === 0) rows.push(new ActionRowBuilder());
    rows[rows.length-1].addComponents(new ButtonBuilder()
      .setCustomId(`assign_${d.name}`).setLabel(d.name).setStyle(ButtonStyle.Primary));
  });
  return rows;
}
const STATUS_CODES = {doing:'Doing',review:'Review',revision:'Revision',done:'Done'};
function statusRows(reqId) {
  const buttons = [
    ['doing','Đang làm',ButtonStyle.Primary],
    ['review','Chờ Review',ButtonStyle.Success],
    ['revision','Yêu cầu sửa',ButtonStyle.Secondary],
    ['done','Duyệt Done',ButtonStyle.Danger]
  ];
  const row = new ActionRowBuilder();
  for (const [code,label,style] of buttons) {
    const customId = `status:${code}:${reqId}`;
    if (customId.length > 100) throw new Error('Request ID too long for Discord button');
    row.addComponents(new ButtonBuilder().setCustomId(customId).setLabel(label).setStyle(style));
  }
  return [row];
}
function embeddedRequestId(msg) {
  const field = msg.embeds?.[0]?.fields?.find(f => f.name === 'Request ID');
  return idOf(field?.value);
}
async function scanRecentTasks(channel, limit=300) {
  const found = new Map(), duplicate=[];
  let before;
  for (let read=0;read<limit;read+=100) {
    const batch=await channel.messages.fetch({...{limit:Math.min(100,limit-read)}, ...(before?{before}:{})});
    if (!batch.size) break;
    for (const msg of batch.values()) {
      if (msg.author.id !== client.user.id) continue;
      const id=embeddedRequestId(msg);
      if (!id) continue;
      if (found.has(id)) duplicate.push(msg);
      else found.set(id,msg);
    }
    before=batch.last()?.id;
    if (batch.size < Math.min(100,limit-read)) break;
  }
  return {found,duplicate};
}
async function duplicateReport() {
  if (diagnosticReadOnly) {
    console.log('DIAGNOSTIC_READ_ONLY: duplicate audit skipped');
    return 0;
  }
  const channel=await client.channels.fetch(cfg.newChannel);
  if (!channel || !channel.messages) throw new Error('New task channel is not a text channel');
  const {duplicate}=await scanRecentTasks(channel);
  console.log(`Duplicate audit: ${duplicate.length} duplicates among latest 300 messages. No automatic deletion.`);
  return duplicate.length;
}
const processing = new Set();
let polling = false;
const warnings = new Set();
async function poll() {
  if (diagnosticReadOnly) {
    console.log('DIAGNOSTIC_READ_ONLY: poll skipped');
    return;
  }
  if (polling) return;
  polling=true;
  try {
    const tasks=await api('unsynced');
    if (!Array.isArray(tasks)) throw new Error('unsynced returned non-array');
    if (!tasks.length) return;
    const channel=await client.channels.fetch(cfg.newChannel);
    if (!channel || typeof channel.send !== 'function' || !channel.messages) throw new Error('Configured task channel cannot send/fetch messages');
    let scan = await scanRecentTasks(channel,300);
    for (const task of tasks) {
      const reqId=idOf(task.requestId);
      if (!reqId || processing.has(reqId)) continue;
      processing.add(reqId);
      try {
        // Old sends and uncertain POSTING sends: reconcile rather than sending a duplicate.
        let existing=scan.found.get(reqId);
        if (task.messageId && !existing) {
          try { existing=await channel.messages.fetch(String(task.messageId)); } catch (_) {}
        }
        if (existing) {
          await api('discordInfo',{requestId:reqId,messageId:existing.id,channelId:existing.channel.id,messageUrl:existing.url});
          continue;
        }
        const state=String(task.syncStatus || '').toUpperCase();
        if (state === 'POSTING' || state === 'RECONCILE_REQUIRED' || task.messageId) {
          if (!warnings.has(reqId)) console.error(`RECONCILE MANUALLY: ${reqId} in state ${state || 'HAS_MESSAGE_ID'}; not automatically reposting`);
          warnings.add(reqId);
          continue;
        }
        const designers=await getDesigners();
        const rows=assignRows(designers);
        const claim=await api('claimSync',{requestId:reqId});
        if (!claim.claimed) continue;
        // If send fails after claim, leave POSTING and reconcile rather than blindly retry.
        const msg=await channel.send({embeds:[createTaskEmbed(task,'📋 TASK MỚI')],components:rows,allowedMentions:{parse:[]}});
        scan.found.set(reqId,msg);
        await api('discordInfo',{requestId:reqId,messageId:msg.id,channelId:channel.id,messageUrl:msg.url});
        console.log('SYNCED:',reqId,msg.id);
      } catch(err) { console.error('SYNC ERROR:',reqId,err.message); }
      finally { processing.delete(reqId); }
    }
  } catch(err) { console.error('POLL ERROR:',err.message); }
  finally { polling=false; }
}
function startPolling() {
  if (diagnosticReadOnly) {
    console.log('DIAGNOSTIC_READ_ONLY: polling loop not started');
    return;
  }
  const loop=async()=>{ await poll(); setTimeout(loop,15000); };
  loop().catch(err=>console.error('POLL LOOP ERROR:',err));
}
async function hasManagerRole(interaction) {
  if (!interaction.inGuild()) return false;
  try {
    const member=await interaction.guild.members.fetch(interaction.user.id);
    return member.roles.cache.has(cfg.managerRoleId);
  } catch(err) { console.error('Role lookup failed:',err.message); return false; }
}
async function ensureDesignerNotification(designer,requestId) {
  if (diagnosticReadOnly) throw new Error('DIAGNOSTIC_READ_ONLY: designer notification blocked');
  const list=await getDesigners(true);
  const d=list.find(x=>x.name.normalize('NFC').toUpperCase() === designer.normalize('NFC').toUpperCase());
  if (!d || !/^\d{15,22}$/.test(String(d.channelId||''))) throw new Error('Missing designer CHANNEL ID in SETTINGS column E');
  const channel=await client.channels.fetch(d.channelId);
  if (!channel || !channel.messages || typeof channel.send !== 'function') throw new Error('Designer channel is inaccessible');
  const {found}=await scanRecentTasks(channel,300);
  if (found.has(requestId)) return false;
  const task=await api('task',{requestId});
  if (!task.requestId) throw new Error('Task no longer exists');
  await channel.send({content:`🎨 Task dành cho ${short(designer,80)}`,embeds:[createTaskEmbed(task,'🎨 TASK ĐƯỢC GIAO')],components:statusRows(requestId),allowedMentions:{parse:[]}});
  return true;
}
async function notifyChannel(channelId,text) {
  if (diagnosticReadOnly) throw new Error('DIAGNOSTIC_READ_ONLY: channel notification blocked');
  const channel=await client.channels.fetch(channelId);
  if (!channel || typeof channel.send !== 'function') throw new Error('Notification channel inaccessible');
  await channel.send({content:text,allowedMentions:{parse:[]}});
}

client.on('messageCreate',async message=>{
  if (message.author.bot) return;
  const command = message.content.trim().split(/\s+/);
  if (!['!checkdup','!cleandup','!notify','!reconcile'].includes(command[0])) return;
  if (diagnosticReadOnly) {
    console.log('DIAGNOSTIC_READ_ONLY: command blocked', command[0]);
    return;
  }
  if (!message.member?.roles?.cache?.has(cfg.managerRoleId)) return message.reply('❌ Không có quyền.');
  try {
    if (command[0] === '!notify') {
      const requestId=command[1];
      if (!requestId) return message.reply('Cú pháp: !notify TASK-...');
      const task=await api('task',{requestId});
      if (!task.requestId || !task.designer) throw new Error('Task chưa được giao');
      const posted=await ensureDesignerNotification(String(task.designer),requestId);
      return message.reply(posted ? '✅ Đã gửi thông báo.' : '✅ Thông báo đã tồn tại trong 300 tin gần nhất.');
    }
    if (command[0] === '!reconcile') {
      const requestId=command[1];
      if (!requestId) return message.reply('Cú pháp: !reconcile TASK-...');
      const channel=await client.channels.fetch(cfg.newChannel);
      const {found}=await scanRecentTasks(channel,300);
      const msg=found.get(requestId);
      if (!msg) return message.reply('⚠️ Không tìm thấy trong 300 tin gần nhất; giữ nguyên POSTING. Kiểm tra thủ công trước khi reset.');
      await api('discordInfo',{requestId,messageId:msg.id,channelId:channel.id,messageUrl:msg.url});
      return message.reply('✅ Đã đối soát Message ID vào Sheet.');
    }
    const count=await duplicateReport();
    await message.reply(`🔎 Đã kiểm tra 300 tin gần nhất: ${count} tin trùng. Để bảo vệ link và audit, bot KHÔNG tự xóa.`);
  } catch(err) { await message.reply(`❌ ${short(err.message,1500)}`); }
});
client.on('interactionCreate',async interaction=>{
  if (!interaction.isButton()) return;
  const customId=interaction.customId;
  const isAssign=customId.startsWith('assign_');
  const isStatus=customId.startsWith('status:') || customId.startsWith('status_');
  if (!isAssign && !isStatus) return;
  if (diagnosticReadOnly) {
    console.log('DIAGNOSTIC_READ_ONLY: interaction blocked', customId);
    return;
  }
  try {
    await interaction.deferReply({ephemeral:true}); // acknowledge within 3 seconds
    const manager=await hasManagerRole(interaction);
    if (isAssign) {
      if (!manager) return interaction.editReply('❌ Chỉ Manager được phân công task.');
      const designer=customId.slice('assign_'.length).trim().normalize('NFC');
      const reqId=embeddedRequestId(interaction.message);
      if (!reqId) throw new Error('Request ID missing from source message');
      const result=await api('assign',{requestId:reqId,designer});
      let note='';
      try { await ensureDesignerNotification(result.designer,reqId); }
      catch(err) { note=`\n⚠️ Task đã assign nhưng chưa thông báo cho Designer: ${short(err.message,250)}. Hãy kiểm tra SETTINGS và thực hiện lại.`; }
      try {
        const task=await api('task',{requestId:reqId});
        await interaction.message.edit({embeds:[createTaskEmbed(task,'✅ ĐÃ PHÂN CÔNG')],components:[],allowedMentions:{parse:[]}});
      } catch(err) { note+=`\n⚠️ Không cập nhật được embed: ${short(err.message,150)}`; }
      return interaction.editReply(`✅ Task ${reqId} được giao cho **${result.designer}**.${note}`);
    }
    let status,reqId;
    if (customId.startsWith('status:')) {
      const m=/^status:(doing|review|revision|done):(.+)$/.exec(customId);
      if (!m) throw new Error('Malformed status button');
      status=STATUS_CODES[m[1]];reqId=m[2];
    } else {
      const m=/^status_(In Progress|Doing|Review|Revision|Done)_(.+)$/.exec(customId);
      if (!m) throw new Error('Malformed legacy status button');
      status=m[1] === 'In Progress' ? 'Doing' : m[1];reqId=m[2];
    }
    const task=await api('task',{requestId:reqId});
    if (!task.requestId) throw new Error('Task not found');
    const designers=await getDesigners(true);
    const assigned=designers.find(d=>d.name.toUpperCase() === String(task.designer||'').trim().normalize('NFC').toUpperCase());
    const owner=Boolean(assigned && assigned.discordUserId && String(assigned.discordUserId) === interaction.user.id);
    if (status === 'Done' || status === 'Revision') {
      if (!manager) return interaction.editReply('❌ Chỉ Manager mới được duyệt Done hoặc yêu cầu Revision.');
    } else if (!manager && !owner) {
      return interaction.editReply('❌ Chỉ designer được giao hoặc Manager mới có thể cập nhật task. Kiểm tra SETTINGS cột C.');
    }
    const result=await api('status',{requestId:reqId,status});
    let warning='';
    if (result.changed && status === 'Review') {
      try {await notifyChannel(cfg.reviewChannel,`👀 Task chờ review: ${reqId}`);} catch(err){warning=` ⚠️ Không gửi được thông báo Review: ${short(err.message,150)}`;}
    }
    if (result.changed && status === 'Done') {
      try {await notifyChannel(cfg.doneChannel,`✅ Task hoàn thành: ${reqId}`);} catch(err){warning=` ⚠️ Không gửi được thông báo Done: ${short(err.message,150)}`;}
    }
    try {
      const updated=await api('task',{requestId:reqId});
      await interaction.message.edit({embeds:[createTaskEmbed(updated,'🎨 TASK ĐƯỢC GIAO')],components:(status==='Done'?[]:statusRows(reqId)),allowedMentions:{parse:[]}});
    } catch(err) { warning+=` ⚠️ Embed chưa cập nhật.`; }
    return interaction.editReply(`✅ ${reqId}: **${result.status}**${result.changed?'':' (đã ở trạng thái này)'}${warning}`);
  } catch(err) {
    console.error('INTERACTION ERROR:',err);
    const text=`❌ ${short(err.message,1500)}`;
    try { if (interaction.deferred || interaction.replied) await interaction.editReply(text); else await interaction.reply({content:text,ephemeral:true}); } catch(_) {}
  }
});
client.once("clientReady", async () => {
  console.log('Logged in:',client.user.tag);
  if (diagnosticReadOnly) {
    console.log('DISCORD_DIAGNOSTIC_READ_ONLY_ACTIVE: duplicate audit and polling disabled');
    return;
  }
  duplicateReport().catch(err=>console.error('Initial duplicate audit:',err.message));
  startPolling();
});
client.login(process.env.DISCORD_TOKEN).catch(err=>{console.error('Discord login failed:',err.message);process.exitCode=1;});
