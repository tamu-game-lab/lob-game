# LOB Game play data dictionary

Schema version: **1** (2026-10-28, Marathon 7, SR49). Mirrored in the release repo as `docs/data-dictionary.md`.

Rules:
- Every new field is added here first, with a schema version bump.
- The data holds no names, emails, student numbers or free text.
- Players are identified only by a study code. The instructor keeps the key from codes to names offline.

## 1. How data travels
- **The client.** The game (`PlaytestService`) queues rows and posts them in batches: about once a minute, at every run end, and at Finish session.
  - Each post is one HTTP POST of JSON with `Content-Type: text/plain;charset=utf-8`, so the browser sends no CORS preflight.
  - Posts never block play. A failed post is retried with exponential backoff and jitter: 5 s doubling to a 5 min cap, times 0.5-1.5.
  - On the Web, pending rows are kept in the browser's local storage, so they survive a page reload.
- **The sinks.** In the Editor and the Windows build, the same rows go to a local JSONL file instead of the network (`<persistentDataPath>/Playtest/session_<session>.jsonl`). `?mode=off` sends and writes nothing.
- **The server.** The Google Apps Script web app (`apps-script/Code.gs` in the release repo):
  - validates each post;
  - ignores a batch id it has already appended, so retries never duplicate rows;
  - takes a lock and appends rows to the tab for their kind and mode, by header name;
  - adds a column when a new field arrives;
  - stamps `server_time`.

### Post body
```json
{
  "schema": 1,
  "mode": "tryout",
  "build": "W1 2026-10-28",
  "code": "P042",
  "session": "8f0c2a6e-3b1d-4d7e-9a51-2f6c0b9d4e11",
  "batch": "5d2b7f90-1c44-4b0e-8f3a-6e7d9c1a2b3c",
  "sent_at": "2026-10-28T19:05:12Z",
  "rows": [ { "kind": "progress", "row_seq": 7, "client_time": "2026-10-28T19:04:58Z", "node": "bars_to_lines", "action": "complete", "seconds": 142 } ]
}
```
At most 100 rows and 200 KB per post.

### Server reply
- `{"ok":true,"appended":N}`: done.
- `{"ok":true,"appended":0,"duplicate":true}`: a retry of a batch already stored.
- `{"ok":false,"error":"<reason>","retry":false}`: invalid; the client drops the batch into the "Download my data" file rather than retrying forever.
- `{"ok":false,"error":"busy","retry":true}`: try again later.

### doGet
- `?op=health` returns `{"ok":true,"schema":1,"script":"<script version>","time":"<ISO>"}`.
- `?op=code&code=P042` returns `{"ok":true,"known":true|false}`. It answers for the one code asked about and never lists codes.

## 2. Modes (from the link)
| Link | Mode | Rows go to | ID check |
|---|---|---|---|
| (none) | tryout | `tryout_*` tabs | any well-formed code passes |
| `?mode=study` | study | `sessions`, `progress`, `runs`, `events`; unknown codes to `unmatched` | the server checks the code; an unknown one asks the player to recheck |
| `?mode=off` | off | nothing is sent or written | any well-formed code passes |
| `?mode=test` | test | `test_*` tabs (automated smoke test only; not linked anywhere) | any well-formed code passes |

- `?id=P042` prefills the code, so a pre-test can hand off to the game.
- `?fps=1` shows a frame counter. It is not data.
- Tryout data is never research data (SR49): tryout and test tabs are for usability work only.

## 3. Study code
- **Format:** 1-3 letters then 1-4 digits (`^[A-Za-z]{1,3}[0-9]{1,4}$`), stored upper-case (P042). Anything else is refused on the ID screen in every mode, so a name, email or student number cannot be entered.
- **The codes tab** has columns `code` and `active` (TRUE/FALSE; blank counts as TRUE). In study mode, rows whose code is not an active code in this tab go to `unmatched`, never dropped.

## 4. Fields on every row
| Field | Type | Example | Meaning |
|---|---|---|---|
| kind | text | `progress` | Row type: `session`, `progress`, `run`, `event`. Selects the tab. |
| schema | integer | 1 | Schema version of this dictionary. |
| mode | text | `tryout` | `study`, `tryout` or `test`. |
| build | text | `W1 2026-10-28` | Build label and date. |
| code | text | `P042` | Study code. |
| session | text (UUID) | `8f0c…4e11` | One per ID-screen Continue. A reload with the same code keeps the session. |
| row_seq | integer | 7 | Order of the row within its session, from 1. |
| client_time | text (ISO 8601 UTC) | `2026-10-28T19:04:58Z` | When the game made the row. |
| server_time | text (ISO 8601 UTC) | `2026-10-28T19:05:13Z` | Added by the server on append. |
| target_tab | text | `progress` | Only on `unmatched` rows: the tab the row would have gone to. |

## 5. sessions (kind = `session`)
| Field | Type | Values | Meaning |
|---|---|---|---|
| phase | text | `start`, `finish` | `start` at ID-screen Continue; `finish` at Finish session. |
| platform | text | `web`, `windows`, `editor` | Where the game ran. |
| browser | text | `chrome`, `edge`, `firefox`, `safari`, `other`, `none` | Browser family only (not the full user agent). |
| screen | text | `1920x1080` | Canvas size in pixels at start. |
| first_visit | boolean | TRUE | No earlier session for this code on this browser. |
| intro_seen | boolean | FALSE | The intro was viewed before this session on this browser. |
| seconds | integer | 1834 | (finish) Seconds from start to finish. |
| nodes_completed | integer | 4 | (finish) Concept-map nodes completed this session. |
| runs | integer | 3 | (finish) Runs started this session. |
| pending | integer | 0 | (finish) Rows still unsent when Finish was pressed. |
| downloaded | boolean | FALSE | (finish) The player saved the "Download my data" file. |

## 6. progress (kind = `progress`): the concept map
| Field | Type | Values | Meaning |
|---|---|---|---|
| node | text | `bar_chart` | Concept-map node id (`MD Files\_concept_map.md`). |
| action | text | `open`, `complete`, `leave`, `locked` | The node was opened, completed, left unfinished, or clicked while locked (study mode). |
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
| outcome | text | `won`, `lost`, `quit` | (end) How it ended. |
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

Lesson event types:
- `intro_view` (`detail`: `{"part":"crews"}` …);
- `intro_skip`;
- `task_attempt` (`detail`: `{"node":"bar_chart","correct":false}`);
- `audio_change` (`detail`: `{"volume":0.6}`).

## 9. Change log
| Schema | Date | Change |
|---|---|---|
| 1 | 2026-10-28 | First version (Marathon 7, SR49). |
