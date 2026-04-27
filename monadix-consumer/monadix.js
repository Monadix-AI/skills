/**
 * monadix.js — Monadix consumer helper (Node.js 18+, built-in modules only)
 *
 * Place this file alongside monadix.key and monadix.signing-key.
 * Run:  node monadix.js
 */

'use strict';

var crypto = require('crypto');
var fs = require('fs');
var readline = require('readline');
var path = require('path');

function loadKey(filename) {
  return fs.readFileSync(path.join(__dirname, filename), 'utf8').trim();
}

function prompt(rl, question) {
  return new Promise(function (resolve) {
    rl.question(question, resolve);
  });
}

/**
 * Send a signed POST request to the Monadix API.
 * Credentials are read fresh from disk on every call — never cached.
 *
 * @param {string} apiPath - API path, e.g. '/marketplace/match'
 * @param {object} body    - Request payload (will be JSON-serialised)
 * @returns {Promise<object>} Parsed JSON response body
 */
async function callMonadix(apiPath, body) {
  var apiKey = loadKey('monadix.key');
  var signingKey = loadKey('monadix.signing-key');
  var rawBody = body === undefined ? '' : JSON.stringify(body);
  var timestamp = Date.now().toString();
  var signature = crypto.createHmac('sha256', signingKey)
    .update(timestamp + '.' + rawBody)
    .digest('hex');
  var res = await fetch('https://api.monadix.ai' + apiPath, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + apiKey,
      'X-Monadix-Timestamp': timestamp,
      'X-Monadix-Signature': signature,
      'Content-Type': 'application/json',
    },
    body: rawBody || undefined,
  });
  if (!res.ok) {
    var text = await res.text();
    throw new Error('Monadix API error: ' + res.status + ' ' + text);
  }
  return res.json();
}

/**
 * Full five-step delegation workflow:
 *   Step 2 — match providers (no credits spent)
 *   Step 3 — present matches, ask user to confirm
 *   Step 4 — publish the task to the confirmed provider
 *   Step 5 — report the result
 *
 * @param {string} description   - Task description (max 2000 chars)
 * @param {object} [inputData]   - Optional structured input for the provider
 */
async function delegateTask(description, inputData) {
  // Step 2 — Match providers (no credits spent)
  console.log('Matching providers...');
  var matchData = await callMonadix('/marketplace/match', { description: description, limit: 5 });
  var matches = matchData.matches;
  if (!matches.length) {
    console.log('No providers available for this task.');
    return;
  }

  // Step 3 — Present matches and confirm
  console.log('\nFound ' + matches.length + ' provider(s):');
  matches.forEach(function (m, i) {
    console.log((i + 1) + '. ' + m.provider.name + ' (' + Math.round(m.score * 100) + '% match)');
    console.log('   Capability: ' + m.capability.description);
  });

  var rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  var answer = await prompt(rl, '\nWhich provider? (number or "cancel"): ');
  rl.close();

  if (answer.trim().toLowerCase() === 'cancel') {
    console.log('Delegation cancelled.');
    return;
  }
  var idx = parseInt(answer.trim(), 10) - 1;
  if (isNaN(idx) || idx < 0 || idx >= matches.length) {
    console.log('Invalid selection.');
    return;
  }
  var chosen = matches[idx];

  // Step 4 — Publish the task
  console.log('\nDelegating to ' + chosen.provider.name + '...');
  var payload = {
    description: description,
    preMatchedProviderId: chosen.provider.id,
    preMatchedScore: chosen.score,
    preMatchedCapabilityDescription: chosen.capability.description,
  };
  if (inputData !== undefined) {
    payload.input = inputData;
  }
  var result = await callMonadix('/marketplace/tasks', payload);

  // Step 5 — Handle the result
  var task = result.task;
  if (task.status === 'completed') {
    console.log('\nTask completed!');
    console.log('Output:', JSON.stringify(result.result.output, null, 2));
    console.log('Credits consumed: ' + result.usage.creditsConsumed);
  } else {
    console.log('\nTask ' + task.status + '. Delegation did not succeed.');
  }
}

module.exports = { callMonadix: callMonadix, delegateTask: delegateTask };

// Example invocation (runs when executed directly)
if (require.main === module) {
  delegateTask(
    'Summarise the key clauses of the attached contract and identify any unusual terms.',
    { contractText: '...' }
  ).catch(function (err) {
    console.error(err);
    process.exit(1);
  });
}
