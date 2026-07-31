import { vi, describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest';
import { createChromeMock } from './setup.js';

// Set up chrome mock BEFORE importing the module so the guard check passes
const chromeMock = createChromeMock();
globalThis.chrome = chromeMock;

// Dynamic import AFTER setting globalThis.chrome
const {
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
} = await import('../background/service-worker.js');

// ── Fetch helpers ─────────────────────────────────────────────────────────────

function mockResponse(status, body) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('getVaultLocked / setVaultLocked', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset storage data between tests
    Object.keys(chromeMock.storage.session._data).forEach(k => {
      delete chromeMock.storage.session._data[k];
    });
  });

  it('default returns true when key not in storage', async () => {
    const result = await getVaultLocked();
    expect(result).toBe(true);
  });

  it('setVaultLocked(false) → getVaultLocked() returns false', async () => {
    await setVaultLocked(false);
    const result = await getVaultLocked();
    expect(result).toBe(false);
  });

  it('setVaultLocked(true) → getVaultLocked() returns true', async () => {
    await setVaultLocked(false);
    await setVaultLocked(true);
    const result = await getVaultLocked();
    expect(result).toBe(true);
  });
});

describe('unlockVault', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.keys(chromeMock.storage.session._data).forEach(k => {
      delete chromeMock.storage.session._data[k];
    });
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('network error (fetch throws) → { ok: false, error: "Cannot reach vault..." }', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const result = await unlockVault('password');
    expect(result).toEqual({ ok: false, error: 'Cannot reach vault. Is Flask running?' });
  });

  it('200 response → { ok: true }, storage set with { vaultLocked: false }', async () => {
    globalThis.fetch = vi.fn().mockReturnValue(mockResponse(200, {}));
    const result = await unlockVault('correct');
    expect(result).toEqual({ ok: true });
    expect(chromeMock.storage.session.set).toHaveBeenCalledWith({ vaultLocked: false });
  });

  it('401 response with { error: "wrong password" } → { ok: false, error: "wrong password" }', async () => {
    globalThis.fetch = vi.fn().mockReturnValue(mockResponse(401, { error: 'wrong password' }));
    const result = await unlockVault('bad');
    expect(result).toEqual({ ok: false, error: 'wrong password' });
  });

  it('400 response with { error: "password required" } → { ok: false, error: "password required" }', async () => {
    globalThis.fetch = vi.fn().mockReturnValue(mockResponse(400, { error: 'password required' }));
    const result = await unlockVault('');
    expect(result).toEqual({ ok: false, error: 'password required' });
  });

  it('non-ok response, JSON parse fails → { ok: false, error: "unlock failed" }', async () => {
    globalThis.fetch = vi.fn().mockReturnValue(
      Promise.resolve({
        ok: false,
        status: 500,
        json: () => Promise.reject(new Error('not json')),
      })
    );
    const result = await unlockVault('pw');
    expect(result).toEqual({ ok: false, error: 'unlock failed' });
  });
});

describe('lockVault', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.keys(chromeMock.storage.session._data).forEach(k => {
      delete chromeMock.storage.session._data[k];
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('success case → { ok: true }, vaultLocked set to true', async () => {
    globalThis.fetch = vi.fn().mockReturnValue(mockResponse(200, {}));
    const result = await lockVault();
    expect(result).toEqual({ ok: true });
    expect(chromeMock.storage.session.set).toHaveBeenCalledWith({ vaultLocked: true });
  });

  it('API call throws → still { ok: true }, vaultLocked still set to true', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('network down'));
    const result = await lockVault();
    expect(result).toEqual({ ok: true });
    expect(chromeMock.storage.session.set).toHaveBeenCalledWith({ vaultLocked: true });
  });
});

describe('searchEntries', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.keys(chromeMock.storage.session._data).forEach(k => {
      delete chromeMock.storage.session._data[k];
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('no params → fetch called with /api/entries (no query string)', async () => {
    const mockFetch = vi.fn().mockReturnValue(mockResponse(200, []));
    globalThis.fetch = mockFetch;
    await searchEntries();
    expect(mockFetch).toHaveBeenCalledWith(
      'http://127.0.0.1:5000/api/entries',
      expect.any(Object)
    );
  });

  it('with query → fetch URL contains ?q=github', async () => {
    const mockFetch = vi.fn().mockReturnValue(mockResponse(200, []));
    globalThis.fetch = mockFetch;
    await searchEntries('github');
    const calledUrl = mockFetch.mock.calls[0][0];
    expect(calledUrl).toContain('?q=github');
  });

  it('with both query and category → URL contains both params', async () => {
    const mockFetch = vi.fn().mockReturnValue(mockResponse(200, []));
    globalThis.fetch = mockFetch;
    await searchEntries('github', 'work');
    const calledUrl = mockFetch.mock.calls[0][0];
    expect(calledUrl).toContain('q=github');
    expect(calledUrl).toContain('category=work');
  });

  it('200 with entries → { entries: [entry1, entry2] }', async () => {
    const entries = [{ id: 1, title: 'entry1' }, { id: 2, title: 'entry2' }];
    globalThis.fetch = vi.fn().mockReturnValue(mockResponse(200, entries));
    const result = await searchEntries();
    expect(result).toEqual({ entries });
  });

  it('401 → { locked: true }, setVaultLocked(true) called', async () => {
    globalThis.fetch = vi.fn().mockReturnValue(mockResponse(401, {}));
    const result = await searchEntries();
    expect(result).toEqual({ locked: true });
    expect(chromeMock.storage.session.set).toHaveBeenCalledWith({ vaultLocked: true });
  });

  it('fetch throws → { error: "network error" }', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const result = await searchEntries();
    expect(result).toEqual({ error: 'network error' });
  });
});

describe('getEntry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('200 → returns parsed JSON', async () => {
    const entry = { id: 5, title: 'GitHub', username: 'user' };
    globalThis.fetch = vi.fn().mockReturnValue(mockResponse(200, entry));
    const result = await getEntry(5);
    expect(result).toEqual(entry);
  });

  it('404 (res.ok=false) → null', async () => {
    globalThis.fetch = vi.fn().mockReturnValue(mockResponse(404, {}));
    const result = await getEntry(999);
    expect(result).toBeNull();
  });

  it('fetch throws → null', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('network'));
    const result = await getEntry(1);
    expect(result).toBeNull();
  });
});

describe('saveEntry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.keys(chromeMock.storage.session._data).forEach(k => {
      delete chromeMock.storage.session._data[k];
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('201 with { id: 42 } → { ok: true, id: 42 }', async () => {
    globalThis.fetch = vi.fn().mockReturnValue(mockResponse(201, { id: 42 }));
    const result = await saveEntry({ title: 'New', username: 'u', password: 'p' });
    expect(result).toEqual({ ok: true, id: 42 });
  });

  it('401 → { ok: false, error: "vault locked" }, setVaultLocked(true) called', async () => {
    globalThis.fetch = vi.fn().mockReturnValue(mockResponse(401, {}));
    const result = await saveEntry({ title: 'New' });
    expect(result).toEqual({ ok: false, error: 'vault locked' });
    expect(chromeMock.storage.session.set).toHaveBeenCalledWith({ vaultLocked: true });
  });

  it('400 with { error: "title is required" } → { ok: false, error: "title is required" }', async () => {
    globalThis.fetch = vi.fn().mockReturnValue(mockResponse(400, { error: 'title is required' }));
    const result = await saveEntry({});
    expect(result).toEqual({ ok: false, error: 'title is required' });
  });

  it('fetch throws → { ok: false, error: "network error" }', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('gone'));
    const result = await saveEntry({ title: 'x' });
    expect(result).toEqual({ ok: false, error: 'network error' });
  });
});

describe('updateEntry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('res.ok=true → { ok: true }', async () => {
    globalThis.fetch = vi.fn().mockReturnValue(mockResponse(200, {}));
    const result = await updateEntry(1, { title: 'updated' });
    expect(result).toEqual({ ok: true });
  });

  it('res.ok=false → { ok: false }', async () => {
    globalThis.fetch = vi.fn().mockReturnValue(mockResponse(500, {}));
    const result = await updateEntry(1, { title: 'updated' });
    expect(result).toEqual({ ok: false });
  });

  it('fetch throws → { ok: false }', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('network'));
    const result = await updateEntry(1, {});
    expect(result).toEqual({ ok: false });
  });
});

describe('deleteEntry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('res.ok=true → { ok: true }', async () => {
    globalThis.fetch = vi.fn().mockReturnValue(mockResponse(200, {}));
    const result = await deleteEntry(1);
    expect(result).toEqual({ ok: true });
  });

  it('fetch throws → { ok: false }', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('network'));
    const result = await deleteEntry(1);
    expect(result).toEqual({ ok: false });
  });
});

describe('handleMessage — GET_STATUS', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.keys(chromeMock.storage.session._data).forEach(k => {
      delete chromeMock.storage.session._data[k];
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('locked=true in storage → returns { locked: true } WITHOUT calling fetch', async () => {
    const mockFetch = vi.fn();
    globalThis.fetch = mockFetch;
    // Ensure vault is locked (default)
    await setVaultLocked(true);
    const result = await handleMessage({ type: 'GET_STATUS' });
    expect(result).toEqual({ locked: true });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('locked=false, probe returns 200 → { locked: false }', async () => {
    await setVaultLocked(false);
    globalThis.fetch = vi.fn().mockReturnValue(mockResponse(200, []));
    const result = await handleMessage({ type: 'GET_STATUS' });
    expect(result).toEqual({ locked: false });
  });

  it('locked=false, probe returns 401 → sets locked + { locked: true }', async () => {
    await setVaultLocked(false);
    globalThis.fetch = vi.fn().mockReturnValue(mockResponse(401, {}));
    const result = await handleMessage({ type: 'GET_STATUS' });
    expect(result).toEqual({ locked: true });
    expect(chromeMock.storage.session.set).toHaveBeenCalledWith({ vaultLocked: true });
  });

  it('locked=false, probe fetch throws → { locked: true, unreachable: true }', async () => {
    await setVaultLocked(false);
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const result = await handleMessage({ type: 'GET_STATUS' });
    expect(result).toEqual({ locked: true, unreachable: true });
  });
});

describe('handleMessage — other types', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.keys(chromeMock.storage.session._data).forEach(k => {
      delete chromeMock.storage.session._data[k];
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('UNLOCK with masterPassword → delegates to unlockVault, returns result', async () => {
    globalThis.fetch = vi.fn().mockReturnValue(mockResponse(200, {}));
    const result = await handleMessage({ type: 'UNLOCK', masterPassword: 'secret' });
    expect(result).toEqual({ ok: true });
  });

  it('LOCK → delegates to lockVault', async () => {
    globalThis.fetch = vi.fn().mockReturnValue(mockResponse(200, {}));
    const result = await handleMessage({ type: 'LOCK' });
    expect(result).toEqual({ ok: true });
    expect(chromeMock.storage.session.set).toHaveBeenCalledWith({ vaultLocked: true });
  });

  it('SEARCH_ENTRIES with { query, category } → delegates to searchEntries', async () => {
    const entries = [{ id: 1 }];
    globalThis.fetch = vi.fn().mockReturnValue(mockResponse(200, entries));
    const result = await handleMessage({ type: 'SEARCH_ENTRIES', query: 'git', category: 'work' });
    expect(result).toEqual({ entries });
    const calledUrl = globalThis.fetch.mock.calls[0][0];
    expect(calledUrl).toContain('q=git');
    expect(calledUrl).toContain('category=work');
  });

  it('GET_ENTRY with { id } → delegates to getEntry', async () => {
    const entry = { id: 3, title: 'test' };
    globalThis.fetch = vi.fn().mockReturnValue(mockResponse(200, entry));
    const result = await handleMessage({ type: 'GET_ENTRY', id: 3 });
    expect(result).toEqual(entry);
  });

  it('SAVE_ENTRY with { data } → delegates to saveEntry', async () => {
    globalThis.fetch = vi.fn().mockReturnValue(mockResponse(201, { id: 10 }));
    const result = await handleMessage({ type: 'SAVE_ENTRY', data: { title: 'new' } });
    expect(result).toEqual({ ok: true, id: 10 });
  });

  it('UPDATE_ENTRY with { id, data } → delegates to updateEntry', async () => {
    globalThis.fetch = vi.fn().mockReturnValue(mockResponse(200, {}));
    const result = await handleMessage({ type: 'UPDATE_ENTRY', id: 5, data: { title: 'updated' } });
    expect(result).toEqual({ ok: true });
  });

  it('DELETE_ENTRY with { id } → delegates to deleteEntry', async () => {
    globalThis.fetch = vi.fn().mockReturnValue(mockResponse(200, {}));
    const result = await handleMessage({ type: 'DELETE_ENTRY', id: 7 });
    expect(result).toEqual({ ok: true });
  });

  it('Unknown type → { ok: false, error: "unknown message type" }', async () => {
    const result = await handleMessage({ type: 'NONEXISTENT' });
    expect(result).toEqual({ ok: false, error: 'unknown message type' });
  });
});

describe('handleMessage — TRIGGER_AUTOFILL', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.keys(chromeMock.storage.session._data).forEach(k => {
      delete chromeMock.storage.session._data[k];
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('entry not found (getEntry returns null) → { ok: false, error: "entry not found" }', async () => {
    globalThis.fetch = vi.fn().mockReturnValue(mockResponse(404, {}));
    const result = await handleMessage({ type: 'TRIGGER_AUTOFILL', entryId: 999 });
    expect(result).toEqual({ ok: false, error: 'entry not found' });
  });

  it('entry found, no active tab → { ok: false, error: "no active tab" }', async () => {
    const entry = { id: 1, username: 'user', password: 'pass' };
    globalThis.fetch = vi.fn().mockReturnValue(mockResponse(200, entry));
    chromeMock.tabs.query = vi.fn().mockResolvedValue([]);
    const result = await handleMessage({ type: 'TRIGGER_AUTOFILL', entryId: 1 });
    expect(result).toEqual({ ok: false, error: 'no active tab' });
  });

  it('entry found, tab exists, sendMessage succeeds → chrome.tabs.sendMessage called, returns { ok: true }', async () => {
    const entry = { id: 1, username: 'myuser', password: 'mypass' };
    globalThis.fetch = vi.fn().mockReturnValue(mockResponse(200, entry));
    chromeMock.tabs.query = vi.fn().mockResolvedValue([{ id: 42 }]);
    chromeMock.tabs.sendMessage = vi.fn().mockResolvedValue({});
    const result = await handleMessage({ type: 'TRIGGER_AUTOFILL', entryId: 1 });
    expect(chromeMock.tabs.sendMessage).toHaveBeenCalledWith(42, {
      type: 'FILL_CREDENTIALS',
      data: { username: 'myuser', password: 'mypass' },
    });
    expect(result).toEqual({ ok: true });
  });

  it('entry found, tab exists, sendMessage throws → { ok: false, error: "cannot autofill this page" }', async () => {
    const entry = { id: 1, username: 'u', password: 'p' };
    globalThis.fetch = vi.fn().mockReturnValue(mockResponse(200, entry));
    chromeMock.tabs.query = vi.fn().mockResolvedValue([{ id: 42 }]);
    chromeMock.tabs.sendMessage = vi.fn().mockRejectedValue(new Error('Could not establish connection'));
    const result = await handleMessage({ type: 'TRIGGER_AUTOFILL', entryId: 1 });
    expect(result).toEqual({ ok: false, error: 'cannot autofill this page' });
  });
});
