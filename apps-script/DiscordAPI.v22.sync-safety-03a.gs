/**
 * COMPLETE ISOLATED CANDIDATE — DO NOT DEPLOY DIRECTLY.
 * Base: verified Apps Script Version 22 candidate v3.0.
 * Base SHA-256: F81FC4254D33EA0F02AFB22CC1465073C0E866447D5BE7EF3373336D64D65446
 * Adds SYNC-SAFETY-03A/1 handshake and Script Properties fencing.
 */
/**
 * THISKYHALL — Discord bridge API, v3.0
 * Runs in the SAME Apps Script project as Formprocessor.gs and WorkloadEngine.gs.
 * Script Properties: DISCORD_API_TOKEN = long random secret (>=32 characters).
 * Deploy as Web App; all bot requests are JSON POST and must supply apiToken.
 * SETTINGS: A=Display Name, B=Discord Name, C=Discord USER ID,
 *           D=Designer Sheet Name, E=Discord CHANNEL ID.
 * Master columns W:AC remain unchanged. AB=SYNCED/POSTING/RECONCILE_REQUIRED/blank.
 */
var SHEET_ID = (typeof CONFIG !== 'undefined' && CONFIG.SHEET_ID) ? CONFIG.SHEET_ID : '';
var TASK_SHEET = (typeof CONFIG !== 'undefined' && CONFIG.DB_NAME) ? CONFIG.DB_NAME : 'Thông Tin Task';
var COL = {
  REQUEST_ID: 2, DESIGNER: 15, STATUS: 16, ROUND: 17,
  ASSIGNED_DATE: 18, START_TIME: 19, REVIEW_TIME: 20, DONE_TIME: 21,
  FINAL_LINK: 22, MESSAGE_ID: 23, CHANNEL_ID: 24, THREAD_ID: 25,
  MESSAGE_URL: 26, THREAD_URL: 27, SYNC_STATUS: 28, LAST_UPDATE: 29
};

function getSpreadsheet() {
  return (typeof getSS === 'function') ? getSS() : SpreadsheetApp.openById(SHEET_ID);
}
function getTaskSheet() {
  var sh = getSpreadsheet().getSheetByName(TASK_SHEET);
  if (!sh) throw new Error('Missing master sheet: ' + TASK_SHEET);
  return sh;
}
function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
function apiFailure(message, code) {
  return { success: false, code: code || 'API_ERROR', message: message };
}
function apiRequireToken(token) {
  var expected = PropertiesService.getScriptProperties().getProperty('DISCORD_API_TOKEN') || '';
  if (expected.length < 32) throw new Error('API_TOKEN_NOT_CONFIGURED');
  // Fixed-duration comparison; do not include a token in logs/responses.
  var actual = String(token || '');
  if (actual.length > 256) throw new Error('UNAUTHORIZED');
  var diff = expected.length ^ actual.length;
  var size = Math.max(expected.length, actual.length);
  for (var i = 0; i < size; i++) diff |= (expected.charCodeAt(i) || 0) ^ (actual.charCodeAt(i) || 0);
  if (diff !== 0) throw new Error('UNAUTHORIZED');
}

// No anonymous public GET endpoints. Use authenticated POST for reads too.
function doGet(e) {
  return jsonResponse(apiFailure('Use authenticated POST', 'METHOD_NOT_ALLOWED'));
}
function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) return jsonResponse(apiFailure('Missing body', 'BAD_REQUEST'));
    var data = JSON.parse(e.postData.contents);
    apiRequireToken(data.apiToken);
    var action = String(data.action || '');
    switch (action) {
      case 'unsynced': return jsonResponse(getUnsyncedTasks());
      case 'designers': return jsonResponse(getDesignersWithChannels());
      case 'task': return jsonResponse(getTaskById(data.requestId));
      case 'assign': return jsonResponse(assignDesigner(data.requestId, data.designer));
      case 'autoAssign': return jsonResponse(smartAssignTask(data.requestId));
      case 'status': return jsonResponse(updateStatus(data.requestId, data.status));
      case 'syncContract': return jsonResponse(getDiscordSyncContract());
      case 'claimSync': return jsonResponse(claimDiscordSync(data.requestId));
      case 'discordInfo': return jsonResponse(saveDiscordInfo(data));
      default: return jsonResponse(apiFailure('Unknown action', 'INVALID_ACTION'));
    }
  } catch (err) {
    var msg = String(err && err.message || err);
    // Do not leak raw internals on public endpoints.
    if (msg === 'UNAUTHORIZED' || msg === 'API_TOKEN_NOT_CONFIGURED')
      return jsonResponse(apiFailure(msg, msg));
    console.error('DiscordAPI error:', msg);
    return jsonResponse(apiFailure('Request could not be processed', 'SERVER_ERROR'));
  }
}

function findTaskRow(requestId) {
  var target = String(requestId || '').trim().toUpperCase();
  if (!target) return null;
  var sh = getTaskSheet();
  var lastRow = sh.getLastRow();
  if (lastRow < 5) return null;
  var ids = sh.getRange(5, COL.REQUEST_ID, lastRow - 4, 1).getValues();
  var found = null;
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]).trim().toUpperCase() === target) {
      if (found !== null) throw new Error('DUPLICATE_REQUEST_ID');
      found = i + 5;
    }
  }
  return found;
}
function taskFromRow(r) {
  var task = {
    requestId: String(r[1] || ''), sender: r[2], team: r[3], brand: r[4],
    category: r[5], note: r[6], orderDate: r[7], deadline: r[8],
    priority: r[9], format: r[10], quantity: r[11], brief: r[12],
    fileRef: r[13], designer: r[14], status: r[15], round: r[16],
    finalLink: r[21], messageId: String(r[22] || ''),
    channelId: String(r[23] || ''), threadId: String(r[24] || ''),
    messageUrl: String(r[25] || ''), threadUrl: String(r[26] || ''),
    syncStatus: String(r[27] || '').trim().toUpperCase()
  };
  task.claimId = getDiscordClaimId(task.requestId);
  return task;
}
function getTaskById(requestId) {
  var row = findTaskRow(requestId);
  if (!row) return apiFailure('Task not found', 'TASK_NOT_FOUND');
  var sh = getTaskSheet();
  var r = sh.getRange(row, 1, 1, 29).getValues()[0];
  var task = taskFromRow(r);
  try {
    var rich = sh.getRange(row, COL.FINAL_LINK).getRichTextValue();
    if (rich && rich.getLinkUrl()) task.finalLink = rich.getLinkUrl();
  } catch (ignored) {}
  return task;
}
function getUnsyncedTasks() {
  var sh = getTaskSheet();
  var lastRow = sh.getLastRow();
  if (lastRow < 5) return [];
  var data = sh.getRange(5, 1, lastRow - 4, 29).getValues();
  var ready = [], needReconcile = [];
  data.forEach(function(r) {
    var task = taskFromRow(r);
    if (!task.requestId || task.syncStatus === 'SYNCED') return;
    if (task.syncStatus === 'POSTING' || task.syncStatus === 'RECONCILE_REQUIRED' || task.messageId)
      needReconcile.push(task);
    else ready.push(task);
  });
  // Prevent old POSTING rows from starving all new tasks.
  return ready.slice(0, 80).concat(needReconcile.slice(0, 20)).concat(ready.slice(80, Math.max(80, 100 - Math.min(20, needReconcile.length))));
}
function getDesignersWithChannels() {
  var sh = getSpreadsheet().getSheetByName('SETTINGS');
  if (!sh || sh.getLastRow() < 2) return [];
  var values = sh.getRange(2, 1, sh.getLastRow() - 1, 5).getDisplayValues();
  var result = [], seen = {};
  values.forEach(function(r) {
    // IMPORTANT: C is Discord USER ID, E is Discord CHANNEL ID.
    var name = String(r[3] || r[0] || '').trim().normalize('NFC').toUpperCase();
    if (name && !seen[name]) {
      seen[name] = true;
      result.push({ name: name, discordUserId: String(r[2] || '').trim(), channelId: String(r[4] || '').trim() });
    }
  });
  return result;
}
function markAnalyticsDirty() {
  try { PropertiesService.getScriptProperties().setProperty('ANALYTICS_DIRTY', '1'); }
  catch (err) { console.error('Unable to flag analytics refresh:', err); }
}
function apiLock(fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) return apiFailure('Another operation is running, retry', 'BUSY');
  try { return fn(); }
  finally { lock.releaseLock(); }
}
function canonicalDesigner(input) {
  var name = String(input || '').trim().normalize('NFC');
  var list = getDesignersWithChannels();
  var match = list.filter(function(d) { return d.name.normalize('NFC').toUpperCase() === name.toUpperCase(); })[0];
  return match ? match.name : null;
}
function smartAssignTask(requestId) {
  var task = getTaskById(requestId);
  if (!task.requestId) return task;
  var suggestion = (typeof suggestBestDesignerForBrand === 'function')
    ? suggestBestDesignerForBrand(task.brand) : '';
  var best = String(suggestion || '').split(' (')[0].trim();
  if (!best) return apiFailure('No designer available', 'NO_DESIGNER');
  var out = assignDesigner(requestId, best);
  out.suggestionDetail = suggestion;
  return out;
}
function assignDesigner(requestId, designer) {
  var selected = canonicalDesigner(designer);
  if (!selected) return apiFailure('Designer is not in SETTINGS', 'INVALID_DESIGNER');
  var result = apiLock(function() {
    var row = findTaskRow(requestId);
    if (!row) return apiFailure('Task not found', 'TASK_NOT_FOUND');
    var sh = getTaskSheet();
    var previous = String(sh.getRange(row, COL.DESIGNER).getValue() || '').trim();
    var currentStatus = String(sh.getRange(row, COL.STATUS).getValue() || '').trim();
    if (previous) {
      if (previous.normalize('NFC').toUpperCase() === selected.toUpperCase())
        return { success: true, changed: false, designer: previous, status: currentStatus };
      return apiFailure('Task already assigned to ' + previous + '; reassign only from master Sheet', 'ASSIGN_CONFLICT');
    }
    if (currentStatus && currentStatus !== 'New')
      return apiFailure('Cannot assign task in status ' + currentStatus, 'INVALID_TRANSITION');
    var now = new Date();
    sh.getRange(row, COL.DESIGNER, 1, 2).setValues([[selected, 'Assigned']]);
    sh.getRange(row, COL.ASSIGNED_DATE).setValue(now);
    sh.getRange(row, COL.LAST_UPDATE).setValue(now);
    SpreadsheetApp.flush();
    return { success: true, changed: true, designer: selected, status: 'Assigned' };
  });
  if (result.success && result.changed) {
    try { dispatchToDesigner(getSpreadsheet(), requestId); } catch (err) { result.warning = 'DESIGNER_SHEET_SYNC_FAILED'; console.error(err); }
    try { if (typeof writeLog === 'function') writeLog('Assign Designer (Discord)', requestId, result.designer); } catch (ignored) {}
    markAnalyticsDirty(); // heavy dashboard rebuild moved outside API response path
  }
  return result;
}

var DISCORD_STATUS_NEXT = {
  'New': [], 'Assigned': ['Doing'], 'Doing': ['Review'],
  'Review': ['Revision', 'Done'], 'Revision': ['Doing', 'Review'],
  'Done': [], 'Cancelled': []
};
function updateStatus(requestId, rawStatus) {
  var target = String(rawStatus || '').trim();
  if (target === 'In Progress') target = 'Doing';
  if (!Object.prototype.hasOwnProperty.call(DISCORD_STATUS_NEXT, target))
    return apiFailure('Unsupported status', 'INVALID_STATUS');
  var result = apiLock(function() {
    var row = findTaskRow(requestId);
    if (!row) return apiFailure('Task not found', 'TASK_NOT_FOUND');
    var sh = getTaskSheet();
    var current = String(sh.getRange(row, COL.STATUS).getValue() || 'New').trim();
    if (current === 'In Progress') current = 'Doing';
    if (current === target) return { success: true, changed: false, status: target, round: sh.getRange(row, COL.ROUND).getValue() };
    var allowed = DISCORD_STATUS_NEXT[current] || [];
    if (allowed.indexOf(target) < 0) return apiFailure('Transition ' + current + ' -> ' + target + ' is not allowed', 'INVALID_TRANSITION');
    if (!String(sh.getRange(row, COL.DESIGNER).getValue() || '').trim())
      return apiFailure('Task has no assigned designer', 'UNASSIGNED_TASK');
    var now = new Date();
    var updatedRound = sh.getRange(row, COL.ROUND).getValue();
    if (target === 'Revision') updatedRound = getNextRoundText(updatedRound);
    sh.getRange(row, COL.STATUS).setValue(target);
    if (target === 'Revision') sh.getRange(row, COL.ROUND).setValue(updatedRound);
    if (target === 'Doing' && !sh.getRange(row, COL.START_TIME).getValue()) sh.getRange(row, COL.START_TIME).setValue(now);
    if (target === 'Review') sh.getRange(row, COL.REVIEW_TIME).setValue(now);
    if (target === 'Done') sh.getRange(row, COL.DONE_TIME).setValue(now);
    sh.getRange(row, COL.LAST_UPDATE).setValue(now);
    SpreadsheetApp.flush();
    return { success: true, changed: true, status: target, round: updatedRound };
  });
  if (result.success && result.changed) {
    try { dispatchToDesigner(getSpreadsheet(), requestId); } catch (err) { result.warning = 'DESIGNER_SHEET_SYNC_FAILED'; console.error(err); }
    try { if (typeof writeLog === 'function') writeLog('Update Status (Discord)', requestId, result.status); } catch (ignored) {}
    markAnalyticsDirty(); // heavy dashboard rebuild moved outside API response path
  }
  return result;
}

// Claim first, SEND second, finalize last. Uncertain sends remain POSTING for reconciliation.
var DISCORD_SYNC_CONTRACT_VERSION = 'SYNC-SAFETY-03A/1';
var DISCORD_CLAIM_PREFIX = 'DISCORD_SYNC_CLAIM_';

function getDiscordSyncContract() {
  return {
    success: true,
    version: DISCORD_SYNC_CONTRACT_VERSION,
    claimId: true,
    fencing: true,
    postingNoRetry: true,
    idempotentDiscordInfo: true,
    claimStorage: 'SCRIPT_PROPERTIES'
  };
}
function discordClaimKey(requestId) {
  var normalized = String(requestId || '').trim().toUpperCase();
  if (!normalized) throw new Error('INVALID_REQUEST_ID');
  var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, normalized);
  return DISCORD_CLAIM_PREFIX + Utilities.base64EncodeWebSafe(digest).replace(/=+$/, '');
}
function readDiscordClaim(requestId) {
  var raw = PropertiesService.getScriptProperties().getProperty(discordClaimKey(requestId));
  if (!raw) return null;
  try {
    var record = JSON.parse(raw);
    return record && record.claimId ? record : null;
  } catch (ignored) {
    return null;
  }
}
function getDiscordClaimId(requestId) {
  var record = readDiscordClaim(requestId);
  return record ? String(record.claimId) : '';
}
function newDiscordClaimId() {
  return Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
}

function claimDiscordSync(requestId) {
  return apiLock(function() {
    var row = findTaskRow(requestId);
    if (!row) return apiFailure('Task not found', 'TASK_NOT_FOUND');
    var sh = getTaskSheet();
    var record = sh.getRange(row, COL.MESSAGE_ID, 1, 7).getValues()[0];
    var msgId = String(record[0] || '');
    var state = String(record[5] || '').trim().toUpperCase();
    if (msgId || state === 'SYNCED')
      return { success: true, claimed: false, reason: 'ALREADY_SENT', messageId: msgId };

    var props = PropertiesService.getScriptProperties();
    var key = discordClaimKey(requestId);
    var existing = props.getProperty(key);
    // Any property value, including malformed data, is a durable stop marker.
    if (existing || state === 'POSTING' || state === 'RECONCILE_REQUIRED')
      return { success: true, claimed: false, reason: 'NEEDS_RECONCILIATION' };

    var claimId = newDiscordClaimId();
    // Property first: if the later Sheet write is uncertain, the durable marker
    // still prevents a second claim after an exception or process restart.
    props.setProperty(key, JSON.stringify({
      claimId: claimId,
      requestId: String(requestId),
      createdAt: new Date().toISOString()
    }));
    sh.getRange(row, COL.SYNC_STATUS).setValue('POSTING');
    sh.getRange(row, COL.LAST_UPDATE).setValue(new Date());
    SpreadsheetApp.flush();
    return { success: true, claimed: true, claimId: claimId };
  });
}
function saveDiscordInfo(data) {
  var msgId = String(data.messageId || '').trim();
  var channelId = String(data.channelId || '').trim();
  var suppliedClaimId = String(data.claimId || '').trim();
  if (!/^\d{15,22}$/.test(msgId) || !/^\d{15,22}$/.test(channelId))
    return apiFailure('Invalid Discord message/channel ID', 'INVALID_DISCORD_INFO');

  var result = apiLock(function() {
    var row = findTaskRow(data.requestId);
    if (!row) return apiFailure('Task not found', 'TASK_NOT_FOUND');
    var sh = getTaskSheet();
    var old = sh.getRange(row, COL.MESSAGE_ID, 1, 7).getValues()[0];
    var oldMessageId = String(old[0] || '');
    if (oldMessageId && oldMessageId !== msgId)
      return apiFailure('Different Discord message already registered', 'MESSAGE_CONFLICT');
    if (oldMessageId === msgId)
      return { success: true, changed: false, idempotent: true };

    var expectedClaimId = getDiscordClaimId(data.requestId);
    var state = String(old[5] || '').trim().toUpperCase();
    if (!expectedClaimId || suppliedClaimId !== expectedClaimId || state !== 'POSTING')
      return apiFailure('Claim is missing, stale, or not POSTING', 'CLAIM_CONFLICT');

    sh.getRange(row, COL.MESSAGE_ID, 1, 7).setValues([[
      msgId, channelId, String(data.threadId || old[2] || ''),
      String(data.messageUrl || old[3] || ''), String(data.threadUrl || old[4] || ''),
      'SYNCED', new Date()
    ]]);
    SpreadsheetApp.flush();
    // Delete last: a failure here leaves an orphan stop marker, while the
    // already stored Message ID makes retries idempotent and conflicts visible.
    PropertiesService.getScriptProperties().deleteProperty(discordClaimKey(data.requestId));
    return { success: true, changed: true };
  });
  if (result.success && result.changed) {
    try { dispatchToDesigner(getSpreadsheet(), data.requestId); }
    catch (err) { result.warning = 'DESIGNER_SHEET_SYNC_FAILED'; console.error(err); }
  }
  return result;
}

