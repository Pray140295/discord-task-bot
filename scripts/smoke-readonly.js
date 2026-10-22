'use strict';

require('dotenv').config();
const axios = require('axios');

const CONTRACT_VERSION = 'SYNC-SAFETY-03A/1';
const required = ['GOOGLE_SCRIPT_URL', 'GOOGLE_SCRIPT_TOKEN', 'EXPECTED_GOOGLE_DEPLOYMENT_SUFFIX'];
const missing = required.filter(key => !String(process.env[key] || '').trim());
if (missing.length) throw new Error(`Missing smoke environment variables: ${missing.join(', ')}`);

const scriptUrl = String(process.env.GOOGLE_SCRIPT_URL);
const expectedSuffix = String(process.env.EXPECTED_GOOGLE_DEPLOYMENT_SUFFIX).trim();
const suffixMatch = scriptUrl.includes(`/s/${expectedSuffix}/`) || scriptUrl.endsWith(expectedSuffix);
if (!suffixMatch) throw new Error('GOOGLE_SCRIPT_URL deployment suffix mismatch');

async function main() {
  const result = {
    deploymentSuffixMatch: true,
    contractMatch: false,
    healthReachable: null
  };

  const contractResponse = await axios.post(scriptUrl, {
    action: 'syncContract',
    apiToken: process.env.GOOGLE_SCRIPT_TOKEN
  }, {
    timeout: 15000,
    maxRedirects: 5,
    headers: {'Content-Type': 'application/json'}
  });
  const contract = contractResponse.data;
  result.contractMatch = Boolean(
    contract && contract.version === CONTRACT_VERSION &&
    contract.claimId === true && contract.fencing === true &&
    contract.postingNoRetry === true && contract.idempotentDiscordInfo === true
  );
  if (!result.contractMatch) throw new Error('SYNC contract mismatch');

  const healthUrl = String(process.env.BOT_HEALTH_URL || '').trim();
  if (healthUrl) {
    const health = await axios.get(healthUrl, { timeout: 10000, maxRedirects: 2 });
    result.healthReachable = health.status >= 200 && health.status < 300;
  }

  // Only booleans are emitted. URLs, suffixes, tokens, and response payloads stay private.
  console.log(JSON.stringify(result));
}

main().catch(error => {
  console.error(`READ_ONLY_SMOKE_FAILED: ${error.message}`);
  process.exitCode = 1;
});

