# GeneFill — FamilySearch AutoFill (Firefox build)

This is a Firefox-compatible fork of the Chrome extension at
`Desktop\extension\fs-extension`. Same features, same code — the only
difference is `manifest.json`, which uses Firefox's Manifest V3 background
style (`background.scripts` instead of `background.service_worker`, plus a
`browser_specific_settings.gecko.id` Firefox needs).

**This is a manual fork, not a synced one.** If a bug gets fixed in the
Chrome version's `background.js`, `content.js`, or `popup.js`, the same fix
needs to be copied into this folder — it does not happen automatically.

---

## Load into Firefox

1. Open Firefox.
2. Go to `about:debugging`.
3. Click **This Firefox** in the left sidebar.
4. Click **Load Temporary Add-on**.
5. Navigate to this folder and select `manifest.json`.
6. Extension is loaded.

Note: "Load Temporary Add-on" only lasts until Firefox restarts — you'll
need to re-load it each time you reopen Firefox, unless you go through
Mozilla's signing process for a permanent install.

### Icons

If any icon files are missing, regenerate them:
```
python generate_icon.py
```
This creates icon16.png, icon32.png, icon48.png, icon96.png, icon128.png.

---

## Usage

Same as the Chrome version — see `Desktop\extension\fs-extension\README.md`
for the full JSON format, editor tools (Repair/Clean Genealogy/RIN check),
and multi-tab fill workflow.
