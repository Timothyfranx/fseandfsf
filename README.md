# GeneFill — FamilySearch AutoFill Extension

A browser extension that fills FamilySearch oral genealogy forms directly from JSON data.
Multi-tab support — fill multiple forms simultaneously.

---

## Features

- ✅ Opens as a normal browser tab, not a popup — clicking the toolbar icon reuses that tab if it's already open, instead of stacking duplicates or risking work getting lost if a popup auto-closes
- ✅ Full JSON editor (GeneEdit) built into the extension tab
- ✅ Find & Replace (global or per column)
- ✅ Bulk edit selected rows
- ✅ Undo / Redo (50 steps)
- ✅ Auto-save to localStorage — data survives closing the tab
- ✅ Multi-tab simultaneous fill — assign different JSON to each tab
- ✅ Live progress per tab (filled / skipped / total / current RIN)
- ✅ Speed control (Safe / Normal / Turbo)
- ✅ Stop fill mid-run
- ✅ Pagination — auto-navigates through all form pages
- ✅ Firefox compatible (Manifest V3, `firefox/` folder in this repo)
- ✅ Extract tab (GeneVision) — turns scanned PDFs/photos into the JSON above using Gemini, batched 3 pages per call, with a review/rotate/reorder step before extraction

---

## Setup (One Time)

### Step 1 — Generate icons
```
python generate_icon.py
```
This creates icon16.png, icon32.png, icon48.png, icon96.png, icon128.png

### Step 2 — Load into Firefox

1. Open Firefox
2. Go to: `about:debugging`
3. Click **This Firefox** in the left sidebar
4. Click **Load Temporary Add-on**
5. Navigate to this folder and select `manifest.json`
6. Extension is loaded ✅

### Step 3 — Load into Chrome (optional)

1. Open Chrome
2. Go to: `chrome://extensions`
3. Enable **Developer Mode** (top right toggle)
4. Click **Load unpacked**
5. Select this entire folder
6. Extension is loaded ✅

---

## How to Use

Click the toolbar icon to open the extension — it opens as its own browser tab, not a small popup, so it stays open however long a Fill or Extract job takes. Clicking the icon again just switches to that same tab instead of opening a second one.

### Editor Tab (✎ Editor)

1. Click **📂 Load** — select your JSON file
2. Edit cells by clicking them
3. Use **Find/Replace** to bulk update locations or names
4. Select rows with checkboxes → **Bulk edit** or **Delete**
5. Click **⬇ Save** to download updated JSON
6. Data auto-saves — closing the tab does NOT lose your work

### Fill Tab (⚡ Fill)

1. Open one or more FamilySearch form tabs in the browser
2. Click **🔄 Detect Tabs** — extension finds all open form tabs
3. For each tab, click **📋 Assign JSON** — this copies your current editor data to that tab
4. Select your fill speed:
   - 🐢 Safe (600ms) — slowest, most reliable
   - ⚡ Normal (350ms) — recommended
   - 🚀 Turbo (150ms) — fastest, may miss fields on slow connections
5. Click **▶ Fill All** to start all tabs simultaneously
   — OR click **▶ Fill** on individual tabs
6. Watch the progress bars and RIN counters update live
7. Click **⏹ Stop** to stop any tab mid-fill

The fill loop runs in `background.js` (the extension's service worker), not on the page — so it does not slow down when you switch to another tab or app. If the FamilySearch tab itself is closed or navigated away mid-fill, the fill stops immediately with a clear error instead of silently "finishing" without actually filling anything.

---

### Extract Tab (🖼 Extract)

Turns scanned sheets (PDF or photos) into the JSON format above using Gemini.

1. In Settings, add at least one Gemini API key (up to 3 — jobs round-robin across them for extra throughput)
2. Click **🖼 Upload Images** for photos, or **📄 Upload PDF** for a scanned PDF (PDFs are split into page images locally, in your browser — nothing is uploaded anywhere for this step)
3. Review the page grid before it's sent anywhere: click a page to view it full-size, ✕ to drop a page that shouldn't be extracted (checklists, blank pages), ⟳ to rotate a sideways page, ◀▶ to fix page order
4. Click **✔ Confirm & Extract to JSON** — pages are sent to Gemini 3 at a time; each batch retries automatically on a dropped connection or rate limit
5. If a batch still fails after retrying, the job is marked **partial** with a **↻ Retry failed batches** button — nothing already extracted is lost
6. Rows Gemini wasn't confident about are flagged and highlighted once loaded into the Editor tab — check the RIN banner at the top for a count

---

## Multi-Tab Workflow

**For multiple different forms (recommended):**
1. Open Form A in Tab 1, Form B in Tab 2, Form C in Tab 3
2. Load JSON A in editor → Assign to Tab 1
3. Load JSON B in editor → Assign to Tab 2
4. Load JSON C in editor → Assign to Tab 3
5. Click Fill All — all 3 fill simultaneously

Each tab remembers its assigned data independently.

---

## JSON Format

The extension expects this exact structure:

```json
[
  {
    "rin": 1,
    "relation": "",
    "sex": "Male",
    "living": "No",
    "given_names": "Omah",
    "family_names": "Nwanwu",
    "birth_year": null,
    "birth_location": "Onu Ukpoka Mbu Akpoti, Isi Uzo, Enugu, Nigeria",
    "death_year": null,
    "death_location": "Onu Ukpoka Mbu Akpoti, Isi Uzo, Enugu, Nigeria"
  }
]
```

---

## Firefox for Android (Future)

To install on Firefox Android:
1. Publish the extension to addons.mozilla.org (AMO) — free
2. Or use Firefox Nightly on Android which supports unsigned extensions

---

## Troubleshooting

**"Stopped — lost contact with the FamilySearch tab" error:**
- The tab was closed, reloaded, or navigated away from the form while a fill was running
- Reopen the form and click Fill again — it's safe to re-run; already-filled fields will just be overwritten with the same values

**Fills slow down when you switch to another tab or app:**
- Check `chrome://settings/performance` (or the equivalent in Brave/Edge) — turn off Memory Saver, or add `familysearch.org` to "Always keep these sites active"
- The fill loop itself runs in the background service worker and isn't slowed by tab/window focus — this is a separate browser-level setting, not a bug in the extension

**Fields not filling correctly:**
- Try Safe speed (600ms) — gives the page more time between fields
- FamilySearch may have updated their form structure — check browser console for errors

**Progress stuck:**
- The form may have reached its last page
- Click Stop and check how many rows were filled

**Extract job stuck on "partial":**
- One or more batches failed even after automatic retries (bad connection, invalid/rate-limited API key) — click **↻ Retry failed batches**. Everything already extracted is kept; only the failed batches are re-sent.

**Rotate your Gemini API key if it was ever shared or pasted anywhere outside this extension's Settings panel** — treat it like a password.

---

## Files

```
fs-extension/                Chrome build (Manifest V3)
  manifest.json       Extension config
  popup.html           Popup UI — Editor / Fill / Extract tabs
  popup.js              Editor + multi-tab fill manager
  background.js         Owns the fill loop and all pacing (service worker)
  extract.js             PDF/image → JSON extraction via Gemini
  generate_icon.py    Generates PNG icons
  icon16/32/48/96/128.png  Extension icons
  README.md           This file
firefox/                     Firefox build (Manifest V3, background script — kept in sync with the files above by hand; no build step)
```
