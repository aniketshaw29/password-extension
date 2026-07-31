# How to Run

## Prerequisites

- **Chrome** (or any Chromium-based browser)
- **Python 3.10+**
- The `password-vault` project cloned alongside this directory:
  ```
  coding-stuff/
  ├── password-vault/    ← Flask backend
  └── password-extension/  ← this repo
  ```

---

## 1. Start the Flask Vault

```bash
cd ../password-vault

# First time only — create virtual environment and install deps
python3 -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install -r requirements.txt

# Start the server
python app.py
# → Vault running at http://127.0.0.1:5000
```

The vault opens in your default browser automatically.
If this is your first run, set a master password on the unlock screen.

> **Keep this terminal running** — the extension talks to this server.

---

## 2. Load the Extension in Chrome

1. Open Chrome and navigate to `chrome://extensions`
2. Enable **Developer mode** (toggle in top-right corner)
3. Click **Load unpacked**
4. Select the `password-extension/` directory (this repo root)
5. The "Password Vault" extension appears with a blue icon

> Any time you edit extension files, click the **↻ refresh** button on the extension card in `chrome://extensions`.

---

## 3. Unlock the Extension

1. Click the extension icon in Chrome's toolbar (pin it for easy access via the puzzle piece icon)
2. Enter your master password — the same one you set in the Flask vault
3. The main view opens showing entries matching the current site

---

## 4. Features

### Auto-save banner
1. Navigate to any login page and submit the form
2. A banner appears at the top of the next page: *"Save [site] to vault?"*
3. Click **Save** — the credentials are encrypted and stored

### Autofill from popup
1. Navigate to a login page for a site you have saved
2. Open the popup — the **Matches** tab shows matching entries
3. Click **Fill** — username and password are injected into the form

### Manual save
1. Open the popup on any page
2. Click the **Save New** tab
3. Title and URL are pre-filled from the current tab
4. Fill in username + password and click **Save to Vault**

---

## 5. Verify It's Working

**Check CORS is working:**
```bash
curl -s -X OPTIONS \
  -H "Origin: chrome-extension://test" \
  -H "Access-Control-Request-Method: POST" \
  http://127.0.0.1:5000/api/unlock -v 2>&1 | grep "Access-Control"
# Expected: Access-Control-Allow-Origin: chrome-extension://test
```

**Check unlock works:**
```bash
curl -s -c cookies.txt -X POST \
  -H "Content-Type: application/json" \
  -H "Origin: chrome-extension://test" \
  -d '{"master_password":"yourpassword"}' \
  http://127.0.0.1:5000/api/unlock
# Expected: {"ok": true}
```

**Check entries API:**
```bash
curl -s -b cookies.txt \
  -H "Origin: chrome-extension://test" \
  http://127.0.0.1:5000/api/entries
# Expected: JSON array of entries
```

---

## 6. Troubleshooting

| Symptom | Fix |
|---|---|
| Popup shows "Cannot reach vault" | Start Flask: `python app.py` in `password-vault/` |
| "Wrong password" on correct password | Flask restarts regenerate `secret_key` — existing cookies are invalidated. Just enter the master password again. |
| Autofill doesn't work | Some pages block content scripts (e.g., `chrome://` pages, extension pages). Try a regular HTTP/HTTPS login page. |
| Banner doesn't appear after form submit | The vault may have auto-locked (5-min timeout). Open popup and re-unlock. |
| Extension changes not taking effect | Click the **↻ refresh** button on `chrome://extensions` |

---

## 7. Development Notes

- Edit any file, then refresh the extension on `chrome://extensions`
- Service worker logs: `chrome://extensions` → "Password Vault" → **Service Worker** → Inspect
- Content script logs: DevTools on the target page → Console (filter by `content-script.js`)
- Popup logs: Right-click the popup → **Inspect**
- Flask server logs appear in the terminal where `python app.py` is running
