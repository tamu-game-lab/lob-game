/*
 * LOB Game play-data receiver: a Google Apps Script web app (V8 runtime, no libraries).
 *
 * Contract: docs/data-dictionary.md, schema 1. The game posts batches of rows as
 * text/plain JSON. doPost validates a post, appends its rows to the tab for their mode
 * and kind (columns matched by header name; a new field gets a new column on the
 * right, up to MAX_COLUMNS a tab), stamps server_time, and replies with a small JSON
 * object. doGet answers ?op=health and ?op=code.
 *
 * Bound script: create it from the Google Sheet (Extensions > Apps Script), so that
 * SpreadsheetApp.getActiveSpreadsheet() is that Sheet. Steps: docs/apps-script-setup.md.
 *
 * Privacy: payload contents can be research data and are never logged. Logs carry
 * counts and error kinds only.
 *
 * Duplicates: an appended batch id is remembered in the script cache for 6 hours, the
 * CacheService maximum. A retry that arrives later than that, or after the cache
 * evicted the id early, is appended again; so is a retry after a failure that came
 * after some tabs were written. Every row carries session and row_seq, so analysis
 * can drop such duplicates.
 *
 * Session emails (1.1.0): when a post stores the row that marks a session's finish, the
 * settings tab decides: email_mode off (the default) does nothing, session emails a
 * summary at once, and digest queues it in digest_queue for sendDigest(), which a time
 * trigger runs. A summary holds the code, mode, build, start, finish, row counts and the
 * Sheet's link, never row contents. setupSettings() and installDigestTrigger() are run
 * from the script editor (docs/apps-script-setup.md, Part 7). The manifest's scopes:
 * spreadsheets (as before), script.send_mail (MailApp), script.scriptapp (the trigger)
 * and userinfo.email (the deploying account's address, the default recipient).
 *
 * Offline tests: node apps-script/test/run-tests.js
 */

const SCRIPT_VERSION = 'lob-receiver 1.1.0 (2026-10-29)';
const SCHEMA = 1;

const MAX_BODY_BYTES = 200 * 1024; // "at most 200 KB per post", counted in UTF-8 bytes
const MAX_ROWS = 100;
const MAX_TEXT = 1000;
const MAX_DETAIL = 4000; // "detail" holds a telemetry line's key/value pairs as compact JSON
// Distinct row field names in one post. The four kinds together use 30; the cap only
// stops a malformed or hostile post from flooding a tab with columns.
const MAX_FIELDS = 64;
// A tab grows to at most this many columns; a post that would add columns past it is
// rejected whole. The dictionary's widest tab, unmatched, has 40.
const MAX_COLUMNS = 60;

const LOCK_WAIT_MS = 20000;
const BATCH_TTL_S = 21600; // 6 h, the CacheService maximum
const CODES_TTL_S = 60;
const ROW_CHUNK = 1000; // a full tab grows by at least this many rows, so most appends skip the resize

const CODES_TAB = 'codes';
const UNMATCHED_TAB = 'unmatched';
const MODE_PREFIX = { study: '', tryout: 'tryout_', test: 'test_' };
const KIND_TAB = { session: 'sessions', progress: 'progress', run: 'runs', event: 'events' };
const BODY_FIELDS = ['schema', 'mode', 'build', 'code', 'session', 'batch', 'sent_at', 'rows'];
// The game repeats these post fields on every row. A row's copy must equal the post's
// value (code after the same normalization); the post's value is the one stored.
const POST_ROW_FIELDS = ['schema', 'mode', 'build', 'code', 'session'];
// The server stamps these on rows, so a row may not carry them.
const RESERVED_ROW_FIELDS = ['server_time', 'target_tab'];

const CODE_RE = /^[A-Za-z]{1,3}[0-9]{1,4}$/;
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const FIELD_RE = /^[a-z][a-z0-9_]{0,39}$/;

// Session emails. setupSettings() writes these defaults to the settings tab; a blank
// email_to means the deploying account's own address.
const SETTINGS_TAB = 'settings';
const QUEUE_TAB = 'digest_queue';
const SETTING_DEFAULTS = [['email_mode', 'off'], ['email_to', ''], ['digest_minutes', 60]];
const EMAIL_MODES = ['off', 'session', 'digest'];
// The intervals a time trigger runs at: every 5, 10, 15 or 30 minutes, or every 1, 2, 4,
// 6, 8 or 12 hours. One minute is left out, so a "1" meant as an hour is not taken.
const DIGEST_MINUTES = [5, 10, 15, 30, 60, 120, 240, 360, 480, 720];
const DIGEST_FUNCTION = 'sendDigest';
const ADDRESS_RE = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;

/**
 * Web app POST: one batch of rows from the game.
 * Replies {"ok":true,"appended":N}, {"ok":true,"appended":0,"duplicate":true},
 * {"ok":false,"error":"<reason>","retry":false} for an invalid post, or
 * {"ok":false,"error":"busy"|"server","retry":true} when the client should try again later.
 */
function doPost(e) {
  let post;
  try {
    post = readPost_(e);
  } catch (err) {
    if (!err || !err.invalid) return serverError_('validate', err);
    return rejected_(err);
  }
  try {
    return storePost_(post);
  } catch (err) {
    if (err && err.invalid) return rejected_(err); // the column cap, checked under the lock
    return serverError_('store', err);
  }
}

/**
 * Web app GET: ?op=health, or ?op=code&code=P042 (answers for that one code; never lists codes).
 * Once setupSettings() has made the settings tab, health also reports the effective email
 * mode, and the keys (never the values) of any setting it ignored; before that its reply
 * keeps 1.0.1's fields, and emails are off.
 */
function doGet(e) {
  const params = (e && e.parameter) || {};
  try {
    if (params.op === 'health') {
      const ss = SpreadsheetApp.getActiveSpreadsheet();
      if (!ss) return reply_({ ok: false, error: 'not bound to a sheet' });
      const health = { ok: true, schema: SCHEMA, script: SCRIPT_VERSION, time: isoNow_() };
      const settings = readSettings_(ss);
      if (settings.present) {
        health.email = settings.mode;
        if (settings.ignored.length > 0) health.ignored_settings = settings.ignored;
      }
      return reply_(health);
    }
    if (params.op === 'code') {
      const code = typeof params.code === 'string' ? params.code : '';
      const known = CODE_RE.test(code) && activeCodes_(spreadsheet_()).has(code.toUpperCase());
      return reply_({ ok: true, known: known });
    }
    return reply_({ ok: false, error: 'unknown op' });
  } catch (err) {
    return serverError_('get', err);
  }
}

/** Parses and validates a post. Throws invalid_() errors; returns the post with its code upper-cased. */
function readPost_(e) {
  const text = e && e.postData ? e.postData.contents : null;
  if (typeof text !== 'string' || text === '') throw invalid_('empty body');
  if (text.length > MAX_BODY_BYTES || utf8Length_(text) > MAX_BODY_BYTES) throw invalid_('body too large');
  let body;
  try {
    body = JSON.parse(text);
  } catch (err) {
    throw invalid_('bad json'); // the parser's message quotes the payload, so it is dropped
  }
  if (!isObject_(body)) throw invalid_('body is not an object');
  Object.keys(body).forEach(key => {
    if (BODY_FIELDS.indexOf(key) < 0) throw invalid_('unknown body field', FIELD_RE.test(key) ? key : '');
  });
  if (body.schema !== SCHEMA) throw invalid_('unknown schema');
  if (typeof body.mode !== 'string' || !own_(MODE_PREFIX, body.mode)) throw invalid_('bad mode');
  if (!isText_(body.build)) throw invalid_('bad build');
  const code = normalCode_(body.code);
  if (code === null) throw invalid_('bad code');
  if (typeof body.session !== 'string' || !UUID_RE.test(body.session)) throw invalid_('bad session');
  if (typeof body.batch !== 'string' || !UUID_RE.test(body.batch)) throw invalid_('bad batch');
  if (body.sent_at !== undefined && body.sent_at !== null && !isText_(body.sent_at)) throw invalid_('bad sent_at');
  const rows = body.rows;
  if (!Array.isArray(rows) || rows.length === 0) throw invalid_('no rows');
  if (rows.length > MAX_ROWS) throw invalid_('too many rows');
  const post = {
    schema: body.schema,
    mode: body.mode,
    build: body.build,
    code: code,
    session: body.session,
    batch: body.batch,
    rows: rows,
  };
  const names = new Set();
  rows.forEach((row, i) => checkRow_(row, 'row ' + (i + 1), post, names));
  if (names.size > MAX_FIELDS) throw invalid_('too many fields');
  return post;
}

/**
 * Validates one row: kind, row_seq, client_time, then every field name and value. A
 * row may repeat the post's schema, mode, build, code and session, each equal to the
 * post's value; its code is compared after the post code's normalization.
 */
function checkRow_(row, where, post, names) {
  if (!isObject_(row)) throw invalid_('row is not an object', where);
  if (typeof row.kind !== 'string' || !own_(KIND_TAB, row.kind)) throw invalid_('bad kind', where);
  if (!Number.isSafeInteger(row.row_seq) || row.row_seq < 1) throw invalid_('bad row_seq', where);
  if (!isText_(row.client_time) || row.client_time === '') throw invalid_('bad client_time', where);
  Object.keys(row).forEach(name => {
    if (!FIELD_RE.test(name)) throw invalid_('bad field name', where);
    if (RESERVED_ROW_FIELDS.indexOf(name) >= 0) throw invalid_('reserved field', where + ', ' + name);
    if (POST_ROW_FIELDS.indexOf(name) >= 0) {
      const value = name === 'code' ? normalCode_(row[name]) : row[name];
      if (value !== post[name]) throw invalid_('row disagrees with post', where + ', ' + name);
    }
    checkValue_(row[name], name, where);
    names.add(name);
  });
}

/** A value is a string (up to 1000 chars; 4000 for detail), a finite number, a boolean, or null (empty). */
function checkValue_(value, name, where) {
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'number' && isFinite(value)) return;
  if (typeof value === 'string') {
    if (value.length > (name === 'detail' ? MAX_DETAIL : MAX_TEXT)) throw invalid_('value too long', where + ', ' + name);
    return;
  }
  throw invalid_('bad value', where + ', ' + name);
}

/**
 * A study code upper-cased, or null when it is not 1-3 letters then 1-4 digits. It is
 * checked before upper-casing, so letters outside A-Z can never turn into a valid code.
 */
function normalCode_(value) {
  return typeof value === 'string' && CODE_RE.test(value) ? value.toUpperCase() : null;
}

/**
 * Appends a validated post under the script lock, unless its batch was already appended.
 * Every tab is read and checked before any is written, so a post over the column cap is
 * rejected whole, and the writes go out together.
 */
function storePost_(post) {
  const batchKey = 'batch:' + post.batch.toLowerCase();
  if (cacheGet_(batchKey) !== null) return duplicate_();

  const ss = spreadsheet_();
  // Only study mode checks the code; tryout and test take any well-formed code.
  const matched = post.mode !== 'study' || activeCodes_(ss).has(post.code);

  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(LOCK_WAIT_MS);
  } catch (err) {
    console.warn('busy: lock wait timed out');
    return reply_({ ok: false, error: 'busy', retry: true });
  }
  let tabCount;
  try {
    // A copy of this batch may have been appended while this request waited for the lock.
    if (cacheGet_(batchKey) !== null) return duplicate_();
    const plans = [];
    groupRows_(post, matched, isoNow_()).forEach((rows, tabName) => plans.push(planTab_(ss, tabName, rows)));
    plans.forEach(plan => writeTab_(ss, plan));
    // Keep this flush: the next post, under the lock, must see this post's committed last row, or it would overwrite it.
    SpreadsheetApp.flush();
    cachePut_(batchKey, '1', BATCH_TTL_S);
    tabCount = plans.length;
  } finally {
    lock.releaseLock();
  }
  console.log('appended rows=' + post.rows.length + ' tabs=' + tabCount + (matched ? '' : ' unmatched'));
  notifyFinish_(ss, post, matched);
  return reply_({ ok: true, appended: post.rows.length });
}

/**
 * Builds the sheet rows of a post, grouped by tab. Each row starts with the common
 * fields (kind, the post-level values copied from the body, row_seq, client_time,
 * server_time), then its own fields in arrival order; a new tab's header follows this
 * order. Unmatched study rows go to the unmatched tab, with target_tab naming the tab
 * they would have gone to. A row's own copy of a post-level value is dropped: the
 * stored value is the post's.
 */
function groupRows_(post, matched, serverTime) {
  const tabs = new Map();
  post.rows.forEach(row => {
    const target = MODE_PREFIX[post.mode] + KIND_TAB[row.kind];
    const out = {
      kind: row.kind,
      schema: post.schema,
      mode: post.mode,
      build: post.build,
      code: post.code,
      session: post.session,
      row_seq: row.row_seq,
      client_time: row.client_time,
      server_time: serverTime,
    };
    if (!matched) out.target_tab = target;
    Object.keys(row).forEach(name => {
      if (!own_(out, name)) out[name] = row[name];
    });
    const tabName = matched ? target : UNMATCHED_TAB;
    if (!tabs.has(tabName)) tabs.set(tabName, []);
    tabs.get(tabName).push(out);
  });
  return tabs;
}

/**
 * Reads one tab and lays out rows (objects keyed by field name) for it, writing nothing.
 * Columns are matched by header name, and a new field gets a column on the right; a
 * missing or empty tab gets a header in the rows' field order, which groupRows_ makes
 * the common fields first, then the others in arrival order. A tab grows to at most
 * MAX_COLUMNS columns: a post that would add columns past that is invalid, and the error
 * names the new fields.
 */
function planTab_(ss, tabName, rows) {
  const sheet = ss.getSheetByName(tabName); // null: writeTab_ makes the tab
  const lastCol = sheet ? sheet.getLastColumn() : 0;
  const existing = lastCol > 0
    ? sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(h => String(h).trim())
    : [];
  const header = existing.slice();
  const column = new Map();
  header.forEach((name, i) => {
    if (name !== '' && !column.has(name)) column.set(name, i);
  });
  rows.forEach(row => Object.keys(row).forEach(name => {
    if (!column.has(name)) {
      column.set(name, header.length);
      header.push(name);
    }
  }));
  const added = header.slice(existing.length);
  if (added.length > 0 && header.length > MAX_COLUMNS) {
    throw invalid_('too many columns', tabName + ', new fields: ' + added.join(', '));
  }
  return {
    tabName: tabName,
    sheet: sheet,
    lastRow: sheet ? sheet.getLastRow() : 0,
    maxRows: sheet ? sheet.getMaxRows() : 0,
    maxCols: sheet && added.length > 0 ? sheet.getMaxColumns() : 0, // only needed when the header grows
    oldWidth: existing.length,
    header: header,
    values: rows.map(row => {
      const line = new Array(header.length).fill('');
      Object.keys(row).forEach(name => {
        line[column.get(name)] = toCell_(row[name]);
      });
      return line;
    }),
  };
}

/** Writes a planned tab: makes it if missing, grows it as needed, adds the new header cells, then the rows in one call. */
function writeTab_(ss, plan) {
  let sheet = plan.sheet;
  let maxRows = plan.maxRows;
  let maxCols = plan.maxCols;
  if (!sheet) {
    sheet = ss.insertSheet(plan.tabName);
    maxRows = sheet.getMaxRows();
    maxCols = sheet.getMaxColumns();
  }
  const width = plan.header.length;
  if (width > plan.oldWidth) {
    if (width > maxCols) sheet.insertColumnsAfter(maxCols, width - maxCols);
    sheet.getRange(1, plan.oldWidth + 1, 1, width - plan.oldWidth)
      .setValues([plan.header.slice(plan.oldWidth).map(toCell_)]);
  }
  const first = Math.max(plan.lastRow, 1) + 1; // row 1 is the header
  const last = first + plan.values.length - 1;
  if (last > maxRows) sheet.insertRowsAfter(maxRows, Math.max(last - maxRows, ROW_CHUNK));
  sheet.getRange(first, 1, plan.values.length, width).setValues(plan.values);
}

/** The active study codes, upper-case, cached for CODES_TTL_S seconds. */
function activeCodes_(ss) {
  const cached = cacheGet_('codes');
  if (cached !== null) return new Set(JSON.parse(cached));
  const codes = readActiveCodes_(ss);
  cachePut_('codes', JSON.stringify(codes), CODES_TTL_S);
  return new Set(codes);
}

/**
 * Reads the codes tab: columns "code" and "active", found by header name in row 1.
 * A code is active when its active cell is TRUE or blank. Any other value makes it
 * inactive, and so does a FALSE (or other) entry anywhere for the same code.
 */
function readActiveCodes_(ss) {
  const sheet = ss.getSheetByName(CODES_TAB);
  if (!sheet) return [];
  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  if (lastRow < 2 || lastCol < 1) return [];
  const values = sheet.getRange(1, 1, lastRow, lastCol).getValues();
  const header = values[0].map(h => String(h).trim().toLowerCase());
  const codeCol = header.indexOf('code');
  const activeCol = header.indexOf('active');
  if (codeCol < 0) return [];
  const active = new Map();
  values.slice(1).forEach(line => {
    const code = String(line[codeCol]).trim().toUpperCase();
    if (code === '') return;
    const on = activeCol < 0 || isActiveCell_(line[activeCol]);
    active.set(code, (active.has(code) ? active.get(code) : true) && on);
  });
  return Array.from(active.keys()).filter(code => active.get(code));
}

function isActiveCell_(value) {
  if (value === true || value === null || value === undefined) return true;
  if (typeof value !== 'string') return false;
  const text = value.trim().toUpperCase();
  return text === '' || text === 'TRUE';
}

/**
 * Session emails, once a post is stored and the lock released. When the post holds the
 * row that marks its session's finish, the settings tab decides: email_mode off does
 * nothing, session emails the summary now, and digest queues it for sendDigest(). A
 * duplicate post never gets here, so a retry sends no second email. It never throws: a
 * settings, mail or queue failure is logged, and the post keeps its normal reply.
 */
function notifyFinish_(ss, post, matched) {
  const finish = post.rows.find(isFinishRow_);
  if (!finish) return;
  let stage = 'settings';
  try {
    const settings = readSettings_(ss);
    if (settings.mode === 'session') {
      stage = 'session email';
      const totals = codeTotals_(ss, post.mode, [post.code]).get(post.code);
      sendMail_(settings, sessionEmail_(finishSummary_(post, matched, finish), totals, ss.getUrl()));
    } else if (settings.mode === 'digest') {
      stage = 'digest queue';
      queueFinish_(ss, finishSummary_(post, matched, finish));
    }
  } catch (err) {
    emailFailed_(stage, err);
  }
}

/**
 * The row that marks a session's finish (data dictionary, sessions): phase finish. The
 * status row that "Download my data" adds afterwards (downloaded TRUE) is not a second finish.
 */
function isFinishRow_(row) {
  return row.kind === 'session' && row.phase === 'finish' && row.downloaded !== true;
}

/**
 * What the emails say about a finished session, and nothing from the rows' contents:
 * finish is the finish row's client_time and start is finish minus its seconds (the
 * dictionary's "seconds from start to finish"), both rewritten as ISO UTC times, or ''
 * when they do not parse; added counts this post's rows per tab.
 */
function finishSummary_(post, matched, finish) {
  const finishMs = Date.parse(finish.client_time);
  const seconds = finish.seconds;
  return {
    code: post.code,
    mode: post.mode,
    build: emailBuild_(post.build),
    start: typeof seconds === 'number' && seconds >= 0 ? isoAt_(finishMs - seconds * 1000) : '',
    finish: isoAt_(finishMs),
    added: addedCounts_(post, matched),
  };
}

/** This post's rows per tab, where groupRows_ sent them: the mode's tab for their kind, or unmatched. */
function addedCounts_(post, matched) {
  const counts = emptyCounts_();
  post.rows.forEach(row => {
    counts[matched ? KIND_TAB[row.kind] : UNMATCHED_TAB] += 1;
  });
  return counts;
}

/**
 * Rows per tab for each code, in the mode's four tabs and, in study mode, the unmatched
 * tab: a Map from code to counts keyed like emptyCounts_().
 */
function codeTotals_(ss, mode, codes) {
  const totals = new Map(codes.map(code => [code, emptyCounts_()]));
  Object.keys(emptyCounts_()).forEach(name => {
    if (name === UNMATCHED_TAB && mode !== 'study') return;
    const counts = codeCounts_(ss, name === UNMATCHED_TAB ? name : MODE_PREFIX[mode] + name);
    totals.forEach((total, code) => {
      total[name] = counts.get(code) || 0;
    });
  });
  return totals;
}

/** How many rows each code has in a tab, from its column headed "code"; empty when the tab or column is missing. */
function codeCounts_(ss, tabName) {
  const counts = new Map();
  const sheet = ss.getSheetByName(tabName);
  const lastRow = sheet ? sheet.getLastRow() : 0;
  const lastCol = sheet ? sheet.getLastColumn() : 0;
  if (lastRow < 2 || lastCol < 1) return counts;
  const col = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(h => String(h).trim()).indexOf('code');
  if (col < 0) return counts;
  sheet.getRange(2, col + 1, lastRow - 1, 1).getValues().forEach(line => {
    const code = String(line[0]).trim().toUpperCase();
    if (code !== '') counts.set(code, (counts.get(code) || 0) + 1);
  });
  return counts;
}

/** Zero rows in each tab the emails count: sessions, progress, runs and events (no mode prefix), and unmatched. */
function emptyCounts_() {
  const counts = {};
  Object.keys(KIND_TAB).forEach(kind => {
    counts[KIND_TAB[kind]] = 0;
  });
  counts[UNMATCHED_TAB] = 0;
  return counts;
}

/** "sessions 1, progress 0, runs 0, events 12", then "unmatched N" when N > 0. */
function countsText_(counts) {
  return Object.keys(counts)
    .filter(name => name !== UNMATCHED_TAB || counts[name] > 0)
    .map(name => name + ' ' + counts[name])
    .join(', ');
}

/** The session-mode email: the fields one per line, then the Sheet's link. */
function sessionEmail_(summary, totals, url) {
  return {
    subject: 'LOB session finished: ' + summary.code + ' (' + summary.mode + ')',
    body: [
      'Code: ' + summary.code,
      'Mode: ' + summary.mode,
      'Build: ' + summary.build,
      'Start: ' + (summary.start || 'unknown'),
      'Finish: ' + (summary.finish || 'unknown'),
      'Rows in the finishing post: ' + countsText_(summary.added),
      'Total rows for this code: ' + countsText_(totals),
      'Sheet: ' + url,
    ].join('\n'),
  };
}

/**
 * Digest mode: appends the summary as one line of the digest_queue tab (by header name,
 * like the data tabs). It takes the script lock again, briefly, so the line never races
 * another append or a sendDigest() deleting the lines it sent.
 */
function queueFinish_(ss, summary) {
  const line = {
    code: summary.code,
    mode: summary.mode,
    build: summary.build,
    start: summary.start,
    finish: summary.finish,
  };
  Object.keys(summary.added).forEach(name => {
    line['added_' + name] = summary.added[name];
  });
  line.queued_at = isoNow_();
  const lock = LockService.getScriptLock();
  lock.waitLock(LOCK_WAIT_MS);
  try {
    writeTab_(ss, planTab_(ss, QUEUE_TAB, [line]));
    SpreadsheetApp.flush(); // as in storePost_: the next append, under the lock, must see this line
  } finally {
    lock.releaseLock();
  }
}

/**
 * Run by the time trigger that installDigestTrigger() makes: emails one list of the queued
 * sessions, one line each with the session email's fields, and the Sheet's link, then
 * deletes the lines it sent. An empty queue, or email_mode off, sends nothing. It holds
 * the script lock from reading the queue to deleting the lines (a second or two a run),
 * so no line arrives or is sent twice in between. A failure is logged, and the lines stay
 * queued for the next run.
 */
function sendDigest() {
  try {
    const ss = spreadsheet_();
    const settings = readSettings_(ss);
    if (settings.mode === 'off') {
      console.log('digest: email_mode is off, nothing sent');
      return;
    }
    const lock = LockService.getScriptLock();
    lock.waitLock(LOCK_WAIT_MS);
    try {
      const queue = readQueue_(ss);
      if (queue.lines.length === 0) return;
      sendMail_(settings, digestEmail_(ss, queue.lines));
      queue.sheet.deleteRows(2, queue.rows);
      SpreadsheetApp.flush();
      console.log('digest sent sessions=' + queue.lines.length);
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    emailFailed_('digest', err);
  }
}

/**
 * The digest_queue tab by header name: how many rows follow the header (rows), and the
 * lines among them that have a code (lines), each read back as a summary.
 */
function readQueue_(ss) {
  const sheet = ss.getSheetByName(QUEUE_TAB);
  const lastRow = sheet ? sheet.getLastRow() : 0;
  const lastCol = sheet ? sheet.getLastColumn() : 0;
  if (lastRow < 2 || lastCol < 1) return { sheet: sheet, rows: 0, lines: [] };
  const values = sheet.getRange(1, 1, lastRow, lastCol).getValues();
  const header = values[0].map(h => String(h).trim());
  const cell = (line, name) => (header.indexOf(name) < 0 ? '' : String(line[header.indexOf(name)]).trim());
  const lines = values.slice(1).filter(line => cell(line, 'code') !== '').map(line => {
    const added = emptyCounts_();
    Object.keys(added).forEach(name => {
      added[name] = Number(cell(line, 'added_' + name)) || 0;
    });
    return {
      code: cell(line, 'code').toUpperCase(),
      mode: cell(line, 'mode'),
      build: cell(line, 'build'),
      start: cell(line, 'start'),
      finish: cell(line, 'finish'),
      added: added,
    };
  });
  return { sheet: sheet, rows: lastRow - 1, lines: lines };
}

/** The digest email: one line per queued session, with each code's total rows as they are now, then the Sheet's link. */
function digestEmail_(ss, lines) {
  const totals = new Map();
  Object.keys(MODE_PREFIX).forEach(mode => {
    const codes = lines.filter(line => line.mode === mode).map(line => line.code);
    if (codes.length > 0) totals.set(mode, codeTotals_(ss, mode, codes));
  });
  const text = lines.map(line => {
    const total = totals.has(line.mode) ? totals.get(line.mode).get(line.code) : emptyCounts_();
    return line.code + ' (' + line.mode + '); build ' + line.build +
      '; start ' + (line.start || 'unknown') + '; finish ' + (line.finish || 'unknown') +
      '; rows in the finishing post: ' + countsText_(line.added) + '; total rows for this code: ' + countsText_(total);
  });
  return {
    subject: 'LOB digest: ' + lines.length + (lines.length === 1 ? ' session' : ' sessions') + ' finished',
    body: text.concat(['', 'Sheet: ' + ss.getUrl()]).join('\n'),
  };
}

/** Sends a plain-text email to email_to, or, when that is blank, to the deploying account. */
function sendMail_(settings, email) {
  const to = settings.to || Session.getEffectiveUser().getEmail();
  if (!to) throw new Error('no recipient: email_to is blank and the account has no address');
  MailApp.sendEmail({ to: to, subject: email.subject, body: email.body });
}

/**
 * The settings, read afresh by every request that needs them (never cached), so an edit
 * in the tab applies at once. A missing tab or key takes its default. A value the
 * receiver cannot use is ignored and its key listed in ignored, which op=health shows
 * (never the value): an unknown email_mode, or an email_to that is not one or more
 * addresses, turns emails off; an unknown digest_minutes means 60.
 */
function readSettings_(ss) {
  const sheet = ss.getSheetByName(SETTINGS_TAB);
  const table = settingsTable_(sheet);
  const ignored = [];
  let mode = (table.get('email_mode') || 'off').toLowerCase();
  if (EMAIL_MODES.indexOf(mode) < 0) {
    ignored.push('email_mode');
    mode = 'off';
  }
  const to = (table.get('email_to') || '').split(',').map(part => part.trim()).join(',');
  if (to !== '' && !to.split(',').every(part => ADDRESS_RE.test(part))) {
    ignored.push('email_to');
    mode = 'off';
  }
  let minutes = Number(table.get('digest_minutes') || 60);
  if (DIGEST_MINUTES.indexOf(minutes) < 0) {
    ignored.push('digest_minutes');
    minutes = 60;
  }
  return { present: Boolean(sheet), mode: mode, to: to, minutes: minutes, ignored: ignored };
}

/** The settings tab's rows as key to value text, columns "key" and "value" found by header name (any case). */
function settingsTable_(sheet) {
  const table = new Map();
  const lastRow = sheet ? sheet.getLastRow() : 0;
  const lastCol = sheet ? sheet.getLastColumn() : 0;
  if (lastRow < 2 || lastCol < 1) return table;
  const values = sheet.getRange(1, 1, lastRow, lastCol).getValues();
  const header = values[0].map(h => String(h).trim().toLowerCase());
  const keyCol = header.indexOf('key');
  const valueCol = header.indexOf('value');
  if (keyCol < 0 || valueCol < 0) return table;
  values.slice(1).forEach(line => {
    const key = String(line[keyCol]).trim().toLowerCase();
    if (key !== '') table.set(key, String(line[valueCol]).trim());
  });
  return table;
}

/**
 * Makes the settings tab with its defaults (email_mode off, email_to blank, digest_minutes
 * 60), or adds any key missing from it. Values already there are never changed, so a
 * second run changes nothing. Run it once from the script editor; that run is where Google
 * asks for the new permissions (docs/apps-script-setup.md, Part 7).
 */
function setupSettings() {
  const ss = spreadsheet_();
  const table = settingsTable_(ss.getSheetByName(SETTINGS_TAB));
  const missing = SETTING_DEFAULTS.filter(pair => !table.has(pair[0])).map(pair => ({ key: pair[0], value: pair[1] }));
  if (missing.length > 0) writeTab_(ss, planTab_(ss, SETTINGS_TAB, missing));
  const added = missing.map(setting => setting.key).join(', ');
  console.log('settings: ' + (added ? 'added ' + added : 'nothing to add'));
}

/**
 * Installs the time trigger that runs sendDigest() every digest_minutes, replacing any
 * earlier one, so running it again (say, after digest_minutes changed) still leaves
 * exactly one. Run it from the script editor before class.
 */
function installDigestTrigger() {
  const settings = readSettings_(spreadsheet_());
  removeDigestTrigger();
  const clock = ScriptApp.newTrigger(DIGEST_FUNCTION).timeBased();
  (settings.minutes < 60 ? clock.everyMinutes(settings.minutes) : clock.everyHours(settings.minutes / 60)).create();
  console.log('digest trigger installed: every ' + settings.minutes + ' minutes' +
    (settings.mode === 'digest' ? '' : '; email_mode is ' + settings.mode + ', so nothing is queued'));
}

/** Removes the sendDigest() trigger; with none installed it does nothing. Run it from the script editor after class. */
function removeDigestTrigger() {
  const triggers = ScriptApp.getProjectTriggers().filter(trigger => trigger.getHandlerFunction() === DIGEST_FUNCTION);
  triggers.forEach(trigger => ScriptApp.deleteTrigger(trigger));
  console.log('digest triggers removed: ' + triggers.length);
}

/**
 * The build label as the emails show it: letters, digits, spaces, _ and -, and a dot only
 * between two digits (W2 1.2-W2); any other character becomes ?, and it stops at 60. It is
 * the only text a post puts into an email, so a forged post cannot add a line, an address,
 * a URL or a domain name (mail apps turn a bare "example.com" into a link) to one.
 */
function emailBuild_(build) {
  const digit = c => c >= '0' && c <= '9';
  return String(build)
    .replace(/[^A-Za-z0-9 ._-]/g, '?')
    .replace(/\./g, (dot, i, text) => (digit(text.charAt(i - 1)) && digit(text.charAt(i + 1)) ? dot : '?'))
    .slice(0, 60);
}

/** An ISO 8601 UTC time to the second, or '' when ms is not a valid time. */
function isoAt_(ms) {
  const date = new Date(ms);
  return isFinite(date.getTime()) ? date.toISOString().replace(/\.\d{3}Z$/, 'Z') : '';
}

/**
 * A failure in the email path (settings, mail, queue or digest): logged, never thrown into
 * a post's reply. The log has the error kind and message, with any address masked.
 */
function emailFailed_(stage, err) {
  const name = err && err.name ? err.name : 'Error';
  const message = err && err.message ? String(err.message).replace(/[^\s@]+@[^\s@]+/g, '<address>').slice(0, 200) : '';
  console.error('email failed (' + stage + '): ' + name + (message ? ': ' + message : ''));
}

/**
 * Strings are written with a leading apostrophe, which Sheets reads as "this is text"
 * and does not store: a value is never run as a formula ("=...") and never turned into
 * a number, date or boolean. Numbers and booleans keep their type; null is an empty cell.
 */
function toCell_(value) {
  if (value === null || value === undefined || value === '') return '';
  if (typeof value === 'string') return "'" + value;
  return value;
}

function duplicate_() {
  console.log('duplicate batch');
  return reply_({ ok: true, appended: 0, duplicate: true });
}

function cacheGet_(key) {
  try {
    return CacheService.getScriptCache().get(key);
  } catch (err) {
    console.warn('cache get failed');
    return null;
  }
}

function cachePut_(key, value, seconds) {
  try {
    CacheService.getScriptCache().put(key, value, seconds);
  } catch (err) {
    console.warn('cache put failed');
  }
}

function spreadsheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('script is not bound to a spreadsheet');
  return ss;
}

function reply_(body) {
  return ContentService.createTextOutput(JSON.stringify(body)).setMimeType(ContentService.MimeType.JSON);
}

/** An invalid post: the client does not send it again. The log shows the reason only. */
function rejected_(err) {
  console.warn('rejected: ' + err.reason);
  return reply_({ ok: false, error: err.message, retry: false });
}

/**
 * Unexpected failure: the client keeps the rows and tries again later. Service error
 * messages describe the failure, not the payload (JSON parse errors, which quote the
 * payload, never get here).
 */
function serverError_(stage, err) {
  const name = err && err.name ? err.name : 'Error';
  const message = err && err.message ? String(err.message).slice(0, 200) : '';
  console.error('server error (' + stage + '): ' + name + (message ? ': ' + message : ''));
  return reply_({ ok: false, error: 'server', retry: true });
}

/** A validation failure. The reply shows reason and place; the log shows the reason only. */
function invalid_(reason, where) {
  const err = new Error(where ? reason + ' (' + where + ')' : reason);
  err.invalid = true;
  err.reason = reason;
  return err;
}

function isObject_(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isText_(value) {
  return typeof value === 'string' && value.length <= MAX_TEXT;
}

function own_(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function isoNow_() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function utf8Length_(text) {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c < 0xdc00) {
      bytes += 4; // a surrogate pair is one 4-byte character
      i++;
    } else bytes += 3;
  }
  return bytes;
}
