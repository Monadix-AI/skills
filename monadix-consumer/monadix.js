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
 * @param {string} apiPath - API path, e.g. '/network/match'
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
    var parsed;
    try { parsed = text ? JSON.parse(text) : null; } catch (_) { parsed = null; }
    var err = new Error('Monadix API error: ' + res.status + ' ' + text);
    err.status = res.status;
    err.body = parsed;
    throw err;
  }
  return res.json();
}

/**
 * Send a signed GET request to the Monadix API. Body is empty by definition.
 *
 * @param {string} apiPath
 * @returns {Promise<object>}
 */
async function getMonadix(apiPath) {
  var apiKey = loadKey('monadix.key');
  var signingKey = loadKey('monadix.signing-key');
  var timestamp = Date.now().toString();
  var signature = crypto.createHmac('sha256', signingKey)
    .update(timestamp + '.')
    .digest('hex');
  var res = await fetch('https://api.monadix.ai' + apiPath, {
    method: 'GET',
    headers: {
      'Authorization': 'Bearer ' + apiKey,
      'X-Monadix-Timestamp': timestamp,
      'X-Monadix-Signature': signature,
    },
  });
  var text = await res.text();
  var parsed;
  try { parsed = text ? JSON.parse(text) : {}; } catch (_) { parsed = {}; }
  if (!res.ok) {
    var err = new Error('Monadix API error: ' + res.status + ' ' + text);
    err.status = res.status;
    err.body = parsed;
    throw err;
  }
  return parsed;
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
    await callMonadix('/network/tasks/' + encodeURIComponent(taskId) + '/rate', { rating: rating });
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
// (delegateTask is defined below, after the conversation primitives.)

// ---------------------------------------------------------------------------
// Conversation primitives (v14)
// ---------------------------------------------------------------------------

var MAX_PUBLISH_ATTEMPTS = 3;

function genClientTurnId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

/**
 * Generic capped retry runner with mandatory status-check-before-retry.
 *
 * @param {string} taskId
 * @param {() => Promise<object>} attemptFn  - performs ONE call (publish or message)
 * @param {string} label                     - human label for log lines
 * @param {(snap: object) => 'retry'|'attached'|'abort'} canRetryOnStatus
 *        Decide what to do based on the persisted status snapshot:
 *          'retry'    — issue attemptFn again
 *          'attached' — server already moved on; do attemptFn once more to
 *                       re-attach to the existing wait or fetch cached result
 *          'abort'    — surface failure and stop
 * @returns {Promise<object|null>} the outcome from attemptFn, or null on failure
 */
async function runWithRetry(taskId, attemptFn, label, canRetryOnStatus) {
  var lastError = null;
  for (var attempt = 1; attempt <= MAX_PUBLISH_ATTEMPTS; attempt++) {
    try {
      return await attemptFn();
    } catch (err) {
      lastError = err;
      var status = err && err.status;
      if (status >= 400 && status < 500 && status !== 409) {
        console.log(label + ' failed with ' + status + ' — not retryable. ' + err.message);
        return null;
      }
      if (status === 409) {
        console.log(label + ' rejected by server cap (409). Aborting. ' + err.message);
        return null;
      }
      if (attempt === MAX_PUBLISH_ATTEMPTS) {
        console.log(label + ' failed after ' + attempt + ' attempts: ' + err.message);
        return null;
      }
      console.log(label + ' attempt ' + attempt + ' failed (' + (status || 'network') + '). Checking task status before retry...');
      try {
        var snap = await getMonadix('/network/tasks/' + encodeURIComponent(taskId) + '/status');
        var verdict = canRetryOnStatus(snap);
        if (verdict === 'abort') {
          console.log('Task is ' + snap.status + ' — not eligible for ' + label + ' retry. Aborting.');
          return null;
        }
        if (verdict === 'attached') {
          console.log('Task is ' + snap.status + ' server-side — re-issuing ' + label + ' to attach/fetch cached.');
        } else {
          console.log('Task is ' + snap.status + ' (attempt ' + (snap.dispatchAttemptCount || attempt) + '/' + MAX_PUBLISH_ATTEMPTS + ') — retrying.');
        }
      } catch (statusErr) {
        console.log('Status check failed: ' + statusErr.message + ' — retrying anyway.');
      }
    }
  }
  return lastError ? null : null;
}

/**
 * Publish a previously-reserved conversation draft. Idempotent.
 * Returns the publish outcome (`{task, status, result?, pendingPrompt?, usage?}`)
 * or null on terminal failure.
 *
 * @param {string} taskId
 */
async function publishConversation(taskId) {
  return runWithRetry(
    taskId,
    function () { return callMonadix('/network/conversations/' + encodeURIComponent(taskId) + '/publish'); },
    'Publish',
    function (snap) {
      if (snap.status === 'completed' || snap.status === 'failed') return 'attached';
      if (snap.status === 'awaiting_consumer') return 'attached';
      if (snap.status === 'pending' || snap.status === 'matched' || snap.status === 'executing') return 'attached';
      return 'retry'; // draft / failed (re-eligible)
    }
  );
}

/**
 * Send a single consumer follow-up message. Idempotent via clientTurnId —
 * always retry-safe with the same id.
 *
 * @param {string} taskId
 * @param {string|object} content
 * @param {string} [clientTurnId]
 */
async function respondToProvider(taskId, content, clientTurnId) {
  var turnId = clientTurnId || genClientTurnId();
  return runWithRetry(
    taskId,
    function () {
      return callMonadix(
        '/network/conversations/' + encodeURIComponent(taskId) + '/messages',
        { content: content, clientTurnId: turnId }
      );
    },
    'Message',
    function (snap) {
      // Same clientTurnId is always safe to resend; server will dedupe.
      if (snap.status === 'completed' || snap.status === 'failed') return 'attached';
      // executing means our message landed and the provider is working — re-POST returns the dedup'd outcome.
      if (snap.status === 'executing' || snap.status === 'matched') return 'attached';
      // awaiting_consumer means message hasn't landed yet OR provider asked again — safe to retry.
      if (snap.status === 'awaiting_consumer') return 'retry';
      return 'abort';
    }
  );
}

/**
 * Idempotently close a conversation. Safe to call multiple times.
 *
 * @param {string} taskId
 * @param {string} [reason]
 */
async function closeConversation(taskId, reason) {
  try {
    var body = reason ? { reason: reason } : {};
    return await callMonadix('/network/conversations/' + encodeURIComponent(taskId) + '/close', body);
  } catch (err) {
    return { error: String(err && err.message ? err.message : err) };
  }
}

/**
 * Full delegation workflow (step-by-step — pauses at each boundary):
 *   Step 1 — Match:        call the match API, print ranked providers
 *   Step 2 — Confirm:      ask the user to pick a provider (or cancel)
 *   Step 3 — Publish & drive multi-turn conversation:
 *              3a reserve a conversation id (no credits)
 *              3b publish & wait for first turn (credits debited)
 *              3c loop on awaiting_consumer — collect user reply, send back
 *   Step 4 — Show Results: print the provider's output and usage summary
 *   Step 5 — Rate:         offer the user a 1–5 star rating prompt
 *
 * @param {string} description   - Task description (max 2000 chars)
 * @param {object} [inputData]   - Optional structured input for the provider
 */
async function delegateTask(description, inputData) {
  // Step 1 — Match: find providers (no credits spent)
  console.log('Matching providers...');
  var matchData = await callMonadix('/network/match', { description: description, limit: 5 });
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

  if (answer.trim().toLowerCase() === 'cancel') {
    rl.close();
    console.log('Delegation cancelled.');
    return;
  }
  var idx = parseInt(answer.trim(), 10) - 1;
  if (isNaN(idx) || idx < 0 || idx >= matches.length) {
    rl.close();
    console.log('Invalid selection.');
    return;
  }
  var chosen = matches[idx];

  // Step 3a — Reserve a conversation id (no credits, no provider contacted).
  // NEVER call this twice for the same logical request.
  console.log('\nReserving conversation id for ' + chosen.provider.name + '...');
  var draftPayload = {
    description: description,
    preMatchedProviderId: chosen.provider.id,
    preMatchedScore: chosen.score,
    preMatchedCapabilityDescription: chosen.capability.description,
  };
  if (inputData !== undefined) {
    draftPayload.input = inputData;
  }
  var draft = await callMonadix('/network/conversations/draft', draftPayload);
  var taskId = draft.task.id;
  console.log('Conversation reserved: ' + taskId + '. Publishing...');

  // Step 3b — Publish & wait for the first turn.
  var outcome = await publishConversation(taskId);

  // Step 3c — Reply loop. Continues until terminal (completed/failed) or
  // until publish/message returns null (terminal failure inside the helper).
  while (outcome && outcome.status === 'awaiting_consumer') {
    var prompt_ = outcome.pendingPrompt || {};
    console.log('\n[Provider needs input]');
    console.log('Question: ' + (prompt_.question || '(no question text)'));
    if (prompt_.schema) {
      console.log('Expected shape: ' + JSON.stringify(prompt_.schema));
    }
    var userReply = await prompt(rl, 'Your reply (or "abort"): ');
    if (userReply.trim().toLowerCase() === 'abort') {
      console.log('Aborting conversation...');
      await closeConversation(taskId, 'User aborted from helper.');
      rl.close();
      return;
    }
    outcome = await respondToProvider(taskId, userReply.trim(), genClientTurnId());
  }
  rl.close();

  if (!outcome) {
    console.log('\nDelegation failed (see logs above).');
    return;
  }

  // Step 4 — Show Results
  var task = outcome.task;
  if (outcome.status === 'completed') {
    console.log('\n[Step 4 — Results]');
    console.log('\nTask completed!');
    console.log('Output:', JSON.stringify(outcome.result, null, 2));
    if (outcome.usage) {
      console.log('Credits consumed: ' + outcome.usage.creditsConsumed);
    }

    // Step 5 — Rate (completed only)
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
    console.log('\nTask ' + outcome.status + '. Delegation did not succeed.');
  }
}

module.exports = {
  callMonadix: callMonadix,
  getMonadix: getMonadix,
  delegateTask: delegateTask,
  publishConversation: publishConversation,
  respondToProvider: respondToProvider,
  closeConversation: closeConversation,
  rateTask: rateTask,
};

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
