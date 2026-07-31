'use strict';

// ── Messaging helpers ─────────────────────────────────────────────────────────

function bg(type, payload) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type, ...payload }, (res) => {
      if (chrome.runtime.lastError) resolve(null);
      else resolve(res);
    });
  });
}

// ── View management ───────────────────────────────────────────────────────────

const VIEWS = ['loading', 'error', 'locked', 'main'];

function showView(name) {
  VIEWS.forEach(v => {
    document.getElementById(`view-${v}`).classList.toggle('hidden', v !== name);
  });
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function esc(str) {
  return String(str).replace(/[&<>"]/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])
  );
}

function extractDomain(url) {
  try { return new URL(url).hostname; }
  catch { return url; }
}

// ── Startup ───────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  bindStaticEvents();
  await checkStatus();
});

async function checkStatus() {
  showView('loading');
  const status = await bg('GET_STATUS');
  if (!status) {
    showView('error');
    return;
  }
  if (status.unreachable) {
    showView('error');
    return;
  }
  if (status.locked) {
    showView('locked');
    document.getElementById('master-password').focus();
  } else {
    await loadMainView();
  }
}

// ── Lock / Unlock ─────────────────────────────────────────────────────────────

function bindStaticEvents() {
  // Unlock button + Enter key
  document.getElementById('btn-unlock').addEventListener('click', doUnlock);
  document.getElementById('master-password').addEventListener('keydown', e => {
    if (e.key === 'Enter') doUnlock();
  });

  // Lock button
  document.getElementById('btn-lock').addEventListener('click', async () => {
    await bg('LOCK');
    showView('locked');
    document.getElementById('master-password').value = '';
    document.getElementById('master-password').focus();
    document.getElementById('unlock-error').classList.add('hidden');
  });

  // Retry (server unreachable)
  document.getElementById('btn-retry').addEventListener('click', checkStatus);

  // Tab switching
  document.querySelectorAll('.tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(t => t.classList.add('hidden'));
      btn.classList.add('active');
      document.getElementById(`tab-${btn.dataset.tab}`).classList.remove('hidden');
    });
  });

  // Show/hide password in save form
  document.getElementById('btn-show-pw').addEventListener('click', () => {
    const pw = document.getElementById('save-password');
    pw.type = pw.type === 'password' ? 'text' : 'password';
  });

  // Autofill click (delegated on the list)
  document.getElementById('entry-list').addEventListener('click', async (e) => {
    const btn = e.target.closest('.btn-autofill');
    if (!btn) return;
    const entryId = Number(btn.dataset.id);
    btn.textContent = '…';
    btn.disabled = true;
    const res = await bg('TRIGGER_AUTOFILL', { entryId });
    if (res && res.ok) {
      btn.textContent = 'Done!';
      setTimeout(() => window.close(), 800);
    } else {
      btn.textContent = 'Fill';
      btn.disabled = false;
      showStatus('save-status', `Autofill failed: ${res?.error || 'unknown'}`, 'error');
    }
  });

  // Save form submit
  document.getElementById('save-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = {
      title:    document.getElementById('save-title').value.trim(),
      username: document.getElementById('save-username').value,
      password: document.getElementById('save-password').value,
      url:      document.getElementById('save-url').value.trim(),
      category: document.getElementById('save-category').value.trim(),
      notes:    document.getElementById('save-notes').value,
    };
    if (!data.title) {
      showStatus('save-status', 'Title is required.', 'error');
      return;
    }
    const btn = e.target.querySelector('[type="submit"]');
    btn.disabled = true;
    btn.textContent = 'Saving…';
    const res = await bg('SAVE_ENTRY', { data });
    btn.disabled = false;
    btn.textContent = 'Save to Vault';
    if (res && res.ok) {
      showStatus('save-status', 'Saved successfully!', 'success');
      document.getElementById('save-form').reset();
    } else {
      showStatus('save-status', `Error: ${res?.error || 'save failed'}`, 'error');
    }
  });

  // Debounced search
  let searchTimer;
  document.getElementById('search-input').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(async () => {
      const q = e.target.value.trim();
      const result = await bg('SEARCH_ENTRIES', { query: q });
      if (!result) return;
      if (result.locked) { showView('locked'); return; }
      renderEntryList(result.entries || []);
    }, 250);
  });
}

async function doUnlock() {
  const pwInput = document.getElementById('master-password');
  const errEl = document.getElementById('unlock-error');
  const btn = document.getElementById('btn-unlock');
  const pw = pwInput.value;
  if (!pw) return;

  errEl.classList.add('hidden');
  btn.disabled = true;
  btn.textContent = 'Unlocking…';

  const res = await bg('UNLOCK', { masterPassword: pw });
  btn.disabled = false;
  btn.textContent = 'Unlock';

  if (res && res.ok) {
    pwInput.value = '';
    await loadMainView();
  } else {
    const msg = res?.error === 'wrong password' ? 'Wrong password.' : (res?.error || 'Unlock failed.');
    errEl.textContent = msg;
    errEl.classList.remove('hidden');
    pwInput.select();
  }
}

// ── Main view ─────────────────────────────────────────────────────────────────

async function loadMainView() {
  showView('main');

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const currentUrl = tab?.url || '';

  // Pre-fill save form with current tab info
  document.getElementById('save-url').value = currentUrl;
  document.getElementById('save-title').value = tab?.title || '';

  // Reset save status
  const statusEl = document.getElementById('save-status');
  statusEl.classList.add('hidden');

  // Load matching entries
  await loadMatches(currentUrl);
}

async function loadMatches(pageUrl) {
  const domain = extractDomain(pageUrl);
  const result = await bg('SEARCH_ENTRIES', { query: domain });

  if (!result) return;
  if (result.locked) { showView('locked'); return; }

  renderEntryList(result.entries || []);
}

function renderEntryList(entries) {
  const list = document.getElementById('entry-list');
  const noMatches = document.getElementById('no-matches');
  list.innerHTML = '';

  if (!entries.length) {
    noMatches.classList.remove('hidden');
    return;
  }
  noMatches.classList.add('hidden');

  entries.forEach(entry => {
    const li = document.createElement('li');
    li.className = 'entry-row';
    li.innerHTML = `
      <div class="entry-info">
        <span class="entry-title">${esc(entry.title)}</span>
        <span class="entry-url">${esc(entry.url || '')}</span>
      </div>
      <button class="btn-autofill" data-id="${entry.id}">Fill</button>
    `;
    list.append(li);
  });
}

// ── Status helper ─────────────────────────────────────────────────────────────

function showStatus(elId, msg, type) {
  const el = document.getElementById(elId);
  el.textContent = msg;
  el.className = `status-msg ${type}`;
  el.classList.remove('hidden');
  if (type === 'success') {
    setTimeout(() => el.classList.add('hidden'), 3000);
  }
}
