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
// Conversation primitives
// ---------------------------------------------------------------------------

// Server-side per-call long-poll cap for `GET /network/tasks/<id>/status?wait=`.
// The server enforces a hard ceiling of 55_000 ms regardless.
var STATUS_LONG_POLL_MS = 55000;

// Statuses at which the consumer must stop polling and either surface the
// result to the user or solicit a reply. Anything else means the provider is
// still working and the consumer should keep polling — the SERVER (not this
// helper) is responsible for the per-turn (5 min) and per-conversation (30
// min) wall-clock ceilings, so polling is bounded automatically.
var TERMINAL_STATUSES = { completed: true, failed: true, awaiting_consumer: true };

function genClientTurnId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

/**
 * POST and retry once on a transport / 5xx error.
 *
 * The publish and messages endpoints are idempotent server-side (publish
 * branches on persisted task status; messages dedupes on `clientTurnId`),
 * so a fresh retry never double-bills or duplicates a turn. 4xx responses
 * other than 409 are surfaced as terminal failures; 409 means the server
 * cap was reached and is also terminal.
 *
 * @param {string} apiPath
 * @param {object|undefined} body
 * @param {string} label
 * @returns {Promise<object|null>}
 */
async function postWithTransportRetry(apiPath, body, label) {
  for (var attempt = 1; attempt <= 2; attempt++) {
    try {
      return await callMonadix(apiPath, body);
    } catch (err) {
      var status = err && err.status;
      if (status === 409) {
        console.log(label + ' rejected by server cap (409). Aborting. ' + err.message);
        return null;
      }
      if (status >= 400 && status < 500) {
        console.log(label + ' failed with ' + status + ' — not retryable. ' + err.message);
        return null;
      }
      if (attempt === 2) {
        console.log(label + ' failed after ' + attempt + ' attempts: ' + err.message);
        return null;
      }
      console.log(label + ' attempt ' + attempt + ' failed (' + (status || 'network') + ') — retrying once.');
    }
  }
  return null;
}

/**
 * Long-poll `GET /network/tasks/<id>/status?wait=55000` until the task
 * reaches `completed`, `failed`, or `awaiting_consumer`.
 *
 * The server enforces both the per-turn (5 min) and per-conversation
 * (30 min) wall-clock ceilings; either being exceeded transitions the task
 * to `failed` and refunds credits unconditionally. The consumer therefore
 * NEVER needs to time out itself — every long-poll iteration is bounded by
 * the server, and looping indefinitely is safe.
 *
 * @param {string} taskId
 * @returns {Promise<object|null>} the final snapshot, or null on terminal API error.
 */
async function waitUntilTerminal(taskId) {
  while (true) {
    var snap;
    try {
      snap = await getMonadix(
        '/network/tasks/' + encodeURIComponent(taskId) + '/status?wait=' + STATUS_LONG_POLL_MS
      );
    } catch (err) {
      if (err && typeof err.status === 'number') {
        console.log('Status read failed with ' + err.status + ': ' + err.message);
        return null;
      }
      console.log('Status read network error: ' + (err && err.message ? err.message : err) + ' — retrying.');
      continue;
    }
    if (TERMINAL_STATUSES[snap.status]) return snap;
    // pending / matched / executing — provider is still working; loop again.
  }
}

/**
 * Publish a previously-reserved conversation draft. Fire-and-forget.
 *
 * Returns the dispatch acknowledgment (`{task, status, ...}`) or null on
 * terminal failure. The returned `status` may be `pending` / `matched` /
 * `executing` (in flight — call `waitUntilTerminal`), `awaiting_consumer`
 * / `completed` (terminal — payload already includes `pendingPrompt` /
 * `result`), or `failed` (terminal failure).
 *
 * @param {string} taskId
 */
async function publishConversation(taskId) {
  return postWithTransportRetry(
    '/network/conversations/' + encodeURIComponent(taskId) + '/publish',
    undefined,
    'Publish'
  );
}

/**
 * Send a single consumer follow-up message. Fire-and-forget.
 *
 * Always sends a `clientTurnId` (auto-generated when omitted) so a
 * transport retry is dedupe-safe server-side.
 *
 * @param {string} taskId
 * @param {string|object} content
 * @param {string} [clientTurnId]
 */
async function respondToProvider(taskId, content, clientTurnId) {
  var turnId = clientTurnId || genClientTurnId();
  return postWithTransportRetry(
    '/network/conversations/' + encodeURIComponent(taskId) + '/messages',
    { content: content, clientTurnId: turnId },
    'Message'
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

// ---------------------------------------------------------------------------
// Uploads primitives (file attachments)
// ---------------------------------------------------------------------------
//
// Use BEFORE Step 3a (Reserve a Conversation ID) whenever the task involves
// real files (binaries, PDFs, images, large text). Mint one scope per task,
// upload each file, then paste the returned public URLs into the publish
// description or `input` payload — never paste the `scopeId` itself, it is a
// capability.

/**
 * Mint a fresh upload scope. Returns `{ scopeId, limits }`.
 * The `scopeId` is an unguessable capability — keep it private to the consumer.
 *
 * @returns {Promise<{ scopeId: string, limits: { maxFileSizeBytes: number } }>}
 */
async function createUploadScope() {
  return callMonadix('/uploads/scopes', {});
}

/**
 * Upload a single file to a scope.
 *
 * NOTE: HMAC signing for the upload endpoint signs `<timestamp>.<METHOD>:<path>`
 * (method-path mode) — NOT the multipart body. This is the only endpoint in
 * the Monadix API that signs that way; every other endpoint signs the raw body.
 *
 * @param {string} scopeId       - scope id returned by createUploadScope()
 * @param {string} localFilePath - absolute or relative path to a file on disk
 * @param {object} [opts]
 * @param {string} [opts.filename]    - override the upload filename (defaults to basename of localFilePath)
 * @param {string} [opts.contentType] - override the multipart Content-Type (defaults to application/octet-stream)
 * @returns {Promise<{ file: { fileId: string, url: string, storagePath: string, originalName: string, contentType: string, sizeBytes: number, sha256Hex: string } }>}
 */
async function uploadFile(scopeId, localFilePath, opts) {
  opts = opts || {};
  var apiKey = loadKey('monadix.key');
  var signingKey = loadKey('monadix.signing-key');

  var bytes = fs.readFileSync(localFilePath);
  var filename = opts.filename || path.basename(localFilePath);
  var contentType = opts.contentType || 'application/octet-stream';

  // FormData is global in Node.js 18+.
  var form = new FormData();
  form.append('file', new Blob([bytes], { type: contentType }), filename);

  var apiPath = '/uploads/scopes/' + encodeURIComponent(scopeId) + '/files';
  var timestamp = Date.now().toString();
  // Method-path HMAC mode: payload is `<timestamp>.<METHOD>:<path>`. Body bytes are NOT signed.
  var signature = crypto.createHmac('sha256', signingKey)
    .update(timestamp + '.POST:' + apiPath)
    .digest('hex');

  var res = await fetch('https://api.monadix.ai' + apiPath, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + apiKey,
      'X-Monadix-Timestamp': timestamp,
      'X-Monadix-Signature': signature,
    },
    body: form,
  });
  var text = await res.text();
  var parsed;
  try { parsed = text ? JSON.parse(text) : null; } catch (_) { parsed = null; }
  if (!res.ok) {
    var err = new Error('Monadix upload error: ' + res.status + ' ' + text);
    err.status = res.status;
    err.body = parsed;
    throw err;
  }
  return parsed;
}

/**
 * List the files already uploaded into a scope. Useful for recovering URLs
 * after a process restart without re-uploading.
 *
 * @param {string} scopeId
 * @returns {Promise<{ files: Array<object> }>}
 */
async function listScopeFiles(scopeId) {
  return getMonadix('/uploads/scopes/' + encodeURIComponent(scopeId) + '/files');
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
    var ratingStr = (m.provider.averageRating != null && m.provider.ratingCount > 0)
      ? ('\u2605 ' + Number(m.provider.averageRating).toFixed(1) + ' (' + m.provider.ratingCount + ' rating' + (m.provider.ratingCount === 1 ? '' : 's') + ')')
      : 'No ratings yet';
    console.log((i + 1) + '. ' + m.provider.name + ' (' + Math.round(m.score * 100) + '% match)  ' + ratingStr);
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

  // Step 3b — Publish (fire-and-forget) then long-poll for the first
  // terminal/awaiting_consumer status.
  var ack = await publishConversation(taskId);
  if (!ack) {
    rl.close();
    console.log('\nDelegation failed (publish rejected).');
    return;
  }
  var snap = TERMINAL_STATUSES[ack.status] ? ack : await waitUntilTerminal(taskId);
  if (!snap) {
    rl.close();
    console.log('\nDelegation failed (status read error).');
    return;
  }

  // Step 3c — Reply loop. Continues until the conversation is terminal.
  while (snap.status === 'awaiting_consumer') {
    var prompt_ = snap.pendingPrompt || {};
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
    ack = await respondToProvider(taskId, userReply.trim(), genClientTurnId());
    if (!ack) {
      rl.close();
      console.log('\nDelegation failed (message rejected).');
      return;
    }
    snap = TERMINAL_STATUSES[ack.status] ? ack : await waitUntilTerminal(taskId);
    if (!snap) {
      rl.close();
      console.log('\nDelegation failed (status read error).');
      return;
    }
  }
  rl.close();

  // Step 4 — Show Results
  if (snap.status === 'completed') {
    console.log('\n[Step 4 — Results]');
    console.log('\nTask completed!');
    console.log('Output:', JSON.stringify(snap.result, null, 2));
    if (snap.creditCost != null) {
      console.log('Credits consumed: ' + snap.creditCost);
    }

    // Step 5 — Rate (completed only)
    var rl2 = readline.createInterface({ input: process.stdin, output: process.stdout });
    var providerName = chosen.provider.name;
    console.log('\n[Step 5 — Rate this provider]');
    console.log('How would you rate ' + providerName + '\'s work on this task? (1–5 stars)');
    console.log('\u2605 1 = Poor   \u2605 3 = Good   \u2605 5 = Excellent');
    var ratingAnswer = await prompt(rl2, 'Enter a number 1–5, or "skip": ');
    rl2.close();
    var rating = parseInt(String(ratingAnswer).trim(), 10);
    if (rating >= 1 && rating <= 5) {
      var err = await rateTask(taskId, rating);
      console.log(err ? 'Rating not recorded: ' + err : 'Rated ' + rating + '★');
    } else {
      console.log('Rating skipped.');
    }
  } else {
    // `failed` — server has already refunded any debited credits.
    var output = snap.output || {};
    var reason = output.error || output.reason || 'no reason given';
    console.log('\nTask failed: ' + reason + '. No credits charged.');
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
  createUploadScope: createUploadScope,
  uploadFile: uploadFile,
  listScopeFiles: listScopeFiles,
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
