# Line of Balance: web pilot

This repository publishes the browser build of **Line of Balance**, an educational construction-scheduling game from the TAMU Game Lab, for usability tryouts and a classroom study.

**Play:** https://tamu-game-lab.github.io/lob-game/. It needs Chrome, Edge or Firefox on a laptop or desktop.

## What is here
| Branch | Holds |
|---|---|
| `main` | This README, `docs/` (the play data dictionary and setup notes) and `apps-script/` (the Google Apps Script that receives play data). |
| `gh-pages` | The latest web build only, as one orphan commit replaced at each release, so the repository stays small. GitHub Pages serves this branch. |

There is no game source code and no play data here. The Unity project is kept in a separate version-control system. Play data goes to a Google Sheet owned by the study team, through the script in `apps-script/`.

## Links
| Link | Use |
|---|---|
| `https://tamu-game-lab.github.io/lob-game/` | Tryout mode: any well-formed code works, and rows go to tryout tabs. |
| `...?mode=study&id=BLU4821` | Study mode with the study ID's color and digits filled in (for a hand-off from a pre-test survey). |
| `...?mode=off` | Nothing is sent. |
| `...?fps=1` | Shows a frame counter. |

From W5i each player makes their own study ID: a favorite color's three letters and the last four digits of their phone, such as BLU4821. Nobody holds a list of IDs or a key to names. (Earlier builds used assigned codes of one to three letters and one to four digits, such as P042.) The data holds no names, emails, student numbers or free text. See `docs/data-dictionary.md`.

## Releases
| Build | Version | Published | Purpose |
|---|---|---|---|
| W1 | 1.1-W1 | 2026-10-28 (replaced by W2) | Tryouts: the study-code screen, the main screen and the data pipeline. |
| W2 | 1.2-W2 | 2026-10-28 (replaced by W2.1) | Adds the concept map and the intro from the crews to the bar chart to the Line of Balance. |
| W2.1 | 1.2.1-W2.1 | 2026-10-29 (replaced by W3) | W2 with play data posting to the Apps Script receiver (1.0.1 deployed); the data-only build before W3. |
| Receiver | 1.1.0 | 2026-10-29 (`apps-script/`) | The Apps Script receiver emails the study team when a session finishes: one email per session, or an hourly digest during class, set in the Sheet's `settings` tab. Counts and a link to the Sheet only, never the data. Setup: `docs/apps-script-setup.md`, Part 7. |
| W3 | 1.3-W3 | 2026-10-30 (replaced by W5) | Realistic work on site (SIM.L17), one onboarding flow (SR51), a modern game UI (SR52), the whole environment kit; Finish never blocks on the receiver. |
| W5 | 1.5-W5h | 2026-11-08 (replaced by W5i) | One money model and one screen for every lesson and the Sandbox: machines hired by the day, the budget strip, the Line of Balance with one gesture, event cards with the project manager's suggestion, the four-stage site map; interim builds W5a to W5h went live in turn. |
| Receiver | 1.2.0 | 2026-11-16 (`apps-script/`; live once the study lead deploys it) | The self-made study ID: in study mode every well-formed ID goes to the study tabs, the `codes` tab is no longer read and nothing new goes to `unmatched`; the reply counts the rows per tab. Deployed as a new version of the same web app, so the URL stays. Steps: `docs/apps-script-setup.md`, "Updating the receiver (same URL)". |
| W5i | 1.5-W5i | 2026-11-16 (replaced by W6) | The study ID screen: the player makes the ID from a favorite color and the last four digits of a phone (BLU4821); study mode no longer asks the receiver to check a code. W5 otherwise unchanged. |
| W6 | 1.6-W6 | 2026-11-17 (replaced by W6a) | The game reads clearly: the Line of Balance with its grid and numbers, straight lines, start pills that stack and can each be picked, day and feet tags while dragging; every event and crew conflict stops the run, moves the camera in and says what happened on a card with real buttons; Back in every lesson; one set of controls and type on every screen; lessons on an 18-second day; each machine type audible in its own shot. The study ID and the data rows are W5i's. |
| W6a | 1.6-W6a | 2026-11-17 (live) | Lessons with step lists: a card with the project manager's line, a count and the steps, and a mark on what to press. Crew conflicts opens as a bar chart and folds to the Line of Balance when the conflict stops the run. One rule for days: columns numbered in their middles, an end named by the last day worked. Markers named by their event, a key under the chart, a missed target that says what is lost, the project manager's two-part suggestion as one row. At an event's stop the site catches up before it freezes. Saira Stencil One, Barlow Condensed and Inter as the typefaces. New machine sounds and a sound at each event's stop. The study ID and the data rows are W5i's. |

Play data is sent only once the study team's Apps Script address is set in a build (see `docs/apps-script-setup.md`). Until then the game keeps a player's rows for "Download my data" at Finish session.
