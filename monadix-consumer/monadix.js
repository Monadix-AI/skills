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
 * Submit a 1-5 star rating for a previously completed task.
 * Returns null on success or a string error message on a 4xx soft failure.
 *
 * @param {string} taskId
 * @param {number} rating - integer 1..5
 * @returns {Promise<string|null>}
 */
async function rateTask(taskId, rating) {
  try {
    await callMonadix('/marketplace/tasks/' + encodeURIComponent(taskId) + '/rate', { rating: rating });
    return null;
  } catch (err) {
    return String(err && err.message ? err.message : err);
  }
}

/**
 * Full delegation workflow (step-by-step — pauses at each boundary):
 *   Step 1 — Match:        call the match API, print ranked providers
 *   Step 2 — Confirm:      ask the user to pick a provider (or cancel)
 *   Step 3 — Publish Task: publish to the chosen provider
 *   Step 4 — Show Results: print the provider's output and usage summary
 *   Step 5 — Rate:         offer the user a 1–5 star rating prompt
 *
 * @param {string} description   - Task description (max 2000 chars)
 * @param {object} [inputData]   - Optional structured input for the provider
 */
async function delegateTask(description, inputData) {
  // Step 1 — Match: find providers (no credits spent)
  console.log('Matching providers...');
  var matchData = await callMonadix('/marketplace/match', { description: description, limit: 5 });
  var matches = matchData.matches;
  if (!matches.length) {
    console.log('No providers available for this task.');
    return;
  }

  // --- PAUSE after Step 1: show results and wait for user selection ---
  console.log('\n[Step 1 complete — Match results]');
  console.log('\nFound ' + matches.length + ' provider(s):');
  matches.forEach(function (m, i) {
    console.log((i + 1) + '. ' + m.provider.name + ' (' + Math.round(m.score * 100) + '% match)');
    console.log('   Capability: ' + m.capability.description);
  });

  var rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  // Step 2 — Confirm: wait for the user to choose a provider
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

  // Step 3 — Publish Task: send to the chosen provider
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

  // Step 4 — Show Results
  var task = result.task;
  if (task.status === 'completed') {
    console.log('\n[Step 4 — Results]');
    console.log('\nTask completed!');
    console.log('Output:', JSON.stringify(result.result, null, 2));
    console.log('Credits consumed: ' + result.usage.creditsConsumed);

    // --- PAUSE after Step 4: show results, then ask for rating ---

    // Step 5 — Rate: offer a 1–5 star rating (skip on non-completed tasks)
    var rl2 = readline.createInterface({ input: process.stdin, output: process.stdout });
    var ratingAnswer = await prompt(rl2, '\n[Step 5 — Rate] Rate this provider (1–5, or "skip"): ');
    rl2.close();
    var rating = parseInt(String(ratingAnswer).trim(), 10);
    if (rating >= 1 && rating <= 5) {
      var err = await rateTask(task.id, rating);
      console.log(err ? 'Rating not recorded: ' + err : 'Rated ' + rating + '★');
    } else {
      console.log('Rating skipped.');
    }
  } else {
    console.log('\nTask ' + task.status + '. Delegation did not succeed.');
  }
}

module.exports = { callMonadix: callMonadix, delegateTask: delegateTask, rateTask: rateTask };

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
