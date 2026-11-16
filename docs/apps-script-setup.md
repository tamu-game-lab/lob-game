# Play-data Sheet setup (Google Apps Script)

These steps connect the game to a Google Sheet in the Google account approved for the study. The game sends play data to a small script attached to the Sheet (a Google Apps Script "web app"), and the script adds the rows to the Sheet. You do this once; it takes about 15 minutes.

**Where things stand.** TAMU's Google accounts do not allow a web app that anyone can open without signing in, and the game needs one (see "Why a personal Google account" near the end). So the Sheet, `LOB Game play data`, and its script live in your personal Google account, which you have confirmed is approved for this study. In these steps, "the study account" means that account. The web app was set up and checked with Parts 1 to 4. The repository now holds receiver 1.2.0, in which players make their own study ID and the `codes` tab is no longer used. To move the running web app to it, don't repeat those parts: follow "Updating the receiver (same URL)" below. The web app URL stays the same, so the game needs no change.

You need:
- the study account (your personal Google account);
- two files from this repository: `apps-script/Code.gs` and `apps-script/appsscript.json`.

Where the data is stored has to match your IRB approval. These steps keep everything in one Google Sheet in the study account. If you ever set this up again in another account and Google's settings get in the way, read "Why a personal Google account" near the end before trying anything else.

## Part 1: Create the Sheet

1. Go to sheets.google.com. Check the round account picture in the top-right corner: it must be the study account, not your TAMU account. If it is not, click it and switch accounts.
2. Click **Blank spreadsheet**.
3. Click **Untitled spreadsheet** (top left) and name it `LOB Game play data`, the name the live Sheet has.
4. Leave the empty tab **Sheet1** as it is; you may delete it once the data tabs have appeared. There is no list of study codes to type in: each player makes their own study ID in the game (see "Study IDs" below).

Don't create any other tabs. The data tabs (`sessions`, `progress`, `runs`, `events`, and the `tryout_` and `test_` tabs) are created automatically when the first data arrives. The `settings` tab comes from Part 7, and `digest_queue` appears by itself if you use digest emails.

## Part 2: Add the script

5. In the Sheet, choose **Extensions > Apps Script**. The script editor opens in a new browser tab. Creating the script this way, from the Sheet, attaches ("binds") it to this Sheet. A script created anywhere else cannot find the Sheet.
6. Click **Untitled project** (top left), type `LOB play data receiver` and click **Rename**.
7. On the left, under **Files**, click **Code.gs**. Click inside the code, press **Ctrl+A**, then **Delete**, so the file is empty.
8. Open `apps-script/Code.gs` from the repository in a plain text editor (Notepad is fine). Press **Ctrl+A** and **Ctrl+C**, go back to the script editor, click inside the empty file and press **Ctrl+V**.
9. Click the gear icon **Project Settings** in the narrow bar on the far left. Tick **Show "appsscript.json" manifest file in editor**.
10. Click the **< >** icon (**Editor**) in the same bar. A file named **appsscript.json** now shows under **Files**. Click it, press **Ctrl+A**, and paste the whole contents of `apps-script/appsscript.json` from the repository over it.
11. Click the disk icon **Save project** (or press **Ctrl+S**).

## Part 3: Deploy the web app

12. Click the blue **Deploy** button (top right), then **New deployment**.
13. Next to **Select type**, click the gear icon and choose **Web app**.
14. Fill in the form:
    - **Description**: `v1`
    - **Execute as**: **Me** (the study account)
    - **Who has access**: **Anyone**

    If **Anyone** is not in the list, stop here and read "Why a personal Google account" below.
15. Click **Deploy**.
16. Google asks you to authorize the script. Click **Authorize access** and choose the study account.
    - If you see "Google hasn't verified this app", click **Advanced**, then **Go to LOB play data receiver (unsafe)**. The warning appears because you made the script yourself instead of installing it from Google.
    - If the next screen has checkboxes, tick all of them (or **Select all**). Then click **Allow**.

    The script asks for access to your spreadsheets because it writes to this Sheet. It only ever opens the Sheet it is attached to. It also asks to send email as you, to run when you are not present, and to see your email address: these are for the session emails in Part 7, which stay off until you turn them on.
17. The window now shows **Web app** with a **URL** ending in `/exec`. Click **Copy** under the URL, then **Done**. Paste the URL somewhere you can find it again.

## Part 4: Test it

18. Open a new browser tab, paste the URL, type `?op=health` at the end and press Enter. For example:

    `https://script.google.com/macros/s/AKfy...xyz/exec?op=health`

    You should see one line like:

    `{"ok":true,"schema":1,"script":"lob-receiver 1.2.0 (2026-11-16)","time":"2026-11-16T19:05:13Z"}`

    If you see `"ok":false` or an error page, go over steps 5 to 15 again.
19. Open a private window (**Ctrl+Shift+N** in Chrome or Edge), where you are not signed in to Google, and open the same `?op=health` address there. You must see the same `"ok":true` line, because the game's players are not signed in either.
    - If Google asks you to sign in and your URL contains `/a/macros/tamu.edu/` (or `/a/tamu.edu/macros/`), try the shorter form without that part: `https://script.google.com/macros/s/<the same long ID>/exec?op=health`. If the shorter form shows the `"ok":true` line, use the shorter form from now on, including in the game.
    - If it still asks you to sign in, the web app is not open to "Anyone" and the game's data will not arrive. Read "Why a personal Google account".

## Part 5: Load test (optional)

This checks that the web app keeps up when a class of 40 finishes a run at the same moment. It needs Node.js 18 or later and a copy of this repository, so the game team may run it for you. Run it after Part 4 works, and when nobody is playing.

In a terminal in the repository folder, run it with your `/exec` URL from step 17, in the short form (it refuses any other address):

```
node apps-script/test/load-test.js https://script.google.com/macros/s/AKfy...xyz/exec
```

It simulates 40 players who each send 3 posts of 20 rows, all 40 at the same moment in each round, and resends a post the way the game does. It sends test data only (codes T900 to T999), so its rows go to the `test_` tabs, which you may delete afterwards. It never finishes a session, so it sends no session emails (Part 7). A good result, which it prints as `result: good`:
- `loss: 0 rows`;
- every post acknowledged within 120 seconds (`posts acknowledged within 120 s` counts all of them), before the game may offer "Download my data" to a player who pressed Finish session.

## Part 6: Connect the game

20. Put the `/exec` URL into the game's config asset: **PlaytestConfig**, field **Endpoint**. If you are not editing the game yourself, send the URL to the game team.
21. After the next game build, play once using the normal link (tryout mode). Within a minute or two, new `tryout_` tabs appear in the Sheet.

## Part 7: Session emails

From version 1.1.0 the script can email you when a player presses **Finish session**: one email per session, or, during class, one digest email an hour. An email holds the study ID, the mode, the build, the session's start and finish times (in UTC), the number of rows in each tab, and a link to the Sheet. It never holds the play data itself. Emails are off until you turn them on.

**The settings tab.** The script reads a tab named `settings`, with the columns `key` and `value`, each time a session finishes, so a change there works at once, without a new deployment.

| key | value | What it does |
|---|---|---|
| `email_mode` | `off` (the default), `session` or `digest` | `off`: no emails. `session`: one email per finished session. `digest`: finished sessions wait in a `digest_queue` tab, and one email lists them every `digest_minutes`. |
| `email_to` | blank (the default) | Blank sends the emails to you, the account that deployed the script. To send them elsewhere, type an address, or several separated by commas. |
| `digest_minutes` | `60` (the default) | How often the digest goes out: 5, 10, 15, 30, 60, 120, 240, 360, 480 or 720 minutes. It takes effect when you install the digest timer (step 29). |

A value the script cannot use (a typo, say) counts as `off` (for `digest_minutes`, as 60), and the health check lists its key under `ignored_settings`.

Google lets a script in a personal account email at most 100 recipients a day, and each address in `email_to` counts once per email. One email per session for a class of 40 stays under that; an hourly digest sends at most 24 a day.

22. If your web app runs version 1.0.1 (the `script` value of the health check in step 18 shows `lob-receiver 1.0.1`), first put in the new files: replace **Code.gs** as in steps 7 and 8, and **appsscript.json** as in step 10, then click **Save project**. Don't deploy yet: the web app keeps running 1.0.1 until step 26.
23. At the top of the script editor, open the list of functions (to the right of **Debug**), choose **setupSettings**, and click **Run**.
24. If Google asks you to authorize the script (it does when the web app was set up with 1.0.1, because 1.1.0 and later need three more permissions), click **Review permissions** and choose the study account. If you see "Google hasn't verified this app", click **Advanced**, then **Go to LOB play data receiver (unsafe)**, as in step 16. Tick every checkbox (or **Select all**), then click **Allow**. Google's wording for the new permissions may differ a little:
    - **Send email as you**: for the session emails.
    - **Allow this application to run when you are not present**: for the digest timer (it manages the script's triggers).
    - **See your primary Google Account email address**: so the emails go to you.
25. When the run finishes, the Sheet has a new tab, `settings`, with `email_mode` set to `off`, `email_to` blank and `digest_minutes` set to `60`. Running **setupSettings** again changes nothing: it only puts back a setting that is missing, and never changes a value you typed.
26. If you did step 22, deploy the new version: **Deploy > Manage deployments**, select the active deployment, click the pencil icon (**Edit**), under **Version** choose **New version**, click **Deploy**, then **Done**. The `/exec` URL stays the same, so the game needs no change.
27. Open the `?op=health` address from step 18 again. It now shows the version you deployed (`lob-receiver 1.2.0`) and ends with `"email":"off"`.
28. To turn emails on, type `session` or `digest` in the `value` cell next to `email_mode`. The health check shows the new mode at once.

**Digest emails during class.**

29. Before class, set `email_mode` to `digest`. In the script editor, choose **installDigestTrigger** in the list of functions and click **Run**. This installs a timer that runs **sendDigest** every `digest_minutes` (every hour by default). To check it, click the clock icon **Triggers** in the left bar: there is one trigger, for `sendDigest`. Running **installDigestTrigger** again replaces the timer rather than adding a second one; do that after you change `digest_minutes`.
30. During class, each hour in which sessions finish brings one email that lists them, one line per session. They wait in the `digest_queue` tab until then, and each email deletes the lines it listed. An hour in which no session finishes sends nothing. One email lists at most 200 sessions; any more wait for the next one.
31. After class, choose **sendDigest** and click **Run** to send what is still waiting, then choose **removeDigestTrigger** and click **Run**. Set `email_mode` back to `off` or `session`.

**When the class finishes together.** The W2.1 load tests showed what to expect. When 40 posts arrive at the same moment, they clear in about 75 s, because the receiver writes one post at a time; the others wait their turn or are sent again, and none is lost. When 40 simulated players pressed Finish session at the same moment, every finish was acknowledged within 120 s, with no loss. From W3 the game no longer waits at Finish session: it moves on at once, keeps sending in the background, and offers "Download my data" only if sending still fails 120 s later.

Good to know:
- A post that the game sends again (a retry) sends no second email and adds no second line. The rare exception is a copy that arrives more than six hours later: like its rows, it is taken as new.
- If an email cannot be sent (for example, after Google's daily email limit), the play data is still stored. The failure shows under **Executions** with no play data in it, and in digest mode the lines stay in `digest_queue` for the next run.
- The link in the emails opens the Sheet only for accounts it is shared with.
- After any change to the code, deploy a new version (step 26, and "Updating the receiver (same URL)" below). The `/exec` URL stays the same. A change in the `settings` tab needs no deployment.

## Updating the receiver (same URL)

Do this when the game team sends a new `Code.gs`, such as receiver 1.2.0. It replaces the script inside the web app you already have, so its URL, and the address in the game, stay the same. It takes about five minutes.

1. Have the new `Code.gs` from the repository (`apps-script/Code.gs`) ready on your computer. Open a browser tab at your web app URL with `?op=health` at the end and note the version after `"script"`: you need it in step 7.
2. Go to sheets.google.com, make sure the round account picture in the top-right corner is the study account, and open the Sheet `LOB Game play data`.
3. In the Sheet's menu, choose **Extensions > Apps Script**. The script editor opens in a new browser tab, showing the project `LOB play data receiver`.
4. On the left, under **Files**, click **Code.gs**. Click inside the code, press **Ctrl+A**, then **Delete**, so the file is empty.
5. Open the new `Code.gs` in a plain text editor (Notepad is fine). Press **Ctrl+A** and **Ctrl+C**, go back to the script editor, click inside the empty file and press **Ctrl+V**.
6. Click the disk icon **Save project** (or press **Ctrl+S**). Saving alone does not change what the web app runs.
7. Only if the version you noted in step 1 is `lob-receiver 1.0.1`: also replace **appsscript.json** as in Part 2 (its steps 9 and 10), save again, and run **setupSettings** once as in Part 7 (its steps 23 and 24), so Google asks for the newer permissions before you deploy. Coming from 1.1.0, skip this step: `appsscript.json` has not changed.
8. Click the blue **Deploy** button (top right) and choose **Manage deployments**. Don't choose **New deployment**: it would make a second web app with a different URL, and the game would keep sending to the old one.
9. In the window that opens, select the existing web app deployment on the left (the active one), then click the pencil icon (**Edit**) at the top right.
10. Open the **Version** list and choose **New version**. Leave everything else as it is (Execute as **Me**, Who has access **Anyone**). Click **Deploy**, then **Done**.
11. Reload the browser tab with your web app URL and `?op=health` at the end (from step 1). The line shows `"script":"lob-receiver 1.2.0 (2026-11-16)"`. If it still shows the old version, wait a minute, reload, and check that you chose **New version** in step 10. If the page shows a Google sign-in or an authorization message instead of that line, the script is waiting for the permissions of step 7: do step 7, then steps 8 to 10 again.

After the update to 1.2.0:
- The `codes` tab and the key to names retire: the receiver no longer reads the `codes` tab, and since players make their own IDs, nobody keeps a list of IDs or a key linking them to names. You may delete the `codes` tab from the Sheet; the offline key is no longer needed (keep or destroy it as your IRB protocol says).
- Rows already in the `unmatched` tab stay there; the receiver adds no new rows to it. Each has a `target_tab` column naming the tab it would have gone to, so they can be joined to the study data in analysis.
- Before you deploy 1.2.0, a study session from the new game (a self-made ID such as `BLU4821`) is filed in `unmatched` by the old receiver. Nothing is lost; from the deploy on, those sessions go to `sessions`, `progress`, `runs` and `events`.

## Study IDs

- The player makes their study ID on the game's first screen: a favorite color, chosen from twelve buttons, and the last four digits of their phone. The game stores the color's three letters and the four digits, for example `BLU4821`. Nobody keeps a list of IDs or a key to names, and the Sheet holds no names, emails or student numbers.
- A study link may fill the ID in with `?id=BLU4821`, so a survey can hand players on to the game with the same ID.
- In study mode (game links with `?mode=study`) every well-formed ID goes to the study tabs. A malformed one (anything other than 1 to 3 letters followed by 1 to 4 digits) is refused, and the game keeps those rows for "Download my data".
- Two players can, rarely, make the same ID. Their sessions stay apart: every row has the `session` column, one value per session.
- The game team's automated checks use the IDs `GRY0000` to `GRY0009`. Filter out rows with those IDs before analysis.
- The data dictionary (`docs/data-dictionary.md`, section 3) lists the twelve colors and their letters.

## What the tabs hold

| Tab | Holds |
|---|---|
| `sessions`, `progress`, `runs`, `events` | Study data (game links with `?mode=study`). |
| `unmatched` | Only in a Sheet used before receiver 1.2.0: study-mode rows whose code was not in the old `codes` tab. `target_tab` says where each one belongs. Nothing new is added. |
| `codes` | Only in a Sheet used before receiver 1.2.0: the old list of study codes. No longer read; you may delete it. |
| `tryout_sessions` ... `tryout_events` | The normal game link (tryout mode). For usability work only; not research data. |
| `test_sessions` ... `test_events` | The game team's automated test (`?mode=test`). Not research data. |
| `settings` | The session-email settings (Part 7). You change the `value` cells. |
| `digest_queue` | Finished sessions waiting for the next digest email (Part 7). The script deletes each line once it is emailed. |

- The script matches columns by their header (row 1) and adds a column on the right when a new kind of field arrives. You may move columns around, but don't rename or delete header cells and don't rename tabs: the script would start a new column or a new tab.
- The script only adds rows to the data tabs; it never changes or deletes them. (The only rows it deletes are `digest_queue` lines it has emailed.) A row sent twice (rare: a retry that arrives hours later) has the same `session` and `row_seq` as an earlier row.
- Keep the Sheet private. The web app writes to it as you, so nobody else needs access to the Sheet.
- For analysis, work on a copy (**File > Make a copy**) or a download (**File > Download**) rather than in the data tabs.
- The script never writes the data into its logs. **Executions** (in the script editor's left bar) shows only counts and error types.

## Why a personal Google account

> **Read this if** **Anyone** is missing from **Who has access** (step 14), if the private-window test (step 19) keeps asking you to sign in, or if Google says the app is blocked when you authorize it (step 16).

The game sends its data anonymously: players never sign in to Google. So the web app has to be set to **Anyone**. With "Anyone within Texas A&M University", "Anyone with Google account" or "Only myself", the game's data will not arrive.

TAMU's Google accounts block web apps that anyone can open anonymously, so a TAMU account cannot run this web app. (A Google Workspace's administrators can limit web apps to people signed in to it; the option then reads, for example, "Anyone within Texas A&M University".) That is why the Sheet and its script live in your personal Google account, which you have confirmed is approved for this study: option 3 below.

If **Anyone** is not available in an account you set this up in:

1. Don't pick one of the other options, and don't move the data to another service or to an account the study is not approved for.
2. Ask the account's administrators (for a TAMU account, TAMU IT) whether **Anyone** access can be allowed for this Apps Script web app. Tell them it receives anonymous research play data into a Google Sheet in that account.
3. Or use a different Google account that your IRB approval allows, and do every step of this guide in that account.

Whichever way you go, the place where the data is stored has to match your IRB approval. If you are not sure an account is covered, check with the IRB first.

## For the game team

- Offline tests (Node.js only, no packages): `node apps-script/test/run-tests.js`
- The live web app runs in the study lead's personal Google account, not a TAMU one (see "Where things stand"). `?op=health` shows which receiver version is live; the repository's is 1.2.0, which Bryan deploys with "Updating the receiver (same URL)".
- Bump `SCRIPT_VERSION` in `Code.gs` with every change; `?op=health` shows it.
- `?op=code` stays for builds before W5i, which ask it before study mode: from 1.2.0 it answers `known: true` for every well-formed code.
- `setupSettings`, `installDigestTrigger`, `removeDigestTrigger` and `sendDigest` are run from the script editor (or, for `sendDigest`, by its trigger), never through the web app.
- Contract: `docs/data-dictionary.md` (schema 1).
