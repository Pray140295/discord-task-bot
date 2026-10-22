/**
 * SYNC-SAFETY-03A candidate module. ISOLATED REVIEW COPY — DO NOT DEPLOY.
 *
 * Integrate these functions into the verified DiscordAPI.gs candidate and add:
 *   case 'syncContract': return jsonResponse(getDiscordSyncContract());
 *
 * Replace claimDiscordSync and saveDiscordInfo with the implementations below.
 * In getUnsyncedTasks and getTaskById, attach
 * task.claimId = getDiscordClaimId(task.requestId).
 * This stores fencing tokens in Script Properties, so it does not assume AF:AH
 * or change the current 31-column Sheet schema.
 */

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

function getDiscordClaimId(requestId) {
  var raw = PropertiesService.getScriptProperties().getProperty(discordClaimKey(requestId));
  if (!raw) return '';
  try { return String(JSON.parse(raw).claimId || ''); }
  catch (ignored) { return ''; }
}

function newDiscordClaimId() {
  return Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
}

// Requires the verified candidate's apiLock, findTaskRow, getTaskSheet, COL and apiFailure.
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
    if (existing || state === 'POSTING' || state === 'RECONCILE_REQUIRED')
      return { success: true, claimed: false, reason: 'NEEDS_RECONCILIATION' };

    var claimId = newDiscordClaimId();
    props.setProperty(key, JSON.stringify({ claimId: claimId, requestId: String(requestId), createdAt: new Date().toISOString() }));
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

    var props = PropertiesService.getScriptProperties();
    var key = discordClaimKey(data.requestId);
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
    props.deleteProperty(key);
    return { success: true, changed: true };
  });
  if (result.success && result.changed) {
    try { dispatchToDesigner(getSpreadsheet(), data.requestId); }
    catch (err) { result.warning = 'DESIGNER_SHEET_SYNC_FAILED'; console.error(err); }
  }
  return result;
}
