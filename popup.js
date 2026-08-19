// popup.js — FamilySearch AutoFill Extension
'use strict';

// ════════════════════════════════════════════════
//  STATE
// ════════════════════════════════════════════════
let data = [];
let headers = [];
let undoStack = [];
let redoStack = [];
let selectedRows = new Set();
let sortCol = null;
let sortAsc = true;
let autoSaveTimer = null;
let confirmCallback = null;

// Per-tab data assignments: tabId -> records[]
let tabAssignments = {};
// Per-tab live progress: tabId -> session object
let tabProgress = {};
// Detected FamilySearch tabs: [{id, url, title}]
let fsTabs = [];
// Open editor files/tabs: [{ id, filename, digits, data, undoStack, redoStack }]
// Also doubles as the 4-digit auto-match pool (each entry already has .digits/.data).
let loadedJsonPool = [];
// id of the currently active entry in loadedJsonPool (which tab is shown in the table)
let activeFileId = null;
// User-resized column widths (px): colKey -> width, persisted across sessions
let columnWidths = {};

const COLS = ['rin','relation','sex','living','given_names','family_names',
              'birth_year','birth_location','death_year','death_location'];
const LS_DATA = 'gf_data';
const LS_HDR = 'gf_headers';
const LS_FILES = 'gf_files';
const LS_ACTIVE_FILE = 'gf_active_file';
const LS_COLWIDTHS = 'gf_colwidths';
const MAX_UNDO = 50;
const DEFAULT_COL_WIDTHS = {
  rin: 55, relation: 90, sex: 70, living: 70,
  given_names: 130, family_names: 130,
  birth_year: 90, birth_location: 220,
  death_year: 90, death_location: 220
};
const DEFAULT_COL_WIDTH_FALLBACK = 130;

// ════════════════════════════════════════════════
//  INIT
// ════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', () => {
  setupNav();
  setupEditorListeners();
  setupFillListeners();
  setupModalListeners();
  if (window.setupExtractListeners) window.setupExtractListeners();
  loadColumnWidths();
  loadFromStorage();
  // Listen for progress updates from background
  chrome.runtime.onMessage.addListener(handleBackgroundMessage);
  // Restore progress from any fills that were already running before this
  // popup instance opened — the popup closes whenever you click away, so
  // without this a still-running fill looks like it has no progress at all.
  restoreSessions();
});

function restoreSessions() {
  chrome.runtime.sendMessage({ type: 'GET_SESSIONS' }, (resp) => {
    if (chrome.runtime.lastError || !resp || !resp.sessions) return;
    Object.keys(resp.sessions).forEach(tabId => {
      tabProgress[tabId] = resp.sessions[tabId];
    });
    renderTabList();
  });
}

// ════════════════════════════════════════════════
//  NAVIGATION
// ════════════════════════════════════════════════
function setupNav() {
  document.getElementById('navEditor').addEventListener('click', () => showView('editor'));
  document.getElementById('navFill').addEventListener('click', () => { showView('fill'); detectTabs(); });
  document.getElementById('navExtract').addEventListener('click', () => showView('extract'));
  const openTabBtn = document.getElementById('btnOpenTab');
  if (openTabBtn) {
    openTabBtn.addEventListener('click', () => {
      chrome.tabs.create({ url: chrome.runtime.getURL('popup.html') });
    });
  }
}

function showView(name) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('view' + cap(name)).classList.add('active');
  document.getElementById('nav' + cap(name)).classList.add('active');
}

function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

// ════════════════════════════════════════════════
//  EDITOR LISTENERS
// ════════════════════════════════════════════════
function setupEditorListeners() {
  document.getElementById('btnLoad').addEventListener('click', () => {
    document.getElementById('fileInputLoad').value = '';
    document.getElementById('fileInputLoad').click();
  });
  document.getElementById('fileInputLoad').addEventListener('change', e => loadFile(e, false));

  document.getElementById('btnAppend').addEventListener('click', () => {
    document.getElementById('fileInputAppend').value = '';
    document.getElementById('fileInputAppend').click();
  });
  document.getElementById('fileInputAppend').addEventListener('change', e => loadFile(e, true));

  document.getElementById('btnRawPaste').addEventListener('click', openRawJsonModal);
  document.getElementById('btnSave').addEventListener('click', downloadJSON);

  // New Clean Genealogy, Repair, Format listeners
  document.getElementById('btnCleanGenealogy').addEventListener('click', cleanGenealogyData);
  document.getElementById('btnRepairJSON').addEventListener('click', handleRepair);
  document.getElementById('btnFormatJSON').addEventListener('click', handleFormat);

  document.getElementById('btnAddRow').addEventListener('click', addRow);
  document.getElementById('btnClearSession').addEventListener('click', clearSession);
  document.getElementById('btnUndo').addEventListener('click', undo);
  document.getElementById('btnRedo').addEventListener('click', redo);

  document.getElementById('filterInput').addEventListener('input', applyFilter);
  document.getElementById('filterCol').addEventListener('change', applyFilter);

  document.getElementById('btnReplace').addEventListener('click', doFindReplace);

  document.getElementById('btnBulkApply').addEventListener('click', applyBulkEdit);
  document.getElementById('btnBulkDelete').addEventListener('click', deleteSelected);
  document.getElementById('btnClearSel').addEventListener('click', clearSelection);

  // Raw JSON Modal buttons
  document.getElementById('rawFormatBtn').addEventListener('click', formatRawJsonText);
  document.getElementById('rawRepairBtn').addEventListener('click', repairRawJsonText);
  document.getElementById('rawCancelBtn').addEventListener('click', closeRawJsonModal);
  document.getElementById('rawApplyBtn').addEventListener('click', applyRawJsonText);

  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); undo(); }
    if ((e.ctrlKey || e.metaKey) && e.key === 'y') { e.preventDefault(); redo(); }
    if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); downloadJSON(); }
  });
}

// ════════════════════════════════════════════════
//  CLEAN GENEALOGY & JSON TOOLS
// ════════════════════════════════════════════════
function cleanGenealogyData() {
  syncDataFromTable();
  if (!data || data.length === 0) {
    toast('No data loaded in editor', 'error');
    return;
  }

  saveUndo();
  let livingFixed = 0;
  let deceasedFixed = 0;

  data.forEach(person => {
    const livingStatus = String(person.living || '').trim().toLowerCase();

    if (livingStatus === 'yes' || livingStatus === 'true' || livingStatus === '1') {
      if ((person.death_location && person.death_location !== '') || (person.death_year && person.death_year !== '')) {
        person.death_location = '';
        person.death_year = '';
        livingFixed++;
      }
    } else if (livingStatus === 'no' || livingStatus === 'false' || livingStatus === '0') {
      const birthLoc = person.birth_location || '';
      if (person.death_location !== birthLoc) {
        person.death_location = birthLoc;
        deceasedFixed++;
      }
    }
  });

  renderTable();
  autoSave();
  toast(`Genealogy Cleaned: ${livingFixed} living cleared, ${deceasedFixed} death places aligned`, 'success');
}

function repairJSONString(str) {
  if (!str || !str.trim()) return [];

  // Try standard parse first
  try {
    const parsed = JSON.parse(str);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch (e) {
    // Proceed to repair
  }

  // Step 1: Cleanup trailing commas, quotes, and keys
  let cleaned = str
    .replace(/,\s*([\}\]])/g, '$1')
    .replace(/'/g, '"')
    .replace(/([{,]\s*)([a-zA-Z0-9_]+)\s*:/g, '$1"$2":');

  try {
    const parsed = JSON.parse(cleaned);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch (e) {
    // Step 2: Extract valid object blocks
    const blocks = str.match(/\{[^{}]*?\}/g) || [];
    const recovered = [];
    for (const b of blocks) {
      try {
        const obj = JSON.parse(b.replace(/,\s*\}/g, '}'));
        recovered.push(obj);
      } catch (err) {}
    }
    if (recovered.length > 0) {
      recovered.sort((a, b) => (a.rin || 0) - (b.rin || 0));
      return recovered;
    }
  }

  throw new Error('Could not recover valid JSON objects from text');
}

function handleRepair() {
  syncDataFromTable();
  if (data.length === 0) {
    openRawJsonModal();
    return;
  }
  saveUndo();
  try {
    const repaired = repairJSONString(JSON.stringify(data));
    data = repaired;
    renderTable();
    autoSave();
    toast(`Repaired ${data.length} records!`, 'success');
  } catch (err) {
    toast('Repair error: ' + err.message, 'error');
  }
}

function handleFormat() {
  syncDataFromTable();
  if (data.length === 0) {
    openRawJsonModal();
    return;
  }
  toast(`JSON formatted (${data.length} rows)`, 'success');
}

// ════════════════════════════════════════════════
//  RAW JSON PASTE MODAL
// ════════════════════════════════════════════════
function openRawJsonModal() {
  syncDataFromTable();
  const area = document.getElementById('rawJsonArea');
  area.value = data.length > 0 ? JSON.stringify(data, null, 2) : '';
  document.getElementById('rawJsonModal').classList.add('open');
}

function closeRawJsonModal() {
  document.getElementById('rawJsonModal').classList.remove('open');
}

function formatRawJsonText() {
  const area = document.getElementById('rawJsonArea');
  try {
    const parsed = JSON.parse(area.value);
    area.value = JSON.stringify(parsed, null, 2);
    toast('Formatted!', 'success');
  } catch (err) {
    toast('Invalid JSON: ' + err.message, 'error');
  }
}

function repairRawJsonText() {
  const area = document.getElementById('rawJsonArea');
  try {
    const repaired = repairJSONString(area.value);
    area.value = JSON.stringify(repaired, null, 2);
    toast(`Repaired & recovered ${repaired.length} objects!`, 'success');
  } catch (err) {
    toast('Repair failed: ' + err.message, 'error');
  }
}

function applyRawJsonText() {
  const area = document.getElementById('rawJsonArea');
  if (!area.value.trim()) {
    closeRawJsonModal();
    return;
  }
  try {
    const repaired = repairJSONString(area.value);
    if (activeFileId) {
      // Replace the currently active tab's contents in place.
      saveUndo();
      data = repaired;
      const cur = getActiveFile();
      if (cur) cur.data = data;
      initHeaders();
      renderTable();
      autoSave();
    } else {
      // No tabs open yet — this paste becomes a new one.
      const id = addFileTab('Pasted Data', null, repaired);
      switchToFile(id);
      renderFileTabs();
    }
    closeRawJsonModal();
    toast(`Loaded ${repaired.length} records from raw JSON`, 'success');
  } catch (err) {
    toast('Error loading JSON: ' + err.message, 'error');
  }
}

// ════════════════════════════════════════════════
//  FILE TABS — each loaded JSON file gets its own tab instead of all
//  loaded data being merged into one flat table.
// ════════════════════════════════════════════════
function genFileId() {
  return 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[c]);
}

function getActiveFile() {
  return loadedJsonPool.find(f => f.id === activeFileId) || null;
}

// Adds a new file tab without switching to it. Returns its id.
function addFileTab(filename, digits, records) {
  const id = genFileId();
  loadedJsonPool.push({ id, filename, digits, data: records, undoStack: [], redoStack: [] });
  return id;
}

function switchToFile(fileId) {
  if (fileId === activeFileId) return;

  // Persist whatever's currently on screen back into the file we're leaving,
  // including any edit still sitting in a focused-but-not-blurred cell.
  const leaving = getActiveFile();
  if (leaving) {
    syncDataFromTable();
    leaving.data = data;
    leaving.undoStack = undoStack;
    leaving.redoStack = redoStack;
  }

  const next = loadedJsonPool.find(f => f.id === fileId);
  if (!next) return;

  activeFileId = fileId;
  data = next.data;
  undoStack = next.undoStack;
  redoStack = next.redoStack;

  selectedRows.clear();
  initHeaders();
  renderTable();
  renderFileTabs();
  autoSave();
}

function closeFile(fileId) {
  const idx = loadedJsonPool.findIndex(f => f.id === fileId);
  if (idx === -1) return;
  const wasActive = fileId === activeFileId;

  loadedJsonPool.splice(idx, 1);

  if (wasActive) {
    if (loadedJsonPool.length > 0) {
      const next = loadedJsonPool[Math.max(0, idx - 1)];
      activeFileId = null; // force switchToFile to actually switch
      switchToFile(next.id);
    } else {
      activeFileId = null;
      data = [];
      headers = [];
      selectedRows.clear();
      undoStack = []; redoStack = [];
      renderTable();
      renderFileTabs();
      autoSave();
    }
  } else {
    renderFileTabs();
    autoSave();
  }
}

function renderFileTabs() {
  const strip = document.getElementById('fileTabStrip');
  if (!strip) return;

  if (loadedJsonPool.length === 0) {
    strip.style.display = 'none';
    strip.innerHTML = '';
    return;
  }

  strip.style.display = 'flex';
  strip.innerHTML = loadedJsonPool.map(f => {
    const active = f.id === activeFileId ? ' active' : '';
    const name = f.filename || 'Untitled';
    const label = `${name} (${f.data.length})`;
    return `<div class="file-tab${active}" data-id="${f.id}" title="${escapeHtml(name)}">
      <span class="file-tab-name">${escapeHtml(label)}</span>
      <span class="file-tab-close" data-id="${f.id}" title="Close">✕</span>
    </div>`;
  }).join('');

  strip.querySelectorAll('.file-tab').forEach(el => {
    el.addEventListener('click', (e) => {
      if (e.target.classList.contains('file-tab-close')) return;
      switchToFile(el.dataset.id);
    });
  });
  strip.querySelectorAll('.file-tab-close').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      closeFile(el.dataset.id);
    });
  });
}

function extractLast4Digits(str) {
  if (!str) return null;
  let s = String(str).split('?')[0].split('#')[0].trim();
  if (s.includes('/')) {
    s = s.split('/').filter(Boolean).pop();
  }
  s = s.replace(/\.json$/i, '');

  const endMatch = s.match(/\d{4}$/);
  if (endMatch) return endMatch[0];

  const allMatches = s.match(/\d{4}/g);
  if (allMatches && allMatches.length > 0) {
    return allMatches[allMatches.length - 1];
  }
  return null;
}

function loadFile(e, append) {
  const files = Array.from(e.target.files);
  if (!files || files.length === 0) return;

  // Load = close every existing tab and start fresh; Append = keep them and add more.
  if (!append) {
    loadedJsonPool = [];
    activeFileId = null;
  }

  let loadedFilesCount = 0;
  let lastNewId = null;

  let readPromises = files.map(file => {
    return new Promise(resolve => {
      const reader = new FileReader();
      reader.onload = ev => {
        try {
          const parsed = repairJSONString(ev.target.result);
          const digits = extractLast4Digits(file.name);
          lastNewId = addFileTab(file.name, digits, parsed);
          loadedFilesCount++;
        } catch (err) {
          console.warn('Error reading file', file.name, err);
        }
        resolve();
      };
      reader.readAsText(file);
    });
  });

  Promise.all(readPromises).then(() => {
    if (loadedFilesCount > 0) {
      if (lastNewId) {
        activeFileId = null; // force switchToFile to actually switch
        switchToFile(lastNewId);
      }
      renderFileTabs();

      // Auto-match open FamilySearch tabs by 4-digit code if tabs are open
      if (fsTabs.length > 0) {
        autoMatchTabsByDigits();
      }

      toast((append ? 'Appended ' : 'Loaded ') + loadedFilesCount + ' file(s) as tab(s)', 'success');
    } else {
      toast('Failed to load JSON files', 'error');
    }
  });
}

function downloadJSON() {
  syncDataFromTable();
  const cur = getActiveFile();
  if (cur) cur.data = data;
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = (cur && cur.filename) ? cur.filename : 'genealogy_data.json';
  a.click();
  toast('Saved!', 'success');
}

// ════════════════════════════════════════════════
//  HEADERS
// ════════════════════════════════════════════════
function initHeaders() {
  headers = data.length > 0 ? Object.keys(data[0]).filter(h => h !== 'review') : COLS;
  ['filterCol', 'replaceCol', 'bulkCol'].forEach(id => {
    const sel = document.getElementById(id);
    const first = sel.options[0].outerHTML;
    sel.innerHTML = first;
    headers.forEach(h => {
      const opt = document.createElement('option');
      opt.value = h; opt.textContent = h;
      sel.appendChild(opt);
    });
  });
}

// ════════════════════════════════════════════════
//  TABLE RENDER
// ════════════════════════════════════════════════
function renderTable() {
  const table = document.getElementById('dataTable');
  const empty = document.getElementById('emptyState');

  if (data.length === 0) {
    table.style.display = 'none';
    empty.style.display = 'block';
    document.getElementById('tableBody').innerHTML = '';
    document.getElementById('rowCountBadge').textContent = '0 rows';
    checkRinIntegrity();
    return;
  }

  table.style.display = 'table';
  empty.style.display = 'none';
  document.getElementById('rowCountBadge').textContent = data.length + ' rows';
  checkRinIntegrity();

  // Colgroup — controls actual column widths (table-layout:fixed reads these,
  // not the th/td content), so resizing just means updating a <col>'s width.
  let colHtml = '<col style="width:28px;"><col style="width:34px;">';
  headers.forEach(h => {
    colHtml += `<col data-col="${escapeHtml(h)}" style="width:${getColWidth(h)}px;">`;
  });
  document.getElementById('tableColgroup').innerHTML = colHtml;

  // Head
  const head = document.getElementById('tableHead');
  let th = '<tr>';
  th += '<th class="no-sort"><input type="checkbox" id="chkAll"></th>';
  th += '<th class="no-sort">#</th>';
  headers.forEach(h => {
    th += `<th data-col="${escapeHtml(h)}"><span class="th-label">${escapeHtml(h.replace(/_/g,' '))}</span><span class="col-resize-handle" data-col="${escapeHtml(h)}"></span></th>`;
  });
  th += '</tr>';
  head.innerHTML = th;

  document.getElementById('chkAll').addEventListener('change', function() { toggleSelectAll(this.checked); });
  head.querySelectorAll('th[data-col]').forEach(thEl => {
    thEl.querySelector('.th-label').addEventListener('click', () => sortBy(thEl.dataset.col));
  });
  setupColumnResize(head);

  // Body
  const body = document.getElementById('tableBody');
  body.innerHTML = '';
  data.forEach((row, i) => body.appendChild(makeRow(row, i)));

  applyFilter();
}

// ════════════════════════════════════════════════
//  RESIZABLE COLUMNS
// ════════════════════════════════════════════════
function getColWidth(colKey) {
  return columnWidths[colKey] || DEFAULT_COL_WIDTHS[colKey] || DEFAULT_COL_WIDTH_FALLBACK;
}

function loadColumnWidths() {
  try {
    const raw = localStorage.getItem(LS_COLWIDTHS);
    columnWidths = raw ? JSON.parse(raw) : {};
  } catch (e) {
    columnWidths = {};
  }
}

function saveColumnWidths() {
  try { localStorage.setItem(LS_COLWIDTHS, JSON.stringify(columnWidths)); } catch (e) {}
}

function setupColumnResize(head) {
  head.querySelectorAll('.col-resize-handle').forEach(handle => {
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();

      const colKey = handle.dataset.col;
      const col = document.querySelector(`#tableColgroup col[data-col="${colKey}"]`);
      const th = handle.closest('th');
      if (!col || !th) return;

      const startX = e.clientX;
      const startWidth = th.offsetWidth;
      let currentWidth = startWidth;

      handle.classList.add('active');
      document.body.classList.add('col-resizing');

      function onMove(ev) {
        currentWidth = Math.max(50, startWidth + (ev.clientX - startX));
        col.style.width = currentWidth + 'px';
      }
      function onUp() {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        handle.classList.remove('active');
        document.body.classList.remove('col-resizing');
        columnWidths[colKey] = currentWidth;
        saveColumnWidths();
      }
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  });
}

// ════════════════════════════════════════════════
//  RIN INTEGRITY CHECK (missing / duplicate RINs)
// ════════════════════════════════════════════════
function checkRinIntegrity() {
  const banner = document.getElementById('rinIntegrityBanner');
  if (!banner) return;

  if (!data || data.length === 0) {
    banner.style.display = 'none';
    return;
  }

  const rinNums = data
    .map(r => parseInt(r.rin, 10))
    .filter(n => !isNaN(n));

  if (rinNums.length === 0) {
    banner.style.display = 'none';
    return;
  }

  const counts = {};
  rinNums.forEach(n => { counts[n] = (counts[n] || 0) + 1; });
  const unique = Object.keys(counts).map(Number).sort((a, b) => a - b);
  const duplicates = unique.filter(n => counts[n] > 1);

  const min = unique[0];
  const max = unique[unique.length - 1];
  const gapRanges = [];
  for (let i = 1; i < unique.length; i++) {
    if (unique[i] !== unique[i - 1] + 1) {
      const gapStart = unique[i - 1] + 1;
      const gapEnd = unique[i] - 1;
      gapRanges.push(gapStart === gapEnd ? `${gapStart}` : `${gapStart}-${gapEnd}`);
    }
  }
  const totalMissing = (max - min + 1) - unique.length;
  const flaggedCount = data.filter(r => r.review).length;

  if (gapRanges.length === 0 && duplicates.length === 0 && flaggedCount === 0) {
    banner.className = 'rin-banner ok';
    banner.textContent = `RIN check: ${unique.length} records, RIN ${min}-${max}, no gaps or duplicates`;
  } else {
    let msg = `RIN check: ${unique.length} records, RIN ${min}-${max}`;
    if (gapRanges.length > 0) msg += ` — missing ${totalMissing} RIN(s): ${gapRanges.join(', ')}`;
    if (duplicates.length > 0) msg += ` — duplicate RIN(s): ${duplicates.join(', ')}`;
    if (flaggedCount > 0) msg += ` — ${flaggedCount} row(s) flagged for review (highlighted below)`;
    banner.className = 'rin-banner warn';
    banner.textContent = msg;
  }
  banner.style.display = 'block';
}

function makeRow(row, i) {
  const tr = document.createElement('tr');
  tr.dataset.index = i;
  if (selectedRows.has(i)) tr.classList.add('selected');
  if (row.review) { tr.classList.add('flagged-row'); tr.title = 'Flagged by extraction as uncertain — double-check this row'; }

  // Checkbox
  const tdCk = document.createElement('td');
  tdCk.className = 'td-check';
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = selectedRows.has(i);
  cb.addEventListener('change', () => toggleRowSelect(i, cb.checked, tr));
  tdCk.appendChild(cb);
  tr.appendChild(tdCk);

  // Row number
  const tdN = document.createElement('td');
  tdN.className = 'td-num';
  tdN.textContent = i + 1;
  tr.appendChild(tdN);

  // Data cells
  headers.forEach((h, ci) => {
    const td = document.createElement('td');
    const inp = document.createElement('input');
    inp.className = 'cell-input';
    inp.type = 'text';
    const val = row[h];
    if (val === null || val === undefined || val === '') {
      inp.placeholder = 'null';
      inp.classList.add('is-null');
    } else {
      inp.value = String(val);
    }
    inp.addEventListener('focus', () => inp.classList.remove('is-null'));
    inp.addEventListener('blur', () => {
      saveUndo();
      const v = inp.value.trim();
      data[i][h] = (v === '' || v === 'null') ? null : v;
      if (!inp.value) { inp.placeholder = 'null'; inp.classList.add('is-null'); }
      autoSave();
    });
    inp.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); moveFocus(i, ci, 1); }
      if (e.key === 'Tab') { e.preventDefault(); moveFocusCol(i, ci, e.shiftKey ? -1 : 1); }
    });
    td.appendChild(inp);
    tr.appendChild(td);
  });

  return tr;
}

function moveFocus(rowIdx, colIdx, dir) {
  const rows = [...document.querySelectorAll('#tableBody tr:not(.filtered-out)')];
  const cur = rows.findIndex(r => parseInt(r.dataset.index) === rowIdx);
  const next = rows[cur + dir];
  if (next) { const inputs = next.querySelectorAll('.cell-input'); if (inputs[colIdx]) inputs[colIdx].focus(); }
}

function moveFocusCol(rowIdx, colIdx, dir) {
  const rows = document.querySelectorAll('#tableBody tr');
  const row = [...rows].find(r => parseInt(r.dataset.index) === rowIdx);
  if (row) { const inputs = row.querySelectorAll('.cell-input'); if (inputs[colIdx + dir]) inputs[colIdx + dir].focus(); }
}

function syncDataFromTable() {
  document.querySelectorAll('#tableBody tr').forEach(tr => {
    const i = parseInt(tr.dataset.index);
    // Rows can linger in the DOM (hidden, not cleared) after the table goes
    // empty — e.g. all file tabs closed — so guard against a stale index.
    if (isNaN(i) || !data[i]) return;
    tr.querySelectorAll('.cell-input').forEach((inp, ci) => {
      const v = inp.value.trim();
      data[i][headers[ci]] = (v === '' || v === 'null') ? null : v;
    });
  });
}

// ════════════════════════════════════════════════
//  SELECTION
// ════════════════════════════════════════════════
function toggleRowSelect(i, checked, tr) {
  if (checked) { selectedRows.add(i); tr.classList.add('selected'); }
  else { selectedRows.delete(i); tr.classList.remove('selected'); }
  updateBulkPanel();
}

function toggleSelectAll(checked) {
  document.querySelectorAll('#tableBody tr:not(.filtered-out)').forEach(tr => {
    const i = parseInt(tr.dataset.index);
    const cb = tr.querySelector('input[type="checkbox"]');
    if (checked) { selectedRows.add(i); tr.classList.add('selected'); }
    else { selectedRows.delete(i); tr.classList.remove('selected'); }
    if (cb) cb.checked = checked;
  });
  updateBulkPanel();
}

function clearSelection() {
  selectedRows.clear();
  document.querySelectorAll('#tableBody tr').forEach(tr => {
    tr.classList.remove('selected');
    const cb = tr.querySelector('input[type="checkbox"]');
    if (cb) cb.checked = false;
  });
  const ca = document.getElementById('chkAll');
  if (ca) ca.checked = false;
  updateBulkPanel();
}

function updateBulkPanel() {
  const n = selectedRows.size;
  const panel = document.getElementById('bulkPanel');
  document.getElementById('bulkLabel').textContent = n + ' selected';
  if (n > 0) panel.classList.add('visible');
  else panel.classList.remove('visible');
}

// ════════════════════════════════════════════════
//  ROW OPS
// ════════════════════════════════════════════════
function addRow() {
  saveUndo();
  const row = {};
  headers.forEach(h => row[h] = null);
  data.push(row);
  renderTable();
  autoSave();
  const wrapper = document.querySelector('.table-wrapper');
  wrapper.scrollTop = wrapper.scrollHeight;
  toast('Row added', 'success');
}

function deleteSelected() {
  if (!selectedRows.size) return;
  confirm2(`Delete ${selectedRows.size} row(s)?`, () => {
    saveUndo();
    data = data.filter((_, i) => !selectedRows.has(i));
    selectedRows.clear();
    renderTable();
    autoSave();
    toast('Deleted', 'success');
  });
}

// ════════════════════════════════════════════════
//  BULK EDIT
// ════════════════════════════════════════════════
function applyBulkEdit() {
  const col = document.getElementById('bulkCol').value;
  const val = document.getElementById('bulkVal').value.trim();
  if (!col) { toast('Pick a column', 'error'); return; }
  if (!selectedRows.size) { toast('No rows selected', 'error'); return; }
  confirm2(`Set "${col}" = "${val || 'null'}" for ${selectedRows.size} rows?`, () => {
    saveUndo();
    selectedRows.forEach(i => { data[i][col] = (val === '' || val === 'null') ? null : val; });
    renderTable();
    autoSave();
    toast('Applied to ' + selectedRows.size + ' rows', 'success');
  });
}

// ════════════════════════════════════════════════
//  FIND & REPLACE
// ════════════════════════════════════════════════
function doFindReplace() {
  const find = document.getElementById('findInput').value.trim();
  const replace = document.getElementById('replaceInput').value.trim();
  const col = document.getElementById('replaceCol').value;
  if (!find) { toast('Enter search term', 'error'); return; }

  let count = 0;
  data.forEach(row => {
    (col ? [col] : headers).forEach(h => {
      if (row[h] !== null && String(row[h]).toLowerCase().includes(find.toLowerCase())) count++;
    });
  });

  if (!count) { toast('No matches found', 'error'); return; }

  confirm2(`Replace ${count} match(es) in ${col || 'all columns'}?\n"${find}" → "${replace || 'null'}"`, () => {
    saveUndo();
    const re = new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    data.forEach(row => {
      (col ? [col] : headers).forEach(h => {
        if (row[h] !== null && String(row[h]).toLowerCase().includes(find.toLowerCase())) {
          const result = String(row[h]).replace(re, replace);
          row[h] = (result === '' || result === 'null') ? null : result;
        }
      });
    });
    renderTable();
    autoSave();
    toast(`Replaced ${count} match(es)`, 'success');
  });
}

// ════════════════════════════════════════════════
//  FILTER
// ════════════════════════════════════════════════
function applyFilter() {
  const term = document.getElementById('filterInput').value.toLowerCase().trim();
  const col = document.getElementById('filterCol').value;
  let visible = 0;

  document.querySelectorAll('#tableBody tr').forEach(tr => {
    const i = parseInt(tr.dataset.index);
    if (isNaN(i)) return;
    let match = !term;
    if (term) {
      (col ? [col] : headers).forEach(h => {
        const v = data[i][h];
        if (v !== null && String(v).toLowerCase().includes(term)) match = true;
      });
    }
    tr.classList.toggle('filtered-out', !match);
    if (match) visible++;
  });

  const badge = document.getElementById('rowCountBadge');
  badge.textContent = (visible !== data.length ? `${visible} / ${data.length}` : data.length) + ' rows';
}

// ════════════════════════════════════════════════
//  SORT
// ════════════════════════════════════════════════
function sortBy(col) {
  saveUndo();
  sortAsc = sortCol === col ? !sortAsc : true;
  sortCol = col;
  data.sort((a, b) => {
    const va = a[col] ?? '', vb = b[col] ?? '';
    return sortAsc ? String(va).localeCompare(String(vb)) : String(vb).localeCompare(String(va));
  });
  renderTable();
}

// ════════════════════════════════════════════════
//  UNDO / REDO
// ════════════════════════════════════════════════
function saveUndo() {
  undoStack.push(JSON.stringify(data));
  if (undoStack.length > MAX_UNDO) undoStack.shift();
  redoStack = [];
}

function undo() {
  if (!undoStack.length) { toast('Nothing to undo', 'error'); return; }
  redoStack.push(JSON.stringify(data));
  data = JSON.parse(undoStack.pop());
  renderTable();
  toast('Undone', 'success');
}

function redo() {
  if (!redoStack.length) { toast('Nothing to redo', 'error'); return; }
  undoStack.push(JSON.stringify(data));
  data = JSON.parse(redoStack.pop());
  renderTable();
  toast('Redone', 'success');
}

// ════════════════════════════════════════════════
//  AUTO-SAVE (localStorage)
// ════════════════════════════════════════════════
function autoSave() {
  clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(() => {
    try {
      syncDataFromTable();
      const cur = getActiveFile();
      if (cur) cur.data = data;
      const toSave = loadedJsonPool.map(f => ({ id: f.id, filename: f.filename, digits: f.digits, data: f.data }));
      localStorage.setItem(LS_FILES, JSON.stringify(toSave));
      localStorage.setItem(LS_ACTIVE_FILE, activeFileId || '');
      document.getElementById('statusDot').style.background = 'var(--green)';
      document.getElementById('statusText').textContent = 'Auto-saved ' + new Date().toLocaleTimeString();
    } catch(e) {
      document.getElementById('statusText').textContent = 'Auto-save failed';
    }
  }, 700);
}

function loadFromStorage() {
  try {
    const raw = localStorage.getItem(LS_FILES);
    if (raw) {
      const saved = JSON.parse(raw);
      if (Array.isArray(saved) && saved.length > 0) {
        loadedJsonPool = saved.map(f => ({
          id: f.id, filename: f.filename, digits: f.digits, data: f.data,
          undoStack: [], redoStack: []
        }));
        const savedActive = localStorage.getItem(LS_ACTIVE_FILE);
        const match = loadedJsonPool.find(f => f.id === savedActive);
        activeFileId = (match || loadedJsonPool[0]).id;
        const cur = getActiveFile();
        data = cur.data;
        headers = data.length > 0 ? Object.keys(data[0]) : COLS;
        initHeaders();
        renderTable();
        renderFileTabs();
        const totalRows = loadedJsonPool.reduce((n, f) => n + f.data.length, 0);
        toast(`Session restored — ${loadedJsonPool.length} file(s), ${totalRows} rows`, 'success');
        document.getElementById('statusText').textContent = 'Restored from last session';
        return;
      }
    }

    // One-time migration from the old single-blob storage format.
    const oldData = localStorage.getItem(LS_DATA);
    if (oldData) {
      const parsed = JSON.parse(oldData);
      if (Array.isArray(parsed) && parsed.length > 0) {
        const id = addFileTab('Untitled', null, parsed);
        switchToFile(id);
        renderFileTabs();
        toast('Session restored — ' + parsed.length + ' rows', 'success');
      }
      localStorage.removeItem(LS_DATA);
      localStorage.removeItem(LS_HDR);
    }
  } catch(e) {
    console.warn('[GeneEdit] session restore failed:', e);
    toast('Could not restore your previous session (saved data may be corrupted) — starting fresh', 'error');
    const statusText = document.getElementById('statusText');
    if (statusText) statusText.textContent = 'Session restore failed';
  }
}

function clearSession() {
  confirm2('Clear all data and start fresh?', () => {
    localStorage.removeItem(LS_FILES);
    localStorage.removeItem(LS_ACTIVE_FILE);
    localStorage.removeItem(LS_DATA);
    localStorage.removeItem(LS_HDR);
    loadedJsonPool = []; activeFileId = null;
    data = []; headers = [];
    selectedRows.clear(); undoStack = []; redoStack = [];
    renderTable();
    renderFileTabs();
    toast('Session cleared', 'success');
  });
}

// ════════════════════════════════════════════════
//  FILL VIEW & MULTI-TAB CONTROLS (3-5 Tabs)
// ════════════════════════════════════════════════
function setupFillListeners() {
  document.getElementById('btnDetectTabs').addEventListener('click', detectTabs);
  document.getElementById('btnFillAll').addEventListener('click', fillAll);

  // Multi-tab actions
  const btnMatch = document.getElementById('btnAutoMatch');
  if (btnMatch) btnMatch.addEventListener('click', autoMatchTabsByDigits);
  document.getElementById('btnAutoSplit').addEventListener('click', autoSplitTabs);
  document.getElementById('btnAssignAll').addEventListener('click', assignAllTabs);
  document.getElementById('btnStopAll').addEventListener('click', stopAllTabs);

  const btnSave = document.getElementById('btnSaveAll');
  if (btnSave) btnSave.addEventListener('click', saveAllTabs);

  const btnReset = document.getElementById('btnResetRin');
  if (btnReset) btnReset.addEventListener('click', resetToBeginning);
}

async function saveAllTabs() {
  if (fsTabs.length === 0) { toast('No FamilySearch tabs detected', 'error'); return; }
  const btn = document.getElementById('btnSaveAll');
  setBusy(btn, `Saving ${fsTabs.length} tab(s)...`);

  // Routed through background.js's SAVE_TAB -> clickSave() so each tab's
  // save is actually verified (with the same slow-connection tolerance the
  // fill loop gets) instead of clicking and assuming success.
  const results = await Promise.all(fsTabs.map(t => new Promise(resolve => {
    chrome.runtime.sendMessage({ type: 'SAVE_TAB', tabId: t.id }, r => resolve({ tab: t, r }));
  })));

  clearBusy(btn);
  const okResults = results.filter(x => x.r && x.r.ok);
  const failResults = results.filter(x => !x.r || !x.r.ok);

  if (failResults.length === 0) {
    toast(`Saved ${okResults.length}/${results.length} tab(s)`, 'success');
  } else {
    toast(`Saved ${okResults.length}/${results.length} tab(s) — ${failResults.length} failed`, 'error');
    failResults.forEach(x => console.warn('[GeneEdit] save failed for tab', x.tab.id, x.r && x.r.reason));
  }
}

function resetToBeginning() {
  const startInp = document.getElementById('startRinInput');
  if (startInp) startInp.value = '1';

  // Reset all progress state
  tabProgress = {};

  renderTabList();
  updateMultiTabSummary();

  toast('Reset — Next fill will start from the beginning (RIN 1)', 'success');
}

async function detectTabs() {
  const btn = document.getElementById('btnDetectTabs');
  setBusy(btn, 'Detecting...');
  return new Promise(resolve => {
    chrome.tabs.query({}, tabs => {
      fsTabs = tabs.filter(t => t.url && t.url.includes('familysearch.org/en/oral-gen/pedigree-form'));
      const badge = document.getElementById('tabCountBadge');
      if (badge) badge.textContent = `${fsTabs.length} Tab(s)`;
      renderTabList();
      updateMultiTabSummary();
      clearBusy(btn);
      resolve();
    });
  });
}

function autoMatchTabsByDigits() {
  syncDataFromTable();
  if (fsTabs.length === 0) {
    toast('No FamilySearch tabs detected. Click Detect Tabs first.', 'error');
    return;
  }

  let matchedCount = 0;

  fsTabs.forEach(tab => {
    // Extract last 4 digits from tab URL or form title
    const tabDigits = extractLast4Digits(tab.url || tab.title || '');

    if (tabDigits) {
      // 1. Check loadedJsonPool for a file whose filename contains matching 4 digits
      let matchPool = loadedJsonPool.find(item => item.digits === tabDigits);

      if (matchPool && matchPool.data && matchPool.data.length > 0) {
        tabAssignments[tab.id] = JSON.parse(JSON.stringify(matchPool.data));
        matchedCount++;
      } else {
        // 2. Check if loaded records inside `data` match tabDigits via RIN / source_file
        const matchingRecords = data.filter(r => {
          const rDigits = extractLast4Digits(String(r.rin || r.source_file || ''));
          return rDigits === tabDigits;
        });

        if (matchingRecords.length > 0) {
          tabAssignments[tab.id] = JSON.parse(JSON.stringify(matchingRecords));
          matchedCount++;
        }
      }
    }
  });

  renderTabList();
  updateMultiTabSummary();

  if (matchedCount > 0) {
    toast(`Auto-matched ${matchedCount} tab(s) by 4-digit ID!`, 'success');
  } else {
    toast(`No 4-digit matches found between JSON files & open tabs`, 'warning');
  }
}

function autoSplitTabs() {
  syncDataFromTable();
  if (data.length === 0) { toast('No data in editor to split', 'error'); return; }
  if (fsTabs.length === 0) { toast('No FamilySearch tabs detected. Click Detect Tabs.', 'error'); return; }

  const numTabs = fsTabs.length;
  const chunkSize = Math.ceil(data.length / numTabs);

  fsTabs.forEach((tab, index) => {
    const start = index * chunkSize;
    const end = Math.min(start + chunkSize, data.length);
    tabAssignments[tab.id] = data.slice(start, end);
  });

  renderTabList();
  updateMultiTabSummary();
  toast(`Split ${data.length} rows across ${numTabs} tab(s) (${chunkSize} rows/tab)`, 'success');
}

function assignAllTabs() {
  syncDataFromTable();
  if (data.length === 0) { toast('No data in editor', 'error'); return; }
  if (fsTabs.length === 0) { toast('No FamilySearch tabs detected', 'error'); return; }

  fsTabs.forEach(tab => {
    tabAssignments[tab.id] = JSON.parse(JSON.stringify(data));
  });

  renderTabList();
  updateMultiTabSummary();
  toast(`Assigned ${data.length} rows to all ${fsTabs.length} tab(s)`, 'success');
}

function stopAllTabs() {
  fsTabs.forEach(tab => stopTab(tab.id));
  toast('Stopped all tab fills', 'success');
}

function updateMultiTabSummary() {
  const summaryEl = document.getElementById('multiTabSummary');
  const statsEl = document.getElementById('multiTabStats');
  const barEl = document.getElementById('multiTabBar');

  if (!fsTabs || fsTabs.length === 0) {
    if (summaryEl) summaryEl.style.display = 'none';
    return;
  }

  let totalFilled = 0;
  let totalRecords = 0;
  let hasActiveOrDone = false;

  fsTabs.forEach(t => {
    const prog = tabProgress[t.id];
    if (prog) {
      if (prog.status === 'filling' || prog.status === 'done') hasActiveOrDone = true;
      totalFilled += (prog.filled || 0);
      totalRecords += (prog.total || 0);
    }
  });

  if (summaryEl && hasActiveOrDone && totalRecords > 0) {
    summaryEl.style.display = 'block';
    const pct = Math.min(100, Math.round((totalFilled / totalRecords) * 100));
    statsEl.textContent = `${totalFilled} / ${totalRecords} (${pct}%)`;
    barEl.style.width = `${pct}%`;
  } else if (summaryEl) {
    summaryEl.style.display = 'none';
  }
}

function renderTabList() {
  const container = document.getElementById('tabList');

  if (fsTabs.length === 0) {
    container.innerHTML = `
      <div class="no-tabs">
        <div class="icon">🔍</div>
        <div>No FamilySearch form tabs detected.<br>Open 3 to 5 tabs and click Detect Tabs.</div>
      </div>`;
    updateMultiTabSummary();
    return;
  }

  container.innerHTML = '';
  fsTabs.forEach(tab => {
    const prog = tabProgress[tab.id] || {};
    const assigned = tabAssignments[tab.id];
    const status = prog.status || 'idle';

    const card = document.createElement('div');
    card.className = `tab-card ${status}`;
    card.id = `tabcard-${tab.id}`;

    const pct = prog.total ? Math.round((prog.filled || 0) / prog.total * 100) : 0;
    const formId = tab.url.split('/').pop();

    card.innerHTML = `
      <div class="tab-card-header">
        <span class="tab-url" title="${tab.url}">📄 Tab ${tab.id} (Form: ${formId})</span>
        <span class="tab-status ${status}">${status.toUpperCase()}</span>
      </div>
      <div class="tab-card-body">
        <span class="tab-assigned">${assigned ? assigned.length + ' rows assigned' : '⚠ No data assigned'}</span>
        <button class="btn btn-ghost btn-sm" data-action="assign" data-tabid="${tab.id}">
          ${assigned ? '↺ Reassign' : '📋 Assign JSON'}
        </button>
        ${status === 'filling'
          ? `<button class="btn btn-danger btn-sm" data-action="stop" data-tabid="${tab.id}">⏹ Stop</button>`
          : `<button class="btn btn-primary btn-sm" data-action="fill" data-tabid="${tab.id}" ${!assigned ? 'disabled' : ''}>▶ Fill</button>`
        }
      </div>
      <div class="progress-bar-wrap">
        <div class="progress-bar ${status === 'done' ? 'done' : status === 'error' ? 'error' : ''}"
             style="width:${pct}%"></div>
      </div>
      <div class="progress-text">${tabProgressText(prog)}</div>
    `;

    // Event listeners
    card.querySelector('[data-action="assign"]').addEventListener('click', () => assignJSON(tab.id));
    const fillBtn = card.querySelector('[data-action="fill"]');
    if (fillBtn) fillBtn.addEventListener('click', () => fillTab(tab.id));
    const stopBtn = card.querySelector('[data-action="stop"]');
    if (stopBtn) stopBtn.addEventListener('click', () => stopTab(tab.id));

    container.appendChild(card);
  });

  updateMultiTabSummary();
}

function assignJSON(tabId) {
  syncDataFromTable();
  if (data.length === 0) { toast('No data in editor. Load a JSON file first.', 'error'); return; }
  tabAssignments[tabId] = JSON.parse(JSON.stringify(data));
  toast(`Assigned ${data.length} rows to tab`, 'success');
  renderTabList();
}

function fillTab(tabId) {
  let records = tabAssignments[tabId];
  if (!records || !records.length) { toast('No data assigned to this tab', 'error'); return; }

  // Check if Start at RIN filter is set
  const startRinEl = document.getElementById('startRinInput');
  const startRinVal = startRinEl ? parseInt(startRinEl.value) : null;
  if (!isNaN(startRinVal) && startRinVal > 0) {
    records = records.filter(r => parseInt(r.rin) >= startRinVal);
    if (!records.length) {
      toast(`No records found with RIN >= ${startRinVal} for Tab ${tabId}`, 'warning');
      return;
    }
  }

  const speed = parseInt(document.getElementById('speedSelect').value);

  tabProgress[tabId] = { status: 'filling', filled: 0, skipped: 0, total: records.length, currentRin: null, errors: [] };
  renderTabList();

  chrome.runtime.sendMessage({ type: 'FILL_TAB', tabId, records, speed }, resp => {
    if (chrome.runtime.lastError || !resp || !resp.ok) {
      const err = (resp && resp.error) || (chrome.runtime.lastError && chrome.runtime.lastError.message) || 'Unknown error';
      tabProgress[tabId] = { status: 'error', error: err };
      updateTabCard(tabId);
      toast('Fill error: ' + err, 'error');
    }
  });
}

function stopTab(tabId) {
  chrome.runtime.sendMessage({ type: 'STOP_TAB', tabId }, () => {
    if (tabProgress[tabId]) {
      const lastRin = tabProgress[tabId].currentRin;
      tabProgress[tabId].status = 'stopped';

      // Auto-set Start at RIN so hitting Fill automatically continues by default!
      if (lastRin) {
        const nextRin = parseInt(lastRin) + 1;
        const startRinEl = document.getElementById('startRinInput');
        if (startRinEl) startRinEl.value = nextRin;
      }
    }
    renderTabList();
    toast('Stopped — Click Fill to continue, or "Start from Beginning" to reset', 'info');
  });
}

function fillAll() {
  const assigned = fsTabs.filter(t => tabAssignments[t.id]);
  if (!assigned.length) { toast('No tabs have data assigned. Click "Assign to All" or "Split across Tabs".', 'error'); return; }
  confirm2(`Fill ${assigned.length} tab(s) simultaneously?`, () => {
    assigned.forEach(t => fillTab(t.id));
    toast(`Started filling ${assigned.length} tab(s) in parallel`, 'success');
  });
}

// ════════════════════════════════════════════════
//  BACKGROUND MESSAGE HANDLER
// ════════════════════════════════════════════════
function handleBackgroundMessage(msg) {
  switch (msg.type) {
    case 'TAB_PROGRESS':
      tabProgress[msg.tabId] = {
        status: 'filling',
        filled: msg.filled,
        skipped: msg.skipped,
        total: msg.total,
        currentRin: msg.currentRin,
        errors: msg.errors,
        searching: !!msg.searching,
        searchAttempt: msg.searchAttempt || null
      };
      ensureTabTracked(msg.tabId);
      updateTabCard(msg.tabId);
      break;

    case 'TAB_DONE':
      tabProgress[msg.tabId] = {
        status: 'done',
        filled: msg.filled,
        skipped: msg.skipped,
        total: msg.total,
        errors: msg.errors
      };
      ensureTabTracked(msg.tabId);
      updateTabCard(msg.tabId);
      toast(`Tab ${msg.tabId} done — ${msg.filled} filled`, 'success');
      break;

    case 'TAB_ERROR':
      tabProgress[msg.tabId] = { status: 'error', error: msg.error };
      ensureTabTracked(msg.tabId);
      updateTabCard(msg.tabId);
      toast('Tab error: ' + msg.error, 'error');
      break;
  }
}

// If a progress message arrives for a tab this popup instance doesn't know
// about yet (e.g. it was started before this popup was opened, or "Detect
// Tabs" was never clicked), pull it in so its card actually renders instead
// of the update silently having nowhere to go.
function ensureTabTracked(tabId) {
  const id = typeof tabId === 'string' ? parseInt(tabId, 10) : tabId;
  if (fsTabs.some(t => t.id === id)) return;
  chrome.tabs.get(id, (tab) => {
    if (chrome.runtime.lastError || !tab) return;
    fsTabs.push({ id: tab.id, url: tab.url, title: tab.title });
    renderTabList();
  });
}

// Shared by renderTabList and updateTabCard so both surfaces agree on what
// "still working" looks like during the row-search dead-air (searching:true,
// sent as a heartbeat from background.js) instead of a static, frozen-looking line.
function tabProgressText(prog) {
  if (!prog.total) return 'Not started';
  // currentRin and errors ultimately trace back to values in the loaded JSON
  // (record.rin) — escaped here since this whole string lands in innerHTML.
  const rin = escapeHtml(String(prog.currentRin || '–'));
  const base = prog.searching
    ? `<span class="btn-spinner" style="margin-right:4px;"></span>Searching for RIN ${rin} (page attempt ${prog.searchAttempt || 1}/200)...`
    : `${prog.filled || 0} filled / ${prog.skipped || 0} skipped / ${prog.total} total — RIN ${rin}`;
  const errs = prog.errors && prog.errors.length
    ? `<br>⚠ Errors: ${escapeHtml(prog.errors.slice(0,3).join(', '))}${prog.errors.length > 3 ? '...' : ''}`
    : '';
  return base + errs;
}

function updateTabCard(tabId) {
  const card = document.getElementById(`tabcard-${tabId}`);
  const prog = tabProgress[tabId];
  if (!prog) return;

  if (card) {
    const pct = prog.total ? Math.min(100, Math.round(((prog.filled || 0) / prog.total) * 100)) : 0;
    const bar = card.querySelector('.progress-bar');
    const text = card.querySelector('.progress-text');
    const statusSpan = card.querySelector('.tab-status');

    if (bar) {
      bar.style.width = `${pct}%`;
      if (prog.status === 'done') bar.className = 'progress-bar done';
      else if (prog.status === 'error') bar.className = 'progress-bar error';
    }

    if (statusSpan) {
      statusSpan.textContent = (prog.status || 'idle').toUpperCase();
      statusSpan.className = `tab-status ${prog.status || 'idle'}`;
    }

    if (text && prog.total) {
      text.innerHTML = tabProgressText(prog);
    }
  } else {
    renderTabList();
  }

  updateMultiTabSummary();
}

// ════════════════════════════════════════════════
//  MODAL
// ════════════════════════════════════════════════
function setupModalListeners() {
  document.getElementById('confirmOk').addEventListener('click', () => {
    closeModal();
    if (confirmCallback) { confirmCallback(); confirmCallback = null; }
  });
  document.getElementById('confirmCancel').addEventListener('click', closeModal);
  document.getElementById('confirmModal').addEventListener('click', function(e) {
    if (e.target === this) closeModal();
  });
}

function confirm2(msg, cb) {
  document.getElementById('confirmMsg').textContent = msg;
  document.getElementById('confirmModal').classList.add('open');
  confirmCallback = cb;
}

function closeModal() {
  document.getElementById('confirmModal').classList.remove('open');
}

// ════════════════════════════════════════════════
//  TOAST
// ════════════════════════════════════════════════
let toastTimer = null;
function toast(msg, type = '') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast show ' + type;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast'; }, 2800);
}

// ════════════════════════════════════════════════
//  BUSY-BUTTON HELPER — reusable double-click guard + spinner for any
//  button that kicks off an async operation. Pairs with the .btn:disabled
//  and .btn-spinner CSS rules.
// ════════════════════════════════════════════════
function setBusy(btn, label) {
  if (!btn || btn.dataset.busy) return;
  btn.dataset.busy = '1';
  btn.dataset.origHtml = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = `<span class="btn-spinner"></span>${escapeHtml(label || 'Working...')}`;
}
function clearBusy(btn) {
  if (!btn || !btn.dataset.busy) return;
  btn.disabled = false;
  btn.innerHTML = btn.dataset.origHtml;
  delete btn.dataset.busy;
  delete btn.dataset.origHtml;
}

// ════════════════════════════════════════════════
//  FRIENDLY ERROR — turns a raw JS/fetch/chrome.runtime error into a
//  message a non-technical user can act on, instead of a bare stack string.
// ════════════════════════════════════════════════
function friendlyError(e) {
  if (!e) return 'Unknown error';
  const msg = e.message || String(e);
  if (e.name === 'AbortError') {
    return 'Request timed out — your connection may be slow, or the server is taking too long. Try again.';
  }
  if (e.name === 'TypeError' && /fetch/i.test(msg)) {
    return 'Network error — check your internet connection and try again.';
  }
  if (e.httpStatus === 401 || e.httpStatus === 403) {
    return 'API key rejected — check it in Settings.';
  }
  if (e.httpStatus === 429) {
    return 'Rate limited by the API — wait a moment and try again, or add another key.';
  }
  if (e.httpStatus >= 500) {
    return 'The server had a problem on its end — try again in a moment.';
  }
  return msg;
}

