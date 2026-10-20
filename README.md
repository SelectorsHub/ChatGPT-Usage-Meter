# ChatGPT Usage Meter

A Chrome / Edge / Brave extension (Manifest V3) that shows your ChatGPT usage right above the ChatGPT chat box. It's the sister tool to Claude Usage Meter, by SelectorsHub.

- **Strip above the composer**: 5-hour % · reset time · weekly % · reset time, other limits (such as Code review), the feature quota closest to running out, limit-hit countdown, and the size of the current chat (**Chat ~35.7K tokens**). It sheds detail as the composer gets narrower and collapses to a compact pill when there's no room left.
- **Limit forecast**: an "⏳ ~51m left" chip appears when, at your current pace, you'll hit the 5-hour limit before it resets. It needs about 12 minutes of data to measure your pace.
- **Limit-hit detection**: when ChatGPT refuses a message (HTTP 429, or a cap message in the reply stream), the strip shows **Limit · 4h 50m** with the reset time parsed from ChatGPT's own message.
- **Toolbar popup**: plan badge, one card per usage window, feature quotas (deep research, image generation, agent…) with their reset times, messages sent per model (5h / 24h / 7d), and the More tools drawer.
- **My model caps**: ChatGPT doesn't report a remaining count for every model. If your plan has a fixed cap (for example a weekly limit on a Pro model), add it in Settings and the meter counts your messages to that model against it.
- **Alerts**: desktop notifications at 75 / 90 / 100% (configurable), and a 5-hour % badge on the toolbar icon.

## Install (unpacked)

1. Unzip the folder.
2. Open `chrome://extensions` (or `edge://extensions`, `brave://extensions`).
3. Turn on **Developer mode** → **Load unpacked** → pick the `chatgpt-usage-meter` folder.
4. Sign in to chatgpt.com in the same browser profile and open a chat.

## Where the numbers come from

All of these are undocumented internal endpoints on chatgpt.com. They're called with the user's own signed-in session, and nothing leaves the browser.

| Source | Gives |
|---|---|
| `GET /api/auth/session` | short-lived access token, plan |
| `GET /backend-api/wham/usage` | `rate_limit.primary_window` (5-hour) and `secondary_window` (weekly): `used_percent`, `reset_at`, `limit_window_seconds`; `additional_rate_limits[]`; `credits` |
| `POST /backend-api/conversation/init` | `limits_progress[]`: `feature_name`, `remaining`, `reset_after` |
| `GET /backend-api/conversation/<id>` | the chat, for its token estimate (active branch only; reasoning skipped) |
| `page-injector.js` (fetch wrapper, main world) | model of each message you send, 429/cap refusals, stream end. It also reads the usage responses above whenever the page fetches them itself |

**Requests.** `background.js` calls the endpoints directly from the service worker. If that's refused in a way that looks like a bot wall (Cloudflare) rather than a signed-out session, it relays the same request through an open chatgpt.com tab (`proxyFetch` in `content-script.js`), where it's an ordinary same-origin call. Workspace accounts get the `ChatGPT-Account-Id` header from the `_account` cookie.

**What the 5-hour and weekly windows cover.** These are the windows ChatGPT reports for the account. They're the ones Codex and ChatGPT's agent/Work features draw from. Plain chat on most plans has no fixed message cap at the moment, so there may be nothing to count for it. That gap is why limit-hit detection and My model caps exist.

## Files

```
manifest.json        MV3 manifest (host: chatgpt.com)
shared/config.js     names, URLs, tool list, defaults, formatting helpers  ← edit store URLs here
shared/tokens.js     conversation → token estimate
background.js        auth, polling, parsing, forecast, notifications, badge
page-injector.js     main-world fetch wrapper (tee / clone only)
content-script.js    bridge, proxy fetch, strip, gear + logo menus
overlay.css          strip and menu styles (follows ChatGPT's light/dark theme)
popup/  options/     toolbar popup and settings page
icons/               gauge icon (logo.svg is the source) + SelectorsHub tool icons
```

## Before publishing

- Fill `STORE_URLS` in `shared/config.js` once the listings exist. The "★ Rate us" links stay hidden until you do.
- Optionally set `INSTALL_URL` / `UNINSTALL_URL`, and create the `PRODUCT_URL` page (`selectorshub.com/chatgpt-usage-meter/`).
- All outbound links carry `utm_source=chatgpt-usage-meter` with `utm_medium` = `strip-logo`, `logo-menu`, `logo-menu-all`, `limit-reached`, `popup`, `options`, `strip`.

## Debugging

- Run `localStorage.cgum_debug = "1"` on chatgpt.com and reload to see what the injector intercepts.
- The service worker console is at `chrome://extensions` → ChatGPT Usage Meter → *service worker*.

## Caveats

- Every endpoint and response shape above is undocumented and can change without notice. Parsing is deliberately loose, and a missing source just hides its part of the UI.
- Message counts and My model caps only see messages sent from this browser after install (not other devices or the mobile app).
- Chat tokens are an estimate (word/symbol-piece heuristic, about ±15%). Files read through retrieval, memory and the system prompt aren't visible and aren't counted.
- Firefox: needs `background.scripts` in place of `service_worker` (Firefox 128+ for main-world content scripts). Not included in this build.

Not affiliated with or endorsed by OpenAI. ChatGPT is a trademark of OpenAI.
