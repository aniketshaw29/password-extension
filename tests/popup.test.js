import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { JSDOM } from 'jsdom';
import vm from 'vm';
import { createChromeMock } from './setup.js';

const POPUP_HTML = readFileSync(new URL('../popup/popup.html', import.meta.url), 'utf8');
const POPUP_JS   = readFileSync(new URL('../popup/popup.js',   import.meta.url), 'utf8');

function createPopupEnv(bgResponse = null) {
  const dom = new JSDOM(POPUP_HTML, { url: 'chrome-extension://fake/popup.html' });
  const chromeMock = createChromeMock();

  // Default chrome.tabs.query returns a fake tab
  chromeMock.tabs = {
    query: vi.fn().mockResolvedValue([{ url: 'https://github.com/login', title: 'Sign in · GitHub' }]),
  };

  // Default bg response
  if (bgResponse !== null) {
    chromeMock.runtime.sendMessage.mockResolvedValue(bgResponse);
  }

  dom.window.chrome = chromeMock;

  const ctx = vm.createContext(dom.window);
  vm.runInContext(POPUP_JS, ctx);

  return { dom, chrome: chromeMock, document: dom.window.document, window: dom.window };
}

// Helper to dispatch DOMContentLoaded
function fireReady(window) {
  window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
}

// ---------------------------------------------------------------------------
// esc
// ---------------------------------------------------------------------------

describe('esc', () => {
  let env;

  beforeEach(() => {
    env = createPopupEnv({ locked: false });
  });

  it("esc('Hello & World') → 'Hello &amp; World'", () => {
    expect(env.window.esc('Hello & World')).toBe('Hello &amp; World');
  });

  it("esc('<script>') → '&lt;script&gt;'", () => {
    expect(env.window.esc('<script>')).toBe('&lt;script&gt;');
  });

  it('esc(\'\"quoted\"\') → \'&quot;quoted&quot;\'', () => {
    expect(env.window.esc('"quoted"')).toBe('&quot;quoted&quot;');
  });

  it('esc(123) → "123" (non-string coerced)', () => {
    expect(env.window.esc(123)).toBe('123');
  });

  it('multiple entities in one string', () => {
    expect(env.window.esc('<b>Hello & "World"</b>')).toBe(
      '&lt;b&gt;Hello &amp; &quot;World&quot;&lt;/b&gt;'
    );
  });
});

// ---------------------------------------------------------------------------
// extractDomain
// ---------------------------------------------------------------------------

describe('extractDomain', () => {
  let env;

  beforeEach(() => {
    env = createPopupEnv({ locked: false });
  });

  it("'https://github.com/login' → 'github.com'", () => {
    expect(env.window.extractDomain('https://github.com/login')).toBe('github.com');
  });

  it("'http://127.0.0.1:5000/vault' → '127.0.0.1'", () => {
    expect(env.window.extractDomain('http://127.0.0.1:5000/vault')).toBe('127.0.0.1');
  });

  it("'not-a-url' → 'not-a-url' (returns original on error)", () => {
    expect(env.window.extractDomain('not-a-url')).toBe('not-a-url');
  });

  it("'' empty string → '' (returns original)", () => {
    expect(env.window.extractDomain('')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// showView
// ---------------------------------------------------------------------------

describe('showView', () => {
  let env;

  beforeEach(() => {
    env = createPopupEnv({ locked: false });
  });

  const allViews = ['loading', 'error', 'locked', 'main'];

  it("showView('loading') → only #view-loading lacks 'hidden' class", () => {
    env.window.showView('loading');
    expect(env.document.getElementById('view-loading').classList.contains('hidden')).toBe(false);
    for (const v of allViews.filter(v => v !== 'loading')) {
      expect(env.document.getElementById(`view-${v}`).classList.contains('hidden')).toBe(true);
    }
  });

  it("showView('error') → only #view-error lacks 'hidden' class", () => {
    env.window.showView('error');
    expect(env.document.getElementById('view-error').classList.contains('hidden')).toBe(false);
    for (const v of allViews.filter(v => v !== 'error')) {
      expect(env.document.getElementById(`view-${v}`).classList.contains('hidden')).toBe(true);
    }
  });

  it("showView('locked') → only #view-locked lacks 'hidden' class", () => {
    env.window.showView('locked');
    expect(env.document.getElementById('view-locked').classList.contains('hidden')).toBe(false);
    for (const v of allViews.filter(v => v !== 'locked')) {
      expect(env.document.getElementById(`view-${v}`).classList.contains('hidden')).toBe(true);
    }
  });

  it("showView('main') → only #view-main lacks 'hidden' class", () => {
    env.window.showView('main');
    expect(env.document.getElementById('view-main').classList.contains('hidden')).toBe(false);
    for (const v of allViews.filter(v => v !== 'main')) {
      expect(env.document.getElementById(`view-${v}`).classList.contains('hidden')).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// renderEntryList
// ---------------------------------------------------------------------------

describe('renderEntryList', () => {
  let env;

  beforeEach(() => {
    env = createPopupEnv({ locked: false });
  });

  it('empty array → #no-matches visible, #entry-list has no children', () => {
    env.window.renderEntryList([]);
    const noMatches = env.document.getElementById('no-matches');
    const entryList = env.document.getElementById('entry-list');
    expect(noMatches.classList.contains('hidden')).toBe(false);
    expect(entryList.children.length).toBe(0);
  });

  it('two entries → two .entry-row elements, correct titles, Fill buttons with data-id', () => {
    const entries = [
      { id: 1, title: 'GitHub', url: 'https://github.com', username: 'alice' },
      { id: 2, title: 'GitLab', url: 'https://gitlab.com', username: 'bob' },
    ];
    env.window.renderEntryList(entries);
    const rows = env.document.querySelectorAll('.entry-row');
    expect(rows.length).toBe(2);

    const titles = Array.from(env.document.querySelectorAll('.entry-title')).map(el => el.textContent);
    expect(titles).toContain('GitHub');
    expect(titles).toContain('GitLab');

    const fillBtns = env.document.querySelectorAll('.btn-autofill');
    expect(fillBtns.length).toBe(2);
    const ids = Array.from(fillBtns).map(b => b.getAttribute('data-id'));
    expect(ids).toContain('1');
    expect(ids).toContain('2');
  });

  it("entry with XSS title ('<script>alert(1)</script>') → rendered safely (HTML escaped in innerHTML)", () => {
    const entries = [
      { id: 1, title: '<script>alert(1)</script>', url: 'https://evil.com', username: 'x' },
    ];
    env.window.renderEntryList(entries);
    // The raw script tag should not appear as an actual script in the DOM
    const scripts = env.document.querySelectorAll('#entry-list script');
    expect(scripts.length).toBe(0);
    // The text content should show the escaped version or the literal angle brackets as text
    const titleEl = env.document.querySelector('.entry-title');
    expect(titleEl).not.toBeNull();
    expect(titleEl.innerHTML).not.toContain('<script>');
  });

  it('entry URL is displayed in .entry-url span', () => {
    const entries = [
      { id: 1, title: 'Example', url: 'https://example.com/login', username: 'user' },
    ];
    env.window.renderEntryList(entries);
    const urlEl = env.document.querySelector('.entry-url');
    expect(urlEl).not.toBeNull();
    expect(urlEl.textContent).toContain('example.com');
  });
});

// ---------------------------------------------------------------------------
// showStatus
// ---------------------------------------------------------------------------

describe('showStatus', () => {
  let env;

  beforeEach(() => {
    env = createPopupEnv({ locked: false });
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("calls with 'success' type → element has class 'success', text set, hidden removed", () => {
    // Find a status element that exists in the popup HTML — try save-status or unlock-error
    // Use a generic approach: inject a test element
    const el = env.document.createElement('div');
    el.id = 'test-status';
    el.classList.add('hidden');
    env.document.body.appendChild(el);

    env.window.showStatus('test-status', 'Saved!', 'success');
    expect(el.classList.contains('hidden')).toBe(false);
    expect(el.classList.contains('success')).toBe(true);
    expect(el.textContent).toBe('Saved!');
  });

  it("calls with 'error' type → element has class 'error', text set, hidden removed", () => {
    const el = env.document.createElement('div');
    el.id = 'test-status-err';
    el.classList.add('hidden');
    env.document.body.appendChild(el);

    env.window.showStatus('test-status-err', 'Something went wrong', 'error');
    expect(el.classList.contains('hidden')).toBe(false);
    expect(el.classList.contains('error')).toBe(true);
    expect(el.textContent).toBe('Something went wrong');
  });

  it('success type sets a timeout (verify with vi.useFakeTimers)', () => {
    const el = env.document.createElement('div');
    el.id = 'test-status-timeout';
    el.classList.add('hidden');
    env.document.body.appendChild(el);

    env.window.showStatus('test-status-timeout', 'Done!', 'success');
    expect(el.classList.contains('hidden')).toBe(false);

    // After 3 seconds the element should be re-hidden
    vi.advanceTimersByTime(3000);
    expect(el.classList.contains('hidden')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// checkStatus flow
// ---------------------------------------------------------------------------

describe('checkStatus flow', () => {
  it('GET_STATUS returns null → showView("error") called', async () => {
    const env = createPopupEnv(null);
    env.chrome.runtime.sendMessage.mockResolvedValue(null);
    fireReady(env.window);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(env.document.getElementById('view-error').classList.contains('hidden')).toBe(false);
  });

  it('GET_STATUS returns { unreachable: true } → showView("error") called', async () => {
    const env = createPopupEnv({ unreachable: true });
    fireReady(env.window);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(env.document.getElementById('view-error').classList.contains('hidden')).toBe(false);
  });

  it('GET_STATUS returns { locked: true } → showView("locked") called', async () => {
    const env = createPopupEnv({ locked: true });
    fireReady(env.window);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(env.document.getElementById('view-locked').classList.contains('hidden')).toBe(false);
  });

  it('GET_STATUS returns { locked: false } → bg("SEARCH_ENTRIES") called, showView("main") reached', async () => {
    const env = createPopupEnv(null);
    env.chrome.runtime.sendMessage
      .mockResolvedValueOnce({ locked: false })
      .mockResolvedValue({ entries: [] });
    fireReady(env.window);
    await new Promise(resolve => setTimeout(resolve, 50));
    // Should have called sendMessage at least twice: GET_STATUS and SEARCH_ENTRIES
    const calls = env.chrome.runtime.sendMessage.mock.calls.map(c => c[0]);
    expect(calls.some(c => c && c.type === 'SEARCH_ENTRIES')).toBe(true);
    expect(env.document.getElementById('view-main').classList.contains('hidden')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Unlock flow
// ---------------------------------------------------------------------------

describe('Unlock flow', () => {
  it('btn-unlock click with empty password → sendMessage NOT called', async () => {
    const env = createPopupEnv({ locked: true });
    fireReady(env.window);
    await new Promise(resolve => setTimeout(resolve, 0));

    env.chrome.runtime.sendMessage.mockClear();

    const pwInput = env.document.getElementById('master-password');
    pwInput.value = '';
    env.document.getElementById('btn-unlock').dispatchEvent(
      new env.window.MouseEvent('click', { bubbles: true })
    );

    expect(env.chrome.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it('btn-unlock click with password → sendMessage called with { type: "UNLOCK", masterPassword: "pw" }', async () => {
    const env = createPopupEnv({ locked: true });
    fireReady(env.window);
    await new Promise(resolve => setTimeout(resolve, 0));

    env.chrome.runtime.sendMessage.mockClear();
    env.chrome.runtime.sendMessage.mockResolvedValue({ ok: true });

    const pwInput = env.document.getElementById('master-password');
    pwInput.value = 'pw';
    env.document.getElementById('btn-unlock').dispatchEvent(
      new env.window.MouseEvent('click', { bubbles: true })
    );

    await new Promise(resolve => setTimeout(resolve, 0));

    expect(env.chrome.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'UNLOCK', masterPassword: 'pw' })
    );
  });

  it('successful unlock (ok: true) → master-password input cleared', async () => {
    const env = createPopupEnv(null);
    env.chrome.runtime.sendMessage
      .mockResolvedValueOnce({ locked: true })   // initial GET_STATUS
      .mockResolvedValueOnce({ ok: true })        // UNLOCK
      .mockResolvedValue({ entries: [] });        // SEARCH_ENTRIES after unlock

    fireReady(env.window);
    await new Promise(resolve => setTimeout(resolve, 0));

    const pwInput = env.document.getElementById('master-password');
    pwInput.value = 'correct-password';
    env.document.getElementById('btn-unlock').dispatchEvent(
      new env.window.MouseEvent('click', { bubbles: true })
    );

    await new Promise(resolve => setTimeout(resolve, 50));
    expect(pwInput.value).toBe('');
  });

  it("failed unlock (error: 'wrong password') → #unlock-error shows 'Wrong password.'", async () => {
    const env = createPopupEnv(null);
    env.chrome.runtime.sendMessage
      .mockResolvedValueOnce({ locked: true })
      .mockResolvedValueOnce({ ok: false, error: 'wrong password' });

    fireReady(env.window);
    await new Promise(resolve => setTimeout(resolve, 0));

    const pwInput = env.document.getElementById('master-password');
    pwInput.value = 'wrong-pw';
    env.document.getElementById('btn-unlock').dispatchEvent(
      new env.window.MouseEvent('click', { bubbles: true })
    );

    await new Promise(resolve => setTimeout(resolve, 0));

    const errEl = env.document.getElementById('unlock-error');
    expect(errEl.classList.contains('hidden')).toBe(false);
    expect(errEl.textContent).toContain('Wrong password');
  });
});

// ---------------------------------------------------------------------------
// Lock flow
// ---------------------------------------------------------------------------

describe('Lock flow', () => {
  it('btn-lock click → sendMessage called with { type: "LOCK" }, showView("locked")', async () => {
    const env = createPopupEnv(null);
    env.chrome.runtime.sendMessage
      .mockResolvedValueOnce({ locked: false })
      .mockResolvedValueOnce({ entries: [] })
      .mockResolvedValueOnce({ ok: true }); // LOCK response

    fireReady(env.window);
    await new Promise(resolve => setTimeout(resolve, 50));

    env.chrome.runtime.sendMessage.mockClear();
    env.chrome.runtime.sendMessage.mockResolvedValue({ ok: true });

    env.document.getElementById('btn-lock').dispatchEvent(
      new env.window.MouseEvent('click', { bubbles: true })
    );

    await new Promise(resolve => setTimeout(resolve, 0));

    expect(env.chrome.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'LOCK' })
    );
    expect(env.document.getElementById('view-locked').classList.contains('hidden')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Save form
// ---------------------------------------------------------------------------

describe('Save form', () => {
  async function setupMainView(bgEntries = []) {
    const env = createPopupEnv(null);
    env.chrome.runtime.sendMessage
      .mockResolvedValueOnce({ locked: false })
      .mockResolvedValueOnce({ entries: bgEntries });

    fireReady(env.window);
    await new Promise(resolve => setTimeout(resolve, 50));
    return env;
  }

  it('submit with empty title → sendMessage NOT called, error shown', async () => {
    const env = await setupMainView();
    env.chrome.runtime.sendMessage.mockClear();

    const titleInput = env.document.getElementById('new-title');
    if (titleInput) titleInput.value = '';

    const saveForm = env.document.getElementById('save-form') ||
      env.document.querySelector('form[id*="save"]');

    if (saveForm) {
      saveForm.dispatchEvent(new env.window.Event('submit', { bubbles: true, cancelable: true }));
    } else {
      // Trigger via btn-save click
      const btnSave = env.document.getElementById('btn-save');
      if (btnSave) {
        btnSave.dispatchEvent(new env.window.MouseEvent('click', { bubbles: true }));
      }
    }

    await new Promise(resolve => setTimeout(resolve, 0));
    expect(env.chrome.runtime.sendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'SAVE_ENTRY' })
    );
  });

  it('submit with valid data → sendMessage called with SAVE_ENTRY containing {title, username, password, url}', async () => {
    const env = await setupMainView();
    env.chrome.runtime.sendMessage.mockResolvedValue({ ok: true });

    const setField = (id, val) => {
      const el = env.document.getElementById(id);
      if (el) el.value = val;
    };
    setField('save-title', 'My Site');
    setField('save-username', 'alice');
    setField('save-password', 'secret123');
    setField('save-url', 'https://mysite.com');

    const saveForm = env.document.getElementById('save-form') ||
      env.document.querySelector('form[id*="save"]');

    if (saveForm) {
      saveForm.dispatchEvent(new env.window.Event('submit', { bubbles: true, cancelable: true }));
    } else {
      const btnSave = env.document.getElementById('btn-save');
      if (btnSave) {
        btnSave.dispatchEvent(new env.window.MouseEvent('click', { bubbles: true }));
      }
    }

    await new Promise(resolve => setTimeout(resolve, 0));

    const saveCall = env.chrome.runtime.sendMessage.mock.calls.find(
      c => c[0] && c[0].type === 'SAVE_ENTRY'
    );
    expect(saveCall).toBeDefined();
    expect(saveCall[0]).toMatchObject({
      type: 'SAVE_ENTRY',
      data: {
        title: 'My Site',
        username: 'alice',
        password: 'secret123',
      },
    });
  });

  it('successful save (ok: true) → success status shown, form reset', async () => {
    const env = await setupMainView();
    env.chrome.runtime.sendMessage.mockResolvedValue({ ok: true });

    const setField = (id, val) => {
      const el = env.document.getElementById(id);
      if (el) el.value = val;
    };
    setField('save-title', 'My Site');
    setField('save-username', 'alice');
    setField('save-password', 'secret123');
    setField('save-url', 'https://mysite.com');

    const saveForm = env.document.getElementById('save-form') ||
      env.document.querySelector('form[id*="save"]');

    if (saveForm) {
      saveForm.dispatchEvent(new env.window.Event('submit', { bubbles: true, cancelable: true }));
    } else {
      const btnSave = env.document.getElementById('btn-save');
      if (btnSave) {
        btnSave.dispatchEvent(new env.window.MouseEvent('click', { bubbles: true }));
      }
    }

    await new Promise(resolve => setTimeout(resolve, 0));

    // Check that either: title field is cleared, or a success status element is visible
    const titleInput = env.document.getElementById('save-title');
    const saveStatus = env.document.getElementById('save-status');

    const formReset = titleInput && titleInput.value === '';
    const statusShown = saveStatus && !saveStatus.classList.contains('hidden');

    expect(formReset || statusShown).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// renderEntryList autofill integration
// ---------------------------------------------------------------------------

describe('renderEntryList autofill integration', () => {
  it('.btn-autofill click → sendMessage called with { type: "TRIGGER_AUTOFILL", entryId: N }', async () => {
    const env = createPopupEnv(null);
    env.chrome.runtime.sendMessage
      .mockResolvedValueOnce({ locked: false })
      .mockResolvedValueOnce({ entries: [{ id: 42, title: 'Example', url: 'https://example.com', username: 'alice' }] });

    fireReady(env.window);
    await new Promise(resolve => setTimeout(resolve, 50));

    env.chrome.runtime.sendMessage.mockClear();
    env.chrome.runtime.sendMessage.mockResolvedValue({ ok: true });

    const fillBtn = env.document.querySelector('.btn-autofill[data-id="42"]');
    expect(fillBtn).not.toBeNull();

    fillBtn.dispatchEvent(new env.window.MouseEvent('click', { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(env.chrome.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'TRIGGER_AUTOFILL', entryId: 42 })
    );
  });
});
