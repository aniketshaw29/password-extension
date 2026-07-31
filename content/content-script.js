'use strict';

// ── Module-level state ────────────────────────────────────────────────────────
let pendingBanner = null;

// ── Entry point ───────────────────────────────────────────────────────────────
init();

function init() {
  checkPendingCredentials(); // Restore banner if previous page stored pending save
  attachToExistingForms();
  watchForNewForms();        // MutationObserver for SPAs
}

// ── Form detection ────────────────────────────────────────────────────────────

function attachToExistingForms() {
  document.querySelectorAll('form').forEach(tryAttachForm);
}

function tryAttachForm(form) {
  if (form.dataset.vaultAttached) return;
  if (!form.querySelector('input[type="password"]')) return;
  form.dataset.vaultAttached = 'true';
  form.addEventListener('submit', handleFormSubmit);
}

function watchForNewForms() {
  const observer = new MutationObserver(() => {
    document.querySelectorAll('form').forEach(tryAttachForm);
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

// ── Submit interception ───────────────────────────────────────────────────────

function handleFormSubmit(event) {
  const form = event.target;
  const pwField = form.querySelector('input[type="password"]');
  if (!pwField || !pwField.value) return;

  const usernameField = findUsernameField(form);
  const credentials = {
    username: usernameField ? usernameField.value : '',
    password: pwField.value,
    url: window.location.href,
    title: document.title || window.location.hostname,
  };

  // Store for next page in case form navigates away
  try {
    sessionStorage.setItem('__vault_pending_save__', JSON.stringify(credentials));
  } catch (_) {}

  // Also try to show banner immediately (works for AJAX / SPA forms)
  chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (status) => {
    if (chrome.runtime.lastError || !status || status.locked) return;
    showSaveBanner(credentials);
  });
}

// ── Pending save (cross-page banner restoration) ──────────────────────────────

function checkPendingCredentials() {
  let raw;
  try {
    raw = sessionStorage.getItem('__vault_pending_save__');
    if (!raw) return;
    sessionStorage.removeItem('__vault_pending_save__');
  } catch (_) { return; }

  let creds;
  try { creds = JSON.parse(raw); }
  catch (_) { return; }

  chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (status) => {
    if (chrome.runtime.lastError || !status || status.locked) return;
    showSaveBanner(creds);
  });
}

// ── Save banner ───────────────────────────────────────────────────────────────
// Fully inline-styled so page CSP/stylesheets don't affect it.

function showSaveBanner(credentials) {
  removeBanner();

  const banner = document.createElement('div');
  banner.id = '__vault_banner__';
  banner.style.cssText = [
    'position:fixed', 'top:0', 'left:0', 'right:0', 'z-index:2147483647',
    'background:#1e293b', 'color:#f1f5f9',
    'padding:12px 16px',
    'font:14px/1.4 system-ui,sans-serif',
    'display:flex', 'align-items:center', 'gap:12px',
    'box-shadow:0 2px 12px rgba(0,0,0,0.5)',
    'border-bottom:1px solid #334155',
  ].join(';');

  const label = document.createElement('span');
  label.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
  const site = credentials.title || new URL(credentials.url).hostname;
  const user = credentials.username ? ` (${credentials.username})` : '';
  label.textContent = `Save "${site}"${user} to vault?`;

  const btnSave = makeBannerBtn('Save', '#3b82f6', async () => {
    btnSave.textContent = '…';
    btnSave.disabled = true;
    chrome.runtime.sendMessage({ type: 'SAVE_ENTRY', data: credentials }, (res) => {
      if (chrome.runtime.lastError || !res) {
        label.textContent = 'Error: could not reach extension.';
        return;
      }
      if (res.ok) {
        label.textContent = 'Saved to vault ✓';
        setTimeout(removeBanner, 1500);
      } else {
        label.textContent = `Error: ${res.error || 'save failed'}`;
        btnSave.textContent = 'Retry';
        btnSave.disabled = false;
      }
    });
  });

  const btnDismiss = makeBannerBtn('Dismiss', '#475569', removeBanner);

  banner.append(label, btnSave, btnDismiss);
  document.documentElement.prepend(banner);
  pendingBanner = banner;

  // Auto-dismiss after 30 seconds
  setTimeout(removeBanner, 30000);
}

function removeBanner() {
  if (pendingBanner) { pendingBanner.remove(); pendingBanner = null; }
}

function makeBannerBtn(text, bg, onClick) {
  const btn = document.createElement('button');
  btn.textContent = text;
  btn.style.cssText = [
    `background:${bg}`, 'color:#fff', 'border:none',
    'padding:6px 14px', 'border-radius:5px',
    'cursor:pointer', 'font-size:13px', 'white-space:nowrap',
    'transition:opacity 0.15s',
  ].join(';');
  btn.addEventListener('mouseenter', () => { btn.style.opacity = '0.85'; });
  btn.addEventListener('mouseleave', () => { btn.style.opacity = '1'; });
  btn.addEventListener('click', onClick);
  return btn;
}

// ── Username field heuristic ──────────────────────────────────────────────────

function findUsernameField(form) {
  // 1. email input
  const email = form.querySelector('input[type="email"]');
  if (email) return email;

  // 2. text input with user/email/login in name or id
  const named = form.querySelector([
    'input[name*="user" i]', 'input[name*="email" i]', 'input[name*="login" i]',
    'input[id*="user" i]', 'input[id*="email" i]', 'input[id*="login" i]',
  ].join(','));
  if (named) return named;

  // 3. the visible input immediately before the password field
  const pwField = form.querySelector('input[type="password"]');
  const inputs = Array.from(form.querySelectorAll('input:not([type="hidden"])'));
  const pwIndex = inputs.indexOf(pwField);
  if (pwIndex > 0) return inputs[pwIndex - 1];

  return null;
}

// ── Autofill (called by service worker via FILL_CREDENTIALS) ──────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'FILL_CREDENTIALS') {
    const result = fillCredentials(message.data.username, message.data.password);
    sendResponse(result);
  }
  return false; // synchronous response
});

function fillCredentials(username, password) {
  const pwFields = document.querySelectorAll('input[type="password"]');
  if (!pwFields.length) return { ok: false, error: 'no password field found' };

  // Find username field outside a specific form context
  const usernameField = document.querySelector([
    'input[type="email"]',
    'input[name*="user" i]', 'input[name*="email" i]', 'input[name*="login" i]',
    'input[id*="user" i]', 'input[id*="email" i]', 'input[id*="login" i]',
  ].join(','));

  if (usernameField) nativeFill(usernameField, username);
  nativeFill(pwFields[0], password);

  return { ok: true };
}

// Works with React, Vue, Angular — bypasses their synthetic event system
function nativeFill(element, value) {
  const nativeSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype, 'value'
  ).set;
  nativeSetter.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
  element.focus();
}
