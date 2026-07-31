# Architecture

## Overview

A Chrome Manifest V3 browser extension that connects to a locally running Flask password vault at `http://127.0.0.1:5000`. The extension provides three features:

1. **Auto-detect & prompt** — detects password form submissions and shows a "Save to Vault?" banner
2. **Manual save** — popup lets you save the current page's credentials directly
3. **Autofill** — popup shows matching saved entries for the current site and fills login forms on click

---

## System Diagram

```
┌──────────────────────────────────────────────────────────────────┐
│  Browser                                                         │
│                                                                  │
│  ┌──────────────┐      messages      ┌────────────────────────┐  │
│  │  Web Page    │◄──────────────────►│  Service Worker        │  │
│  │              │                    │  (background/          │  │
│  │  content-    │  FILL_CREDENTIALS  │   service-worker.js)   │  │
│  │  script.js   │◄──────────────────►│                        │  │
│  │              │  GET_STATUS        │  All Flask API calls   │  │
│  │  - form      │  SAVE_ENTRY        │  Lock state storage    │  │
│  │    detection │                    │  Message routing       │  │
│  │  - banner    │                    └──────────┬─────────────┘  │
│  │  - autofill  │                               │                │
│  └──────────────┘                               │ fetch()        │
│                                                 │ credentials:   │
│  ┌──────────────┐      messages                 │ 'include'      │
│  │  Popup       │◄─────────────────────────────►│                │
│  │  (popup/)    │                               │                │
│  │              │  UNLOCK / LOCK                │                │
│  │  - lock view │  SEARCH_ENTRIES               │                │
│  │  - matches   │  TRIGGER_AUTOFILL             │                │
│  │  - save form │  SAVE_ENTRY                   │                │
│  └──────────────┘                               │                │
│                                                 │                │
└─────────────────────────────────────────────────┼────────────────┘
                                                  │
                                          ┌───────▼────────┐
                                          │  Flask Vault   │
                                          │  127.0.0.1:5000│
                                          │                │
                                          │  /api/unlock   │
                                          │  /api/lock     │
                                          │  /api/entries  │
                                          │                │
                                          │  Argon2id KDF  │
                                          │  AES-256-GCM   │
                                          │  SQLite DB     │
                                          └────────────────┘
```

---

## File Map

```
password-extension/
├── manifest.json                  # MV3 manifest — permissions, scripts, icons
├── background/
│   └── service-worker.js          # Central hub: all API calls, message routing
├── content/
│   └── content-script.js          # Injected into every page: form detection,
│                                  #   save banner, autofill injection
├── popup/
│   ├── popup.html                 # 4-view shell: loading/error/locked/main
│   ├── popup.css                  # Dark theme, 360px wide
│   └── popup.js                   # State machine, all user interactions
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
└── docs/
    ├── ARCHITECTURE.md            # This file
    └── HOW_TO_RUN.md              # Setup and testing guide
```

---

## Data Flow: Save from Banner

```
[User submits login form on any page]
  └─► content-script.js captures username + password
      ├─ sessionStorage.setItem('__vault_pending_save__', creds)  ← survives page nav
      └─ sendMessage(GET_STATUS)
           └─ (if unlocked) showSaveBanner(creds)
                └─ [User clicks "Save"]
                     └─ sendMessage(SAVE_ENTRY, creds)
                          └─ service-worker.js: POST /api/entries
                               └─ Flask encrypts + stores in SQLite
```

## Data Flow: Autofill from Popup

```
[User opens popup on login page]
  └─► popup.js: chrome.tabs.query → get current URL
      └─ sendMessage(SEARCH_ENTRIES, { query: domain })
           └─ service-worker.js: GET /api/entries?q=<domain>
                └─ Returns entry list (no sensitive fields)
                     └─ popup.js renders list with "Fill" buttons
                          └─ [User clicks "Fill"]
                               └─ sendMessage(TRIGGER_AUTOFILL, { entryId })
                                    └─ service-worker.js:
                                         ├─ GET /api/entries/<id>  ← decrypted
                                         └─ chrome.tabs.sendMessage(FILL_CREDENTIALS)
                                              └─ content-script.js: nativeFill()
```

---

## Message Protocol

All messages go through `chrome.runtime.sendMessage`. The service worker is the **only** caller of the Flask API.

| Message type | Sender | Payload | Response |
|---|---|---|---|
| `GET_STATUS` | popup / content | — | `{ locked, unreachable? }` |
| `UNLOCK` | popup | `masterPassword` | `{ ok, error? }` |
| `LOCK` | popup | — | `{ ok }` |
| `SEARCH_ENTRIES` | popup | `query, category?` | `{ entries }` or `{ locked }` |
| `SAVE_ENTRY` | popup / content | `data` | `{ ok, id?, error? }` |
| `TRIGGER_AUTOFILL` | popup | `entryId` | `{ ok, error? }` |
| `FILL_CREDENTIALS` | service worker → content | `data: { username, password }` | `{ ok, error? }` |

---

## Auth & Session

- **Unlock**: `POST /api/unlock` with `{ master_password }` — Flask runs Argon2id KDF, sets a signed session cookie
- **All API calls**: `credentials: 'include'` — browser automatically attaches the `127.0.0.1` session cookie
- **Lock state**: `chrome.storage.session` — survives service worker restarts within the same browser session, cleared on browser close
- **Auto-lock**: Flask has a 5-minute `AUTO_LOCK_SECONDS` timeout. `GET_STATUS` probes the API to detect server-side lock and syncs extension state

---

## Backend Changes (password-vault/app.py)

Three additions made to the existing Flask app:

1. `SESSION_COOKIE_SAMESITE = "None"` + `SESSION_COOKIE_SECURE = False` — allows cross-origin cookie delivery to extension fetch requests
2. CORS headers echoing `chrome-extension://` origin on all responses + OPTIONS preflight handler
3. `POST /api/unlock` and `POST /api/lock` — JSON equivalents of the HTML form routes (existing web UI routes unchanged)
