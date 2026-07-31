const VAULT_BASE = 'http://127.0.0.1:5000';

// ── Lock state ────────────────────────────────────────────────────────────────
// chrome.storage.session: in-memory, cleared on browser close, survives SW restarts

async function setVaultLocked(locked) {
  await chrome.storage.session.set({ vaultLocked: locked });
}

async function getVaultLocked() {
  const { vaultLocked = true } = await chrome.storage.session.get('vaultLocked');
  return vaultLocked;
}

// ── API layer ─────────────────────────────────────────────────────────────────

async function apiFetch(path, options = {}) {
  const url = `${VAULT_BASE}${path}`;
  const defaults = {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
  };
  return fetch(url, { ...defaults, ...options });
}

async function unlockVault(masterPassword) {
  let res;
  try {
    res = await apiFetch('/api/unlock', {
      method: 'POST',
      body: JSON.stringify({ master_password: masterPassword }),
    });
  } catch (_) {
    return { ok: false, error: 'Cannot reach vault. Is Flask running?' };
  }
  if (res.ok) {
    await setVaultLocked(false);
    return { ok: true };
  }
  const err = await res.json().catch(() => ({}));
  return { ok: false, error: err.error || 'unlock failed' };
}

async function lockVault() {
  try {
    await apiFetch('/api/lock', { method: 'POST' });
  } catch (_) {}
  await setVaultLocked(true);
  return { ok: true };
}

async function searchEntries(query = '', category = '') {
  const params = new URLSearchParams();
  if (query) params.set('q', query);
  if (category) params.set('category', category);
  const qs = params.toString() ? '?' + params : '';
  let res;
  try {
    res = await apiFetch(`/api/entries${qs}`);
  } catch (_) {
    return { error: 'network error' };
  }
  if (res.status === 401) {
    await setVaultLocked(true);
    return { locked: true };
  }
  return { entries: await res.json() };
}

async function getEntry(id) {
  let res;
  try {
    res = await apiFetch(`/api/entries/${id}`);
  } catch (_) {
    return null;
  }
  if (!res.ok) return null;
  return res.json();
}

async function saveEntry(data) {
  let res;
  try {
    res = await apiFetch('/api/entries', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  } catch (_) {
    return { ok: false, error: 'network error' };
  }
  if (res.status === 401) {
    await setVaultLocked(true);
    return { ok: false, error: 'vault locked' };
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    return { ok: false, error: err.error || 'save failed' };
  }
  const body = await res.json();
  return { ok: true, id: body.id };
}

async function updateEntry(id, data) {
  let res;
  try {
    res = await apiFetch(`/api/entries/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  } catch (_) {
    return { ok: false };
  }
  return { ok: res.ok };
}

async function deleteEntry(id) {
  let res;
  try {
    res = await apiFetch(`/api/entries/${id}`, { method: 'DELETE' });
  } catch (_) {
    return { ok: false };
  }
  return { ok: res.ok };
}

// ── Message handler ───────────────────────────────────────────────────────────

async function handleMessage(message) {
  switch (message.type) {
    case 'GET_STATUS': {
      const locked = await getVaultLocked();
      if (!locked) {
        // Probe for server-side auto-lock (5-min timeout in Flask)
        let probeRes;
        try {
          probeRes = await apiFetch('/api/entries?q=__probe__');
        } catch (_) {
          return { locked: true, unreachable: true };
        }
        if (probeRes.status === 401) {
          await setVaultLocked(true);
          return { locked: true };
        }
      }
      return { locked: await getVaultLocked() };
    }

    case 'UNLOCK':
      return unlockVault(message.masterPassword);

    case 'LOCK':
      return lockVault();

    case 'SEARCH_ENTRIES':
      return searchEntries(message.query, message.category);

    case 'GET_ENTRY':
      return getEntry(message.id);

    case 'SAVE_ENTRY':
      return saveEntry(message.data);

    case 'UPDATE_ENTRY':
      return updateEntry(message.id, message.data);

    case 'DELETE_ENTRY':
      return deleteEntry(message.id);

    case 'TRIGGER_AUTOFILL': {
      const entry = await getEntry(message.entryId);
      if (!entry) return { ok: false, error: 'entry not found' };

      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tabs[0]) return { ok: false, error: 'no active tab' };

      try {
        await chrome.tabs.sendMessage(tabs[0].id, {
          type: 'FILL_CREDENTIALS',
          data: { username: entry.username, password: entry.password },
        });
      } catch (_) {
        return { ok: false, error: 'cannot autofill this page' };
      }
      return { ok: true };
    }

    default:
      return { ok: false, error: 'unknown message type' };
  }
}

if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    handleMessage(message)
      .then(sendResponse)
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  });
}

export {
  getVaultLocked,
  setVaultLocked,
  unlockVault,
  lockVault,
  searchEntries,
  getEntry,
  saveEntry,
  updateEntry,
  deleteEntry,
  handleMessage,
};
