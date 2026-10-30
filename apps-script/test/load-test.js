'use strict';
/*
 * Load test for the deployed receiver (apps-script/Code.gs): a class finishing a run
 * together. Node.js 18 or later (built-in fetch), no packages. From the repository:
 *
 *   node apps-script/test/load-test.js <exec-url> [clients=40] [postsPerClient=3]
 *
 * Each simulated client is one player in test mode, with a code from T900-T999 and its
 * own session UUID. Each post has a new batch UUID (a retry resends the same batch, as
 * the game does) and 20 rows shaped like the game's (fixtures/client_post_w1.json, the
 * four kinds in turn), each repeating the post's fields. Posts are text/plain JSON.
 *
 * In each round every client posts at the same moment; the next round starts when all
 * are done. A post is retried as the game retries since W3 (docs/data-dictionary.md):
 * after a busy or server reply, any other ok:false without retry:false, an HTTP error,
 * a reply that is not JSON, or no reply within the game's 20 s request timeout, it
 * waits 5 s doubling, times 0.5-1.5, never more than 20 s, and resends the same batch.
 * It stops at once at a reply with retry:false, whose rows the game keeps for
 * "Download my data". The game never gives up; this run gives up on a post 10 minutes
 * after its first try.
 *
 * It prints the latency per post (first try to final reply: p50, p95, max), the retries
 * by reason, the posts acknowledged within 120 s of their first try, the rows
 * acknowledged, and any loss: each post never acknowledged, with the receiver's last
 * reply. A good result has no loss and every post acknowledged within 120 s, before the
 * game may offer "Download my data" to a player who pressed Finish session.
 *
 * Safety: it posts only to a https://script.google.com/macros/s/<id>/exec URL and only
 * in test mode, so its rows go to the test_ tabs, with the build label "load-test". It
 * never prints the URL.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const USAGE = 'usage: node load-test.js <exec-url> [clients=40] [postsPerClient=3]';
const EXEC_URL = /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/;
const MODE = 'test'; // never study or tryout
const BUILD = 'load-test';
const ROWS_PER_POST = 20;
const REQUEST_TIMEOUT_MS = 20000; // the game's request timeout (AppsScriptSink)
const GIVE_UP_MS = 600000; // the game never gives up; this run stops retrying a post after 10 min
const OFFER_S = 120; // the game's wait after Finish before it may offer "Download my data" (WO-98)
const POST_FIELDS = ['schema', 'mode', 'build', 'code', 'session'];
const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'client_post_w1.json'), 'utf8'));

/** The URL, or null unless it is exactly https://script.google.com/macros/s/<id>/exec. */
function execUrl(text) {
  return typeof text === 'string' && EXEC_URL.test(text) ? text : null;
}

/** Simulated player number `index` (0-99): code T900 + index and its own session. */
function makeClient(index) {
  return { code: 'T' + (900 + index), session: crypto.randomUUID(), nextSeq: 1 };
}

/** The client's next post: a new batch and 20 rows like the fixture's, each repeating the post's fields. */
function makePost(client) {
  const post = {
    schema: 1,
    mode: MODE,
    build: BUILD,
    code: client.code,
    session: client.session,
    batch: crypto.randomUUID(),
    sent_at: stamp(new Date()),
    rows: [],
  };
  for (let i = 0; i < ROWS_PER_POST; i++) {
    const row = Object.assign({}, FIXTURE.rows[i % FIXTURE.rows.length], {
      row_seq: client.nextSeq++,
      client_time: stamp(new Date()),
    });
    POST_FIELDS.forEach(name => {
      row[name] = post[name];
    });
    post.rows.push(row);
  }
  return post;
}

/** Sends one post, retrying as the game does, and resolves to what happened. */
async function send(url, client, round) {
  const post = makePost(client);
  const started = performance.now();
  const retries = [];
  for (let tries = 1; ; tries++) {
    post.sent_at = stamp(new Date());
    const last = await tryPost(url, post);
    const ms = performance.now() - started;
    const result = { code: client.code, round: round, ms: ms, tries: tries, retries: retries, last: last };
    if (last.result !== 'retry') return result;
    const wait = backoffMs(tries - 1);
    if (ms + wait > GIVE_UP_MS) {
      result.last = { result: 'gave up', reason: last.reason, reply: last.reply };
      return result;
    }
    retries.push(last.reason);
    await sleep(wait);
  }
}

/** One HTTP try. result is 'ok' (acknowledged), 'refused' (retry:false) or 'retry'. */
async function tryPost(url, post) {
  if (post.mode !== MODE || post.rows.some(row => row.mode !== MODE)) throw new Error('refused: only test mode is sent');
  let status;
  let text;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(post),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    status = response.status;
    text = await response.text();
  } catch (err) {
    return { result: 'retry', reason: err && err.name === 'TimeoutError' ? 'timeout' : 'network', reply: describeError(err) };
  }
  let reply = null;
  try {
    reply = JSON.parse(text);
  } catch (err) {
    // An error page, not the script's reply.
  }
  if (status < 200 || status > 299) return { result: 'retry', reason: 'http ' + status, reply: 'HTTP ' + status + ' ' + oneLine(text) };
  if (!reply || typeof reply !== 'object') return { result: 'retry', reason: 'not json', reply: 'HTTP ' + status + ' ' + oneLine(text) };
  if (reply.ok === true) return { result: 'ok', duplicate: reply.duplicate === true, reply: oneLine(text) };
  if (reply.retry === false) return { result: 'refused', reason: String(reply.error), reply: oneLine(text) };
  return { result: 'retry', reason: typeof reply.error === 'string' ? reply.error : 'not ok', reply: oneLine(text) };
}

function report(results, rowsSent) {
  const ms = results.map(r => r.ms).sort((a, b) => a - b);
  const reasons = new Map();
  results.forEach(r => r.retries.forEach(reason => reasons.set(reason, (reasons.get(reason) || 0) + 1)));
  const retries = results.reduce((n, r) => n + r.retries.length, 0);
  const acked = results.filter(r => r.last.result === 'ok');
  const duplicates = acked.filter(r => r.last.duplicate).length;
  const inTime = acked.filter(r => r.ms <= OFFER_S * 1000).length;
  const lost = results.filter(r => r.last.result !== 'ok');

  console.log('');
  console.log('latency per post, first try to final reply: p50 ' + seconds(percentile(ms, 50)) +
    ', p95 ' + seconds(percentile(ms, 95)) + ', max ' + seconds(ms[ms.length - 1]));
  console.log('retries: ' + retries +
    (retries > 0 ? ' (' + Array.from(reasons, ([reason, n]) => reason + ' ' + n).join(', ') + ')' : ''));
  console.log('posts acknowledged within ' + OFFER_S + ' s of their first try: ' + inTime + ' of ' + results.length);
  console.log('rows acknowledged: ' + acked.length * ROWS_PER_POST + ' of ' + rowsSent +
    (duplicates > 0 ? ' (' + duplicates + ' of the posts as duplicates: an earlier try had been stored)' : ''));
  console.log('loss: ' + lost.length * ROWS_PER_POST + ' rows');
  lost.slice(0, 20).forEach(r => {
    console.log('  ' + r.code + ' post ' + r.round + ', ' + r.tries + (r.tries === 1 ? ' try' : ' tries') + ', ' + r.last.result + ': ' + r.last.reply);
  });
  if (lost.length > 20) console.log('  ... and ' + (lost.length - 20) + ' more');
  const good = lost.length === 0 && inTime === results.length;
  console.log('result: ' + (good ? 'good' : 'NOT good') + ' (wanted: no loss, and every post acknowledged within ' + OFFER_S +
    ' s, before the game may offer "Download my data" at Finish)');
  process.exitCode = good ? 0 : 1;
}

async function main(args) {
  const url = execUrl(args[0]);
  const clients = count(args[1], 'clients', 40, 100);
  const postsPerClient = count(args[2], 'postsPerClient', 3, 10);
  if (!url || clients === null || postsPerClient === null || args.length > 3) {
    console.error(USAGE);
    if (args[0] !== undefined && !url) console.error('refused: the URL must be https://script.google.com/macros/s/<id>/exec');
    if (clients === null || postsPerClient === null) console.error('clients is 1-100 (codes T900-T999), postsPerClient 1-10');
    process.exitCode = 2;
    return;
  }
  if (typeof fetch !== 'function') {
    console.error('needs Node.js 18 or later (built-in fetch)');
    process.exitCode = 2;
    return;
  }
  const players = Array.from({ length: clients }, (_, i) => makeClient(i));
  console.log('load test: ' + clients + ' clients x ' + postsPerClient + ' posts x ' + ROWS_PER_POST + ' rows, mode ' + MODE +
    ', codes ' + players[0].code + '-' + players[clients - 1].code);
  const results = [];
  for (let round = 1; round <= postsPerClient; round++) {
    const started = performance.now();
    const done = await Promise.all(players.map(player => send(url, player, round)));
    results.push(...done);
    console.log('round ' + round + ' of ' + postsPerClient + ': ' + clients + ' posts in ' + seconds(performance.now() - started));
  }
  report(results, clients * postsPerClient * ROWS_PER_POST);
}

/** A whole number from 1 to max ("40" or "clients=40"), the fallback when absent, or null. */
function count(text, name, fallback, max) {
  if (text === undefined) return fallback;
  const match = new RegExp('^(?:' + name + '=)?([0-9]+)$').exec(text);
  const n = match ? Number(match[1]) : NaN;
  return n >= 1 && n <= max ? n : null;
}

/** The game's wait before retry `attempt` (0 first) since W3: 5 s doubling, times 0.5-1.5, never more than 20 s. */
function backoffMs(attempt) {
  return Math.min(Math.min(5 * Math.pow(2, attempt), 20) * (0.5 + Math.random()), 20) * 1000;
}

function percentile(sorted, p) {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

function describeError(err) {
  if (err && err.name === 'TimeoutError') return 'no reply within ' + REQUEST_TIMEOUT_MS / 1000 + ' s';
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

module.exports = { execUrl, makeClient, makePost };

if (require.main === module) {
  main(process.argv.slice(2)).catch(err => {
    console.error(err && err.stack ? err.stack : String(err));
    process.exitCode = 1;
  });
}
