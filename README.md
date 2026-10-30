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
| `...?mode=study&id=P042` | Study mode with the code prefilled (for a hand-off from a pre-test). |
| `...?mode=off` | Nothing is sent. |
| `...?fps=1` | Shows a frame counter. |

Codes are pseudonymous: one to three letters and one to four digits, such as P042. The data holds no names, emails, student numbers or free text. See `docs/data-dictionary.md`.

## Releases
| Build | Version | Published | Purpose |
|---|---|---|---|
| W1 | 1.1-W1 | 2026-10-28 (replaced by W2) | Tryouts: the study-code screen, the main screen and the data pipeline. |
| W2 | 1.2-W2 | 2026-10-28 (replaced by W2.1) | Adds the concept map and the intro from the crews to the bar chart to the Line of Balance. |
| W2.1 | 1.2.1-W2.1 | 2026-10-29 (replaced by W3) | W2 with play data posting to the Apps Script receiver (1.0.1 deployed); the data-only build before W3. |
| Receiver | 1.1.0 | 2026-10-29 (`apps-script/`) | The Apps Script receiver emails the study team when a session finishes: one email per session, or an hourly digest during class, set in the Sheet's `settings` tab. Counts and a link to the Sheet only, never the data. Setup: `docs/apps-script-setup.md`, Part 7. |
| W3 | 1.3-W3 | 2026-10-30 (live) | Realistic work on site (SIM.L17), one onboarding flow (SR51), a modern game UI (SR52), the whole environment kit; Finish never blocks on the receiver. |

Play data is sent only once the study team's Apps Script address is set in a build (see `docs/apps-script-setup.md`). Until then the game keeps a player's rows for "Download my data" at Finish session.
