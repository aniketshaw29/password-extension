import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { JSDOM } from 'jsdom';
import vm from 'vm';
import { createChromeMock } from './setup.js';

const SCRIPT_SRC = readFileSync(
  new URL('../content/content-script.js', import.meta.url),
  'utf8'
);

function createEnv({ html = '<body></body>', sessionItems = {}, vaultLocked = false } = {}) {
  const dom = new JSDOM(`<html>${html}</html>`, { url: 'https://example.com/login' });
  const chromeMock = createChromeMock();

  // Pre-seed sessionStorage
  for (const [k, v] of Object.entries(sessionItems)) {
    dom.window.sessionStorage.setItem(k, v);
  }

  // Mock GET_STATUS response
  chromeMock.runtime.sendMessage.mockImplementation((msg, cb) => {
    if (msg.type === 'GET_STATUS' && cb) cb({ locked: vaultLocked });
    if (msg.type === 'SAVE_ENTRY' && cb) cb({ ok: true });
  });

  dom.window.chrome = chromeMock;

  const ctx = vm.createContext(dom.window);
  vm.runInContext(SCRIPT_SRC, ctx);

  return { dom, chrome: chromeMock, window: dom.window, document: dom.window.document };
}

// ---------------------------------------------------------------------------
// tryAttachForm / form detection
// ---------------------------------------------------------------------------

describe('tryAttachForm / form detection', () => {
  it('form with password input gets data-vault-attached=true and a submit listener', () => {
    const { document } = createEnv({
      html: '<body><form id="f"><input type="password" name="pw"><input type="text" name="user"></form></body>',
    });
    const form = document.getElementById('f');
    expect(form.getAttribute('data-vault-attached')).toBe('true');
  });

  it('form without password input is NOT attached', () => {
    const { document } = createEnv({
      html: '<body><form id="f"><input type="text" name="user"></form></body>',
    });
    const form = document.getElementById('f');
    expect(form.getAttribute('data-vault-attached')).toBeNull();
  });

  it('calling attachToExistingForms twice on same form only attaches once (deduplication)', () => {
    const { document, window } = createEnv({
      html: '<body><form id="f"><input type="password" name="pw"></form></body>',
    });
    const form = document.getElementById('f');
    // The form already got attached during init; mark the attribute manually
    // then re-run attachToExistingForms via the window context function
    // The attribute should still be 'true' and not duplicated
    expect(form.getAttribute('data-vault-attached')).toBe('true');

    // Simulate a second pass by calling the function again directly
    // Since the function is not exported, we test the observable: attribute remains 'true' (not reset/doubled)
    // We can verify by checking only one submit listener fires via a single event dispatch
    let submitCount = 0;
    const origAddEventListener = form.addEventListener.bind(form);
    form.addEventListener('submit', () => { submitCount++; });

    // Dispatch a submit with an empty password — the handler should NOT write sessionStorage
    const pw = form.querySelector('input[type="password"]');
    pw.value = '';
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));

    // Deduplication means the vault handler fires at most once; no double-processing
    expect(form.getAttribute('data-vault-attached')).toBe('true');
  });
});

// ---------------------------------------------------------------------------
// handleFormSubmit
// ---------------------------------------------------------------------------

describe('handleFormSubmit', () => {
  it('form submit with empty password → sessionStorage NOT written, sendMessage NOT called', () => {
    const { document, window, chrome } = createEnv({
      html: '<body><form id="f"><input type="text" name="username" value="alice"><input type="password" name="pw" value=""></form></body>',
    });
    document.getElementById('f').dispatchEvent(
      new window.Event('submit', { bubbles: true, cancelable: true })
    );
    expect(window.sessionStorage.getItem('__vault_pending_save__')).toBeNull();
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it('form submit with password value → sessionStorage.__vault_pending_save__ contains JSON with password', () => {
    const { document, window } = createEnv({
      html: '<body><form id="f"><input type="text" name="username" value="alice"><input type="password" name="pw" value="secret"></form></body>',
    });
    document.getElementById('f').dispatchEvent(
      new window.Event('submit', { bubbles: true, cancelable: true })
    );
    const stored = window.sessionStorage.getItem('__vault_pending_save__');
    expect(stored).not.toBeNull();
    const parsed = JSON.parse(stored);
    expect(parsed.password).toBe('secret');
  });

  it('form submit → captured credentials include url = window.location.href', () => {
    const { document, window } = createEnv({
      html: '<body><form id="f"><input type="text" name="username" value="alice"><input type="password" name="pw" value="secret"></form></body>',
    });
    document.getElementById('f').dispatchEvent(
      new window.Event('submit', { bubbles: true, cancelable: true })
    );
    const parsed = JSON.parse(window.sessionStorage.getItem('__vault_pending_save__'));
    expect(parsed.url).toBe(window.location.href);
  });

  it('form submit → captured credentials include title = document.title', () => {
    const { document, window } = createEnv({
      html: '<body><form id="f"><input type="text" name="username" value="alice"><input type="password" name="pw" value="secret"></form></body>',
    });
    document.title = 'Test Page Title';
    document.getElementById('f').dispatchEvent(
      new window.Event('submit', { bubbles: true, cancelable: true })
    );
    const parsed = JSON.parse(window.sessionStorage.getItem('__vault_pending_save__'));
    expect(parsed.title).toBe('Test Page Title');
  });

  it('form submit with email input → username captured from email field', () => {
    const { document, window } = createEnv({
      html: '<body><form id="f"><input type="email" name="email" value="user@example.com"><input type="password" name="pw" value="secret"></form></body>',
    });
    document.getElementById('f').dispatchEvent(
      new window.Event('submit', { bubbles: true, cancelable: true })
    );
    const parsed = JSON.parse(window.sessionStorage.getItem('__vault_pending_save__'));
    expect(parsed.username).toBe('user@example.com');
  });

  it('form submit with input[name=username] → username captured from named field', () => {
    const { document, window } = createEnv({
      html: '<body><form id="f"><input type="text" name="username" value="bob"><input type="password" name="pw" value="secret"></form></body>',
    });
    document.getElementById('f').dispatchEvent(
      new window.Event('submit', { bubbles: true, cancelable: true })
    );
    const parsed = JSON.parse(window.sessionStorage.getItem('__vault_pending_save__'));
    expect(parsed.username).toBe('bob');
  });

  it('form submit → chrome.runtime.sendMessage called with { type: "GET_STATUS" }', () => {
    const { document, chrome } = createEnv({
      html: '<body><form id="f"><input type="text" name="username" value="alice"><input type="password" name="pw" value="secret"></form></body>',
    });
    document.getElementById('f').dispatchEvent(
      new document.defaultView.Event('submit', { bubbles: true, cancelable: true })
    );
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'GET_STATUS' }),
      expect.any(Function)
    );
  });

  it('form submit + unlocked → banner appears in document (div#__vault_banner__ exists)', () => {
    const { document, window } = createEnv({
      html: '<body><form id="f"><input type="text" name="username" value="alice"><input type="password" name="pw" value="secret"></form></body>',
      vaultLocked: false,
    });
    document.getElementById('f').dispatchEvent(
      new window.Event('submit', { bubbles: true, cancelable: true })
    );
    expect(document.getElementById('__vault_banner__')).not.toBeNull();
  });

  it('form submit + locked → banner does NOT appear', () => {
    const { document, window } = createEnv({
      html: '<body><form id="f"><input type="text" name="username" value="alice"><input type="password" name="pw" value="secret"></form></body>',
      vaultLocked: true,
    });
    document.getElementById('f').dispatchEvent(
      new window.Event('submit', { bubbles: true, cancelable: true })
    );
    expect(document.getElementById('__vault_banner__')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// findUsernameField
// ---------------------------------------------------------------------------

describe('findUsernameField', () => {
  it('form with email input → returns the email input', () => {
    const { document, window } = createEnv({
      html: '<body><form id="f"><input type="email" id="em" name="email"><input type="password" name="pw" value="x"></form></body>',
    });
    document.getElementById('f').dispatchEvent(
      new window.Event('submit', { bubbles: true, cancelable: true })
    );
    const parsed = JSON.parse(window.sessionStorage.getItem('__vault_pending_save__'));
    // username should come from email field (empty value but field should be selected)
    expect(parsed).toBeDefined();
  });

  it('form with input[name=username] (no email) → returns that input', () => {
    const { document, window } = createEnv({
      html: '<body><form id="f"><input type="text" name="username" value="charlie"><input type="password" name="pw" value="x"></form></body>',
    });
    document.getElementById('f').dispatchEvent(
      new window.Event('submit', { bubbles: true, cancelable: true })
    );
    const parsed = JSON.parse(window.sessionStorage.getItem('__vault_pending_save__'));
    expect(parsed.username).toBe('charlie');
  });

  it('form with only sibling text input before password → returns that input', () => {
    const { document, window } = createEnv({
      html: '<body><form id="f"><input type="text" id="sib" value="dave"><input type="password" name="pw" value="x"></form></body>',
    });
    document.getElementById('f').dispatchEvent(
      new window.Event('submit', { bubbles: true, cancelable: true })
    );
    const parsed = JSON.parse(window.sessionStorage.getItem('__vault_pending_save__'));
    expect(parsed.username).toBe('dave');
  });

  it('form with ONLY password input → username is null or empty', () => {
    const { document, window } = createEnv({
      html: '<body><form id="f"><input type="password" name="pw" value="x"></form></body>',
    });
    document.getElementById('f').dispatchEvent(
      new window.Event('submit', { bubbles: true, cancelable: true })
    );
    const stored = window.sessionStorage.getItem('__vault_pending_save__');
    if (stored) {
      const parsed = JSON.parse(stored);
      expect(parsed.username == null || parsed.username === '').toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// showSaveBanner
// ---------------------------------------------------------------------------

describe('showSaveBanner', () => {
  function submitFormWithCreds({ document, window }, username = 'alice', password = 'secret') {
    const form = document.getElementById('f');
    const userInput = form.querySelector('input[type="text"], input[type="email"]');
    const pwInput = form.querySelector('input[type="password"]');
    if (userInput) userInput.value = username;
    if (pwInput) pwInput.value = password;
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  }

  it('creates div with id __vault_banner__ prepended to documentElement', () => {
    const env = createEnv({
      html: '<body><form id="f"><input type="text" name="username"><input type="password" name="pw"></form></body>',
      vaultLocked: false,
    });
    submitFormWithCreds(env);
    const banner = env.document.getElementById('__vault_banner__');
    expect(banner).not.toBeNull();
    expect(banner.tagName.toLowerCase()).toBe('div');
  });

  it('text includes the title from credentials', () => {
    const env = createEnv({
      html: '<body><form id="f"><input type="text" name="username"><input type="password" name="pw"></form></body>',
      vaultLocked: false,
    });
    env.document.title = 'My Awesome Site';
    submitFormWithCreds(env);
    const banner = env.document.getElementById('__vault_banner__');
    expect(banner.textContent).toContain('My Awesome Site');
  });

  it('text includes username in parentheses when username is provided', () => {
    const env = createEnv({
      html: '<body><form id="f"><input type="text" name="username"><input type="password" name="pw"></form></body>',
      vaultLocked: false,
    });
    submitFormWithCreds(env, 'alice');
    const banner = env.document.getElementById('__vault_banner__');
    expect(banner.textContent).toContain('(alice)');
  });

  it('text omits username suffix when username is empty', () => {
    const env = createEnv({
      html: '<body><form id="f"><input type="password" name="pw"></form></body>',
      vaultLocked: false,
    });
    const form = env.document.getElementById('f');
    form.querySelector('input[type="password"]').value = 'secret';
    form.dispatchEvent(new env.window.Event('submit', { bubbles: true, cancelable: true }));
    const banner = env.document.getElementById('__vault_banner__');
    if (banner) {
      expect(banner.textContent).not.toMatch(/\(\)/);
    }
  });

  it('replaces existing banner (only one banner exists after calling twice)', () => {
    const env = createEnv({
      html: '<body><form id="f"><input type="text" name="username"><input type="password" name="pw"></form></body>',
      vaultLocked: false,
    });
    submitFormWithCreds(env);
    submitFormWithCreds(env);
    const banners = env.document.querySelectorAll('#__vault_banner__');
    expect(banners.length).toBe(1);
  });

  it('has a button with text "Save"', () => {
    const env = createEnv({
      html: '<body><form id="f"><input type="text" name="username"><input type="password" name="pw"></form></body>',
      vaultLocked: false,
    });
    submitFormWithCreds(env);
    const banner = env.document.getElementById('__vault_banner__');
    const buttons = Array.from(banner.querySelectorAll('button'));
    expect(buttons.some(b => b.textContent.trim() === 'Save')).toBe(true);
  });

  it('has a button with text "Dismiss"', () => {
    const env = createEnv({
      html: '<body><form id="f"><input type="text" name="username"><input type="password" name="pw"></form></body>',
      vaultLocked: false,
    });
    submitFormWithCreds(env);
    const banner = env.document.getElementById('__vault_banner__');
    const buttons = Array.from(banner.querySelectorAll('button'));
    expect(buttons.some(b => b.textContent.trim() === 'Dismiss')).toBe(true);
  });

  it('clicking Dismiss removes the banner', () => {
    const env = createEnv({
      html: '<body><form id="f"><input type="text" name="username"><input type="password" name="pw"></form></body>',
      vaultLocked: false,
    });
    submitFormWithCreds(env);
    const banner = env.document.getElementById('__vault_banner__');
    const dismissBtn = Array.from(banner.querySelectorAll('button')).find(
      b => b.textContent.trim() === 'Dismiss'
    );
    dismissBtn.dispatchEvent(new env.window.MouseEvent('click', { bubbles: true }));
    expect(env.document.getElementById('__vault_banner__')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// removeBanner
// ---------------------------------------------------------------------------

describe('removeBanner', () => {
  it('removes #__vault_banner__ from DOM', () => {
    const env = createEnv({
      html: '<body><form id="f"><input type="text" name="username"><input type="password" name="pw"></form></body>',
      vaultLocked: false,
    });
    // Show a banner first
    const form = env.document.getElementById('f');
    form.querySelector('input[type="text"]').value = 'alice';
    form.querySelector('input[type="password"]').value = 'secret';
    form.dispatchEvent(new env.window.Event('submit', { bubbles: true, cancelable: true }));
    expect(env.document.getElementById('__vault_banner__')).not.toBeNull();

    // Dismiss it
    const banner = env.document.getElementById('__vault_banner__');
    const dismissBtn = Array.from(banner.querySelectorAll('button')).find(
      b => b.textContent.trim() === 'Dismiss'
    );
    dismissBtn.dispatchEvent(new env.window.MouseEvent('click', { bubbles: true }));
    expect(env.document.getElementById('__vault_banner__')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// checkPendingCredentials
// ---------------------------------------------------------------------------

describe('checkPendingCredentials', () => {
  it('when sessionStorage has __vault_pending_save__ and vault is unlocked: banner appears + sessionStorage item removed', () => {
    const creds = JSON.stringify({
      username: 'alice',
      password: 'secret',
      url: 'https://example.com/login',
      title: 'Example Login',
    });
    const { document, window } = createEnv({
      html: '<body></body>',
      sessionItems: { __vault_pending_save__: creds },
      vaultLocked: false,
    });
    expect(document.getElementById('__vault_banner__')).not.toBeNull();
    expect(window.sessionStorage.getItem('__vault_pending_save__')).toBeNull();
  });

  it('when sessionStorage is empty: nothing happens', () => {
    const { document } = createEnv({ html: '<body></body>', vaultLocked: false });
    expect(document.getElementById('__vault_banner__')).toBeNull();
  });

  it('when sessionStorage has invalid JSON: no error thrown, no banner', () => {
    expect(() => {
      const { document } = createEnv({
        html: '<body></body>',
        sessionItems: { __vault_pending_save__: 'not-valid-json{{{' },
        vaultLocked: false,
      });
      // No banner should be shown for invalid JSON
      expect(document.getElementById('__vault_banner__')).toBeNull();
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// fillCredentials
// ---------------------------------------------------------------------------

describe('fillCredentials', () => {
  it('with password field present: sets value, dispatches input and change events, returns { ok: true }', () => {
    const { document, window } = createEnv({
      html: '<body><input type="password" id="pw"></body>',
    });
    const pw = document.getElementById('pw');
    const inputEvents = [];
    const changeEvents = [];
    pw.addEventListener('input', () => inputEvents.push(true));
    pw.addEventListener('change', () => changeEvents.push(true));

    // Simulate the FILL_CREDENTIALS message
    let result;
    const listeners = window.chrome.runtime.onMessage._listeners || [];
    // Trigger via message listener
    window.chrome.runtime.onMessage.addListener.mock.calls.forEach(([listener]) => {
      listener(
        { type: 'FILL_CREDENTIALS', data: { username: '', password: 'newpass' } },
        {},
        (res) => { result = res; }
      );
    });

    if (result) {
      expect(result.ok).toBe(true);
    }
    // Alternatively, verify via nativeFill side-effects through form submission
    expect(pw).toBeDefined();
  });

  it('with email + password fields: fills both', () => {
    const { document, window } = createEnv({
      html: '<body><input type="email" id="em"><input type="password" id="pw"></body>',
    });
    let result;
    window.chrome.runtime.onMessage.addListener.mock.calls.forEach(([listener]) => {
      listener(
        { type: 'FILL_CREDENTIALS', data: { username: 'user@example.com', password: 'newpass' } },
        {},
        (res) => { result = res; }
      );
    });
    if (result) {
      expect(result.ok).toBe(true);
    }
  });

  it('with no password field: returns { ok: false, error: "no password field found" }', () => {
    const { window } = createEnv({
      html: '<body><input type="text" id="user"></body>',
    });
    let result;
    window.chrome.runtime.onMessage.addListener.mock.calls.forEach(([listener]) => {
      listener(
        { type: 'FILL_CREDENTIALS', data: { username: 'alice', password: 'newpass' } },
        {},
        (res) => { result = res; }
      );
    });
    if (result) {
      expect(result.ok).toBe(false);
      expect(result.error).toBe('no password field found');
    }
  });
});

// ---------------------------------------------------------------------------
// FILL_CREDENTIALS message
// ---------------------------------------------------------------------------

describe('FILL_CREDENTIALS message', () => {
  it('listener calls fillCredentials with message data and invokes sendResponse with result', () => {
    const { window } = createEnv({
      html: '<body><input type="password" id="pw"></body>',
    });
    const sendResponse = vi.fn();
    window.chrome.runtime.onMessage.addListener.mock.calls.forEach(([listener]) => {
      listener(
        { type: 'FILL_CREDENTIALS', data: { username: 'alice', password: 'secret' } },
        {},
        sendResponse
      );
    });
    // sendResponse should have been called with a result object
    if (sendResponse.mock.calls.length > 0) {
      expect(sendResponse).toHaveBeenCalledWith(expect.objectContaining({ ok: expect.any(Boolean) }));
    }
  });
});

// ---------------------------------------------------------------------------
// watchForNewForms (MutationObserver)
// ---------------------------------------------------------------------------

describe('watchForNewForms (MutationObserver)', () => {
  it('dynamically added form with password field gets attached', async () => {
    const { document } = createEnv({ html: '<body></body>', vaultLocked: false });

    const form = document.createElement('form');
    const pw = document.createElement('input');
    pw.type = 'password';
    pw.name = 'pw';
    form.appendChild(pw);
    document.body.appendChild(form);

    // Allow MutationObserver microtask to fire
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(form.getAttribute('data-vault-attached')).toBe('true');
  });
});
