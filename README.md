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
| Build | Purpose |
|---|---|
| W1 | Tryouts: the study-code screen, the main screen and the data pipeline. |
| W2 | Adds the concept map and the intro from the crews to the bar chart to the Line of Balance. |
