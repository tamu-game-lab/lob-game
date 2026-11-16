# LOB Game play data dictionary

Schema version: **1** (2026-10-28, Marathon 7, SR49). Mirrored in the release repo as `docs/data-dictionary.md`.

Rules:
- Every new field is added here first, with a schema version bump.
- The data holds no names, emails, student numbers or free text.
- Players are identified only by a study ID they make themselves (section 3). Nobody holds a list of IDs or a key from IDs to names.

## 1. How data travels
- **The client.** The game (`PlaytestService`) queues rows and posts them in batches: about once a minute, at every run end, and at Finish session.
  - Each post is one HTTP POST of JSON with `Content-Type: text/plain;charset=utf-8`, so the browser sends no CORS preflight.
  - Posts never block play. A post that gets no reply, an HTTP error or any reply but `ok:true` is resent with the same batch id after an exponential backoff with jitter: 5 s doubling, times 0.5-1.5, never more than 20 s (before W3, a 5 min cap). Only a `retry:false` reply stops the resending (see "Server reply").
  - From W3 (WO-98), Finish session never waits for the receiver: it queues the finish row, asks for a send at once and returns. The queue keeps sending in the background while the Finish screen counts the posts sent. "Download my data" appears only when rows are still unsent 120 s or more after Finish and the latest try failed (or the receiver refused them), and never within 20 s of a post the receiver acknowledged; a later acknowledgment withdraws it.
  - On the Web, pending rows are kept in the browser's local storage (`lob_pt_queue_v1`, section 11), so they survive a page reload. The queue is persisted only when dirty; a failed write keeps it dirty for retry.
  - On `pagehide`, the Web page sends the next unsent batch with `navigator.sendBeacon` as `text/plain`, unless its UTF-8 JSON exceeds 60 KB. C# refreshes the page's endpoint and batch JSON at most once a second when the batch changes. The beacon uses the same batch id as the queued POST, so the server deduplicates it; the client retains the rows until a POST is acknowledged.
  - A sending mode with a blank endpoint retains pending rows for "Download my data" without acknowledging them or making a network call, and offers the download at once at Finish. The download contains only the current session's rows.
- **The sinks.** In the Editor and the Windows build, the same rows go to a local JSONL file instead of the network (`<persistentDataPath>/Playtest/session_<session>.jsonl`). `?mode=off` sends nothing and writes no rows, but still keeps local progress and settings (section 11).
- **The server.** The Google Apps Script web app (`apps-script/Code.gs` in the release repo):
  - validates each post;
  - ignores a batch id it has already appended, so retries never duplicate rows;
  - takes a lock and appends rows to the tab for their kind and mode, by header name (in every mode, any well-formed ID: there is no ID check);
  - adds a column when a new field arrives, up to 60 columns a tab (a post that would add more is refused whole, without retry);
  - stamps `server_time`.

### Post body
```json
{
  "schema": 1,
  "mode": "tryout",
  "build": "W1 2026-10-28",
  "code": "BLU4821",
  "session": "8f0c2a6e-3b1d-4d7e-9a51-2f6c0b9d4e11",
  "batch": "5d2b7f90-1c44-4b0e-8f3a-6e7d9c1a2b3c",
  "sent_at": "2026-10-28T19:05:12Z",
  "rows": [ { "kind": "progress", "row_seq": 7, "client_time": "2026-10-28T19:04:58Z", "node": "bars_to_lines", "action": "complete", "seconds": 142 } ]
}
```
At most 100 rows and 200 KB per post.

### Server reply
- `{"ok":true,"appended":N,"tabs":{"<tab>":n,…}}`: done. `tabs` (receiver 1.2.0) counts the rows appended per tab name, for example `{"ok":true,"appended":3,"tabs":{"sessions":1,"events":2}}`, so a check can see where a session's rows went. The game ignores it. It is a reply field, not a data field: nothing is stored, and the schema stays 1. Receivers before 1.2.0 reply without it.
- `{"ok":true,"appended":0,"duplicate":true}`: a retry of a batch already stored (no `tabs`).
- `{"ok":false,"error":"<reason>","retry":false}`: invalid; the client drops the batch into the "Download my data" file rather than retrying forever.
- `{"ok":false,"error":"busy"|"server","retry":true}`: try again later.
- The client retries any other reply like `busy`: an `ok:false` without `retry:false`, or a page that is not the receiver's JSON.

### doGet
- `?op=health` returns `{"ok":true,"schema":1,"script":"<script version>","time":"<ISO>"}`.
- `?op=code&code=BLU4821` returns `{"ok":true,"known":true|false}`. From receiver 1.2.0 there is no list of codes: `known` is `true` for every well-formed code (section 3, `BLU4821` and `P042` alike) and `false` for anything else (`blue4821x`). It stays for builds before W5i, which ask it before study mode; W5i and later never ask.

## 2. Modes (from the link)
| Link | Mode | Rows go to | ID check |
|---|---|---|---|
| (none) | tryout | `tryout_*` tabs | none: any well-formed ID passes |
| `?mode=study` | study | `sessions`, `progress`, `runs`, `events`, for every well-formed ID (receiver 1.2.0) | none: any well-formed ID passes; the game does not ask the receiver |
| `?mode=off` | off | no rows are sent or written; local progress is still kept (section 11) | none: any well-formed ID passes |
| `?mode=test` | test | `test_*` tabs (automated smoke test only; not linked anywhere) | none: any well-formed ID passes |

- The `mode` key is case-insensitive. Unrecognized mode values are refused on the ID screen.
- `?id=BLU4821` fills in the color and the digits on the ID screen only when the value is a color ID (section 3), so a pre-test survey can hand off to the game. Any other value, an old-style code such as `P042` included, is ignored and the screen opens empty.
- Before receiver 1.2.0, a study-mode post whose code was not active in the old `codes` tab went to `unmatched` (section 3); those rows stay there.
- `?fps=1` shows a frame counter. It is not data.
- Tryout data is never research data (SR49): tryout and test tabs are for usability work only.
- Local intro-seen, visited, concept-progress, started and flow-step state is keyed by both mode and code; concept progress uses `lob.map.v1.<mode>.<CODE>` (section 11 lists every key). Tryout completion never unlocks study content.
- Save ownership is stored separately from the unchanged save format under `lob.save.owner` and `lob.run.owner`. Continue is offered only to the owning code; a legacy slot without an owner remains available to any code.

## 3. Study ID
- **Made by the player** (Marathon 11 decision 0). On the ID screen the player picks a favorite color from twelve buttons and types the last four digits of their phone, exactly four digits. The stored ID is the color's three letters and the four digits: `BLU4821`. Nobody holds a list of IDs or a key from IDs to names, and the four digits never appear apart from the ID.

| Color | Code | Color | Code | Color | Code |
|---|---|---|---|---|---|
| Red | `RED` | Teal | `TEL` | Brown | `BRN` |
| Orange | `ORG` | Blue | `BLU` | Black | `BLK` |
| Yellow | `YEL` | Purple | `PUR` | White | `WHT` |
| Green | `GRN` | Pink | `PNK` | Gray | `GRY` |

- **Format, the data's gate (unchanged):** 1-3 letters then 1-4 digits (`^[A-Za-z]{1,3}[0-9]{1,4}$`), stored upper-case. The game and the receiver refuse anything else in every mode (the receiver with `retry:false`). The screen makes only color IDs (one of the twelve codes and exactly four digits); the colors are buttons and the digits field takes four digits, so nothing typed can carry a name, email or student number. Sessions from builds before W5i carry assigned codes such as `P042`, which pass the same gate.
- **Two players can, rarely, make the same ID.** The `session` id still separates their sessions.
- **Automated checks** use the IDs `GRY0000` to `GRY0009` (test mode; `GRY0000` also in study mode for the one check after the receiver 1.2.0 deploy). Filter those rows out before analysis.
- **The retired codes tab.** Before receiver 1.2.0 the Sheet's `codes` tab (columns `code` and `active`) listed the study codes, and study-mode rows whose code was not active there went to `unmatched` with `target_tab`, never dropped. From 1.2.0 the `codes` tab is not read and nothing new goes to `unmatched`; both tabs stay in the Sheet as they are, and the `codes` tab may be deleted.

## 4. Fields on every row
| Field | Type | Example | Meaning |
|---|---|---|---|
| kind | text | `progress` | Row type: `session`, `progress`, `run`, `event`. Selects the tab. |
| schema | integer | 1 | Schema version of this dictionary. |
| mode | text | `tryout` | `study`, `tryout` or `test`. |
| build | text | `W1 2026-10-28` | Build label and date. |
| code | text | `BLU4821` | Study ID (section 3). |
| session | text (UUID) | `8f0c…4e11` | One per ID-screen Continue. A reload keeps the session only when code, mode and build match (within the resume window). |
| row_seq | integer | 7 | Order of the row within its session, from 1. |
| client_time | text (ISO 8601 UTC) | `2026-10-28T19:04:58Z` | When the game made the row. |
| server_time | text (ISO 8601 UTC) | `2026-10-28T19:05:13Z` | Added by the server on append. |
| target_tab | text | `progress` | Legacy: only on `unmatched` rows filed before receiver 1.2.0, the tab the row would have gone to. No longer written. |

The game repeats the five post fields (`schema`, `mode`, `build`, `code`, `session`) on each row; the server checks that they match the post (`code` compared upper-case; a mismatch rejects the post) and stores the post's values.

## 5. sessions (kind = `session`)
| Field | Type | Values | Meaning |
|---|---|---|---|
| phase | text | `start`, `finish` | `start` at ID-screen Continue; `finish` at Finish session. |
| platform | text | `web`, `windows`, `editor` | Where the game ran. |
| browser | text | `chrome`, `edge`, `firefox`, `safari`, `other`, `none` | Browser family only (not the full user agent). |
| screen | text | `1920x1080` | Canvas size in pixels at start. |
| first_visit | boolean | TRUE | No earlier session for this mode and code on this browser. |
| intro_seen | boolean | FALSE | The intro was viewed before this session for this mode and code on this browser. |
| seconds | integer | 1834 | (finish) Seconds from start to finish. |
| nodes_completed | integer | 4 | (finish) Distinct concept-map node ids completed this session. |
| runs | integer | 3 | (finish) Runs started this session. |
| pending | integer | 0 | (finish) Rows still unsent when Finish was pressed. |
| downloaded | boolean | FALSE | (finish) Clicking "Download my data" appends a finish status row with TRUE and a new `row_seq`; existing queued and beacon batch rows remain immutable for deduplication. The file contains only the finished session's pending rows. |

## 6. progress (kind = `progress`): the concept map
| Field | Type | Values | Meaning |
|---|---|---|---|
| node | text | `bar_chart` | Concept-map node id (`MD Files\_concept_map.md`). |
| action | text | `open`, `complete`, `leave` | The node was opened, completed, or left unfinished. |
| seconds | integer | 142 | Seconds in the node (`complete`, `leave`). |
| attempts | integer | 2 | Attempts at the node's task, where it has one. |
| level | text | `L08` | The training or route the node opens, if any. |

## 7. runs (kind = `run`): decision 44 run summaries
| Field | Type | Values | Meaning |
|---|---|---|---|
| run | text (UUID) | `c41e…` | Decision 44 run id. |
| phase | text | `start`, `end` | Run start or end. |
| level | text | `sandbox`, `L07_TutorialEventResponse` | Route or level id (internal ids, not display numbers). Added by the game, not by decision 44's line. |
| node | text | `event_response` | The concept-map node it was opened from, if any. |
| site | text | `seoul` | (start) The site or city profile id (decision 44's `project`). |
| difficulty | text | `normal` | Tier. |
| seed | integer | 123456 | Root seed (decision 44). |
| deadline | integer | 100 | (start) Deadline day. |
| budget | number | 650000 | (start) The run's starting budget. |
| guided | boolean | FALSE | (start) The guided Training 8 bridge. |
| day | integer | 46 | Sim day of the line (0 at start). |
| outcome | text | `won`, `lost` | (end) How it ended. Abandoning is recorded as a `run_abandoned` event, not a run outcome. |
| reason | text | `deadline` | (end) The engine's outcome reason id. |
| score | number | 1840 | (end) The run's final score. |
| budget_left | number | 37500 | (end) Budget remaining at the end. |
| seconds | integer | 615 | (end) Real seconds played. Added by the game. |

## 8. events (kind = `event`): decision 44 telemetry lines and lesson events
| Field | Type | Values | Meaning |
|---|---|---|---|
| run | text | `c41e…` | Decision 44 run id; empty for lesson events outside a run. |
| seq | integer | 12 | Decision 44 sequence within the run; for lesson events, the session's own count. |
| day | integer | 9 | Sim day (0 outside a run). |
| type | text | `planning_stop`, `intro_view` | The telemetry event type (decision 44), or a lesson event (below). |
| detail | text (JSON) | `{"crew":"PipeLaying"}` | The line's own key/value pairs as compact JSON. Values come from the game, never from player typing. |

Run abandonment is an event with `type=run_abandoned`, emitted when the player abandons the run; it is not `runs.outcome=quit`.

Lesson event types:
- `intro_view` (`detail`: `{"part":"crews"}` …);
- `intro_skip`;
- `task_attempt` (`detail`: `{"node":"bar_chart","correct":false}`); in Site preparation the risk flagged on the site card, logged and never graded (`detail`: `{"node":"site_preparation","flag":"P1"}`, the event id);
- `audio_change` (`detail`: `{"mode":"full|background|off","volume":n}`, for example `{"mode":"background","volume":0.6}`): the main screen's Audio setting (SIM.L15) and master volume, logged when either changes. Before W3 the detail held only `volume`.

PM suggestion event types (SR53, Marathon 10 decision 15). Event response, Site preparation and the Sandbox's Easy and Normal tiers write them. Every value is composed by the game, never player typing:
- `pm_suggestion` (`detail`: `{"id":"job.P1.borrow.heavy","family":"P1","stop":"1"}`): the PM spoke a suggestion.
  - `id` is composed `job.<event>.<action>[.<size>][.<crew>][+<days>]`: the event id as written (`E1`, `P1`), the action (`play`, `fix`, `hire`, `borrow`), the size for a hire or a borrow, the crew only for a site-wide hire, and each later start as `.<crew>+<days>` (`job.P1.borrow.heavy.backfill+1`). Before a Site preparation or Sandbox run the advice is `job.advise` plus the suggested preventions joined by `+` (`job.advise.P1+B1+A2`), or `job.advise` alone for none.
  - `family` is the event id; for the advice, the event flagged on the site card.
  - `stop` is the event's index in the run; 0 for the advice before the run.
- `pm_suggestion_used` (`detail`: `{"id":"job.P1.borrow.heavy","used":"true","stop":"1"}`): written at Play for each suggestion spoken at that pause (for the advice, at Run). `used` is `true` when the chosen response and later starts are the suggestion (for the advice, when the bought preventions are the suggested set), otherwise `false`.

Sandbox crowding edges (WO-130, SR49), emitted once per crew when accepted daily seating changes between crowded and clear:
- `crowded`: at least one assigned, available machine waits for room.
- `crowded_end`: that crew no longer has a machine waiting for room.

Both use the existing model-record payload: `detail` is exactly one crew enum (`Excavation`, `PipeLaying`, `Backfill`), `profile` is the city id, and `configuration` is the catalog version. The row's `day` is the accepted day. No player text, names or email addresses. No daily repetition and no record for a crew that never crowds. The telemetry schema remains 1; the run-save schema is 9 since Marathon 10 (section 9).

## 9. Change log
| Schema | Date | Change |
|---|---|---|
| 1 | 2026-11-16 | Marathon 11 decision 0 (WO-170, WO-171), receiver 1.2.0: the player makes the study ID (a color's three letters and four digits, `BLU4821`; section 3), so there is no list of codes and no key to names. In study mode every well-formed ID goes to the study tabs; the `codes` tab is no longer read and nothing new goes to `unmatched` (`target_tab` is legacy). `?op=code` answers `known` for any well-formed code. The success reply gains `tabs`, a reply field only. Automated checks use `GRY0000` to `GRY0009`. No new fields or columns; the schema stays 1. |
| 1 | 2026-11-04 | Marathon 10's one model (decision 16, WO-162). Run rows keep their fields with these meanings: `budget` the run's budget (the frame), `budget_left` the budget minus the total, `score` the stars (0 to 3), `deadline` the deadline day, `reason` an id (`finished`, `late`), `site` the city id. In the Sandbox each report card writes one complete progress row whose `attempts` is the attempt (1 for the first try, one more for each retry on the same site), and the run's `seed` is that attempt's draw seed (7919 x the attempt); a lesson's `seed` is 0. `task_attempt` keeps its `flag` key (WO-159). `pm_suggestion` ids are composed by the game (section 8); the retired `pm_suggestions.json` ids are no longer written. The run-save schema goes to 9 and an older run save reads as no run (decision 17); `save.json` and `attempts.json` are left untouched and no longer written. No new fields or columns; the schema stays 1. |
| 1 | 2026-11-02 | `crowded` and `crowded_end` model-record event types (WO-130); existing payload and columns. |
| 1 | 2026-11-03 | `task_attempt` detail key `flag` (WO-159): the event id flagged on Site preparation's site card. An existing type and existing columns. |
| 1 | 2026-10-28 | First version (Marathon 7, SR49). |
| 1 | 2026-10-31 | `pm_suggestion` and `pm_suggestion_used` event types (SR53). They are `detail` keys in the existing events tab, so no column changes and the schema stays 1. |

## 10. Admin tabs
The receiver's version is `lob-receiver 1.2.0 (2026-11-16)` (Marathon 11, the self-made study ID), which `?op=health` shows once the study lead deploys it as a new version of the same deployment; until then the live one answers with its older version. Receiver 1.1.0 (the SR49 amendment, session emails) added two admin tabs. They hold no play data, so the schema stays 1:
- `settings` (`key`, `value`): `email_mode` (`off`, `session` or `digest`), `email_to` (blank: the deploying account) and `digest_minutes`. `setupSettings()` makes it (`docs/apps-script-setup.md`, Part 7). Once it exists, `?op=health` also returns `email`, the mode in effect, and lists any setting it could not use under `ignored_settings` (keys only).
- `digest_queue`: in digest mode, one line per finished session until the next digest email sends and deletes it: `code`, `mode`, `build`, `start`, `finish`, the finishing post's rows per tab (`added_sessions` to `added_unmatched`; from 1.2.0 `added_unmatched` is always 0) and `queued_at`. The session emails' total rows for an ID still count any rows a receiver before 1.2.0 filed for it in `unmatched`.

## 11. Browser storage
The game keeps these keys in the browser's local storage (in the Editor and the Windows build, as files under `<persistentDataPath>/Playtest/`). Each holds only local progress, a setting or rows waiting to be sent, never names or free text; a code in them (`<CODE>`, the session's code) is the study ID (section 3).

| Key | Holds |
|---|---|
| `lob_pt_session_v1` | The current session (code, mode, build, session id, start time, next `row_seq` and its finish row's counts), so a reload can resume it (section 4), and the mode-and-code pairs that have visited or seen the intro. |
| `lob_pt_queue_v1` | Each session's rows the receiver has not acknowledged yet, so a reload resumes sending; "Download my data" exports them. |
| `lob.map.v1.<mode>.<CODE>` | The concept-map nodes this code has completed in this mode. |
| `lob.map.v1.started.<mode>.<CODE>` | The nodes this code has opened in this mode, done or not (SR52). |
| `lob.flow.v1.<mode>.<CODE>` | The step of the opening flow (SR51) this code has reached in this mode, so a return resumes there. |
| `lob_audio_mode_v1` | The Audio setting: `full`, `background` or `off` (SIM.L15). |
| `lob_master_volume_v1` | The master volume, from 0 to 1. |
| `lob.save.owner`, `lob.run.owner` | The code that owns the saved game or the saved run (section 2). Not written since Marathon 10 (no level save, no mid-run restore); an older one is left untouched. |

`?mode=off` sends nothing and writes neither `lob_pt_session_v1` nor `lob_pt_queue_v1`, but still keeps local progress (under the mode `off`) and the audio settings. Before Marathon 10, Unity itself kept the saved game and the saved run, and two game preferences (`lob.tutorial5_complete`, `lob_project_last_failed_site`), in the browser's IndexedDB: game state only. The game no longer writes them (WO-162); an older copy is left untouched.
