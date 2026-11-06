# Chrome Web Store submission

Work through the dashboard tabs in this order. Each grey block is one field: copy it as is.
Click **Save draft** before you leave each tab. Brave installs from the Chrome Web Store, so one
listing covers both browsers.

Files live in the `Ration` folder. Rebuild them with `npm run package` (the zip) and
`npm run store-assets` (the images).

---

## 1. Settings page (the gear, top left of the dashboard)

**Contact email**

```
rationextension@gmail.com
```

Then click **Verify** and open the link Google emails you. The store will not publish until the
address is verified.

---

## 2. Package tab

Upload `dist/ration-1.0.3.zip`.

---

## 3. Store listing tab

**Description** (the detailed description)

```
Ration gives the sites that eat your time a ration: a few opens a day, each with a time limit.

EVERYTHING STAYS ON YOUR DEVICE
Ration has no servers, no accounts, and no analytics. It never sends, shares, or sells what you do. Your limits, your stats, and your streak live in your browser and nowhere else. Ration asks for no site access when you install it, and only sees the sites you choose to limit.

HOW IT WORKS
• Pick the sites to limit, such as YouTube, Reddit, or X.
• Give each site a number of opens per day and minutes per open.
• Visiting a limited site shows a short pause first. Then you choose: open it, or not now.
• An open only counts down while the site is your active tab. Switch away and it pauses.
• When the time is up, the site shuts. When the opens are gone, it stays shut until midnight.

NO EASY WAY OUT
• Change your limits any time. Any looser change resets your streak, unless you undo it within 3 minutes.
• Setting the clock back does not bring back spent opens.

STREAKS AND STATS
• Set a daily goal for time on limited sites. Each day under the goal grows your streak.
• See your time by day, month, and year, broken down by site.
• See how the time your limits allow compares with your goal.

Ration only tracks the sites you limit. It keeps no history of anything else.
```

**Category**: Productivity, then **Workflow & Planning**. If that subcategory is missing, pick
**Tools** under Productivity.

**Language**: English (United States)

**Store icon** (128×128): `icons/icon128.png`

**Screenshots** (1280×800). Upload in this order:

1. `store/1-gate.png`
2. `store/2-done-for-today.png`
3. `store/3-stats.png`
4. `store/4-limits.png`
5. `store/5-private.png`

**Small promo tile** (440×280): `store/promo-small-440x280.png`

**Marquee promo tile** (1400×560): `store/promo-marquee-1400x560.png`

All images are 24-bit PNG with no alpha channel.

The name (Ration) and the summary come from the manifest in the zip. Leave them as they are.

---

## 4. Privacy practices tab

**Single purpose description**

```
Ration limits how often and how long you use the websites you choose, and shows how much time you spend on those sites.
```

**Permission justifications**, one box per permission:

`storage`

```
Saves the user's limits, the opens used each day, the time spent on limited sites, and the streak. This data is stored only in the browser on the user's device and is never transmitted.
```

`alarms`

```
Ends a timed open when its minutes run out, and starts a new day at midnight so the daily opens reset.
```

`idle`

```
Stops counting time on a limited site while the user is away from the computer, so the time shown is accurate.
```

`declarativeNetRequest`

```
Redirects a site the user has chosen to limit to the extension's own gate page before the site loads. If the user has turned off the extension's access to a limited site, the same feature blocks that site instead, so the limit still holds.
```

`favicon`

```
Shows the limited site's own icon on the gate page. Without it, the browser saves the extension's icon for the user's bookmarks of that site.
```

Host permission (if the dashboard asks; it is optional host access, `*://*/*`)

```
Ration requests no site access at install. When the user saves a site to limit, Ration requests access to that one site only, so it can send the site to the gate page and tell when the site is the active tab for timing. Ration gives the access back when the user stops limiting the site.
```

**Are you using remote code?** Select **No, I am not using remote code**. If a text box still
appears, paste:

```
Ration uses no remote code. All JavaScript ships inside the extension package. It loads no external scripts, uses no eval, and makes no network requests.
```

**Data usage**

Ration does not collect user data: nothing leaves the device. Leave every data type unticked.

If a reviewer reads "collect" as including data kept only on the device, tick **Web history**
(time on the sites the user limits) and **User activity** (opens used), and state that the data is
stored locally and never transmitted.

Tick all three certifications:

- I do not sell or transfer user data to third parties, outside of the approved use cases.
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
- I do not use or transfer user data to determine creditworthiness or for lending purposes.

**Privacy policy URL**

```
https://github.com/jatmart/ration/blob/main/PRIVACY.md
```

---

## 5. Distribution tab

- Visibility: Public (or Unlisted for a test run).
- Regions: all regions.
- Price: free.

---

## What the install prompt shows

With no host permissions in the manifest, the install prompt has one line, "Block content on any
page", from `declarativeNetRequest`. It has no line about reading or changing data on websites.
When the user saves a site, the browser asks for that site alone, for example "Read and change
your data on youtube.com".
