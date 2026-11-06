# Ration

A Brave and Chrome extension that rations the sites you choose. Each site gets a set number of
opens per day, and each open lasts a set number of minutes. When the opens run out, the site
stays shut until midnight. A streak counts the days you stay under a daily goal, and a dashboard
shows your time on limited sites.

**Everything stays on your device.** Ration has no servers, no accounts, and no analytics, and it
makes no network requests of its own. It asks for no site access at install, and only sees the
sites you choose to limit. See [PRIVACY.md](PRIVACY.md).

## Install

From the Chrome Web Store once it is published. Brave installs from that store too.

To run this folder instead:

1. Open `brave://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick this folder (the one with `manifest.json`).
4. On the Ration card, click **Details** and turn on **Allow in Private**. Without it, private
   windows skip your limits.
5. Pin Ration to the toolbar. The Limits page opens so you can add sites.

## Site access

The manifest asks for no host permissions, so the install prompt has no line about reading or
changing data on websites. The only install line is "Block content on any page", which comes with
`declarativeNetRequest`.

When you save a site on the Limits page, Brave asks for access to that site alone, for example
youtube.com. Ration needs it to send the site to the gate page and to tell when the site is the
active tab. When you stop limiting a site, Ration gives the access back.

If you turn off a site's access in Brave's settings, Ration blocks that site outright with a
plain block rule, which needs no site access. The site then has no gate and no opens until you
click **Allow access** on the Limits page.

## How it works

**Opens.** Visit a limited site and Ration shows a gate page instead. The gate shows how many opens
you have left and makes you wait a few seconds (you choose how many). The wait only counts down
while the tab is visible. Then you can open the site for the set number of minutes. During an
open, every tab on that site works.

An open's minutes only run while its site is the active tab in a focused Brave window. Switch to
another tab or another app and the open pauses. Come back and it resumes. Like screen time, it
also pauses after a minute with no mouse or keyboard input, unless the tab plays sound. The popup
shows each open's time left and whether it is paused. The toolbar badge shows the minutes left
only while an open runs. When the time runs out, Ration sends every tab on the site back to the
gate. Unused minutes end at midnight with the day's opens. You can end an open early from the
popup, but the open stays spent.

"Not now" on the gate closes the tab. If the gate is the only tab in its window, it goes to the
new tab page instead, so the window stays open. The gate shows the site's own favicon, because
Brave saves the gate's icon for the site's bookmarks.

**Matching.** A domain covers its subdomains: `youtube.com` also limits `m.youtube.com`. Add every
domain a site uses, such as `youtu.be` for YouTube. The presets do this for common sites.

**Changing limits.** Every change applies and saves the moment you make it. Domains save when you
leave the field, because each new domain opens the browser's access prompt. A site you just added
stays free to edit or remove for 3 minutes.

**Streak.** Each finished day adds one to the streak if your time on limited sites stayed at or
under your daily goal. A day over the goal resets it to zero. Days with no browsing count as days
under the goal. A lower goal counts from the next day, so lowering it never fails a day already
under way. A higher goal counts at once.

The first change opens a 3-minute window that remembers your limits from before it. If your limits
are looser than that when the window ends, your streak resets to zero and that day does not count.
So you can go down and back up freely. While your limits are looser, a countdown with an Undo button
shows on the Stats and Limits pages, the popup shows it too, and the toolbar icon shows a red `!`.

**Allotted time.** Your limits allow at most opens × minutes per open for each site in one day.
The dashboard, the Limits page, and the popup show this total against your daily goal. If the
allotted time is above the goal, a day can go over it.

**Screen time.** Ration tracks time on limited sites only. Other browsing is never stored. Time
counts while a Brave window has focus and you are at the computer. If you leave the mouse and
keyboard alone for a minute, time stops, unless the tab plays sound (a video). A locked screen
always stops it. The Stats page shows time on limited sites for the last week, the last month,
the last 12 months, the year to date, and all time, with a chart broken down by site. History is
kept for as long as the extension is installed, stored only in Brave.

## What it cannot stop

A browser extension cannot lock itself in. These routes stay open:

- **Turning the extension off** at `brave://extensions`. Brave treats this like uninstalling.
- **Private windows**, unless you turn on Allow in Private (step 4).
- **The developer tools.** Developer mode lets you inspect the extension and edit its stored data.
- **Another browser or another Brave profile.**
- **Moving the system clock forward** starts a new day. Moving it back gains nothing: Ration never goes back a day, and a running open ends.

Ration does not limit sites shown inside other pages, such as a YouTube video embedded in a blog.

## Files

| Path | Contents |
|---|---|
| `manifest.json` | Extension manifest (Manifest V3) |
| `src/lib/core.js` | All rules: days, matching, opens, limit changes, streaks, tracking. No browser calls. |
| `src/lib/stats.js` | Totals and chart bars for each stats range. No browser calls. |
| `src/background.js` | Service worker: blocking rules, tab checks, alarms, time tracking, messages |
| `src/pages/gate.*` | The page a limited site shows |
| `src/pages/popup.*` | Toolbar popup |
| `src/pages/dashboard.*`, `chart.js` | Stats and Limits pages |
| `scripts/make-icons.mjs` | Draws the icons |
| `test/core.test.js`, `test/stats.test.js` | Unit tests for `core.js` and `stats.js` |
| `test/e2e.mjs` | End-to-end test in a real Brave with a throwaway profile |
| `scripts/package.mjs` | Checks the manifest and builds the store upload |
| `scripts/store-assets.mjs` | Renders the store screenshots and promo tile |
| `store/` | Store images and `LISTING.md`, the text for every store field |
| `PRIVACY.md` | Privacy policy for the store listing |

Blocking works in two layers. A `declarativeNetRequest` rule redirects page loads of each limited
site with no running open. The worker also checks each tab URL change, which catches sites that
change pages without a load (YouTube, Reddit) and tabs that were open before a limit started.
Sites without access get a plain block rule instead of the redirect.

## Develop

```sh
npm install        # puppeteer-core, for the end-to-end test only
npm test           # unit tests
npm run e2e        # about 2 minutes; set BRAVE_PATH if Brave is not in Program Files
                   # QUICK=1 skips the 80-second open-timer check
npm run icons      # redraw icons/
```

`npm run e2e` writes screenshots of every page, light and dark, to `test/screenshots/`. Set
`HEADED=1` to watch it run. A test cannot click Brave's permission prompt, so the test loads a
copy of the extension that is granted `*.test` sites up front. After you edit the extension,
click the reload arrow on its card at `brave://extensions`.

## Release

1. Raise `version` in `manifest.json` and `package.json`.
2. `npm run package`. This runs the unit tests, checks the manifest, and writes
   `dist/ration-<version>.zip` with only `manifest.json`, `src/`, and `icons/`.
3. `npm run e2e:dist` runs the end-to-end test against the packaged copy.
4. `npm run store-assets` redraws the store images if the pages changed.
5. Upload the zip and fill in the fields from `store/LISTING.md`.
