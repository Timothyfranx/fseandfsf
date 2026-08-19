// extract.js — Image/PDF → Gemini → Editor pipeline
//
// Plain classic script (like popup.js) — talks to the rest of the app
// through the same globals popup.js exposes (addFileTab, switchToFile,
// renderFileTabs, toast, confirm2, escapeHtml, showView).
//
// pdf.js (only needed for PDF uploads, which only ships as an ES module) is
// loaded lazily via dynamic import() the first time a PDF actually needs
// converting, not at file-load time — so if that ever fails, only PDF
// support breaks, not the whole Extract tab (image uploads never touch it).

let pdfjsLib = null;
async function ensurePdfJs() {
  if (pdfjsLib) return pdfjsLib;
  pdfjsLib = await import(chrome.runtime.getURL('pdf.min.mjs'));
  pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('pdf.worker.min.mjs');
  return pdfjsLib;
}

const LS_API_KEYS = 'gf_api_keys';
const GEMINI_MODEL = 'gemini-3.6-flash';
const MAX_CONTINUATION_ROUNDS = 6;
const MAX_CONCURRENT_JOBS = 3;
// Pages are sent to Gemini in batches of this size rather than all at once —
// keeps each call scoped to about one physical sheet, which is both cheaper
// and reads more reliably than dumping a whole stack of pages in one shot.
const BATCH_SIZE = 3;

const BASE_PROMPT = `You are helping extract data from a FamilySearch oral genealogy interview sheet.

### Columns to Extract
- **RIN #**: Row number.
- **Relation S/C/P**: Relation code. For children with two parents (e.g., parents are RIN 1 and RIN 2), use the format \`C1,C2\`. Always prefix each parent number with 'C'.
- **Sex M/F**: Output as "Male" or "Female".
- **Given names, Family names**: Two separate name fields. Use **Sentence Case** (e.g., "Ezinwanne" instead of "EZINWANNE").
- **Birth and Death Section**:
    - **Smiling face icon**: Birth info (year and/or location).
        - If **CIRCLED**: \`living = "Yes"\`.
    - **Cemetery icon**: Death info (year and/or location).
        - If **CIRCLED**: \`living = "No"\`.
- **Location**: Format is \`Ward, LGA, State, Country\`. Use **Sentence Case**.
    - If only a ward name is written, keep the same LGA/State/Country as the base location.
    - \`"\` (ditto mark) means same location as the row above.
    - Base location for this sheet is written at the top of the page.

### Rules
- If \`living = "No"\` and no death location is written, set \`death_location\` to the same as \`birth_location\`.
- Birth and death are **YEAR ONLY**, never a full date.
- **Relation code**: Use the format \`C1\` for one parent or \`C1,C2\` for two parents.
- **Row 1**: Always has an empty relation field — leave it as \`""\`.
- If a field is unknown or blank, use \`null\`.
- **Formatting**: Use Sentence Case for all names and locations.

### Common Mistake To Avoid
The "Sex M/F" column sits directly to the left of "Given names" on the sheet, and handwriting is often cramped enough that the M or F looks like it's touching the first letter of the name. It is NOT part of the name.
- WRONG: sheet shows \`M | Odo\` → given_names: "Modo"
- RIGHT: sheet shows \`M | Odo\` → sex: "Male", given_names: "Odo"
Always read the Sex column and the Given Names column as two separate cells, even when they look visually joined.

### Review Flag
Add a \`"review": true\` field on any row where you are genuinely unsure — crowded handwriting, an ambiguous circle, unclear column alignment. Use \`"review": false\` when you're confident. This does not affect any other field.

### Output Format
Output **ONLY** a valid JSON array. No explanation, no markdown, no extra text. Use exactly this structure:

\`\`\`json
[
  {
    "rin": 1,
    "relation": "",
    "sex": "Male",
    "given_names": "Omah",
    "family_names": "Nwanwu",
    "birth_year": null,
    "birth_location": "Onu Ukpoka Mbu Akpoti, Isi Uzo, Enugu, Nigeria",
    "death_year": null,
    "death_location": "Onu Ukpoka Mbu Akpoti, Isi Uzo, Enugu, Nigeria",
    "living": "No",
    "review": false
  }
]
\`\`\`

---

## Tips for Best Results
- Always verify the **base location** from the top header of the sheet.
- Double check the **circled icon** (smiling vs. cemetery) for every row.
- If a name is unclear, write your best guess — the user will review and correct.
- **Do NOT** add any text before or after the JSON array.
- prioritize **accuracy** over **speed**`;

function continuationPrompt(lastRin) {
  return `You are continuing a FamilySearch genealogy extraction task on the SAME images provided.

Previous batch ended at RIN: ${lastRin}

Continue extracting from the next RIN onward — do not repeat rows you've already given. Apply all the same rules as before:
- Relation format: C1 or C1,C2
- Sex: "Male" or "Female"
- Living: "Yes" or "No" based on circled icon
- Names and locations in Sentence Case
- Location format: Ward, LGA, State, Country
- Ditto mark " means same location as row above
- If living = "No" and no death location written, death_location = birth_location
- Year only, never full date
- If blank, use null
- The Sex column (M/F) is separate from Given Names — never merge them
- Add "review": true on rows you're unsure about, false otherwise

Output ONLY a valid JSON array continuing from where we stopped. No explanation, no markdown, no extra text.`;
}

// ── API key management (Vercel/Railway-style: paste once, masked after) ────
function loadApiKeys() {
  try { return JSON.parse(localStorage.getItem(LS_API_KEYS)) || {}; }
  catch (e) { return {}; }
}
function saveApiKeys(keys) {
  localStorage.setItem(LS_API_KEYS, JSON.stringify(keys));
}
function maskKey(key) {
  if (!key || key.length < 6) return '••••••••';
  return '••••••••••' + key.slice(-4);
}

function renderApiKeySlots() {
  const keys = loadApiKeys();
  for (let slot = 1; slot <= 3; slot++) {
    const row = document.getElementById('apiKeyRow' + slot);
    if (!row) continue;
    const saved = keys[slot];
    row.innerHTML = saved ? `
      <span style="font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;color:var(--muted);">${maskKey(saved)}</span>
      <button class="btn btn-danger btn-sm" data-slot="${slot}" data-action="delete-key">Delete</button>
    ` : `
      <input class="input-field grow" type="password" id="apiKeyInput${slot}" placeholder="Paste Gemini API key ${slot}...">
      <button class="btn btn-primary btn-sm" data-slot="${slot}" data-action="save-key">Save</button>
    `;
  }
}

function setupApiKeyListeners() {
  document.getElementById('apiKeySettings').addEventListener('click', e => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const slot = btn.dataset.slot;
    const keys = loadApiKeys();
    if (btn.dataset.action === 'save-key') {
      const input = document.getElementById('apiKeyInput' + slot);
      const val = (input.value || '').trim();
      if (!val) { toast('Enter a key first', 'error'); return; }
      keys[slot] = val;
      saveApiKeys(keys);
      renderApiKeySlots();
      toast('Key ' + slot + ' saved', 'success');
    } else if (btn.dataset.action === 'delete-key') {
      confirm2('Delete API key ' + slot + '?', () => {
        delete keys[slot];
        saveApiKeys(keys);
        renderApiKeySlots();
        toast('Key ' + slot + ' deleted', 'info');
      });
    }
  });
}

// ── Shared canvas helpers (thumbnails, rotation) ────────────────────────────
// A small downscaled JPEG for the arrange grid — decoding/painting a full
// extraction-quality image on every re-render is what caused the review
// screen to lag, so the grid never touches full-res data directly.
function makeThumb(source, maxW = 600, quality = 0.7) {
  const scale = Math.min(1, maxW / source.width);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(source.width * scale);
  canvas.height = Math.round(source.height * scale);
  canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', quality).split(',')[1];
}

function loadImageEl(base64, mimeType) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = `data:${mimeType};base64,${base64}`;
  });
}

// Rotates a page 90° clockwise and re-encodes it — used by both the PDF and
// image flows so preview, ZIP export, and Gemini extraction all see the same
// corrected orientation (rotation is baked in immediately, not tracked as a
// separate transform applied later in different places).
async function rotatePage(base64, mimeType) {
  const img = await loadImageEl(base64, mimeType);
  const canvas = document.createElement('canvas');
  canvas.width = img.height;
  canvas.height = img.width;
  const ctx = canvas.getContext('2d');
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate(Math.PI / 2);
  ctx.drawImage(img, -img.width / 2, -img.height / 2);
  return {
    data: canvas.toDataURL('image/jpeg', 0.92).split(',')[1],
    mimeType: 'image/jpeg',
    thumb: makeThumb(canvas)
  };
}

// ── PDF → image pages (rendered client-side, no server) ────────────────────
async function pdfToImages(file) {
  const pdfjs = await ensurePdfJs();
  const buf = await file.arrayBuffer();
  const pdf = await pdfjs.getDocument({ data: buf }).promise;
  const images = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const viewport = page.getViewport({ scale: 2.0 });
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    const dataUrl = canvas.toDataURL('image/jpeg', 0.92);

    images.push({
      full: dataUrl.split(',')[1],
      thumb: makeThumb(canvas)
    });
  }
  return images;
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ── Minimal ZIP writer (no external library) ────────────────────────────────
// Pages are JPEGs, already compressed — STORE (no deflate) keeps this small
// and dependency-free while still producing a standard ZIP any OS can open.
function crc32(bytes) {
  let crc = ~0;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i];
    for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

function createZipBlob(entries) {
  const enc = new TextEncoder();
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  entries.forEach(({ name, bytes }) => {
    const nameBytes = enc.encode(name);
    const crc = crc32(bytes);
    const size = bytes.length;
    const localHeaderOffset = offset;

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);   // local file header signature
    local.setUint16(4, 20, true);           // version needed
    local.setUint16(6, 0, true);            // flags
    local.setUint16(8, 0, true);            // method: stored
    local.setUint16(10, 0, true);           // mod time
    local.setUint16(12, 0, true);           // mod date
    local.setUint32(14, crc, true);
    local.setUint32(18, size, true);        // compressed size
    local.setUint32(22, size, true);        // uncompressed size
    local.setUint16(26, nameBytes.length, true);
    local.setUint16(28, 0, true);           // extra field length
    localParts.push(new Uint8Array(local.buffer), nameBytes, bytes);
    offset += 30 + nameBytes.length + size;

    const central = new DataView(new ArrayBuffer(46));
    central.setUint32(0, 0x02014b50, true); // central directory signature
    central.setUint16(4, 20, true);         // version made by
    central.setUint16(6, 20, true);         // version needed
    central.setUint16(8, 0, true);          // flags
    central.setUint16(10, 0, true);         // method: stored
    central.setUint16(12, 0, true);         // mod time
    central.setUint16(14, 0, true);         // mod date
    central.setUint32(16, crc, true);
    central.setUint32(20, size, true);
    central.setUint32(24, size, true);
    central.setUint16(28, nameBytes.length, true);
    central.setUint16(30, 0, true);         // extra field length
    central.setUint16(32, 0, true);         // comment length
    central.setUint16(34, 0, true);         // disk number
    central.setUint16(36, 0, true);         // internal attrs
    central.setUint32(38, 0, true);         // external attrs
    central.setUint32(42, localHeaderOffset, true);
    centralParts.push(new Uint8Array(central.buffer), nameBytes);
  });

  const centralDirOffset = offset;
  const centralDirSize = centralParts.reduce((n, p) => n + p.length, 0);

  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);      // end-of-central-directory signature
  eocd.setUint16(4, 0, true);
  eocd.setUint16(6, 0, true);
  eocd.setUint16(8, entries.length, true);
  eocd.setUint16(10, entries.length, true);
  eocd.setUint32(12, centralDirSize, true);
  eocd.setUint32(16, centralDirOffset, true);
  eocd.setUint16(20, 0, true);

  return new Blob([...localParts, ...centralParts, new Uint8Array(eocd.buffer)], { type: 'application/zip' });
}

// Lets a PDF-origin job be resolved as a plain image download (like an
// "iLovePDF PDF-to-JPG" export) instead of always going through extraction —
// the split pages are already high quality (scale 2.0 JPEG), so this is
// exactly what the arranging step already has on hand.
function downloadPagesAsZip(job) {
  if (!job.pages.length) { toast('No pages to download', 'error'); return; }
  const safeName = job.name.replace(/[^\w.-]+/g, '_') || 'pages';
  const entries = job.pages.map((p, i) => ({
    name: `${safeName}_page_${String(i + 1).padStart(2, '0')}.jpg`,
    bytes: base64ToBytes(p.data)
  }));
  const blob = createZipBlob(entries);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${safeName}_pages.zip`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast(`Downloaded ${entries.length} page(s) as ZIP`, 'success');
}

// ── Gemini call — timeout + retry/backoff on transient failures ────────────
// A hung connection used to look identical to "still working" forever; now
// each attempt is capped at GEMINI_TIMEOUT_MS via AbortController. Retries
// cover network drops and transient server errors (429/500/502/503/504),
// not client errors (400/401/403/404) — those need a config fix, not a retry.
const GEMINI_TIMEOUT_MS = 45000;
const GEMINI_MAX_ATTEMPTS = 3;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

async function callGemini(apiKey, promptText, pageImages, onRetry) {
  const parts = [{ text: promptText }];
  for (const p of pageImages) parts.push({ inline_data: { mime_type: p.mimeType, data: p.data } });

  const body = { contents: [{ role: 'user', parts }], generationConfig: { temperature: 0.1 } };
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;

  let lastErr;
  for (let attempt = 0; attempt < GEMINI_MAX_ATTEMPTS; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), GEMINI_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal
      });
      const d = await res.json();
      if (d.error) {
        const err = new Error(d.error.message || 'Gemini API error');
        err.httpStatus = d.error.code;
        throw err;
      }
      return d.candidates[0].content.parts.map(p => p.text || '').join('');
    } catch (e) {
      lastErr = e;
      const retryable = e.name === 'AbortError'
        || (e instanceof TypeError) // network failure, e.g. connection dropped
        || RETRYABLE_STATUS.has(e.httpStatus);
      if (!retryable || attempt === GEMINI_MAX_ATTEMPTS - 1) throw e;
      const backoff = 1000 * Math.pow(2, attempt) + Math.floor(Math.random() * 250);
      onRetry && onRetry(attempt + 1, e);
      await sleep(backoff);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

function parseJsonArray(text) {
  const cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim();
  const start = cleaned.indexOf('[');
  const end = cleaned.lastIndexOf(']');
  if (start === -1 || end === -1) throw new Error('No JSON array found in model output');
  return JSON.parse(cleaned.slice(start, end + 1));
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// One batch's worth of extraction: initial call + auto-continuation until
// its RIN count stops growing. Wraps every Gemini call with a 1s ticker so
// progressText never sits static while a slow connection is still working,
// and surfaces retry attempts instead of hiding them behind a silent wait.
async function extractBatch(apiKey, batchImages, batchLabel, onProgress) {
  async function callWithTicker(promptText, roundLabel) {
    let elapsed = 0;
    const tick = () => {
      elapsed++;
      const slowNote = elapsed > 15 ? ' — still working, this can take longer on a slow connection' : '';
      onProgress(`${batchLabel}${roundLabel}... (${elapsed}s)${slowNote}`);
    };
    const ticker = setInterval(tick, 1000);
    try {
      return await callGemini(apiKey, promptText, batchImages, (attempt, err) => {
        onProgress(`${batchLabel}${roundLabel}: retrying (attempt ${attempt + 1}/${GEMINI_MAX_ATTEMPTS}) after ${friendlyError(err)}`);
      });
    } finally {
      clearInterval(ticker);
    }
  }

  const batchMerged = new Map();
  let text = await callWithTicker(BASE_PROMPT, 'extracting');
  parseJsonArray(text).forEach(r => batchMerged.set(Number(r.rin), r));

  let lastMax = Math.max(0, ...batchMerged.keys());
  for (let round = 2; round <= MAX_CONTINUATION_ROUNDS; round++) {
    text = await callWithTicker(continuationPrompt(lastMax), `round ${round}`);
    let more;
    try { more = parseJsonArray(text); }
    catch (e) {
      onProgress(`${batchLabel}round ${round}: model output stopped parsing early — extraction may be incomplete for this batch`);
      break;
    }
    if (!more.length) break;
    let grew = false;
    more.forEach(r => {
      const rin = Number(r.rin);
      if (!batchMerged.has(rin)) grew = true;
      batchMerged.set(rin, r);
    });
    const newMax = Math.max(lastMax, ...more.map(r => Number(r.rin)));
    if (!grew || newMax <= lastMax) break;
    lastMax = newMax;
  }

  return Array.from(batchMerged.values());
}

// ── Per-job extraction: pages go to Gemini in batches of BATCH_SIZE (3).
//    Batch results are merged onto job.mergedRows (not a local variable) —
//    so if one batch fails, the rows already extracted from OTHER batches
//    in the same job are kept, downloaded, and loaded, instead of the whole
//    job's progress being thrown away. job.batchDone/job.failedBatches let a
//    later "Retry failed batches" click re-run only what didn't succeed ────
async function extractJob(job, apiKey, onProgress) {
  const batches = chunkArray(job.pages, BATCH_SIZE);
  if (!job.mergedRows) job.mergedRows = [];
  if (!job.batchDone) job.batchDone = new Array(batches.length).fill(false);
  job.failedBatches = [];

  for (let b = 0; b < batches.length; b++) {
    if (job.batchDone[b]) continue;
    const batchImages = batches[b];
    const batchLabel = batches.length > 1 ? `Batch ${b + 1}/${batches.length}: ` : '';

    try {
      const batchRecords = await extractBatch(apiKey, batchImages, batchLabel, onProgress);
      const rinIndex = new Map(job.mergedRows.map(([rin], i) => [rin, i]));
      batchRecords.forEach(r => {
        const rin = Number(r.rin);
        if (rinIndex.has(rin)) job.mergedRows[rinIndex.get(rin)] = [rin, r];
        else { job.mergedRows.push([rin, r]); rinIndex.set(rin, job.mergedRows.length - 1); }
      });
      job.batchDone[b] = true;
    } catch (batchErr) {
      job.failedBatches.push(b);
      onProgress(`${batchLabel}failed — ${friendlyError(batchErr)}`);
    }
  }

  return job.mergedRows.map(([, r]) => r).sort((a, b) => Number(a.rin) - Number(b.rin));
}

// ── Job queue: up to 3 concurrent jobs, one API key each, round-robin ──────
let jobQueue = [];
let jobIdCounter = 0;

function renderJobQueue() {
  const el = document.getElementById('extractJobList');
  if (!jobQueue.length) {
    el.innerHTML = '<div class="no-tabs"><div class="icon">🖼</div><div>Upload images or a PDF to begin</div></div>';
    return;
  }
  el.innerHTML = jobQueue.map(j => j.status === 'arranging' ? renderArrangingCard(j) : renderQueueCard(j)).join('');
}

// Full-size lightbox for a single page — the arrange grid only ever shows a
// downscaled thumbnail (for speed), so this is how the user actually reads
// the page content before deciding to keep/drop/reorder it.
function showPageZoom(page) {
  let overlay = document.getElementById('pageZoomOverlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'pageZoomOverlay';
    overlay.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,.85); display:flex; align-items:center; justify-content:center; z-index:9999; cursor:zoom-out; padding:24px; box-sizing:border-box;';
    overlay.addEventListener('click', () => overlay.remove());
    document.body.appendChild(overlay);
  }
  overlay.innerHTML = `<img src="data:${page.mimeType};base64,${page.data}" style="max-width:100%; max-height:100%; object-fit:contain; box-shadow:0 4px 24px rgba(0,0,0,.5); border-radius:4px;">`;
}

// Card shown for a PDF-origin job right after it's been split into page
// images, before it's queued — lets the user drop useless pages (cover
// sheets, QC checklists) and fix page order before anything is named/sent.
function renderArrangingCard(j) {
  return `
    <div class="tab-card" style="margin-bottom:8px;">
      <div style="display:flex; justify-content:space-between; align-items:center; gap:8px; margin-bottom:6px;">
        <input class="input-field" data-job-id="${j.id}" data-field="name" value="${escapeHtml(j.name)}" style="font-size:12px; font-weight:700; flex:1;">
        <span style="font-size:10px; color:var(--muted); white-space:nowrap;">${j.pages.length} page(s)</span>
      </div>
      <p style="font-size:10px; color:var(--muted); margin:0 0 6px;">Remove pages that shouldn't be extracted, rotate ones on their side, and use ◀▶ to fix the order — click a page to view it full-size. Then confirm.</p>
      <div style="display:grid; grid-template-columns:repeat(auto-fill, minmax(160px,1fr)); gap:8px; margin-bottom:8px;">
        ${j.pages.map((p, i) => `
          <div style="position:relative; border:1px solid var(--border); border-radius:6px; overflow:hidden;">
            <img src="data:image/jpeg;base64,${p.thumb || p.data}" data-job-id="${j.id}" data-action="zoom-page" data-page-idx="${i}" style="width:100%; height:220px; object-fit:contain; background:var(--surface2); display:block; cursor:zoom-in;">
            <button class="btn btn-ghost btn-sm" data-job-id="${j.id}" data-action="rotate-page" data-page-idx="${i}" title="Rotate 90°" style="position:absolute; top:2px; left:2px; padding:1px 5px; font-size:9px; line-height:1.4;">⟳</button>
            <button class="btn btn-danger btn-sm" data-job-id="${j.id}" data-action="remove-page" data-page-idx="${i}" title="Remove this page" style="position:absolute; top:2px; right:2px; padding:1px 5px; font-size:9px; line-height:1.4;">✕</button>
            <div style="position:absolute; bottom:2px; left:2px; right:2px; display:flex; justify-content:space-between; align-items:center;">
              <button class="btn btn-ghost btn-sm" data-job-id="${j.id}" data-action="move-page-left" data-page-idx="${i}" ${i === 0 ? 'disabled' : ''} style="padding:0 4px; font-size:10px; line-height:1.5;">◀</button>
              <span style="font-size:9px; color:#fff; background:rgba(0,0,0,.55); border-radius:3px; padding:0 4px;">${i + 1}</span>
              <button class="btn btn-ghost btn-sm" data-job-id="${j.id}" data-action="move-page-right" data-page-idx="${i}" ${i === j.pages.length - 1 ? 'disabled' : ''} style="padding:0 4px; font-size:10px; line-height:1.5;">▶</button>
            </div>
          </div>
        `).join('')}
      </div>
      <div style="display:flex; gap:6px; align-items:center; flex-wrap:wrap;">
        <button class="btn btn-success btn-sm" data-job-id="${j.id}" data-action="confirm-arrange" ${j.pages.length === 0 ? 'disabled' : ''}>✔ Confirm & Extract to JSON</button>
        <button class="btn btn-primary btn-sm" data-job-id="${j.id}" data-action="download-zip" ${j.pages.length === 0 ? 'disabled' : ''}>⬇ Download as ZIP</button>
        ${j.lastRemoved ? `<button class="btn btn-warning btn-sm" data-job-id="${j.id}" data-action="undo-remove-page">↺ Undo remove</button>` : ''}
        <button class="btn btn-ghost btn-sm" data-job-id="${j.id}" data-action="remove-job" style="margin-left:auto;">🗑 Discard</button>
      </div>
    </div>
  `;
}

function renderQueueCard(j) {
  const editable = j.status === 'queued' || j.status === 'error';
  return `
    <div class="tab-card" style="margin-bottom:8px;">
      <div style="display:flex; justify-content:space-between; align-items:center; gap:8px;">
        ${editable
          ? `<input class="input-field" data-job-id="${j.id}" data-field="name" value="${escapeHtml(j.name)}" style="font-size:12px; font-weight:700; flex:1;">`
          : `<strong style="font-size:12px;">${escapeHtml(j.name)}${j.digits ? ` <span style="font-weight:400; color:var(--muted);">(ID ...${escapeHtml(j.digits)})</span>` : ''}</strong>`}
        <span style="font-size:10px; color:var(--muted); white-space:nowrap;">${j.status}</span>
      </div>
      ${editable ? `
      <div style="display:flex; gap:6px; align-items:center; margin-top:6px;">
        <span style="font-size:10px; color:var(--muted);">4-digit ID:</span>
        <input class="input-field" data-job-id="${j.id}" data-field="digits" value="${j.digits ? escapeHtml(j.digits) : ''}" placeholder="optional" style="font-size:11px; width:90px;">
        <button class="btn btn-ghost btn-sm" data-job-id="${j.id}" data-action="remove-job" style="margin-left:auto;">✕</button>
      </div>` : ''}
      ${j.status === 'partial' ? `
      <div style="margin-top:6px;">
        <button class="btn btn-warning btn-sm" data-job-id="${j.id}" data-action="retry-failed-batches">↻ Retry failed batches</button>
      </div>` : ''}
      <div style="font-size:11px; color:var(--muted); margin-top:4px;">${j.progressText || ''}</div>
    </div>
  `;
}

// Every job's result is saved to disk as one JSON file — whether it came
// from a single PDF or a stack of page images, it's merged into one array
// first, so what lands on disk is always a single, shareable .json file.
function downloadJobJson(job, records) {
  const blob = new Blob([JSON.stringify(records, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = job.name.replace(/\.json$/i, '') + '.json';
  a.click();
  URL.revokeObjectURL(a.href);
}

async function runJob(job, apiKey) {
  job.status = 'running';
  job.progressText = '';
  renderJobQueue();
  try {
    const records = await extractJob(job, apiKey, (msg) => {
      job.progressText = msg;
      renderJobQueue();
    });
    const failedCount = (job.failedBatches || []).length;

    if (records.length === 0) {
      throw new Error(failedCount > 0
        ? 'All batches failed to extract — check your connection and API key, then try again.'
        : 'No rows were extracted.');
    }

    const flagged = records.filter(r => r.review).length;
    downloadJobJson(job, records);
    const id = addFileTab(job.name, job.digits, records);
    renderFileTabs();

    if (failedCount > 0) {
      // Some batches succeeded, some didn't — save what we have rather than
      // discard it, and let the user retry just the failed part.
      job.status = 'partial';
      job.progressText = `${records.length} row(s) extracted, but ${failedCount} batch(es) failed — partial file saved as ${job.name}.json. Click "Retry failed batches" to complete it.`;
      toast(`${job.name}: partial extraction — ${failedCount} batch(es) failed, partial file saved`, 'warning');
    } else {
      job.status = 'done';
      job.progressText = `${records.length} rows extracted${flagged ? `, ${flagged} flagged for review` : ''} — saved as ${job.name}.json`;
      toast(`${job.name}: ${records.length} rows extracted and saved`, 'success');
    }

    if (!window.__extractSwitched) {
      window.__extractSwitched = true;
      switchToFile(id);
      showView && showView('editor');
    }
  } catch (e) {
    job.status = 'error';
    job.progressText = friendlyError(e);
    toast(job.name + ' failed: ' + friendlyError(e), 'error');
  }
  renderJobQueue();
}

async function runAllJobs() {
  const keys = loadApiKeys();
  const keySlots = [1, 2, 3].filter(s => keys[s]);
  if (!keySlots.length) { toast('Add at least one API key in Settings first', 'error'); return; }

  const pending = jobQueue.filter(j => j.status === 'queued' || j.status === 'error');
  if (!pending.length) { toast('Nothing queued', 'error'); return; }

  const btn = document.getElementById('btnExtractRunAll');
  setBusy(btn, `Running ${pending.length} job(s)...`);

  window.__extractSwitched = false;
  let next = 0;
  async function worker(slotIdx) {
    while (next < pending.length) {
      const job = pending[next++];
      await runJob(job, keys[keySlots[slotIdx % keySlots.length]]);
    }
  }
  const workerCount = Math.min(MAX_CONCURRENT_JOBS, keySlots.length, pending.length);
  await Promise.all(Array.from({ length: workerCount }, (_, i) => worker(i)));
  clearBusy(btn);
}

// Strip extension and any trailing "-page-0003" / "_page3" style page-number
// suffix so a multi-page sheet gets named after the sheet, not its first page.
function baseNameFromFilename(filename) {
  const rawName = filename.replace(/\.(pdf|jpe?g|png)$/i, '');
  return rawName.replace(/[-_]?page[-_]?\d+$/i, '') || rawName;
}

// Images go through the same arranging step as PDFs — uploads can land out
// of order or include a shot that shouldn't be extracted, so the user gets
// a chance to preview, rotate, drop, and reorder before anything is sent.
async function addImagesJob(files) {
  if (!files.length) return;
  const job = {
    id: 'j' + (jobIdCounter++),
    name: baseNameFromFilename(files[0].name),
    digits: null,
    pages: [],
    status: 'splitting',
    progressText: `Loading ${files.length} image(s)...`
  };
  jobQueue.push(job);
  renderJobQueue();

  for (const file of files) {
    try {
      const data = await fileToBase64(file);
      const mimeType = file.type || 'image/jpeg';
      const img = await loadImageEl(data, mimeType);
      job.pages.push({ data, mimeType, thumb: makeThumb(img) });
    } catch (e) {
      job.status = 'error';
      job.progressText = `Failed to read "${file.name}": ${friendlyError(e)}`;
      renderJobQueue();
      return;
    }
  }
  job.status = 'arranging';
  job.progressText = `${job.pages.length} page(s) — review before extracting`;
  renderJobQueue();
}

// A PDF is split locally into page images first, then handed to the
// arranging card — scans often include useless pages (checklists, consent
// forms) or pages out of order, so the user gets a chance to drop/reorder
// them before anything is named or sent to Gemini.
async function addPdfJob(file) {
  const job = {
    id: 'j' + (jobIdCounter++),
    name: baseNameFromFilename(file.name),
    digits: null,
    pages: [],
    status: 'splitting',
    progressText: 'Splitting PDF into pages...'
  };
  jobQueue.push(job);
  renderJobQueue();

  try {
    const images = await pdfToImages(file);
    job.pages = images.map(img => ({ data: img.full, mimeType: 'image/jpeg', thumb: img.thumb }));
    job.status = 'arranging';
    job.progressText = `${job.pages.length} page(s) — review before extracting`;
  } catch (e) {
    job.status = 'error';
    job.progressText = 'PDF split failed: ' + e.message;
  }
  renderJobQueue();
}

async function addPdfJobs(files) {
  for (const file of files) await addPdfJob(file);
}

// ── Wiring ───────────────────────────────────────────────────────────────
function setupExtractListeners() {
  setupApiKeyListeners();
  renderApiKeySlots();

  document.getElementById('btnExtractAddImages').addEventListener('click', () => {
    document.getElementById('extractImageInput').click();
  });
  document.getElementById('extractImageInput').addEventListener('change', e => {
    addImagesJob(Array.from(e.target.files));
    e.target.value = '';
  });
  document.getElementById('btnExtractAddPdf').addEventListener('click', () => {
    document.getElementById('extractPdfInput').click();
  });
  document.getElementById('extractPdfInput').addEventListener('change', e => {
    addPdfJobs(Array.from(e.target.files));
    e.target.value = '';
  });
  document.getElementById('btnExtractRunAll').addEventListener('click', runAllJobs);
  document.getElementById('btnExtractClearQueue').addEventListener('click', () => {
    jobQueue = jobQueue.filter(j => j.status !== 'done');
    renderJobQueue();
  });

  document.getElementById('extractJobList').addEventListener('click', async e => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const job = jobQueue.find(j => j.id === btn.dataset.jobId);

    switch (btn.dataset.action) {
      case 'zoom-page': {
        if (!job) return;
        showPageZoom(job.pages[Number(btn.dataset.pageIdx)]);
        break;
      }
      case 'rotate-page': {
        if (!job) return;
        const i = Number(btn.dataset.pageIdx);
        const p = job.pages[i];
        btn.disabled = true;
        const rotated = await rotatePage(p.data, p.mimeType);
        job.pages[i] = { ...p, ...rotated };
        renderJobQueue();
        break;
      }
      case 'remove-job': {
        if (job && job.status === 'arranging' && job.pages.length > 0) {
          if (!confirm(`Discard "${job.name}" and its ${job.pages.length} arranged page(s)? This can't be undone.`)) return;
        }
        jobQueue = jobQueue.filter(j => j.id !== btn.dataset.jobId);
        renderJobQueue();
        break;
      }
      case 'remove-page': {
        if (!job) return;
        const idx = Number(btn.dataset.pageIdx);
        job.lastRemoved = { page: job.pages[idx], index: idx };
        job.pages.splice(idx, 1);
        renderJobQueue();
        break;
      }
      case 'undo-remove-page': {
        if (!job || !job.lastRemoved) return;
        const { page, index } = job.lastRemoved;
        job.pages.splice(Math.min(index, job.pages.length), 0, page);
        job.lastRemoved = null;
        renderJobQueue();
        break;
      }
      case 'move-page-left': {
        if (!job) return;
        const i = Number(btn.dataset.pageIdx);
        if (i > 0) [job.pages[i - 1], job.pages[i]] = [job.pages[i], job.pages[i - 1]];
        renderJobQueue();
        break;
      }
      case 'move-page-right': {
        if (!job) return;
        const i = Number(btn.dataset.pageIdx);
        if (i < job.pages.length - 1) [job.pages[i + 1], job.pages[i]] = [job.pages[i], job.pages[i + 1]];
        renderJobQueue();
        break;
      }
      case 'confirm-arrange': {
        if (!job) return;
        job.status = 'queued';
        job.progressText = `${job.pages.length} page(s) ready`;
        renderJobQueue();
        break;
      }
      case 'download-zip': {
        if (!job) return;
        downloadPagesAsZip(job);
        break;
      }
      case 'retry-failed-batches': {
        if (!job) return;
        const keys = loadApiKeys();
        const apiKey = keys[1] || keys[2] || keys[3];
        if (!apiKey) { toast('Add at least one API key in Settings first', 'error'); return; }
        runJob(job, apiKey);
        break;
      }
    }
  });
  document.getElementById('extractJobList').addEventListener('input', e => {
    const input = e.target.closest('input[data-job-id]');
    if (!input) return;
    const job = jobQueue.find(j => j.id === input.dataset.jobId);
    if (!job) return;
    const val = input.value.trim();
    job[input.dataset.field] = input.dataset.field === 'name' ? (val || 'Untitled') : (val || null);
  });

  renderJobQueue();
}

window.setupExtractListeners = setupExtractListeners;
