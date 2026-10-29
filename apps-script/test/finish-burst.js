'use strict';
/*
 * Finish-burst run for the deployed receiver (apps-script/Code.gs): a class pressing Finish
 * session together (WO-98). Node.js 18 or later (built-in fetch), no packages. From the repository:
 *
 *   node apps-script/test/finish-burst.js <exec-url> [clients=40]
 *
 * Each simulated client is one player in test mode, with a code from T940-T979 and its own
 * session UUID. Every client presses Finish at a random moment within the same 5 s and posts
 * what the game posts then: one batch holding a session start row, two progress rows and the
 * finish row, shaped like the game's rows (docs/data-dictionary.md, schema 1), each repeating
 * the post's fields, as text/plain JSON.
 *
 * A client retries as the game does since WO-98: after a busy or server reply, an HTTP error,
 * no reply within the game's 20 s request timeout, or a reply that is not the receiver's, it
 * waits 5 s doubling, times 0.5-1.5, never more than 20 s, and resends the same batch (the
 * receiver drops a batch it already stored). It stops when the receiver acknowledges the batch,
 * refuses it (retry:false; the game keeps such rows for "Download my data"), or 10 minutes
 * after its Finish (the game itself never gives up).
 *
 * It prints the rows acknowledged within 30 s, 60 s and 120 s of each client's Finish and by the
 * end, the share of finish rows acknowledged within 120 s (from then on the game would offer
 * "Download my data" to a player whose post still fails), the latency per post, the retries by
 * reason, and any loss: rows never acknowledged, each with the receiver's last reply.
 *
 * Safety: it posts only to a https://script.google.com/macros/s/<id>/exec URL and only in test
 * mode, so its rows go to the test_ tabs, with the build label "finish-burst". It never prints
 * the URL.
 */

const crypto = require('crypto');

const USAGE = 'usage: node finish-burst.js <exec-url> [clients=40]';
const EXEC_URL = /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/;
const MODE = 'test'; // never study or tryout
const BUILD = 'finish-burst';
const FIRST_CODE = 940; // codes T940-T979
const MAX_CLIENTS = 40;
const WINDOW_MS = 5000; // every client presses Finish within the same 5 s
const REQUEST_TIMEOUT_MS = 20000; // the game's request timeout (AppsScriptSink)
const GIVE_UP_MS = 600000;
const MARKS_S = [30, 60, 120];
const OFFER_S = 120; // the game's wait before it may offer "Download my data" (WO-98)
const POST_FIELDS = ['schema', 'mode', 'build', 'code', 'session'];
// The rows a short session still holds at Finish, as the game makes them (kind first).
const ROWS = [
  { kind: 'session', phase: 'start', platform: 'web', browser: 'chrome', screen: '1280x800', first_visit: true, intro_seen: false },
  { kind: 'progress', node: 'three_crews', action: 'complete', seconds: 95 },
  { kind: 'progress', node: 'bar_chart', action: 'complete', seconds: 142, attempts: 2 },
  { kind: 'session', phase: 'finish', seconds: 300, nodes_completed: 2, runs: 0, pending: 3, downloaded: false },
];

/** The URL, or null unless it is exactly https://script.google.com/macros/s/<id>/exec. */
function execUrl(text) {
  return typeof text === 'string' && EXEC_URL.test(text) ? text : null;
}

/** Simulated player number `index` (0-39): code T940 + index and its own session. */
function makeClient(index) {
  return { code: 'T' + (FIRST_CODE + index), session: crypto.randomUUID() };
}

/** The batch the client posts at Finish, made at `now`: the post's fields, then the four rows. */
function makePost(client, now) {
  const time = stamp(now);
  const post = {
    schema: 1,
    mode: MODE,
    build: BUILD,
    code: client.code,
    session: client.session,
    batch: crypto.randomUUID(),
    sent_at: time,
    rows: [],
  };
  ROWS.forEach((fields, i) => {
    const row = { kind: fields.kind, row_seq: i + 1, client_time: time };
    POST_FIELDS.forEach(name => {
      row[name] = post[name];
    });
    Object.keys(fields).forEach(name => {
      if (name !== 'kind') row[name] = fields[name];
    });
    post.rows.push(row);
  });
  return post;
}

/** The game's wait before retry `attempt` (0 first) since WO-98: 5 s doubling, times 0.5-1.5, at most 20 s. */
function backoffMs(attempt, random) {
  const base = Math.min(5 * Math.pow(2, attempt), 20);
  return Math.min(base * (0.5 + random), 20) * 1000;
}

/**
 * Reads one HTTP reply the way the game does (AppsScriptSink.ParseReply since WO-98): result is
 * 'ok' (acknowledged), 'refused' (retry:false) or 'retry'; ok:false without retry:false retries.
 */
function classify(status, text) {
  if (status < 200 || status > 299) return { result: 'retry', reason: 'http ' + status, reply: 'HTTP ' + status + ' ' + oneLine(text) };
  let reply = null;
  try {
    reply = JSON.parse(text);
  } catch (err) {
    // An error page, not the receiver's reply.
  }
  if (!reply || typeof reply !== 'object' || Array.isArray(reply)) {
    return { result: 'retry', reason: 'invalid_reply', reply: 'HTTP ' + status + ' ' + oneLine(text) };
  }
  if (reply.ok === true) return { result: 'ok', duplicate: reply.duplicate === true, reply: oneLine(text) };
  if (reply.retry !== true && !reply.error) return { result: 'retry', reason: 'invalid_reply', reply: oneLine(text) };
  if (reply.retry === false) return { result: 'refused', reason: String(reply.error), reply: oneLine(text) };
  return { result: 'retry', reason: String(reply.error || 'not ok'), reply: oneLine(text) };
}

/** One HTTP try with the game's timeout. */
async function tryPost(url, body) {
  let status;
  let text;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    status = response.status;
    text = await response.text();
  } catch (err) {
    if (err && err.name === 'TimeoutError') return { result: 'retry', reason: 'timeout', reply: 'no reply within ' + REQUEST_TIMEOUT_MS / 1000 + ' s' };
    return { result: 'retry', reason: 'network', reply: describeError(err) };
  }
  return classify(status, text);
}

/** One player: presses Finish `offsetMs` into the burst, then posts and retries as the game does. */
async function finishSession(url, client, offsetMs, burstStart) {
  await sleep(offsetMs);
  const finishedAt = performance.now();
  const post = makePost(client, new Date());
  if (post.mode !== MODE || post.rows.some(row => row.mode !== MODE)) throw new Error('refused: only test mode is sent');
  // The game builds a batch's body once and resends it unchanged.
  const body = JSON.stringify(post);
  const retries = [];
  for (let attempt = 0; ; attempt++) {
    const last = await tryPost(url, body);
    const ms = performance.now() - finishedAt;
    const result = { code: client.code, rows: post.rows.length, finish: finishedAt - burstStart, ms: ms, tries: attempt + 1, retries: retries, last: last };
    if (last.result !== 'retry') return result;
    retries.push(last.reason);
    const wait = backoffMs(attempt, Math.random());
    if (ms + wait > GIVE_UP_MS) {
      result.last = { result: 'gave up', reason: last.reason, reply: last.reply };
      return result;
    }
    await sleep(wait);
  }
}

function report(results) {
  const total = results.reduce((n, r) => n + r.rows, 0);
  const acked = results.filter(r => r.last.result === 'ok');
  const rowsWithin = s => acked.filter(r => r.ms <= s * 1000).reduce((n, r) => n + r.rows, 0);
  const end = Math.max.apply(null, results.map(r => r.finish + r.ms));
  const ackedRows = acked.reduce((n, r) => n + r.rows, 0);
  const ms = acked.map(r => r.ms).sort((a, b) => a - b);
  const reasons = new Map();
  results.forEach(r => r.retries.forEach(reason => reasons.set(reason, (reasons.get(reason) || 0) + 1)));
  const retries = results.reduce((n, r) => n + r.retries.length, 0);
  const duplicates = acked.filter(r => r.last.duplicate).length;
  const lost = results.filter(r => r.last.result !== 'ok');
  const finishes = acked.filter(r => r.ms <= OFFER_S * 1000).length;

  console.log('');
  MARKS_S.forEach(s => {
    console.log('rows acknowledged within ' + s + ' s of Finish: ' + rowsWithin(s) + ' of ' + total + ' (' + share(rowsWithin(s), total) + ')');
  });
  console.log('rows acknowledged by the end: ' + ackedRows + ' of ' + total + ' (' + share(ackedRows, total) +
    '); the last answer came ' + seconds(end) + ' after the burst began');
  console.log('finish rows acknowledged within ' + OFFER_S + ' s: ' + finishes + ' of ' + results.length +
    ' (' + share(finishes, results.length) + ')');
  if (ms.length > 0) {
    console.log('latency per post, Finish to acknowledgment: p50 ' + seconds(percentile(ms, 50)) +
      ', p95 ' + seconds(percentile(ms, 95)) + ', max ' + seconds(ms[ms.length - 1]));
  }
  console.log('tries per post: max ' + Math.max.apply(null, results.map(r => r.tries)) + '; retries: ' + retries +
    (retries > 0 ? ' (' + Array.from(reasons, ([reason, n]) => reason + ' ' + n).join(', ') + ')' : ''));
  if (duplicates > 0) console.log('acknowledged as duplicates: ' + duplicates + ' (an earlier try had been stored)');
  console.log('loss: ' + lost.reduce((n, r) => n + r.rows, 0) + ' rows');
  lost.forEach(r => {
    console.log('  ' + r.code + ', ' + r.tries + (r.tries === 1 ? ' try' : ' tries') + ', ' + r.last.result + ': ' + r.last.reply);
  });
  console.log('result: ' + (lost.length === 0 ? 'no loss' : 'LOSS'));
  process.exitCode = lost.length === 0 ? 0 : 1;
}

async function main(args) {
  const url = execUrl(args[0]);
  const clients = count(args[1], 'clients', MAX_CLIENTS, MAX_CLIENTS);
  if (!url || clients === null || args.length > 2) {
    console.error(USAGE);
    if (args[0] !== undefined && !url) console.error('refused: the URL must be https://script.google.com/macros/s/<id>/exec');
    if (clients === null) console.error('clients is 1-' + MAX_CLIENTS + ' (codes T940-T979)');
    process.exitCode = 2;
    return;
  }
  if (typeof fetch !== 'function' || typeof AbortSignal.timeout !== 'function') {
    console.error('needs Node.js 18 or later (built-in fetch)');
    process.exitCode = 2;
    return;
  }
  const players = Array.from({ length: clients }, (_, i) => makeClient(i));
  console.log('finish burst: ' + clients + ' clients, codes ' + players[0].code + '-' + players[clients - 1].code +
    ', mode ' + MODE + ', build ' + BUILD + ', ' + ROWS.length + ' rows each, every Finish within ' + WINDOW_MS / 1000 + ' s');
  const burstStart = performance.now();
  const results = await Promise.all(players.map(player => finishSession(url, player, Math.random() * WINDOW_MS, burstStart)));
  report(results);
}

/** A whole number from 1 to max ("40" or "clients=40"), the fallback when absent, or null. */
function count(text, name, fallback, max) {
  if (text === undefined) return fallback;
  const match = new RegExp('^(?:' + name + '=)?([0-9]+)$').exec(text);
  const n = match ? Number(match[1]) : NaN;
  return n >= 1 && n <= max ? n : null;
}

function percentile(sorted, p) {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

function share(n, total) {
  return total === 0 ? '0%' : Math.round((100 * n) / total) + '%';
}

function describeError(err) {
  const cause = err && err.cause;
  return oneLine((cause && (cause.code || cause.message)) || (err && err.message) || err);
}

// Printed replies mask long tokens: a Google error page could quote the deployment id.
function oneLine(text) {
  const flat = String(text).replace(/\s+/g, ' ').replace(/[A-Za-z0-9_-]{40,}/g, '<id>').trim();
  return flat.length > 300 ? flat.slice(0, 300) + '...' : flat;
}

function seconds(ms) {
  return (ms / 1000).toFixed(1) + ' s';
}

function stamp(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { execUrl, makeClient, makePost, backoffMs, classify };

if (require.main === module) {
  main(process.argv.slice(2)).catch(err => {
    console.error(err && err.stack ? err.stack : String(err));
    process.exitCode = 1;
  });
}
