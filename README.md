# GeneFill — FamilySearch AutoFill Extension

A browser extension that fills FamilySearch oral genealogy forms directly from JSON data.
Multi-tab support — fill multiple forms simultaneously.

---

## Features

- ✅ Full JSON editor (GeneEdit) built into the extension popup
- ✅ Find & Replace (global or per column)
- ✅ Bulk edit selected rows
- ✅ Undo / Redo (50 steps)
- ✅ Auto-save to localStorage — data survives popup close
- ✅ Multi-tab simultaneous fill — assign different JSON to each tab
- ✅ Live progress per tab (filled / skipped / total / current RIN)
- ✅ Speed control (Safe / Normal / Turbo)
- ✅ Stop fill mid-run
- ✅ Pagination — auto-navigates through all form pages
- ✅ Firefox compatible (Manifest V2)

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

### Editor Tab (✎ Editor)

1. Click **📂 Load** — select your JSON file
2. Edit cells by clicking them
3. Use **Find/Replace** to bulk update locations or names
4. Select rows with checkboxes → **Bulk edit** or **Delete**
5. Click **⬇ Save** to download updated JSON
6. Data auto-saves — closing popup does NOT lose your work

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

**"Content script not ready" error:**
- Make sure you're on a FamilySearch pedigree form page
- Refresh the FamilySearch tab and try again

**Fields not filling correctly:**
- Try Safe speed (600ms) — gives the page more time between fields
- FamilySearch may have updated their form structure — check browser console for errors

**Progress stuck:**
- The form may have reached its last page
- Click Stop and check how many rows were filled

---

## Files

```
fs-extension/
  manifest.json       Extension config
  popup.html          Extension popup UI
  popup.js            Editor + tab manager logic
  background.js       Message hub + session state
  content.js          Form filler (runs in FamilySearch tabs)
  generate_icon.py    Generates PNG icons
  icon16/32/48/96/128.png  Extension icons
  README.md           This file
```
