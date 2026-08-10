# RelayPulse — source

Desktop monitor for [Anyone Protocol](https://anyone.io) relay and exit nodes. It
polls your fleet over SSH, shows per-relay health, and can attempt AI-assisted
fixes when a node goes down.

Downloads and the product page: **https://barisadiy1974-hub.github.io/relaypulse/**

---

## Why this source is public

RelayPulse asks you for **SSH private keys to your servers** and, optionally, an
**OpenAI or Anthropic API key**. That is a lot of trust to hand a binary you
cannot inspect. So the code that handles those credentials is here, in full, and
you are welcome to read it before you run it.

This is *source-available*, not open source — see [LICENSE](LICENSE). You can read,
audit, build and run it; you cannot redistribute it or strip the license check.

## What to audit

If you only read four files, read these:

| File | What to check |
|---|---|
| [`src/config.js`](src/config.js) | Where credentials are stored. Secrets go into an encrypted sidecar vault via Electron `safeStorage`, not into the plain JSON config. |
| [`src/monitor.js`](src/monitor.js) | The SSH polling engine — every command run against your relays. |
| [`src/ai-fixer.js`](src/ai-fixer.js) | What is sent to the AI provider when auto-fix runs, and what it is allowed to execute. |
| [`main.js`](main.js) | All IPC handlers, i.e. everything the UI can ask the main process to do. |

### Every host the app can contact

There is no telemetry and no analytics. `grep` for `https://` and you will find
exactly this list:

- **Anyone Protocol:** `api.ec.anyone.tech`, `relay-api.anyone.io`, `cu.anyone.tech`, `dashboard.anyone.io`
- **Your own public IP lookup:** `api.ipify.org`, `icanhazip.com`, `ifconfig.me`
- **Token price / chain data:** `api.coingecko.com`, `api.dexscreener.com`, `1rpc.io`
- **AI auto-fix (only if you supply a key):** `api.openai.com`, `api.anthropic.com`
- **News feed:** `rss.noleron.com`, `rsshub.app`, `rsshub.pseudoyu.com`
- **Links opened in your browser:** `x.com`, `t.me`

Your SSH credentials are never sent anywhere. They are used locally to open SSH
connections from your own machine.

## Licensing

License keys are verified **offline** with an Ed25519 signature. Only the public
key is in this repository ([`src/license.js`](src/license.js)) — it can check a key
but cannot create one. There is no activation server and no phone-home.

## Build from source

```bash
npm install
npm start                      # run it
npx electron-builder --mac     # or --win / --linux
```

The build tooling is `electron-builder`; targets are declared in `package.json`.

## Reporting a security issue

Open an issue, or if it is sensitive, say so in the issue without details and we
will arrange a private channel.
