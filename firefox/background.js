// background.js — FamilySearch AutoFill Extension
//
// The entire fill loop (pacing, waits between fields, page-turn waits, all
// of it) now runs HERE in the background service worker instead of inside
// the page's own content script. Chrome throttles a page's own setTimeout
// timers once its tab/window isn't the one being looked at — that's what
// was causing fills to crawl whenever the user tabbed away. The service
// worker is a separate extension-owned process that isn't subject to that
// per-tab/per-window throttling, so timing stays fast regardless of what
// tab or app is focused.
//
// Content script injection is done on-demand via chrome.scripting.executeScript
// with a self-contained `func` (pageStepExecutor) for every single DOM action —
// there is no persistent content.js anymore. Each call is a fresh, isolated
// injection: read a field, write a field, click a button. All the "wait N ms
// before checking" pacing lives in this file's own setTimeout calls.

const sessions = {};
// sessions[tabId] = { status, filled, skipped, total, currentRin, errors, stopped }

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {
    case 'GET_SESSIONS':
      sendResponse({ sessions });
      break;

    case 'CLEAR_SESSION':
      delete sessions[msg.tabId];
      sendResponse({ ok: true });
      break;

    case 'FILL_TAB':
      if (sessions[msg.tabId] && sessions[msg.tabId].status === 'filling') {
        sendResponse({ ok: false, error: 'Already filling this tab' });
        break;
      }
      startFillForTab(msg.tabId, msg.records, msg.speed || 350);
      sendResponse({ ok: true });
      break;

    case 'STOP_TAB':
      if (sessions[msg.tabId]) {
        sessions[msg.tabId].stopped = true;
      }
      sendResponse({ ok: true });
      break;

    case 'PING_TAB':
      sendResponse({ ok: true, ...(sessions[msg.tabId] || { status: 'idle' }) });
      break;

    case 'SAVE_TAB':
      // Reuses the same adaptive clickSave() the fill loop uses, instead of
      // popup.js clicking Save and assuming it worked with no verification.
      clickSave(msg.tabId).then(sendResponse);
      return true; // keep the message channel open for the async response
  }
  return true;
});

// ── Fill orchestrator ───────────────────────────────────────────────────────
async function startFillForTab(tabId, records, speed) {
  const session = {
    status: 'filling',
    filled: 0,
    skipped: 0,
    total: records.length,
    currentRin: null,
    errors: [],
    stopped: false
  };
  sessions[tabId] = session;

  const fieldDelay = Math.max(30, Math.floor(speed / 10));
  const recordDelay = Math.max(50, Math.floor(speed / 3));

  try {
    await bgSleep(400);

    for (const record of records) {
      if (session.stopped) break;
      const rin = String(record.rin).trim();

      let navAttempts = 0;
      while (!(await exec(tabId, { action: 'rowExists', rin })) && navAttempts < 40) {
        if (session.stopped) break;
        // goToNextPage's own adaptive wait (background.js PAGE_TURN_MAX_MS)
        // now confirms the page actually turned before returning, so there's
        // no need for an extra fixed settle delay here anymore — and this
        // heartbeat keeps the UI from looking frozen during a long search.
        reportProgress(tabId, session, rin, { searching: true, searchAttempt: navAttempts + 1 });
        const nav = await goToNextPage(tabId);
        navAttempts++;
        if (!nav.ok) {
          session.errors.push(`Stopped: ${nav.reason}`);
          session.stopped = true;
          break;
        }
      }

      if (session.stopped) break;

      if (!(await exec(tabId, { action: 'rowExists', rin }))) {
        session.skipped++;
        session.errors.push(`RIN ${rin}: row not found on any page`);
        reportProgress(tabId, session, rin);
        continue;
      }

      const ok = await fillRecord(tabId, record, rin, fieldDelay);
      if (ok) {
        session.filled++;
      } else {
        session.skipped++;
        session.errors.push(`RIN ${rin}: fill error`);
      }

      reportProgress(tabId, session, rin);
      await bgSleep(recordDelay);
    }

    const saveResult = await clickSave(tabId);
    if (!saveResult.ok) session.errors.push(`Final save: ${saveResult.reason}`);
  } catch (e) {
    session.errors.push('Fatal: ' + e.message);
  } finally {
    session.status = 'done';
    chrome.runtime.sendMessage({
      type: 'TAB_DONE',
      tabId,
      filled: session.filled,
      skipped: session.skipped,
      total: session.total,
      errors: session.errors
    }).catch(() => {});
  }
}

function reportProgress(tabId, session, currentRin, extra) {
  session.currentRin = currentRin;
  chrome.runtime.sendMessage({
    type: 'TAB_PROGRESS',
    tabId,
    filled: session.filled,
    skipped: session.skipped,
    total: session.total,
    currentRin,
    errors: session.errors,
    ...(extra || {})
  }).catch(() => {});
}

// ── Per-record fill (each field write is its own tiny, isolated injection;
//    the pacing between them happens here, not on the page) ────────────────
async function fillRecord(tabId, record, rin, delay) {
  try {
    const relVal = record.relation !== null && record.relation !== undefined ? String(record.relation).trim() : '';
    await exec(tabId, { action: 'setField', rin, key: 'relation', value: relVal, isSelect: false });
    await bgSleep(delay);

    if (record.sex) {
      const sexVal = String(record.sex).trim().toLowerCase().startsWith('f') ? 'F' : 'M';
      await exec(tabId, { action: 'setField', rin, key: 'sex', value: sexVal, isSelect: true });
    }
    await bgSleep(delay);

    if (record.given_names && String(record.given_names).trim() !== '') {
      await exec(tabId, { action: 'setField', rin, key: 'givenName', value: String(record.given_names).trim(), isSelect: false });
    }
    await bgSleep(delay);

    if (record.family_names && String(record.family_names).trim() !== '') {
      await exec(tabId, { action: 'setField', rin, key: 'surname.fieldValue', value: String(record.family_names).trim(), isSelect: false });
    }
    await bgSleep(delay);

    if (record.birth_year && String(record.birth_year).trim() !== '') {
      await exec(tabId, { action: 'setField', rin, key: 'birthDate.fieldValue', value: String(record.birth_year).trim(), isSelect: false });
    }
    await bgSleep(delay);

    if (record.birth_location && String(record.birth_location).trim() !== '') {
      await exec(tabId, { action: 'setField', rin, key: 'birthPlace.fieldValue', value: String(record.birth_location).trim(), isSelect: false });
    }
    await bgSleep(delay);

    // Living select + conditional Death fields. Only touch isLiving when it
    // actually needs to change — re-setting it to its current value can wipe
    // an already-filled Death Date/Place via React's re-render.
    const isDead = String(record.living).toLowerCase() === 'no' || Boolean(record.death_year) || Boolean(record.death_location);
    const livingVal = isDead ? 'No' : 'Yes';
    const livingResult = await exec(tabId, { action: 'setLivingIfNeeded', rin, value: livingVal });

    if (livingResult.ok && livingResult.changed && isDead) {
      await waitForField(tabId, rin, 'deathDate.fieldValue', 1500);
    }

    if (isDead) {
      if (record.death_year && String(record.death_year).trim() !== '') {
        await exec(tabId, { action: 'setField', rin, key: 'deathDate.fieldValue', value: String(record.death_year).trim(), isSelect: false });
      }
      await bgSleep(delay);

      if (record.death_location && String(record.death_location).trim() !== '') {
        await exec(tabId, { action: 'setField', rin, key: 'deathPlace.fieldValue', value: String(record.death_location).trim(), isSelect: false });
      }
      await bgSleep(delay);
    }

    return true;
  } catch (e) {
    console.warn('[FS AutoFill][BG] Error in fillRecord:', rin, e);
    return false;
  }
}

// Polls (using the background's own timer, not the page's) for a
// conditionally-rendered field to appear, e.g. Death Date after Living->No.
async function waitForField(tabId, rin, key, maxWaitMs) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    if (await exec(tabId, { action: 'fieldExists', rin, key })) return true;
    await bgSleep(50);
  }
  return false;
}

// ── Save & page navigation — click happens on the page (instant), the
//    "give it a moment to take effect" wait happens here in the background ──
const PAGE_TURN_POLL_MS = 250;
const PAGE_TURN_MAX_MS = 5000;

async function clickSave(tabId) {
  const clickResult = await exec(tabId, { action: 'clickSaveOnly' });
  if (!clickResult.ok) return clickResult;
  if (clickResult.nothingToSave) return { ok: true };

  // This 1000ms window is the same one that's always worked here — left
  // untouched so a normal/fast connection never gets slower. What's new is
  // the non-blocking re-check below: on a slow connection FamilySearch's own
  // save request can still be in flight after this window closes, so we
  // look again a couple seconds later WITHOUT holding up the fill loop —
  // if an error shows up late, it's recorded instead of silently lost.
  // (Best-effort: if the service worker gets suspended before this fires,
  // the late check is simply skipped — same as if it were never added.)
  await bgSleep(1000);
  const errCheck = await exec(tabId, { action: 'checkSaveError' });
  if (errCheck.hasError) return { ok: false, reason: 'server rejected save (see "Error saving" toast on page)' };

  setTimeout(async () => {
    const session = sessions[tabId];
    if (!session || session.status !== 'filling') return;
    const lateCheck = await exec(tabId, { action: 'checkSaveError' });
    if (lateCheck.hasError) {
      session.errors.push('A save may have failed on a slow connection (error appeared after the fill had already moved on) — please double-check the record around RIN ' + session.currentRin + '.');
      reportProgress(tabId, session, session.currentRin);
    }
  }, 2500);

  return { ok: true };
}

// Polls for the page to actually have turned instead of assuming a fixed
// wait was long enough — resolves as soon as arrival is detected, so a fast
// connection isn't slowed down, while a slow one gets up to PAGE_TURN_MAX_MS
// instead of the fill loop wrongly believing a page-turn already landed.
async function goToNextPage(tabId) {
  const preSave = await clickSave(tabId);
  if (!preSave.ok) {
    return { ok: false, reason: 'explicit save before page turn failed: ' + preSave.reason };
  }

  const before = await exec(tabId, { action: 'getCurrentPage' });
  const navClick = await exec(tabId, { action: 'clickNextOrBegin' });
  if (!navClick.ok) return navClick;

  const start = Date.now();
  while (Date.now() - start < PAGE_TURN_MAX_MS) {
    const errCheck = await exec(tabId, { action: 'checkSaveError' });
    if (errCheck.hasError) {
      return { ok: false, reason: navClick.usedBegin ? 'save failed while creating the next page' : 'save failed while turning to the next page' };
    }

    if (navClick.usedBegin) {
      const rowsCheck = await exec(tabId, { action: 'pageHasRows' });
      if (rowsCheck.hasRows) return { ok: true };
    } else {
      const now = await exec(tabId, { action: 'getCurrentPage' });
      if (now.page && before.page && now.page > before.page) return { ok: true };
    }

    await bgSleep(PAGE_TURN_POLL_MS);
  }

  return { ok: false, reason: 'page did not finish loading within the wait window — connection may be too slow' };
}

function bgSleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ── exec(): inject a single, self-contained step into the tab and run it ───
async function exec(tabId, step) {
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: pageStepExecutor,
      args: [step]
    });
    return result;
  } catch (e) {
    console.warn('[FS AutoFill][BG] exec failed:', step.action, e.message);
    return { ok: false, reason: e.message };
  }
}

// Runs INSIDE the FamilySearch tab, one call per step. Must be fully
// self-contained (no references to anything outside this function body) —
// chrome.scripting.executeScript serializes and re-injects it fresh each time.
function pageStepExecutor(step) {
  function inputField(rin, key) {
    return document.querySelector(`input[name="familyTree.${rin}.${key}"]`);
  }
  function selectField(rin, key) {
    return document.querySelector(`select[name="familyTree.${rin}.${key}"]`);
  }
  function rowExists(rin) {
    return !!inputField(rin, 'givenName');
  }
  function hasSaveError() {
    return /error saving/i.test(document.body.innerText || '');
  }
  function findButtonByText(text) {
    return Array.from(document.querySelectorAll('button')).find(b =>
      !b.disabled && (b.textContent || '').trim().toLowerCase() === text.toLowerCase()
    );
  }
  function findButtonByAriaLabel(pattern) {
    return Array.from(document.querySelectorAll('button')).find(b =>
      !b.disabled && pattern.test(b.getAttribute('aria-label') || '')
    );
  }
  function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  // Native-setter write + verify/retry, same fix as before for React's
  // controlled inputs. These waits are tiny and scoped to one field write.
  async function setValue(el, value, retriesLeft) {
    if (!el) return;
    if (retriesLeft === undefined) retriesLeft = 2;
    try {
      el.focus();
      const proto = el.tagName === 'SELECT' ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype;
      const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      nativeSetter.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(25);
      el.dispatchEvent(new Event('change', { bubbles: true }));
      await sleep(25);
      el.blur();
      await sleep(20);
    } catch (e) {}

    if (String(el.value) === String(value)) return;
    if (retriesLeft > 0) {
      await sleep(150);
      await setValue(el, value, retriesLeft - 1);
    }
  }

  return (async () => {
    switch (step.action) {
      case 'rowExists':
        return rowExists(step.rin);

      case 'fieldExists':
        return !!inputField(step.rin, step.key);

      case 'setField': {
        const el = step.isSelect ? selectField(step.rin, step.key) : inputField(step.rin, step.key);
        if (!el) return { ok: false, reason: 'field not found' };
        if (step.isSelect && el.value === step.value) return { ok: true, skipped: true };
        await setValue(el, step.value);
        return { ok: true, value: el.value };
      }

      case 'setLivingIfNeeded': {
        const el = selectField(step.rin, 'isLiving');
        if (!el) return { ok: false, reason: 'isLiving not found' };
        if (el.value === step.value) return { ok: true, changed: false };
        await setValue(el, step.value);
        return { ok: true, changed: true };
      }

      case 'clickSaveOnly': {
        const btn = findButtonByText('Save');
        if (!btn) {
          const anySaveBtn = Array.from(document.querySelectorAll('button'))
            .find(b => (b.textContent || '').trim().toLowerCase() === 'save');
          if (anySaveBtn && anySaveBtn.disabled) return { ok: true, nothingToSave: true };
          return { ok: false, reason: 'Save button not found' };
        }
        btn.click();
        return { ok: true };
      }

      case 'checkSaveError':
        return { hasError: hasSaveError() };

      // Read-only page-position checks (no click) — used to poll for a page
      // turn actually landing instead of assuming it did after a fixed wait.
      case 'getCurrentPage': {
        const btn = Array.from(document.querySelectorAll('button')).find(b =>
          /currently on page \d+ of \d+/i.test(b.getAttribute('aria-label') || ''));
        if (!btn) return { page: null, total: null };
        const m = (btn.getAttribute('aria-label') || '').match(/currently on page (\d+) of (\d+)/i);
        return m ? { page: parseInt(m[1], 10), total: parseInt(m[2], 10) } : { page: null, total: null };
      }

      case 'pageHasRows':
        return { hasRows: !!inputField(1, 'givenName') || !!document.querySelector('input[name^="familyTree."]') };

      case 'clickNextOrBegin': {
        const nextBtn = findButtonByAriaLabel(/go to next page/i);
        if (nextBtn) {
          const label = nextBtn.getAttribute('aria-label') || '';
          const m = label.match(/currently on page (\d+) of (\d+)/i);
          const onLastPage = m ? parseInt(m[1], 10) >= parseInt(m[2], 10) : false;
          if (!onLastPage) {
            nextBtn.click();
            return { ok: true, usedBegin: false };
          }
        }
        const beginBtn = findButtonByText('Begin Next Page');
        if (beginBtn) {
          beginBtn.click();
          return { ok: true, usedBegin: true };
        }
        return { ok: false, reason: 'no next-page control found (last page and no "Begin Next Page" button present)' };
      }

      default:
        return { ok: false, reason: 'unknown step: ' + step.action };
    }
  })();
}
