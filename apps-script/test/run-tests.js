'use strict';
/*
 * Offline tests for apps-script/Code.gs. Plain Node.js, no packages:
 *
 *   node apps-script/test/run-tests.js
 *
 * Each test loads Code.gs into a fresh VM context whose globals are the in-memory
 * fakes from fakes.js, then calls doPost/doGet the way the web app runtime does.
 * The exit code is 0 when every test passes.
 */

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createServices, MimeType } = require('./fakes');

const CODE = fs.readFileSync(path.join(__dirname, '..', 'Code.gs'), 'utf8');
const SESSION = '8f0c2a6e-3b1d-4d7e-9a51-2f6c0b9d4e11';
const CLIENT_TIME = '2026-10-28T19:04:58Z';
const ISO_SECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const COMMON = ['kind', 'schema', 'mode', 'build', 'code', 'session', 'row_seq', 'client_time', 'server_time'];
const MAX_BODY_BYTES = 200 * 1024;

// ------------------------------------------------------------------ helpers

function makeEnv(options) {
  const env = createServices(options);
  env.context = vm.createContext(Object.assign({}, env.globals));
  vm.runInContext(CODE, env.context, { filename: 'Code.gs' });
  return env;
}

/** Calls doPost the way the web app runtime does: the body arrives as e.postData.contents. */
function post(env, payload) {
  const contents = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const length = Buffer.byteLength(contents, 'utf8');
  return readReply(env.context.doPost({
    postData: { contents: contents, type: 'text/plain', length: length, name: 'postData' },
    parameter: {},
    parameters: {},
    queryString: '',
    contentLength: length,
  }));
}

function get(env, parameter) {
  return readReply(env.context.doGet({ parameter: parameter, parameters: {}, queryString: '', contentLength: -1 }));
}

function readReply(output) {
  assert.strictEqual(output.getMimeType(), MimeType.JSON, 'replies are JSON');
  return JSON.parse(output.getContent());
}

let nextSeq = 1;
function row(kind, fields, extra) {
  return Object.assign({ kind: kind, row_seq: nextSeq++, client_time: CLIENT_TIME }, fields, extra);
}
const progressRow = extra => row('progress', { node: 'bars_to_lines', action: 'complete', seconds: 142 }, extra);
const sessionRow = extra => row('session', {
  phase: 'start', platform: 'web', browser: 'chrome', screen: '1920x1080', first_visit: true, intro_seen: false,
}, extra);
const runRow = extra => row('run', {
  run: 'c41e9a2b-0d3f-4b6e-8a17-5c2d9e0f1a3b', phase: 'end', level: 'L08', node: 'events_preparation',
  city: 'seoul', difficulty: 'normal', seed: 123456, outcome: 'won', day: 46, cost: 412500, budget: 450000,
  stars: 2, seconds: 615,
}, extra);
const eventRow = extra => row('event', { run: '', seq: 12, day: 9, type: 'planning_stop', detail: '{"crew":"PipeLaying"}' }, extra);

function body(overrides) {
  return Object.assign({
    schema: 1,
    mode: 'tryout',
    build: 'W1 2026-10-28',
    code: 'P042',
    session: SESSION,
    batch: crypto.randomUUID(),
    sent_at: '2026-10-28T19:05:12Z',
    rows: [progressRow()],
  }, overrides);
}

function without(object, key) {
  const copy = Object.assign({}, object);
  delete copy[key];
  return copy;
}

function fields(prefix, count) {
  const out = {};
  for (let i = 1; i <= count; i++) out[prefix + i] = i;
  return out;
}

/** A post whose JSON is exactly `target` UTF-8 bytes: 52 event rows, padded out in detail. */
function sizedBody(target) {
  const b = body({ rows: [] });
  for (let i = 1; i <= 52; i++) b.rows.push(eventRow({ row_seq: i, detail: '' }));
  const extra = target - Buffer.byteLength(JSON.stringify(b), 'utf8');
  b.rows.forEach((r, i) => {
    r.detail = 'x'.repeat(Math.floor(extra / 52) + (i < extra % 52 ? 1 : 0));
  });
  assert.strictEqual(Buffer.byteLength(JSON.stringify(b), 'utf8'), target);
  return b;
}

/** Over the limit in UTF-8 bytes (3 bytes per euro sign) while under it in characters. */
function utf8HeavyBody() {
  const text = JSON.stringify(body({ rows: Array.from({ length: 70 }, () => progressRow({ node: '\u20ac'.repeat(1000) })) }));
  assert.ok(text.length < MAX_BODY_BYTES && Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES);
  return text;
}

/** The codes tab as Bryan would type it: a header row, then one code per row. */
function addCodes(env, lines) {
  const sheet = env.spreadsheet.insertSheet('codes');
  sheet.getRange(1, 1, lines.length + 1, 2).setValues([['code', 'active']].concat(lines));
  return sheet;
}

function tab(env, name) {
  const sheet = env.spreadsheet.getSheetByName(name);
  assert.ok(sheet, 'tab "' + name + '" exists');
  return sheet;
}

function dataWrites(env, name) {
  return env.spreadsheet.writes.filter(w => w.sheet === name && w.row > 1);
}

function codeReads(env) {
  return env.spreadsheet.reads.filter(r => r.sheet === 'codes').length;
}

const tests = [];
function test(name, fn) {
  tests.push({ name: name, fn: fn });
}

// ------------------------------------------------------------------ appending

test('a valid tryout post appends to tryout_progress with a header row', () => {
  const env = makeEnv();
  const reply = post(env, body({ rows: [progressRow({ row_seq: 7 })] }));
  assert.deepStrictEqual(reply, { ok: true, appended: 1 });
  assert.deepStrictEqual(env.spreadsheet.sheetNames(), ['tryout_progress']);
  const sheet = tab(env, 'tryout_progress');
  assert.deepStrictEqual(sheet.header(), COMMON.concat(['node', 'action', 'seconds']));
  const records = sheet.records();
  assert.strictEqual(records.length, 1);
  assert.match(records[0].server_time, ISO_SECONDS);
  assert.deepStrictEqual(Object.assign({}, records[0], { server_time: 'checked' }), {
    kind: 'progress', schema: 1, mode: 'tryout', build: 'W1 2026-10-28', code: 'P042', session: SESSION,
    row_seq: 7, client_time: CLIENT_TIME, server_time: 'checked', node: 'bars_to_lines', action: 'complete', seconds: 142,
  });
  assert.strictEqual(env.stats.flushes, 1);
  assert.strictEqual(env.locks.held, false);
});

test('a new tab puts the common fields first, then the others in arrival order', () => {
  const env = makeEnv();
  post(env, body({ rows: [
    { node: 'bar_chart', action: 'open', client_time: CLIENT_TIME, row_seq: 1, kind: 'progress' },
    { kind: 'progress', row_seq: 2, client_time: CLIENT_TIME, level: 'L08', node: 'bar_chart', attempts: 2 },
  ] }));
  assert.deepStrictEqual(tab(env, 'tryout_progress').header(), COMMON.concat(['node', 'action', 'level', 'attempts']));
});

test('the code is stored upper-case', () => {
  const env = makeEnv();
  post(env, body({ code: 'p042' }));
  assert.strictEqual(tab(env, 'tryout_progress').records()[0].code, 'P042');
});

test('the post-level fields are copied onto every row', () => {
  const env = makeEnv();
  post(env, body({ rows: [progressRow(), progressRow(), progressRow()] }));
  const records = tab(env, 'tryout_progress').records();
  assert.strictEqual(records.length, 3);
  records.forEach(r => {
    assert.deepStrictEqual([r.schema, r.mode, r.build, r.code, r.session], [1, 'tryout', 'W1 2026-10-28', 'P042', SESSION]);
  });
});

test('a new field adds a column on the right', () => {
  const env = makeEnv();
  post(env, body());
  assert.deepStrictEqual(post(env, body({ rows: [progressRow({ attempts: 2 })] })), { ok: true, appended: 1 });
  const sheet = tab(env, 'tryout_progress');
  assert.deepStrictEqual(sheet.header(), COMMON.concat(['node', 'action', 'seconds', 'attempts']));
  const records = sheet.records();
  assert.strictEqual(records[0].attempts, '');
  assert.strictEqual(records[1].attempts, 2);
});

test('rows are matched to columns by header name in a tab made by hand', () => {
  const env = makeEnv();
  env.spreadsheet.insertSheet('tryout_progress').getRange(1, 1, 1, 4).setValues([['seconds', 'code', 'kind', 'node']]);
  post(env, body());
  const sheet = tab(env, 'tryout_progress');
  assert.deepStrictEqual(sheet.header(), [
    'seconds', 'code', 'kind', 'node', 'schema', 'mode', 'build', 'session', 'row_seq', 'client_time', 'server_time', 'action',
  ]);
  const r = sheet.records()[0];
  assert.deepStrictEqual([r.seconds, r.code, r.kind, r.node, r.action], [142, 'P042', 'progress', 'bars_to_lines', 'complete']);
});

test('rows of each kind go to their own tab, with one data write per tab', () => {
  const env = makeEnv();
  const reply = post(env, body({ rows: [sessionRow(), progressRow(), runRow(), eventRow(), progressRow()] }));
  assert.deepStrictEqual(reply, { ok: true, appended: 5 });
  assert.deepStrictEqual(env.spreadsheet.sheetNames(), ['tryout_sessions', 'tryout_progress', 'tryout_runs', 'tryout_events']);
  env.spreadsheet.sheetNames().forEach(name => assert.strictEqual(dataWrites(env, name).length, 1, name));
  assert.strictEqual(tab(env, 'tryout_progress').records().length, 2);
  const run = tab(env, 'tryout_runs').records()[0];
  assert.deepStrictEqual([run.kind, run.seed, run.cost, run.outcome], ['run', 123456, 412500, 'won']);
  const event = tab(env, 'tryout_events').records()[0];
  assert.deepStrictEqual([event.kind, event.type, event.detail, event.run], ['event', 'planning_stop', '{"crew":"PipeLaying"}', '']);
});

test('test mode writes to test_ tabs', () => {
  const env = makeEnv();
  assert.deepStrictEqual(post(env, body({ mode: 'test', rows: [sessionRow(), eventRow()] })), { ok: true, appended: 2 });
  assert.deepStrictEqual(env.spreadsheet.sheetNames(), ['test_sessions', 'test_events']);
});

test('text stays text: no formulas, no conversion to numbers or booleans', () => {
  const env = makeEnv();
  post(env, body({ rows: [
    eventRow({ type: '=IMPORTXML("https://example.com","//a")', run: '0123' }),
    progressRow({ node: 'TRUE', action: "'quoted", level: '+1', attempts: -3 }),
  ] }));
  assert.strictEqual(env.spreadsheet.formulas.length, 0);
  const event = tab(env, 'tryout_events').records()[0];
  assert.deepStrictEqual([event.type, event.run], ['=IMPORTXML("https://example.com","//a")', '0123']);
  const progress = tab(env, 'tryout_progress').records()[0];
  assert.deepStrictEqual([progress.node, progress.action, progress.level, progress.attempts], ['TRUE', "'quoted", '+1', -3]);
});

test('numbers and booleans keep their type; null becomes an empty cell', () => {
  const env = makeEnv();
  post(env, body({ rows: [sessionRow({ first_visit: true, intro_seen: false, seconds: 0, pending: null })] }));
  const sheet = tab(env, 'tryout_sessions');
  assert.ok(sheet.header().includes('pending'));
  const r = sheet.records()[0];
  assert.deepStrictEqual([r.first_visit, r.intro_seen, r.seconds, r.pending], [true, false, 0, '']);
});

test('a field named like a built-in property ("constructor") is stored like any other', () => {
  const env = makeEnv();
  assert.deepStrictEqual(post(env, body({ rows: [progressRow({ constructor: 'x' })] })), { ok: true, appended: 1 });
  const sheet = tab(env, 'tryout_progress');
  assert.deepStrictEqual(sheet.header(), COMMON.concat(['node', 'action', 'seconds', 'constructor']));
  assert.strictEqual(sheet.records()[0].constructor, 'x');
});

test('a tab grows past 26 columns', () => {
  const env = makeEnv();
  assert.deepStrictEqual(post(env, body({ rows: [progressRow(fields('f', 30))] })), { ok: true, appended: 1 });
  const sheet = tab(env, 'tryout_progress');
  assert.strictEqual(sheet.header().length, COMMON.length + 3 + 30);
  assert.ok(sheet.getMaxColumns() >= COMMON.length + 3 + 30);
  assert.strictEqual(sheet.records()[0].f30, 30);
});

test('a full tab grows past its last row', () => {
  const env = makeEnv();
  env.spreadsheet.insertSheet('tryout_progress').maxRows = 2;
  assert.deepStrictEqual(post(env, body({ rows: [progressRow(), progressRow(), progressRow()] })), { ok: true, appended: 3 });
  assert.deepStrictEqual(post(env, body()), { ok: true, appended: 1 });
  assert.strictEqual(tab(env, 'tryout_progress').records().length, 4);
});

test('100 rows in one post are accepted and written with one call', () => {
  const env = makeEnv();
  const rows = Array.from({ length: 100 }, () => progressRow());
  assert.deepStrictEqual(post(env, body({ rows: rows })), { ok: true, appended: 100 });
  assert.strictEqual(tab(env, 'tryout_progress').records().length, 100);
  assert.strictEqual(dataWrites(env, 'tryout_progress').length, 1);
});

test('limits are inclusive: 1000-char text, 4000-char detail, 40-char field name, 64 distinct fields', () => {
  const env = makeEnv();
  const rows = [progressRow({ node: 'x'.repeat(1000), ['a'.repeat(40)]: 1 }), eventRow({ detail: 'x'.repeat(4000) })];
  assert.deepStrictEqual(post(env, body({ rows: rows })), { ok: true, appended: 2 });
  assert.deepStrictEqual(post(env, body({ rows: [progressRow(fields('g', 58))] })), { ok: true, appended: 1 });
});

test('a body of exactly 200 KB (204800 bytes) is accepted', () => {
  const env = makeEnv();
  assert.deepStrictEqual(post(env, sizedBody(MAX_BODY_BYTES)), { ok: true, appended: 52 });
});

// ------------------------------------------------------------------ duplicates

test('a duplicate batch appends nothing', () => {
  const env = makeEnv();
  const b = body();
  assert.deepStrictEqual(post(env, b), { ok: true, appended: 1 });
  assert.deepStrictEqual(post(env, b), { ok: true, appended: 0, duplicate: true });
  assert.deepStrictEqual(post(env, Object.assign({}, b, { batch: b.batch.toUpperCase() })), { ok: true, appended: 0, duplicate: true });
  assert.strictEqual(tab(env, 'tryout_progress').records().length, 1);
  assert.deepStrictEqual(env.cache.puts.map(p => p.expirationInSeconds), [21600], 'batch ids are kept 6 h');
});

test('a copy appended while this request waited for the lock is caught under the lock', () => {
  const env = makeEnv();
  const b = body();
  let first;
  env.locks.onWait = () => {
    env.locks.onWait = null;
    first = post(env, b); // another request with the same batch gets the lock first
  };
  const second = post(env, b);
  assert.deepStrictEqual(first, { ok: true, appended: 1 });
  assert.deepStrictEqual(second, { ok: true, appended: 0, duplicate: true });
  assert.strictEqual(tab(env, 'tryout_progress').records().length, 1);
  assert.strictEqual(env.locks.held, false);
});

test('a retry after the 6-hour cache window is appended again (session + row_seq let analysis drop it)', () => {
  const env = makeEnv();
  const b = body();
  post(env, b);
  env.clock.now += (21600 + 1) * 1000;
  assert.deepStrictEqual(post(env, b), { ok: true, appended: 1 });
  const records = tab(env, 'tryout_progress').records();
  assert.strictEqual(records.length, 2);
  assert.deepStrictEqual([records[1].session, records[1].row_seq], [records[0].session, records[0].row_seq]);
});

// ------------------------------------------------------------------ study mode and codes

test('study mode with an active code goes to the study tab', () => {
  const env = makeEnv();
  addCodes(env, [['P042', 'TRUE'], ['P043', '']]);
  assert.deepStrictEqual(post(env, body({ mode: 'study' })), { ok: true, appended: 1 });
  assert.deepStrictEqual(post(env, body({ mode: 'study', code: 'p043' })), { ok: true, appended: 1 });
  assert.deepStrictEqual(env.spreadsheet.sheetNames(), ['codes', 'progress']);
  const sheet = tab(env, 'progress');
  assert.ok(!sheet.header().includes('target_tab'));
  assert.deepStrictEqual(sheet.records().map(r => [r.mode, r.code]), [['study', 'P042'], ['study', 'P043']]);
});

test('study mode with an unknown code goes to unmatched, with target_tab', () => {
  const env = makeEnv();
  addCodes(env, [['P042', 'TRUE']]);
  const reply = post(env, body({ mode: 'study', code: 'Q777', rows: [progressRow(), sessionRow()] }));
  assert.deepStrictEqual(reply, { ok: true, appended: 2 });
  assert.deepStrictEqual(env.spreadsheet.sheetNames(), ['codes', 'unmatched']);
  const sheet = tab(env, 'unmatched');
  assert.deepStrictEqual(sheet.header().slice(0, COMMON.length + 1), COMMON.concat(['target_tab']));
  const records = sheet.records();
  assert.deepStrictEqual(records.map(r => [r.kind, r.code, r.target_tab]), [['progress', 'Q777', 'progress'], ['session', 'Q777', 'sessions']]);
  assert.deepStrictEqual([records[0].node, records[1].platform], ['bars_to_lines', 'web']);
});

test('study mode with an inactive code goes to unmatched', () => {
  const env = makeEnv();
  addCodes(env, [['P042', 'FALSE']]);
  assert.deepStrictEqual(post(env, body({ mode: 'study' })), { ok: true, appended: 1 });
  assert.deepStrictEqual(env.spreadsheet.sheetNames(), ['codes', 'unmatched']);
  assert.strictEqual(tab(env, 'unmatched').records()[0].target_tab, 'progress');
});

test('study mode with no codes tab keeps the rows, in unmatched', () => {
  const env = makeEnv();
  assert.deepStrictEqual(post(env, body({ mode: 'study' })), { ok: true, appended: 1 });
  assert.deepStrictEqual(env.spreadsheet.sheetNames(), ['unmatched']);
});

test('tryout and test modes take any well-formed code without reading the codes tab', () => {
  const env = makeEnv();
  addCodes(env, [['P042', 'FALSE']]);
  assert.deepStrictEqual(post(env, body()), { ok: true, appended: 1 });
  assert.deepStrictEqual(post(env, body({ mode: 'test', code: 'ZZ9999' })), { ok: true, appended: 1 });
  assert.strictEqual(codeReads(env), 0);
  assert.deepStrictEqual(env.spreadsheet.sheetNames(), ['codes', 'tryout_progress', 'test_progress']);
});

test('codes tab: case and spaces are ignored, only TRUE or blank is active, a FALSE entry wins', () => {
  const env = makeEnv();
  addCodes(env, [[' p050 ', ''], ['P051', 'no'], ['P052', 'TRUE'], ['P052', 'FALSE'], ['P053', 1], ['P054', true]]);
  const known = code => get(env, { op: 'code', code: code }).known;
  assert.deepStrictEqual(['P050', 'P051', 'P052', 'P053', 'P054'].map(known), [true, false, false, false, true]);
});

test('codes tab columns are found by header name', () => {
  const env = makeEnv();
  env.spreadsheet.insertSheet('codes').getRange(1, 1, 3, 3).setValues([
    ['Active', 'Note', 'Code'],
    ['FALSE', 'pilot', 'P001'],
    ['', '', 'P002'],
  ]);
  assert.strictEqual(get(env, { op: 'code', code: 'P001' }).known, false);
  assert.strictEqual(get(env, { op: 'code', code: 'P002' }).known, true);
});

test('the code list is cached for 60 seconds', () => {
  const env = makeEnv();
  const codes = addCodes(env, [['P042', 'TRUE']]);
  post(env, body({ mode: 'study' }));
  codes.getRange(2, 2).setValues([[false]]); // the code is switched off in the Sheet
  post(env, body({ mode: 'study' })); // within 60 s the cached list still has it
  env.clock.now += 61 * 1000;
  post(env, body({ mode: 'study' })); // the list is read again: now inactive
  assert.strictEqual(tab(env, 'progress').records().length, 2);
  assert.strictEqual(tab(env, 'unmatched').records().length, 1);
  assert.strictEqual(codeReads(env), 2);
  assert.strictEqual(env.cache.puts.filter(p => p.expirationInSeconds === 60).length, 2);
});

// ------------------------------------------------------------------ invalid posts

const INVALID = [
  ['an empty body', () => '', 'empty body'],
  ['broken JSON', () => '{"schema":1,', 'bad json'],
  ['a body that is not an object', () => '[1,2,3]', 'body is not an object'],
  ['an unknown body field', () => body({ player: 'x' }), 'unknown body field'],
  ['schema 2', () => body({ schema: 2 }), 'unknown schema'],
  ['schema as text', () => body({ schema: '1' }), 'unknown schema'],
  ['a missing schema', () => without(body(), 'schema'), 'unknown schema'],
  ['mode off', () => body({ mode: 'off' }), 'bad mode'],
  ['a mode in capitals', () => body({ mode: 'Study' }), 'bad mode'],
  ['mode __proto__', () => body({ mode: '__proto__' }), 'bad mode'],
  ['a missing build', () => without(body(), 'build'), 'bad build'],
  ['a build that is not text', () => body({ build: 7 }), 'bad build'],
  ['a build over 1000 characters', () => body({ build: 'x'.repeat(1001) }), 'bad build'],
  ['bad code: a dash', () => body({ code: 'P-42' }), 'bad code'],
  ['bad code: four letters', () => body({ code: 'ABCD1' }), 'bad code'],
  ['bad code: five digits', () => body({ code: 'P12345' }), 'bad code'],
  ['bad code: digits only', () => body({ code: '042' }), 'bad code'],
  ['bad code: an email', () => body({ code: 'jane.doe@tamu.edu' }), 'bad code'],
  ['bad code: a name', () => body({ code: 'Jane' }), 'bad code'],
  ['bad code: padded', () => body({ code: ' P042' }), 'bad code'],
  ['bad code: a letter outside A-Z that upper-cases to S', () => body({ code: '\u017f42' }), 'bad code'],
  ['bad code: a number', () => body({ code: 42 }), 'bad code'],
  ['a missing code', () => without(body(), 'code'), 'bad code'],
  ['a session that is not a UUID', () => body({ session: 'not-a-uuid' }), 'bad session'],
  ['a batch that is not a UUID', () => body({ batch: '5d2b7f90' }), 'bad batch'],
  ['a missing batch', () => without(body(), 'batch'), 'bad batch'],
  ['sent_at that is not text', () => body({ sent_at: 1730142312 }), 'bad sent_at'],
  ['missing rows', () => without(body(), 'rows'), 'no rows'],
  ['zero rows', () => body({ rows: [] }), 'no rows'],
  ['rows that are not an array', () => body({ rows: { 0: progressRow() } }), 'no rows'],
  ['too many rows (101)', () => body({ rows: Array.from({ length: 101 }, () => progressRow()) }), 'too many rows'],
  ['a row that is an array', () => body({ rows: [[1, 2]] }), 'row is not an object'],
  ['a row that is null', () => body({ rows: [null] }), 'row is not an object'],
  ['an unknown kind', () => body({ rows: [progressRow({ kind: 'click' })] }), 'bad kind'],
  ['kind "constructor"', () => body({ rows: [progressRow({ kind: 'constructor' })] }), 'bad kind'],
  ['a kind in capitals', () => body({ rows: [progressRow({ kind: 'Progress' })] }), 'bad kind'],
  ['a missing kind', () => body({ rows: [without(progressRow(), 'kind')] }), 'bad kind'],
  ['row_seq 0', () => body({ rows: [progressRow({ row_seq: 0 })] }), 'bad row_seq'],
  ['a fractional row_seq', () => body({ rows: [progressRow({ row_seq: 1.5 })] }), 'bad row_seq'],
  ['row_seq as text', () => body({ rows: [progressRow({ row_seq: '7' })] }), 'bad row_seq'],
  ['a missing client_time', () => body({ rows: [without(progressRow(), 'client_time')] }), 'bad client_time'],
  ['an empty client_time', () => body({ rows: [progressRow({ client_time: '' })] }), 'bad client_time'],
  ['bad field name: a capital letter', () => body({ rows: [progressRow({ Seconds: 1 })] }), 'bad field name'],
  ['bad field name: a leading digit', () => body({ rows: [progressRow({ '1st': 1 })] }), 'bad field name'],
  ['bad field name: a dash', () => body({ rows: [progressRow({ 'a-b': 1 })] }), 'bad field name'],
  ['bad field name: a leading underscore', () => body({ rows: [progressRow({ _x: 1 })] }), 'bad field name'],
  ['bad field name: 41 characters', () => body({ rows: [progressRow({ ['a'.repeat(41)]: 1 })] }), 'bad field name'],
  ['bad field name: __proto__', () => JSON.stringify(body()).replace('"node":', '"__proto__":{},"node":'), 'bad field name'],
  ['a nested object', () => body({ rows: [progressRow({ detail: { crew: 'PipeLaying' } })] }), 'bad value'],
  ['an array value', () => body({ rows: [progressRow({ tags: ['a'] })] }), 'bad value'],
  ['a non-finite number', () => JSON.stringify(body()).replace('"seconds":142', '"seconds":1e400'), 'bad value'],
  ['text over 1000 characters', () => body({ rows: [progressRow({ node: 'x'.repeat(1001) })] }), 'value too long'],
  ['a detail over 4000 characters', () => body({ rows: [eventRow({ detail: 'x'.repeat(4001) })] }), 'value too long'],
  ['a row carrying session', () => body({ rows: [progressRow({ session: SESSION })] }), 'reserved field'],
  ['a row carrying code', () => body({ rows: [progressRow({ code: 'P042' })] }), 'reserved field'],
  ['a row carrying server_time', () => body({ rows: [progressRow({ server_time: CLIENT_TIME })] }), 'reserved field'],
  ['a row carrying target_tab', () => body({ rows: [progressRow({ target_tab: 'progress' })] }), 'reserved field'],
  ['more than 64 distinct fields', () => body({ rows: [progressRow(fields('a', 31)), progressRow(fields('b', 31))] }), 'too many fields'],
  ['a body one byte over 200 KB', () => sizedBody(MAX_BODY_BYTES + 1), 'body too large'],
  ['a body over 200 KB in UTF-8 bytes but not in characters', utf8HeavyBody, 'body too large'],
];

INVALID.forEach(([label, makePayload, reason]) => {
  test('rejects ' + label + ' with retry:false and writes nothing', () => {
    const env = makeEnv();
    const reply = post(env, makePayload());
    assert.deepStrictEqual(Object.keys(reply).sort(), ['error', 'ok', 'retry']);
    assert.strictEqual(reply.ok, false);
    assert.strictEqual(reply.retry, false);
    assert.ok(reply.error.startsWith(reason), 'error "' + reply.error + '" should start with "' + reason + '"');
    assert.strictEqual(env.spreadsheet.sheets.length, 0);
    assert.strictEqual(env.locks.waits.length, 0);
    assert.strictEqual(env.cache.puts.length, 0);
  });
});

// ------------------------------------------------------------------ lock and failures

test('lock failure returns busy with retry:true and writes nothing', () => {
  const env = makeEnv();
  env.locks.busy = true;
  const b = body();
  assert.deepStrictEqual(post(env, b), { ok: false, error: 'busy', retry: true });
  assert.strictEqual(env.locks.waits.length, 1);
  assert.ok(env.locks.waits[0] >= 15000 && env.locks.waits[0] <= 25000, 'waits about 20 s for the lock');
  assert.strictEqual(env.spreadsheet.sheets.length, 0);
  env.locks.busy = false;
  assert.deepStrictEqual(post(env, b), { ok: true, appended: 1 }, 'the retry goes through');
});

test('a failure while writing replies retry:true, releases the lock, and the retry goes through', () => {
  const env = makeEnv();
  env.spreadsheet.failOn = 'setValues';
  const b = body();
  assert.deepStrictEqual(post(env, b), { ok: false, error: 'server', retry: true });
  assert.strictEqual(env.locks.held, false);
  assert.deepStrictEqual(post(env, b), { ok: true, appended: 1 });
  assert.strictEqual(tab(env, 'tryout_progress').records().length, 1);
});

test('every lock taken is released', () => {
  const env = makeEnv();
  const b = body();
  post(env, b);
  post(env, b);
  env.spreadsheet.failOn = 'insertSheet';
  post(env, body({ mode: 'test' }));
  assert.strictEqual(env.locks.held, false);
  assert.strictEqual(env.locks.releases, env.locks.waits.length);
});

test('logs hold counts and error kinds, never payload contents', () => {
  const env = makeEnv();
  addCodes(env, [['ZQ9', 'TRUE']]);
  const marker = 'marker7731';
  const b = body({ mode: 'study', code: 'ZQ9', build: marker, rows: [eventRow({ type: marker, detail: '{"note":"' + marker + '"}' })] });
  post(env, b); // appended
  post(env, b); // duplicate
  post(env, body({ mode: 'study', code: 'ZQ8', build: marker })); // unmatched
  post(env, body({ code: 'ZQ9', rows: [progressRow({ node: marker, server_time: marker })] })); // reserved field
  post(env, body({ code: 'ZQ9', [marker]: 1 })); // unknown body field (named in the reply only)
  post(env, '{"build":"' + marker + '",'); // bad json
  env.locks.busy = true;
  post(env, body({ build: marker })); // busy
  env.locks.busy = false;
  env.spreadsheet.failOn = 'insertSheet';
  post(env, body({ mode: 'test', build: marker })); // server error
  assert.strictEqual(env.logs.length, 8, 'one log line per request');
  const text = env.logs.join('\n').toLowerCase();
  [marker, 'zq9', 'zq8', SESSION, b.batch].forEach(s => {
    assert.ok(!text.includes(s.toLowerCase()), 'logs must not contain ' + s);
  });
});

// ------------------------------------------------------------------ doGet

test('doGet health returns ok, schema 1, the script version and the time', () => {
  const env = makeEnv();
  const reply = get(env, { op: 'health' });
  assert.deepStrictEqual(Object.keys(reply).sort(), ['ok', 'schema', 'script', 'time']);
  assert.strictEqual(reply.ok, true);
  assert.strictEqual(reply.schema, 1);
  assert.ok(typeof reply.script === 'string' && reply.script.length > 0);
  assert.match(reply.time, ISO_SECONDS);
});

test('doGet code answers for the one code asked about', () => {
  const env = makeEnv();
  addCodes(env, [['P042', 'TRUE'], ['P043', 'FALSE']]);
  const ask = code => get(env, code === undefined ? { op: 'code' } : { op: 'code', code: code });
  assert.deepStrictEqual(ask('P042'), { ok: true, known: true });
  assert.deepStrictEqual(ask('p042'), { ok: true, known: true });
  assert.deepStrictEqual(ask('P043'), { ok: true, known: false });
  assert.deepStrictEqual(ask('Q1'), { ok: true, known: false });
  assert.deepStrictEqual(ask('P-42'), { ok: true, known: false });
  assert.deepStrictEqual(ask(undefined), { ok: true, known: false });
});

test('doGet with any other op replies unknown op', () => {
  const env = makeEnv();
  [{}, { op: 'list' }, { op: 'codes' }, { op: 'HEALTH' }].forEach(parameter => {
    assert.deepStrictEqual(get(env, parameter), { ok: false, error: 'unknown op' });
  });
  assert.deepStrictEqual(readReply(env.context.doGet(undefined)), { ok: false, error: 'unknown op' });
});

test('a script that is not bound to a sheet fails health, and posts ask the client to retry', () => {
  const env = makeEnv({ unbound: true });
  assert.deepStrictEqual(get(env, { op: 'health' }), { ok: false, error: 'not bound to a sheet' });
  assert.deepStrictEqual(post(env, body()), { ok: false, error: 'server', retry: true });
});

// ------------------------------------------------------------------ run

let failed = 0;
tests.forEach(t => {
  try {
    t.fn();
    console.log('ok    ' + t.name);
  } catch (err) {
    failed += 1;
    console.log('FAIL  ' + t.name);
    console.log('      ' + String(err && err.stack ? err.stack : err).split('\n').join('\n      '));
  }
});
console.log('\n' + (tests.length - failed) + ' passed, ' + failed + ' failed, ' + tests.length + ' total');
process.exitCode = failed === 0 ? 0 : 1;
