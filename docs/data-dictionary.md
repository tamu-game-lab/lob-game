# LOB Game play data dictionary

Schema version: **1** (2026-10-28, Marathon 7, SR49). Mirrored in the release repo as `docs/data-dictionary.md`.

Rules:
- Every new field is added here first, with a schema version bump.
- The data holds no names, emails, student numbers or free text.
- Players are identified only by a study ID they make themselves (section 3). Nobody holds a list of IDs or a key from IDs to names.
- A new event type or `detail` key is not a new field: it is added here (section 8 and the change log) before the build that writes it, and the schema stays 1.

## 1. How data travels
- **The client.** The game (`PlaytestService`) queues rows and posts them in batches. From build W8: about every three minutes (the batch interval is 180 s, each wait spread from 0.8 to 1.2 times that, so 144 to 216 s) and at Finish session, never at a run's end; the request timeout is 30 s. Builds before W8: about once a minute, at every run end, and at Finish session.
  - Each post is one HTTP POST of JSON with `Content-Type: text/plain;charset=utf-8`, so the browser sends no CORS preflight.
  - Posts never block play. A post that gets no reply, an HTTP error or any reply but `ok:true` is resent with the same batch id after an exponential backoff with jitter: 5 s doubling, times 0.5-1.5, never more than 20 s (before W3, a 5 min cap). Only a `retry:false` reply stops the resending (see "Server reply").
  - From W3 (WO-98), Finish session never waits for the receiver: it queues the finish row, asks for a send at once and returns. The queue keeps sending in the background while the Finish screen counts the posts sent. "Download my data" appears only when rows are still unsent 120 s or more after Finish and the latest try failed (or the receiver refused them), and never within 20 s of a post the receiver acknowledged; a later acknowledgment withdraws it.
  - On the Web, pending rows are kept in the browser's local storage (`lob_pt_queue_v1`, section 11), so they survive a page reload. From W7 (WO-218) the queue and the session's next `row_seq` are saved together each time a row is queued, so a row survives a crash or a closed tab and its number is never used again; before W7 they were saved at most once a second, and rows of the last second before a crash could be lost and their numbers used again. A failed write keeps them unsaved for retry.
  - Each row is checked before it is queued. From W7 a check that runs out of time keeps the row (the receiver checks it again); a row that fails the check is dropped with one console warning that names only its kind and type, and its `row_seq` stays unused (a gap). Before W7 a check that ran out of time dropped the row without a warning.
  - On `pagehide`, the Web page sends the next unsent batch with `navigator.sendBeacon` as `text/plain`, unless its UTF-8 JSON exceeds 60 KB. C# refreshes the page's endpoint and batch JSON at most once a second when the batch changes. The beacon uses the same batch id as the queued POST, so the server deduplicates it; the client retains the rows until a POST is acknowledged.
  - **A continued session (from W10, WO-265, decision E3).** After Finish session the finish card offers Continue session, which begins the same ID as a new session (section 5). The finished session's rows keep their own queue, batches and batch ids and go on sending as after any Finish, also when Continue session is pressed before they are all sent; the two sessions' posts take turns, the finished session's first. In the continued session only: each report card sends at once (its `progress` `complete` row asks for every queued row of that session to be sent, so a Sandbox run goes out when its card shows); the three-minute interval also goes on. And at `pagehide` the page also sends, after the beacon above, that session's reserved batch (when the beacon does not hold it) and one more batch over the rows after it, up to 100 rows and 60 KB, each with `navigator.sendBeacon` as `text/plain;charset=utf-8`, the same body as a POST, until the browser refuses one. Each of those batch ids is saved in the browser before the page holds it, and the queue later posts those rows under the same id, so the receiver keeps each row once. If the page lives on after `pagehide` (the browser's back-forward cache), the game keeps those ids and rows as they were. A beacon is not acknowledged: the rows stay queued until a POST is, and are resent when the game is opened again in that browser. What a browser lets a page send at `pagehide` is limited (about 64 KB in all in Chromium browsers, and nothing at all when the browser is killed or the laptop sleeps first), so a continued session closed without Finish can leave its last rows only in that browser; the report card's send makes those at most the rows since the last card.
  - A sending mode with a blank endpoint retains pending rows for "Download my data" without acknowledging them or making a network call, and offers the download at once at Finish. The download contains only the current session's rows.
- **The sinks.** In the Editor and the Windows build, the same rows go to a local JSONL file instead of the network (`<persistentDataPath>/Playtest/session_<session>.jsonl`). `?mode=off` sends nothing and writes no rows, but still keeps local progress and settings (section 11).
- **The local run file.** In the Editor and the Windows build only, every run line (`run_start`, `planning_stop`, the PM lines, `run_end`) is also appended to `<persistentDataPath>/PMO/Telemetry/run_<run>.jsonl` in the decision 44 format, in every mode, `off` included. It is not sent and not on the Web. The study event types of section 8 (D2's and E7's) are not in it.
- **The server.** The Google Apps Script web app (`apps-script/Code.gs` in the release repo):
  - validates each post;
  - ignores a batch id it has already appended, so retries never duplicate rows;
  - takes a lock and appends rows to the tab for their kind and mode, by header name (in every mode, any well-formed ID: there is no ID check);
  - adds a column when a new field arrives, up to 60 columns a tab (a post that would add more is refused whole, without retry);
  - stamps `server_time`.
  - It does not check event types or `detail` keys, so a new type or key needs no receiver change.

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
| build | text | `W7` | The build's label. Rows of build W7 read `W7` with no date; some earlier builds wrote a label and a date (`W1 2026-10-28`). |
| code | text | `BLU4821` | Study ID (section 3). |
| session | text (UUID) | `8f0c…4e11` | One per ID-screen Continue, and from W10 one per Continue session on the finish card (section 5). A reload keeps the session only when code, mode and build match, within 12 hours of the session's first start. After a reload the ID screen opens again and the session resumes when the player presses Continue with the same ID; the resumed session writes a second `start` row (section 5) and, from W7, a `resume` event (section 8). |
| row_seq | integer | 7 | Order of the row within its session, from 1. |
| client_time | text (ISO 8601 UTC) | `2026-10-28T19:04:58Z` | When the game made the row. |
| server_time | text (ISO 8601 UTC) | `2026-10-28T19:05:13Z` | Added by the server on append. |
| target_tab | text | `progress` | Legacy: only on `unmatched` rows filed before receiver 1.2.0, the tab the row would have gone to. No longer written. |

The game repeats the five post fields (`schema`, `mode`, `build`, `code`, `session`) on each row; the server checks that they match the post (`code` compared upper-case; a mismatch rejects the post) and stores the post's values.

**Money and builds.** Money values from build W7 on include the site cost (Marathon 12 decision B1: a cost for each day of the job from Day 1 to its last day, $100 a day in the lessons and $1,000 in the Sandbox, on a line of its own beside indirect at 30% of direct, with profit at 5% of direct plus indirect plus the site cost). This applies to `runs.budget`, `runs.budget_left` and every `total` in section 8. Builds before W7 do not include it, so an analysis keeps builds apart by `build`.

## 5. sessions (kind = `session`)
| Field | Type | Values | Meaning |
|---|---|---|---|
| phase | text | `start`, `finish` | `start` at ID-screen Continue, and from W10 at the finish card's Continue session; `finish` at Finish session (the map's button, and from W10 also Site preparation's report card, which reads FINISH SESSION). A resumed session (section 4) writes `start` again with the same `session`, with `first_visit` FALSE. |
| platform | text | `web`, `windows`, `editor` | Where the game ran. |
| browser | text | `chrome`, `edge`, `firefox`, `safari`, `other`, `none` | Browser family only (not the full user agent). |
| screen | text | `1920x1080` | Canvas size in pixels at start. |
| first_visit | boolean | TRUE | No earlier session for this mode and code on this browser. |
| intro_seen | boolean | FALSE | The intro was viewed before this session for this mode and code on this browser. |
| seconds | integer | 1834 | (finish) Seconds from the session's first start to finish. For a resumed session this includes the time between the reload and the return. |
| nodes_completed | integer | 4 | (finish) Distinct concept-map node ids completed this session. |
| runs | integer | 3 | (finish) Runs started this session. |
| pending | integer | 0 | (finish) Rows still unsent when Finish was pressed, not counting the finish row itself. Rows made since the last batch are usually still pending (up to about three minutes of play from build W8, about one minute before it), so a value above 0 is normal; the rows the receiver holds against `row_seq` show whether any were lost. |
| downloaded | boolean | FALSE | (finish) Clicking "Download my data" appends a finish status row with TRUE and a new `row_seq`; existing queued and beacon batch rows remain immutable for deduplication. The file contains only the finished session's pending rows. |

**A continued session (from W10, WO-265, decision E3).** From build W10 the session ends on Site preparation: its report card's Next reads FINISH SESSION, the same finish as the map's. The finish card then offers Continue session (after the questionnaire's button, where there is one). Continue session begins the same `code` again without the ID screen, as a new session: a new `session` id, its own `start` row with `row_seq` 1 (`first_visit` FALSE on that browser), and as its row 2 an `events` row of type `continue` whose `detail` names the finished session (section 8). Its lessons' progress is the code's, so the game opens the Sandbox at once when Site preparation is done, else the map. Nothing of the finished session changes: its `finish` row, its counts and its sending are as after any Finish. The continued session is recorded like any play, in the same tabs, columns and kinds. A reload inside it resumes it (a second `start`, then `resume`). Finish session still ends it, with its own `finish` row; a continued session that is never finished has no `finish` row, and its rows are sent at each report card, every three minutes and at `pagehide` (section 1). Continue session can be pressed again after that Finish, which makes a third session the same way.

## 6. progress (kind = `progress`): the concept map
| Field | Type | Values | Meaning |
|---|---|---|---|
| node | text | `bar_chart` | Concept-map node id (`MD Files\_concept_map.md`). |
| action | text | `open`, `complete`, `leave` | The node was opened, completed, or left unfinished. A reload or a closed tab writes no `leave` for the visit it cuts off. After a resume (a reload, the reload panel's button, or a tab opened again) the game writes an `open` and, a second later, a `leave` with `seconds` 0 for the lesson that was open at the break: that `leave` is the resume's, not a player leaving. |
| seconds | integer | 142 | Seconds in the node (`complete`, `leave`). |
| attempts | integer | 2 | Attempts at the node's task, where it has one: in the Sandbox the attempt on its site (1 for the first try, one more for each retry); from W7 in Bars to lines the number of `task_attempt` releases (section 8) in that opening. |
| level | text | `bar_chart` | The node id again for every lesson and the Sandbox (`event_response`, `sandbox_run`); absent on the intro's rows. |

## 7. runs (kind = `run`): decision 44 run summaries
| Field | Type | Values | Meaning |
|---|---|---|---|
| run | text | `9f2c4e7a1b3d4c5e8f6a7b9c0d1e2f3a` | The site run's id, 32 hex digits. New on every load of a lesson, Plan again, Replan and Sandbox Retry. |
| phase | text | `start`, `end` | Run start or end. |
| level | text | `event_response`, `sandbox_run` | The node id (internal ids, not display numbers). Added by the game, not by decision 44's line. |
| node | text | `event_response` | The concept-map node it was opened from, if any. |
| site | text | `chicago` | (start) The site or city profile id (decision 44's `project`). |
| difficulty | text | `normal` | Tier, lower-case; `normal` for every lesson. |
| seed | integer | 7919 | Root seed: 0 in a lesson, 7919 x the attempt in the Sandbox. |
| deadline | integer | 10 | (start) The last day on which finishing is on time, the day the player sees ("Deadline Day 9", "10 days or less"), counted from Day 1 like `days` and the end row's `day`, so `late` = max(0, `days` - `deadline`); absent where the lesson has none. From build W8. Build W7 wrote one more (the chart's mark at the end of that day): subtract 1 where `build` is `W7`. Builds before W7 wrote the first start's day plus the deadline's days. |
| budget | number | 31321 | (start) The run's budget; absent where the lesson has none. |
| guided | boolean | FALSE | (start) Always FALSE. |
| day | integer | 17 | Sim day of the line (0 at start, the last day at end). |
| outcome | text | `won` | (end) Always `won`: every run that reaches its end is finished. Lateness is in `reason`. `lost` is not written. |
| reason | text | `finished`, `late` | (end) The engine's outcome reason id. |
| score | number | 2 | (end) The run's stars, 0 to 3 (0 where the lesson has no targets). From W7, in Crew spacing, the stars of the report card's two gap targets (the 1-day gap and the 5-day gap); before W7 there the stars of the exercise's own target, which could differ from the card. |
| budget_left | number | 4977 | (end) The budget minus the total; absent without a budget. |
| seconds | integer | 615 | (end) Real seconds since `run_start` in this page. Added by the game. From build W8 each stop whose event draws a hit holds at least half a second more than in W7 (the card opens 2.0 s after the stop, not 1.5 s); from build W9 at least 1.1 s more (2.6 s: the camera eases in for 0.6 s first, unless the browser asks for reduced motion). |

A run left before its end (Back and Leave, Plan again, a conflict card's Replan, a reload or a closed tab) has a `start` row and no `end` row. There is no abandon row (section 8).

## 8. events (kind = `event`): decision 44 telemetry lines and lesson events
| Field | Type | Values | Meaning |
|---|---|---|---|
| run | text | `9f2c…2f3a` | The site run's id; empty for lesson events outside a run, for the site card's `task_attempt` flag, for `resume` and (from W10) for `continue`. |
| seq | integer | 12 | For run lines (`planning_stop`, the PM lines): decision 44's sequence within the run. Run rows take numbers from it without carrying `seq`, and the advice lines take numbers before `run_start`, so within a run it can start at 1 or at 2 and can skip a number (in a run with the PM's advice it starts at 1 and skips the number `run_start` takes; in Event response it starts at 2 with no gap). For lesson events and the study event types below: the row's own `row_seq`. |
| day | integer | 9 | Sim day (0 outside a run and in planning). |
| type | text | `planning_stop`, `intro_view` | The telemetry event type (decision 44), or a lesson or study event (below). |
| detail | text (JSON) | `{"crew":"PipeLaying"}` | The line's own key/value pairs as compact JSON. Values come from the game, never from player typing. On run lines every value is a JSON string (`{"pending":"1"}`, `{"used":"true"}`); on lesson events and the study event types numbers stay JSON numbers and true and false stay JSON booleans. |

Run abandonment (`run_abandoned`) is named by decision 44 but no build writes it: a left run is a `run_start` (from W7 followed by a `plan`) with no `run_end` and no `result`.

Run lines:
- `planning_stop` (`detail`: `{"pending":"1"}`, always): the run stopped at an event, before its card. It does not name the event (from W7 the `response` row does).

Lesson event types:
- `intro_view` (`detail`: `{"part":"crews"}` …);
- `intro_skip` (`detail`: `{"part":"<the cue skipped at>"}`);
- `task_attempt`:
  - in Site preparation and the Sandbox, the risk flagged on the site card, logged and never graded (`detail`: `{"node":"site_preparation","flag":"P1"}`, the event id; in the Sandbox `node` is `sandbox_run`). One row each time a flag is set. It is written with `run` empty and `day` 0 although a planning run is loaded.
  - from W7, in Bars to lines, see the study event types below. The shape `{"node":"bar_chart","correct":false}` listed before W7 is not written by this build.
- `audio_change` (`detail`: `{"mode":"full|background|off","volume":n}`, for example `{"mode":"background","volume":0.6}`): the main screen's Audio setting (SIM.L15) and master volume, logged when either changes. Before W3 the detail held only `volume`.

PM suggestion event types (SR53, Marathon 10 decision 15). Event response, Site preparation and the Sandbox's Easy and Normal tiers write them. Every value is composed by the game, never player typing:
- `pm_suggestion` (`detail`: `{"id":"job.P1.borrow.heavy","family":"P1","stop":"0"}`): the PM spoke a suggestion.
  - `id` is composed `job.<event>.<action>[.<size>][.<crew>][+<days>]`: the event id as written (`E1`, `P1`), the action (`play`, `fix`, `hire`, `borrow`), the size for a hire or a borrow, the crew only for a site-wide hire, and each later start as `.<crew>+<days>` (`job.P1.borrow.heavy.backfill+1`). Before a Site preparation or Sandbox run the advice is `job.advise` plus the suggested preventions joined by `+` (`job.advise.P1+B1+A2`), or `job.advise` alone for none.
  - `family` is the event id; for the advice, the event flagged on the site card.
  - `stop` is the event's place among the events known so far, counted from 0 (the first event is `"0"`); 0 for the advice before the run. The `id` prefix `job.advise` tells the advice apart.
  - The advice is written once a risk is flagged and again on every change of the plan or the preventions while planning. The PM works the advice out over a few frames, so it is written when it is ready; a Run pressed before it is ready writes no advice line and no advice `pm_suggestion_used`.
  - Crews in an `id` are spelled `excavation`, `pipe_laying`, `backfill`; the study event types below spell them `Excavation`, `PipeLaying`, `Backfill`.
- `pm_suggestion_used` (`detail`: `{"id":"job.P1.borrow.heavy","used":"true","stop":"0"}`): written at Play for each suggestion spoken at that pause (for the advice, at Run, just before `run_start`). `used` is `true` when the chosen response and the later starts in force are the suggestion (for the advice, when the bought preventions are the suggested set), otherwise `false`.

Sandbox crowding edges (WO-130, SR49): `crowded` (at least one assigned, available machine waits for room) and `crowded_end` (that crew no longer has a machine waiting for room). They are defined for the existing model-record payload (`detail` exactly one crew enum, `Excavation`, `PipeLaying`, `Backfill`; `profile` the city id; `configuration` the catalog version; `day` the accepted day), but no build writes them: the crowding is counted in memory only.

### Study event types (Marathon 12 decision D2, from build W7)
Seven lines that show what a player planned and chose. They use the existing columns: kind `event`, a `type`, and `detail` as compact JSON of values the game composes. Nothing in them is typed by the player. For all of them:
- `run` is the site run's id (section 7), except `resume` and (from W10) `continue`, whose `run` is empty.
- `seq` is the row's own `row_seq`.
- `day` is the run's day when the row is made: 0 in planning, the stop's day at an event or a conflict, the day being played otherwise, the last day at the end; 0 for `resume` and `continue`.
- Crews are `Excavation`, `PipeLaying`, `Backfill`. Sizes are `small`, `standard`, `heavy`. Events and preventions are named by their id (`P1`, `B1`, `A2`); a set is joined by `+` in the engine's event order, and an empty set is `""`. Actions are `play`, `fix`, `hire`, `borrow`.
- Days are whole numbers. A start day is the day the player sees on the chart's axis. A job's days are the forecast's or the result's project days.
- Money is in whole dollars and includes the site cost (section 4).
- `?mode=off` writes none of them.
- The examples are the strings the game's EditMode tests check. Where a test takes `days` and `total` from the engine, the numbers shown are the engine's tested values for that plan. None is a row captured from a played session yet.

`plan`: at every Run, right after `run_start`; in the Sandbox at every attempt's Run.

| Key | Format | Meaning |
|---|---|---|
| exc | text `s-t-h` | Excavation's machines by size: the count of small, standard and heavy, joined by `-`. |
| pipe | text `s-t-h` | Pipe laying's machines by size. |
| back | text `s-t-h` | Backfill's machines by size. |
| starts | text `e-p-b` | The start days of Excavation, Pipe laying and Backfill, joined by `-`. |
| prev | text | The preventions bought, joined by `+`; `""` for none. |
| days | integer | The forecast's job days at Run. At Run the forecast knows no event yet. |
| total | integer | The forecast's total at Run, in dollars, preventions included. |
| conflict_days | integer | The forecast's conflict days at Run: the held days of each crew added together (not the number of conflict stops). 0 for none. |

Example (the game's sample plan, the one Fleet planning's targets are set on, nothing bought): `{"exc":"0-1-1","pipe":"0-0-2","back":"0-1-1","starts":"1-3-5","prev":"","days":7,"total":23107,"conflict_days":0}`. With P1 and B1 bought, in either order, `prev` is `"P1+B1"`.

`response`: at every event's Play, once, before the run goes on.

| Key | Format | Meaning |
|---|---|---|
| event | text | The event's id. |
| action | text | `play`, `fix`, `hire` or `borrow`. |
| size | text | (hire, borrow) The machine's size. |
| from | text | (borrow) The crew that lends the machine. |
| to | text | (hire at a site-wide event) The crew that receives the machine. Absent for a hire at an event on one crew, and absent when a site-wide hire has no receiving crew (never `"-1"`). |
| days | integer | The forecast's job days after this response, with the start days in force at Play. |
| total | integer | The forecast's total after this response, in dollars. |
| pm | boolean | TRUE when the response taken is the PM's pick on that card: the card's opening pick, complete with the later starts it needs, as the player has them at Play. It is the same value as `pm_suggestion_used` at that Play. A Play with no row selected takes plain Play (or a hire made with the crew's counter), and is TRUE when that is the PM's pick; a pick whose later starts the player has not made is FALSE. FALSE where the PM is silent (Hard and Hardcore). |

An event Play that the game refuses (a trench collapse cannot be played through) writes nothing; the row comes with the Play that goes through. A run left at an event card (Back then Leave, a reload) has a `planning_stop` and no `response` for that event.

Examples. The test holds the forecast fixed at the plain sample plan's, so `days` and `total` here show the format only, not the cost of each response: a borrow `{"event":"B1","action":"borrow","size":"heavy","from":"Excavation","days":7,"total":23107,"pm":true}`; a fix `{"event":"B1","action":"fix","days":7,"total":23107,"pm":false}`; a hire at a site-wide event `{"event":"A2","action":"hire","size":"heavy","to":"PipeLaying","days":7,"total":23107,"pm":false}`; the same hire with no receiving crew `{"event":"A2","action":"hire","size":"heavy","days":7,"total":23107,"pm":false}`.

`move`: for every start the player moves and every crew the player pauses or lets go on. One row per drag, written at the release, for each crew whose start changed (never one per day crossed; a start dragged back to where it was writes none); one row per pause and one per resume. Once the run has begun the chart lets a start move only later, so `earlier` comes only from planning. When one drag moves two crews, both rows carry the same `conflict_before` and `conflict_after`.

| Key | Format | Meaning |
|---|---|---|
| crew | text | The crew moved. |
| move | text | `later` (a later start), `earlier` (an earlier start, in planning only), `pause` (a started crew stops, paid), `resume` (a paused crew goes on). |
| days | integer | (later, earlier) The whole days the start moved, always positive. (resume) The whole days that passed while the crew stood paused, 0 when it goes on the same day. A `pause` has no `days`: its length is known only at its `resume`; a pause never resumed lasts to the run's end. |
| at | text | When: `planning` (before Run), `event` (an event card is open), `conflict` (the run stands at a conflict), `other` (the run is playing or paused). |
| conflict_before | boolean | TRUE when, just before the move, the forecast shows a conflict still ahead: the same conflict the screen's red circle marks. Conflicts already met earlier in the run do not count. |
| conflict_after | boolean | The same, just after the move. |

Example: `{"crew":"Backfill","move":"later","days":1,"at":"event","conflict_before":true,"conflict_after":false}`; a later start that clears the conflict ahead although conflict days were already met: `{"crew":"Backfill","move":"later","days":48,"at":"other","conflict_before":true,"conflict_after":false}`; an earlier start in planning: `{"crew":"Backfill","move":"earlier","days":1,"at":"planning","conflict_before":false,"conflict_after":true}`; a pause: `{"crew":"Excavation","move":"pause","at":"other","conflict_before":false,"conflict_after":false}`; its resume: `{"crew":"Excavation","move":"resume","days":0,"at":"other","conflict_before":false,"conflict_after":false}`

`conflict`: at a conflict stop, once, when the player presses on it: Play (the card's or the transport's), Replan, or Back then Leave. A stop the player never presses on (a reload, a closed tab, a crash) writes no `conflict` row. Runs stop at conflicts in Crew conflicts, Crew spacing, Production rate, Fleet planning, Event response, Site preparation and the Sandbox; Replan is offered only in Crew conflicts, Crew spacing, Production rate and Fleet planning.

| Key | Format | Meaning |
|---|---|---|
| crew | text | The held crew. |
| ahead | text | The crew ahead. |
| day | integer | The stop's day, the day the conflict card names. |
| ft | integer | Where the held crew meets the crew ahead, in whole feet. |
| days | integer | The days of the held stretch. |
| then | text | What the player pressed: `play`, `replan`, or `leave` (back to the map from the conflict). Back followed by Stay is not a press. |

Example: `{"crew":"Backfill","ahead":"PipeLaying","day":8,"ft":240,"days":2,"then":"play"}`; the other presses write `"then":"replan"` and `"then":"leave"`.

`result`: at every run's end, right after `run_end`. The run row keeps its fields. A run left before its end has no `result`.

| Key | Format | Meaning |
|---|---|---|
| days | integer | The job's days. |
| total | integer | The total, in dollars. |
| late | integer | Days past the deadline (0 when on time or without a deadline). |
| waiting | integer | Waiting days, summed over the crews. |
| conflict_days | integer | Conflict days: the held days of each crew added together. |
| met | text | The targets met, joined by `+` in the lesson's order; `""` for none. |
| missed | text | The targets missed, the same way. |
| stars | integer | The stars, 0 to 3 (0 where the lesson has no targets); always equal to the `run_end` row's `score` and to the report card. |

Targets are named by kind, never by their display text: `deadline`, `budget`, `no_conflict`, and two kinds that carry their number in the name, with no separator: `days_at_most` followed by its days (`days_at_most13`) and `gap_before` followed by its days (`gap_before1`, `gap_before5`). A lesson without targets writes `"met":""`, `"missed":""` and `"stars":0`. The targets are the report card's own; in Crew spacing the card's two gap targets. In the code of 2026-11-23: Meet the site, Bar chart, Bars to lines and Start days have none; Crew conflicts has `no_conflict` and `days_at_most13`; Crew spacing `gap_before1` and `gap_before5`; Production rate `no_conflict` and `days_at_most12`; Fleet planning, Event response, Site preparation and the Sandbox `deadline` and `budget`. In Crew conflicts the lesson can send the player back to planning when a run ends instead of showing the report card; that run keeps its `run_end` and `result`, and the next Run has a new `run`.

Example (the sample plan run in Fleet planning, against its 10-day deadline and $25,000 budget): `{"days":7,"total":23107,"late":0,"waiting":0,"conflict_days":0,"met":"deadline+budget","missed":"","stars":3}`; Crew spacing with the 1-day gap: `{"days":14,"total":23856,"late":0,"waiting":0,"conflict_days":0,"met":"gap_before1","missed":"gap_before5","stars":2}`; Crew conflicts opening: `{"days":12,"total":24056,"late":0,"waiting":1,"conflict_days":2,"met":"days_at_most13","missed":"no_conflict","stars":2}`

`task_attempt` in Bars to lines (Marathon 12 decision A1): one row per release of a crew's days, before the lift. Lifting alone is not another attempt. The progress row's `attempts` for the node counts them (section 6). It is written in planning, with the planning run's `run` and `day` 0.

| Key | Format | Meaning |
|---|---|---|
| node | text | `bars_to_lines`. |
| crew | text | The crew being made. |
| days | integer | The days the player released on. |
| correct | boolean | TRUE when those days are the days the crew needs for the trench at its rate. It is data only: the player sees no mark of right or wrong. |

Example: `{"node":"bars_to_lines","crew":"PipeLaying","days":7,"correct":false}`

`resume`: when a session comes back after a reload, right after its second `start` row (section 5), that is when the player presses Continue on the ID screen of the reloaded page with the same ID, mode and build within 12 hours of the session's first start. A new session writes none.

| Key | Format | Meaning |
|---|---|---|
| cause | text | `error` when the page's Reload button was pressed after the game stopped (the reload panel); otherwise `reload`, which also covers a tab closed and opened again within the resume window. |

Example: `{"cause":"error"}`; otherwise `{"cause":"reload"}`

`continue` (from build W10, WO-265, decision E3): the first row of a continued session after its `start` row (section 5), so its `row_seq` is 2. Written like `resume`: `run` empty, `day` 0, `seq` its own `row_seq`. A session begun on the ID screen writes none, and a reload inside a continued session writes `resume`, not a second `continue`. `?mode=off` writes none.

| Key | Format | Meaning |
|---|---|---|
| from | text (UUID) | The `session` id of the finished session that Continue session followed. It joins the two sessions: same `code`, this row's `session` and `from`. |

Example: `{"from":"8f0c2a6e-3b1d-4d7e-9a51-2f6c0b9d4e11"}`

### Study event types of decision E7 (Marathon 12, from build W10)
Three lines that show what a player changed between and during runs: `edit`, `view` and `speed`. They follow every rule of D2's lines above: kind `event`, the existing columns, `run` the site run's id (the loaded run's while planning), `seq` the row's own `row_seq`, `day` the run's day when the change was made (0 in planning), D2's spellings of crews, sizes and preventions, numbers and booleans as JSON numbers and booleans, nothing typed by the player, and none of them under `?mode=off`. They are written only for what the player changes: the game's own changes (a lesson's opening speed, the chart's first view, Bars to lines' morph, Crew conflicts' fold to the LOB at its conflict) write none.

`edit`: one row for each settled change of a machine count or a prevention that no other row carries.

| Key | Format | Meaning |
|---|---|---|
| crew | text | (a count) The crew. |
| size | text | (a count) The machine's size. |
| count | integer | (a count changed before Run) The crew's machines of that size after the change. |
| hired | integer | (a hired machine sent away during a run) The hired machines of that crew and size still booked from the next day, after the change. |
| prev | text | (a prevention) The prevention's id. |
| bought | boolean | (a prevention) TRUE when bought, FALSE when returned. |
| at | text | When, as in `move`: `planning` (before Run), `event` (an event card is open), `conflict` (the run stands at a conflict), `other` (the run is playing or paused). |
| days | integer | The forecast's job days after the change, taken where `plan` takes them. |
| total | integer | The forecast's total after the change, in dollars, preventions included. |
| conflict_days | integer | The forecast's conflict days after the change, as in `plan`. |

- **Settled.** Presses on the same control less than a second apart (real time, not game time) make one row, written a second after the last press, that carries the state after the last press. A press on another control, or any other row the game writes (a `move`, the PM's advice, Run's `run_start` and `plan`, an event's `response`, a `conflict`, the run's end, a view or speed line, the lesson loaded again, the screen left), writes the waiting row first, so the rows keep the order things happened. A series that ends where it began (a count back to where it was, a prevention bought and returned) writes nothing. A row still waiting when the tab closes (presses of the last second) is lost; a later `plan` holds the plan at Run.
- **The forecast is the plan's after the change.** The game works the forecast out inside the change itself, before the row is made. The PM's advice is the only thing worked out over a few frames, and no `edit` carries it. In Site preparation and the Sandbox the advice line, when it comes while presses go on, writes the waiting row first, so a quick series there can give two rows.
- **Where counts and preventions change, and which row carries each:**
  - a machine counter before Run: `edit` with `count`;
  - a prevention's BUY or BOUGHT before Run: `edit` with `prev` and `bought`;
  - the counter's + at an event (a hire), and a hire or borrow chosen on the event card, the PM's pick among them: the event's `response` at Play, as before; no `edit`;
  - the counter's - at an event that takes back that card's own hire: the `response` at Play; no `edit`;
  - the counter's - during a run (or at a later card) that sends away a machine hired at an earlier event: `edit` with `hired`;
  - the Sandbox's Retry keeps the plan and the preventions: no `edit` (the next `plan` shows them);
  - a machine lost to an event is the engine's, not the player's: the `result` shows it.

Examples (the test holds the forecast at the plain sample plan's, as for `response` above, so `days`, `total` and `conflict_days` show the format only): a count `{"crew":"Backfill","size":"heavy","count":2,"at":"planning","days":7,"total":23107,"conflict_days":0}`; a hired machine sent away `{"crew":"PipeLaying","size":"heavy","hired":0,"at":"other","days":7,"total":23107,"conflict_days":0}`; a prevention bought `{"prev":"P1","bought":true,"at":"planning","days":7,"total":23107,"conflict_days":0}` and returned `{"prev":"P1","bought":false,"at":"planning","days":7,"total":23107,"conflict_days":0}`.

`view`: when the player opens or closes the cost table, and when the player picks LOB or Bars on the chart. The table also closes by itself at Run; that closing is written too (only when it was open), just before `run_start`. A view opened and closed within a second writes two rows. A press on the view already shown writes none.

| Key | Format | Meaning |
|---|---|---|
| view | text | `table` (the cost table) or `chart` (the chart's LOB and Bars switch). |
| state | text | After the change: `open` or `closed` for the table, `lob` or `bars` for the chart. |

Examples: `{"view":"table","state":"open"}`, `{"view":"table","state":"closed"}`, `{"view":"chart","state":"bars"}`, `{"view":"chart","state":"lob"}`. A table still open when the player leaves the lesson has no closing row. The chart's first view is Bars in Bar chart, Bars to lines and Crew conflicts, and the LOB elsewhere; Bars to lines ends its morph on the LOB, and Crew conflicts folds to the LOB at its first conflict.

`speed`: at each press of 1x, 4x, 10x or 30x that changes the speed. Each lesson opens at 4x and the Sandbox at 1x without a row.

| Key | Format | Meaning |
|---|---|---|
| speed | integer | The speed after the press: 1, 4, 10 or 30. |
| before | integer | The speed before it. |
| state | text | Where the run stood: `planning` (before Run), `playing`, `paused` (the player's pause or a drag), `event` (an event card is open), `conflict` (a conflict stop), `done` (after the run's end). |

Examples: `{"speed":10,"before":4,"state":"planning"}`; during a run `{"speed":4,"before":1,"state":"playing"}`; at the player's pause `{"speed":10,"before":4,"state":"paused"}`.

How many: a session where the player changes no count or prevention, opens no table, switches no chart and keeps the speed has exactly the rows of build W9. Each settled counter series, prevention press, table opening or closing, chart switch and speed press adds one row. The game's own walker through the whole route makes about 8 to 11 `edit` rows (the counters and BUY presses its lessons ask for) and no `view` or `speed` row, on about 155 rows.

Not written by any row: an edit row still waiting when the tab closes (above), and the game's own changes of speed and of the chart's view.

## 9. Change log
| Schema | Date | Change |
|---|---|---|
| 1 | 2026-11-24 | Marathon 12 decision E3 (WO-265), from build W10: the session ends on Site preparation (its report card's FINISH SESSION is the map's Finish session), and the finish card's Continue session begins the same ID again as a new session (section 5) whose row 2 is the new event type `continue` with `detail` `{"from":"<the finished session's id>"}`, `run` empty and `day` 0 (section 8). In a continued session each report card sends its rows at once, and at `pagehide` the page also sends that session's next reserved batch and one batch after it with `sendBeacon`, under batch ids saved first, so the receiver keeps each row once (section 1). The finished session's rows, its `finish` row and its sending do not change. The browser keys hold the continued session's link to the finished one and the promised batch ids (section 11). No new fields, columns or kinds; the receiver is unchanged; the schema stays 1. |
| 1 | 2026-11-24 | Marathon 12 decision E7 (WO-267), from build W10: three study event types in the existing events tab (section 8): `edit` (a settled change of a machine count before Run, of a prevention, or a hired machine sent away during a run, with the forecast's `days`, `total` and `conflict_days` after it), `view` (the cost table opened or closed, the chart switched between LOB and Bars) and `speed` (each press that changes the speed, with the speed before and where the run stood). Presses on one control less than a second apart make one `edit` row. Only the player's changes are written; a session without them has the same rows as before. The client's row check and the receiver keep any `type` (section 1), so the receiver needs no change. The list of what no row records is shortened to match. No new fields, columns or kinds; the schema stays 1. |
| 1 | 2026-11-23 | Build W8's send cadence (Marathon 12, WO-255 and the class rehearsal of 2026-11-23). The game sends its queued rows about every three minutes (180 s, each wait 0.8 to 1.2 times that) and at Finish session, and no longer at the end of each run; build W7 sent about once a minute and at each run's end. A row reaches the Sheet about 4.4 minutes after it is made (modelled median; 95 in 100 within about 6 minutes), so posts are fewer and carry more rows and tabs. The request timeout is 30 s. The finish card reads "Sending your play data… N of M. Keep this tab open." and then "All data sent. You can close this tab." Timing at an event's stop also changed with build W8's look: where the event draws a hit, the banner shows 1.0 s after the stop and the card 2.0 s after it (build W7: the banner at the stop, the card 1.5 s after it; a stop whose event draws no hit keeps W7's times), and Play is refused until the card shows. From build W9 the camera first eases in to the event's shot for 0.6 s (not when the browser asks for reduced motion), so there the banner shows 1.6 s after the stop and the card 2.6 s after it. So each such stop adds at least half a second of real time (build W8; 1.1 s from build W9) to the run row's `seconds`, to the progress rows' `seconds` and to the finish row's `seconds`, and the rows written when the card opens (`pm_suggestion`) and at Play (`response`, `pm_suggestion_used`) carry times that much later. No field measures the time spent on a card: it can only be taken from the rows' own times. No new fields, columns or kinds; the schema stays 1. |
| 1 | 2026-11-23 | From 816 real rows of build W7 (five test-mode sessions of the rehearsal, decision D3) and WO-254. From build W8 the run's start row writes `deadline` as the last on-time day the player sees; build W7 wrote one more, and earlier builds the first start's day plus the deadline's days (section 5). Corrections to match the rows: `build` is the label alone (`W7`); run-line `seq` starts at 1 or 2 and skips at most the number `run_start` takes; after a resume the game writes an `open` and a `leave` of 0 seconds for the lesson that was open. The rehearsal's facts: every row acknowledged once, `row_seq` without a gap or a repeat, nothing stored twice, the finish row's `pending` 1 in every session (the last progress row, sent right after the press). No new fields, columns or kinds; the schema stays 1. |
| 1 | 2026-11-22 | Marathon 12 decision D2 (WO-218), from build W7: seven study event types in the existing events tab (section 8): `plan`, `response`, `move`, `conflict`, `result`, `resume`, and `task_attempt` in Bars to lines with the keys `crew`, `days` and `correct`. `plan` and `result` both name their conflict days `conflict_days`; a target with a number carries it in its name (`days_at_most13`, `gap_before5`); `move`'s `conflict_before` and `conflict_after` say whether the forecast shows a conflict still ahead, and a `pause` has no `days`; `response.pm` is TRUE when the response taken is the PM's pick on that card (the same value as `pm_suggestion_used`), and `response.to` is absent when a site-wide hire has no receiving crew; `conflict` also carries the held stretch's `days`; a `conflict` row is written once, when the player presses Play, Replan or Leave, so a conflict stop ended by a reload or a closed tab has no row. Their `seq` is the row's own `row_seq`, and numbers and booleans in their `detail` stay JSON numbers and booleans. Crew spacing's run `score` now counts the report card's two gap targets, so the run row, the `result` row and the card agree. The queue and the next `row_seq` are saved at every queued row, and a row check that runs out of time keeps the row (section 1). Money values from W7 include the site cost (decision B1, section 4). Corrections to match the code: `run_abandoned`, `crowded` and `crowded_end` are not written; `runs.outcome` is always `won`; `level` is the node id; `pm_suggestion.stop` counts from 0; a resumed session writes a second `start` row; run-line `detail` values are strings and run-line `seq` has gaps; the site card's `task_attempt` flag has `run` empty and `day` 0; the local run file (section 1), the stars keys and the reload marker (section 11) are listed; a resumed session's finish `seconds` includes the time away; the PM's advice is written when it is ready; the crew spellings of `pm_suggestion` ids are named; what no row records is listed (section 8). No new fields, columns or kinds; the schema stays 1. |
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
| `lob_pt_session_v1` | The current session (code, mode, build, session id, start time, next `row_seq` and its finish row's counts), so a reload can resume it (section 4), and the mode-and-code pairs that have visited or seen the intro. From W7 saved at every queued row. |
| `lob_pt_queue_v1` | Each session's rows the receiver has not acknowledged yet, so a reload resumes sending; "Download my data" exports them. From W7 saved at every queued row. From W10 a continued session's entry also says which session it continued and the batch ids (with their row counts) promised to the page for `pagehide` (section 1), so a resend after a reload reuses them; `lob_pt_session_v1` holds the same link for the current session. |
| `lob.map.v1.<mode>.<CODE>` | The concept-map nodes this code has completed in this mode. |
| `lob.map.v1.started.<mode>.<CODE>` | The nodes this code has opened in this mode, done or not (SR52). |
| `lob.map.v1.stars1.<mode>.<CODE>`, `lob.map.v1.stars2.<mode>.<CODE>`, `lob.map.v1.stars3.<mode>.<CODE>` | The nodes whose best report card in this mode reached at least one, two and three stars (Marathon 10 decision 22). A lower score never lowers them. |
| `lob.flow.v1.<mode>.<CODE>` | The step of the opening flow (SR51) this code has reached in this mode, so a return resumes there. |
| `lob_audio_mode_v1` | The Audio setting: `full`, `background` or `off` (SIM.L15). |
| `lob_master_volume_v1` | The master volume, from 0 to 1. |
| `lob.save.owner`, `lob.run.owner` | The code that owns the saved game or the saved run (section 2). Not written since Marathon 10 (no level save, no mid-run restore); an older one is left untouched. |

One key lives in the tab's session storage, not local storage: `lob_reload_cause`. The page writes `error` there when its Reload button is pressed after the game stopped; from W7 the game reads it once when the page loads, removes it, and uses it only for the `resume` event's `cause` (section 8).

`?mode=off` sends nothing and writes neither `lob_pt_session_v1` nor `lob_pt_queue_v1`, but still keeps local progress (under the mode `off`) and the audio settings. Before Marathon 10, Unity itself kept the saved game and the saved run, and two game preferences (`lob.tutorial5_complete`, `lob_project_last_failed_site`), in the browser's IndexedDB: game state only. The game no longer writes them (WO-162); an older copy is left untouched.
