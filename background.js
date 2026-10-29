// background.js — service worker for ChatGPT Usage Meter.
//
// Data sources (all undocumented, all on chatgpt.com, all read with the
// user's own signed-in session — nothing leaves the browser):
//
//   GET  /api/auth/session              → short-lived access token + account
//   GET  /backend-api/wham/usage        → rate_limit.primary_window (5-hour)
//                                         rate_limit.secondary_window (weekly)
//                                         additional_rate_limits[], credits
//   POST /backend-api/conversation/init → limits_progress[] (feature quotas:
//                                         deep research, image gen, uploads…)
//   GET  /backend-api/conversation/<id> → the chat, for its token size
//
// Plus what page-injector.js sees on the page: each message sent (model),
// cap/limit refusals, and the same usage responses whenever the page fetches
// them itself (those are merged in for free).
//
// v1.0.3: SEVERAL ACCOUNTS. A private / container window can be signed in to
// a different ChatGPT account than the normal window. Everything that
// describes one account (snapshot, history, fired alerts, message log, limit
// hits) is stored per account, requests for a non-default window are made by a
// chatgpt.com tab in that window, and every message is handled in the window
// it came from. See "browsing contexts" below.
//
// Requests go straight from the service worker first. If that fails in a way
// that looks like a bot wall rather than a signed-out session, the same
// request is relayed through an open chatgpt.com tab, where it is an ordinary
// same-origin call.

importScripts("shared/config.js", "shared/tokens.js");

const ORIGIN = CUM_CONFIG.ORIGIN;
const POLL_ALARM = "cgum-poll";
const FEATURES_EVERY_MS = 5 * 60 * 1000;
const LOG_KEEP_MS = 31 * 86400e3;
const LOG_MAX = 20000;
const DEBUG = false;
const dlog = (...a) => { if (DEBUG) console.log("[CGUM]", ...a); };

// ---------- settings ----------

function mergeDefaults(s) {
  const d = CUM_CONFIG.DEFAULT_SETTINGS;
  s = s || {};
  return Object.assign({}, d, s, { fields: Object.assign({}, d.fields, s.fields || {}) },
    { modelCaps: Array.isArray(s.modelCaps) ? s.modelCaps : d.modelCaps });
}

async function getSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  return mergeDefaults(settings);
}

// ---------- browsing contexts (v1.0.3) ----------
//
// One extension instance serves several cookie jars: the normal window, an
// incognito / private window and (Firefox) container tabs. Each jar can be
// signed in to a DIFFERENT ChatGPT account. The service worker's own fetch()
// always carries the NORMAL jar's cookies, so before this version a private
// window was shown the normal account's numbers (and its page data was merged
// into the normal account's snapshot).
//
//   CTX            "default" for the normal jar, otherwise "incognito" (Chrome /
//                  Edge) or the Firefox cookieStoreId.
//   inCtx(ctx, fn) runs fn with CTX set, strictly one at a time (FIFO), so the
//                  code in between can use the K() key helper as if there were
//                  one account. Every entry point (alarm, message, cookie
//                  change) goes through it.
//   api()          "default" calls from the worker, as before. Any other jar
//                  cannot be reached from the worker, so the request is run by
//                  the content script of a chatgpt.com tab living in that jar.
//
// Account-level data is stored under "acct:<user>~<workspace>:<name>" no
// matter which window it was seen from (same account in two windows = same
// entry). When the account cannot be read (signed out, no tab in a private
// window) the window's own "ctx:<ctx>:<name>" keys are used instead. Settings,
// rating state etc. are user-level and stay shared. "ptr:<ctx>" tells the UI of
// that window which prefix to read.
//
// Freeze guards: the queue is one lane, so every job has a hard time limit,
// every request a shorter one, and a request that finishes after its job was
// given up on is discarded (ctx_expired) instead of writing into whichever
// account runs next.
let CTX = "default";
let CURRENT_ACCT = null;       // storage-key part of the account being served
let CURRENT_ID = null;         // { userId, accountId, plan } of that account
let CURRENT_ID_ERROR = null;   // why it could not be read (signed_out / no_tab)

const ACCOUNT_KEYS = ["snapshot", "history", "capHits", "fired", "msgLog"];
function acctPrefix() { return CURRENT_ACCT ? `acct:${CURRENT_ACCT}:` : `ctx:${CTX}:`; }
function K(name) { return ACCOUNT_KEYS.includes(name) ? acctPrefix() + name : name; }

const PTR_PREFIX = "ptr:";
const PTR_SEEN = new Map();
async function publishPointer() {
  const p = acctPrefix();
  if (PTR_SEEN.get(CTX) === p) return;
  PTR_SEEN.set(CTX, p);
  try { await chrome.storage.local.set({ [PTR_PREFIX + CTX]: p }); } catch (_) { PTR_SEEN.delete(CTX); }
}

// Firefox exposes cookieStoreId on the tab; Chrome / Edge only say whether it
// is incognito (they have just the two jars).
function ctxOfTab(tab) {
  if (!tab) return "default";
  const sid = tab.cookieStoreId;
  if (sid) return (sid === "firefox-default" || sid === "0") ? "default" : String(sid);
  return tab.incognito ? "incognito" : "default";
}

async function tabsOfCtx(ctx) {
  try {
    const tabs = await chrome.tabs.query({ url: ORIGIN + "/*" });
    return tabs.filter((t) => ctxOfTab(t) === ctx).sort((a, b) => (b.active ? 1 : 0) - (a.active ? 1 : 0));
  } catch (_) { return []; }
}

// Every jar that has a chatgpt.com tab, plus "default" (always polled, as
// before, so the toolbar badge works without a chatgpt.com tab).
async function activeCtxs() {
  const set = new Set(["default"]);
  try {
    for (const t of await chrome.tabs.query({ url: ORIGIN + "/*" })) set.add(ctxOfTab(t));
  } catch (_) {}
  return [...set];
}

const CTX_JOB_TIMEOUT_MS = 60 * 1000;    // longest a single queued job may hold the lane
const CTX_FETCH_TIMEOUT_MS = 20 * 1000;  // longest a single request may take
let ctxQueue = Promise.resolve();
let RUN_ID = 0;    // id of the job currently holding the lane (0 = none)
let runSeq = 0;

function withTimeout(promise, ms, label) {
  let t = null;
  return Promise.race([
    promise,
    new Promise((_, rej) => { t = setTimeout(() => rej(new Error(label || "timeout")), ms); })
  ]).finally(() => clearTimeout(t));
}

function assertRun(myRun) { if (myRun && RUN_ID !== myRun) throw new Error("ctx_expired"); }

// fetch with a time limit; refuses to hand back a response once the job that
// asked for it no longer holds the lane.
async function guardedFetch(url, init) {
  const myRun = RUN_ID;
  const ctl = typeof AbortController === "function" ? new AbortController() : null;
  const timer = setTimeout(() => { try { ctl && ctl.abort(); } catch (_) {} }, CTX_FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(url, ctl ? Object.assign({}, init || {}, { signal: ctl.signal }) : init);
    assertRun(myRun);
    return resp;
  } finally { clearTimeout(timer); }
}

// ---- which account is this window on? ----
const ID_TTL_MS = 10 * 60 * 1000;
const ID_BY_CTX = new Map();   // ctx -> { id, at } (dropped whenever a login cookie changes)
function forgetIdentities() { ID_BY_CTX.clear(); auth = null; }

// Ask a chatgpt.com tab of THIS jar who is signed in (same-origin there, so
// the browser sends that jar's cookies). null = no tab answered.
async function sessionViaTab(ctx) {
  const myRun = RUN_ID;
  let signedOut = false;
  for (const t of await tabsOfCtx(ctx)) {
    let r = null;
    try {
      r = await withTimeout(chrome.tabs.sendMessage(t.id, { type: "proxySession" }), CTX_FETCH_TIMEOUT_MS + 2000, "proxy_timeout");
    } catch (_) { continue; }
    assertRun(myRun);
    if (r && r.status === 200 && r.identity) return r.identity;
    if (r && r.status === 401) signedOut = true;
  }
  if (signedOut) throw apiError("signed_out", "Not signed in to chatgpt.com", 401);
  return null;
}

async function identityForCtx(ctx) {
  const hit = ID_BY_CTX.get(ctx);
  if (hit && Date.now() - hit.at < ID_TTL_MS) return hit.id;
  let id = null;
  if (ctx === "default") {
    try {
      const a = await getAuth(false);
      id = { userId: a.userId, accountId: a.accountId, plan: a.plan };
    } catch (e) {
      if (e && (e.code === "signed_out" || e.message === "ctx_expired")) throw e;
      // blocked / network: a tab of this same jar may still be able to tell
      try { id = await sessionViaTab(ctx); } catch (e2) { if (e2 && e2.code === "signed_out") throw e2; }
    }
  } else {
    id = await sessionViaTab(ctx);
    if (!id) throw apiError("no_tab", "Open a chatgpt.com tab in this window to see its account.");
  }
  if (id && cumAcctKey(id)) ID_BY_CTX.set(ctx, { id, at: Date.now() });
  return id;
}

async function resolveCtxAccount() {
  CURRENT_ID = null; CURRENT_ID_ERROR = null; CURRENT_ACCT = null;
  try { CURRENT_ID = await identityForCtx(CTX); }
  catch (e) {
    if (e && e.message === "ctx_expired") throw e;
    CURRENT_ID_ERROR = e;
  }
  CURRENT_ACCT = CURRENT_ID ? cumAcctKey(CURRENT_ID) : null;
  if (CURRENT_ACCT) await migrateLegacyAccountState();
  await publishPointer();
}

// Before 1.0.3 the account-level keys were stored un-prefixed, and only the
// normal window was ever polled. The first time an account is seen in the
// normal window, that data is moved under it (never overwriting its own).
let LEGACY_DONE = false;
async function migrateLegacyAccountState() {
  if (CTX !== "default" || LEGACY_DONE || !CURRENT_ACCT) return;
  LEGACY_DONE = true;
  try {
    const prefix = acctPrefix();
    const got = await chrome.storage.local.get([...ACCOUNT_KEYS, ...ACCOUNT_KEYS.map((n) => prefix + n)]);
    const moved = {}, legacy = [];
    for (const n of ACCOUNT_KEYS) {
      if (got[n] == null) continue;
      legacy.push(n);
      if (got[prefix + n] == null) moved[prefix + n] = got[n];
    }
    if (!legacy.length) return;
    if (Object.keys(moved).length) await chrome.storage.local.set(moved);
    await chrome.storage.local.remove(legacy);
  } catch (_) { LEGACY_DONE = false; }
}

function inCtx(ctx, fn) {
  const run = () => {
    const myRun = ++runSeq;
    RUN_ID = myRun;
    CTX = ctx || "default";
    CURRENT_ACCT = null; CURRENT_ID = null; CURRENT_ID_ERROR = null;
    let timer = null;
    const work = (async () => {
      await resolveCtxAccount();
      return await fn();
    })();
    const watchdog = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("ctx_job_timeout")), CTX_JOB_TIMEOUT_MS);
    });
    return Promise.race([work, watchdog]).finally(() => {
      clearTimeout(timer);
      if (RUN_ID !== myRun) return;   // never touch another job's state
      CTX = "default"; CURRENT_ACCT = null; CURRENT_ID = null; CURRENT_ID_ERROR = null; RUN_ID = 0;
    });
  };
  const p = ctxQueue.then(run, run);
  ctxQueue = p.catch(() => {});
  return p;
}

// A plain poll that is still waiting in the queue is shared, not repeated.
const queuedPolls = new Map();   // ctx -> promise of a poll that has not started
function pollCtx(ctx, opts) {
  const plain = !opts || !Object.keys(opts).length;
  if (plain && queuedPolls.has(ctx)) return queuedPolls.get(ctx);
  const p = inCtx(ctx, () => {
    if (plain && queuedPolls.get(ctx) === p) queuedPolls.delete(ctx);
    return refresh(opts || {});
  });
  if (plain) {
    queuedPolls.set(ctx, p);
    const clear = () => { if (queuedPolls.get(ctx) === p) queuedPolls.delete(ctx); };
    p.then(clear, clear);
  }
  return p;
}
async function pollAll(opts) {
  const list = await activeCtxs();
  await Promise.allSettled(list.map((c) => pollCtx(c, opts)));
}

// ---------- auth ----------

let auth = null; // { token, exp, accountId, plan }
let authPromise = null;

function apiError(code, message, status) {
  const e = new Error(message || code); e.code = code; e.status = status; return e;
}

function jwtExp(token) {
  try {
    const p = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    return p.exp ? p.exp * 1000 : null;
  } catch (_) { return null; }
}

async function accountIdCookie() {
  try {
    const c = await chrome.cookies.get({ url: ORIGIN, name: "_account" });
    if (c && /^[0-9a-f-]{36}$/i.test(c.value)) return c.value;
  } catch (_) {}
  return null;
}

async function getAuth(force) {
  if (!force && auth && auth.token && (!auth.exp || auth.exp - 120000 > Date.now())) return auth;
  if (authPromise) return authPromise;
  authPromise = (async () => {
    let r;
    try {
      r = await guardedFetch(ORIGIN + "/api/auth/session", { credentials: "include", cache: "no-store", headers: { accept: "application/json" } });
    } catch (e) {
      if (e && e.message === "ctx_expired") throw e;
      throw apiError("network", "Couldn't reach chatgpt.com");
    }
    const j = await r.json().catch(() => null);
    if (!j) throw apiError("blocked", "chatgpt.com didn't return session data", r.status);
    if (!j.accessToken) throw apiError("signed_out", "Not signed in to chatgpt.com", 401);
    auth = {
      token: j.accessToken,
      exp: jwtExp(j.accessToken) || (j.expires ? Date.parse(j.expires) : Date.now() + 30 * 60e3),
      accountId: (await accountIdCookie()) || (j.account && j.account.id) || null,
      plan: (j.account && (j.account.planType || j.account.plan_type)) || null,
      userId: cumUserId(j),
      email: (j.user && j.user.email) || null
    };
    return auth;
  })();
  try { return await authPromise; } finally { authPromise = null; }
}

async function directApi(path, opts, retried) {
  const a = await getAuth(false);
  const headers = { accept: "application/json", authorization: "Bearer " + a.token };
  if (a.accountId) headers["chatgpt-account-id"] = a.accountId;
  if (opts && opts.body) headers["content-type"] = "application/json";
  let r;
  try {
    r = await guardedFetch(ORIGIN + path, {
      method: (opts && opts.method) || "GET",
      credentials: "include",
      cache: "no-store",
      headers,
      body: opts && opts.body ? JSON.stringify(opts.body) : undefined
    });
  } catch (e) {
    if (e && e.message === "ctx_expired") throw e;
    throw apiError("network", "Couldn't reach chatgpt.com");
  }
  if (r.status === 401 && !retried) { auth = null; return directApi(path, opts, true); }
  const json = await r.json().catch(() => null);
  return { status: r.status, ok: r.ok, json };
}

async function chatgptTabs() {
  try { return await chrome.tabs.query({ url: ORIGIN + "/*" }); } catch (_) { return []; }
}

// Relay through a chatgpt.com tab of the SAME cookie jar as the job (v1.0.3:
// it used to be any tab, so a refused call could be answered by a private
// window signed in to another account).
async function tabApi(path, opts) {
  const myRun = RUN_ID;
  for (const t of await tabsOfCtx(CTX)) {
    let res = null;
    try {
      res = await withTimeout(chrome.tabs.sendMessage(t.id, { type: "proxyFetch", path, opts }), CTX_FETCH_TIMEOUT_MS + 2000, "proxy_timeout");
    } catch (_) { continue; }
    assertRun(myRun);
    if (res && res.status) return res;
  }
  return null;
}

async function api(path, opts) {
  if (CTX !== "default") {
    // The worker cannot reach another jar: only a tab of that jar may ask.
    const res = await tabApi(path, opts);
    if (!res) throw apiError("no_tab", "Open a chatgpt.com tab in this window to see its account.");
    if (res.status === 401) throw apiError("signed_out", "Not signed in to chatgpt.com", 401);
    return res;
  }
  let res = null, err = null;
  try { res = await directApi(path, opts); } catch (e) { err = e; }
  const bad = !res || (!res.ok && res.status !== 404) || res.json == null;
  if (bad && !(err && err.code === "signed_out")) {
    const viaTab = await tabApi(path, opts);
    if (viaTab && viaTab.status) { dlog("via tab", path, viaTab.status); return viaTab; }
  }
  if (err) throw err;
  return res;
}

// ---------- parsing ----------

const FEATURE_NAMES = {
  deep_research: "Deep research",
  image_gen: "Image generation",
  image_generation: "Image generation",
  file_upload: "File uploads",
  file_uploads: "File uploads",
  odyssey: "Agent",
  agent: "Agent",
  agent_mode: "Agent",
  operator: "Agent",
  sora: "Video",
  video_gen: "Video",
  voice: "Voice",
  advanced_voice: "Voice",
  canvas: "Canvas",
  tasks: "Tasks",
  connector_search: "Connectors",
  codex: "Codex",
  code_review: "Code review",
  research: "Research",
  reason: "Thinking",
  reasoning: "Thinking",
  paste_text_to_file: "Paste to file"
};

function prettyName(s) {
  if (!s) return "Limit";
  const k = String(s).toLowerCase();
  if (FEATURE_NAMES[k]) return FEATURE_NAMES[k];
  const t = k.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function toMs(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number") return v < 1e12 ? v * 1000 : v;
  const n = Number(v);
  if (isFinite(n)) return n < 1e12 ? n * 1000 : n;
  const t = Date.parse(v);
  return isNaN(t) ? null : t;
}

function parseWindow(w, now) {
  if (!w || typeof w !== "object") return null;
  const pctRaw = w.used_percent != null ? w.used_percent : w.utilization != null ? w.utilization : w.percent_used;
  const pct = pctRaw == null ? null : Math.max(0, Math.min(100, Number(pctRaw)));
  let resetAt = toMs(w.reset_at || w.resets_at);
  if (!resetAt && w.reset_after_seconds != null) resetAt = now + Number(w.reset_after_seconds) * 1000;
  const windowSec = Number(w.limit_window_seconds || w.window_seconds || 0) || null;
  if (pct == null && !resetAt) return null;
  return { pct, resetAt, windowSec };
}

function parseUsage(j, now) {
  if (!j || typeof j !== "object") return null;
  const rl = j.rate_limit || (j.data && j.data.rate_limit) || (j.usage && j.usage.rate_limit) || null;
  const out = {
    plan: j.plan_type || null,
    windows: [],
    reached: false,
    reachedType: j.rate_limit_reached_type || null,
    extra: [],
    credits: null
  };
  if (rl) {
    const p = parseWindow(rl.primary_window, now);
    const s = parseWindow(rl.secondary_window, now);
    if (p) out.windows.push(Object.assign({ id: "primary" }, p));
    if (s) out.windows.push(Object.assign({ id: "secondary" }, s));
    // Shorter window first, whatever order the server used.
    out.windows.sort((a, b) => (a.windowSec || 0) - (b.windowSec || 0));
    if (out.windows[0]) out.windows[0].id = "primary";
    if (out.windows[1]) out.windows[1].id = "secondary";
    out.reached = !!(rl.limit_reached || rl.allowed === false);
  }
  const add = Array.isArray(j.additional_rate_limits) ? j.additional_rate_limits.slice() : [];
  // Seen on live accounts: a separate code-review limit in the rate_limit shape.
  if (j.code_review_rate_limit && typeof j.code_review_rate_limit === "object") {
    add.push({ limit_name: "Code review", metered_feature: "code_review", rate_limit: j.code_review_rate_limit });
  }
  // model_usage: {} on Free. Shape on paid plans unknown — accept anything
  // that looks like a rate_limit or a window.
  if (j.model_usage && typeof j.model_usage === "object" && !Array.isArray(j.model_usage)) {
    for (const [model, v] of Object.entries(j.model_usage)) {
      if (!v || typeof v !== "object") continue;
      const r = v.rate_limit || v;
      if (r.primary_window || r.secondary_window) add.push({ limit_name: model, metered_feature: "model:" + model, rate_limit: r });
      else if (r.used_percent != null) add.push({ limit_name: model, metered_feature: "model:" + model, rate_limit: { primary_window: r } });
    }
  }
  for (const a of add) {
    const r = a.rate_limit || a;
    const id = String(a.metered_feature || a.limit_name || a.id || "extra");
    const wins = [parseWindow(r.primary_window, now), parseWindow(r.secondary_window, now)].filter(Boolean);
    if (!wins.length) continue;
    out.extra.push({
      id: "x:" + id,
      name: a.limit_name ? String(a.limit_name) : prettyName(a.metered_feature),
      windows: wins,
      reached: !!(r.limit_reached || r.allowed === false)
    });
  }
  if (j.credits && typeof j.credits === "object") {
    const c = j.credits;
    out.credits = {
      hasCredits: !!c.has_credits,
      unlimited: !!c.unlimited,
      balance: c.balance == null ? null : Number(c.balance)
    };
  }
  return out;
}

function parseFeatures(j, now) {
  if (!j || typeof j !== "object") return null;
  const list = Array.isArray(j.limits_progress) ? j.limits_progress : [];
  const features = list.map((f) => ({
    id: String(f.feature_name || f.name || "feature"),
    name: prettyName(f.feature_name || f.name),
    remaining: f.remaining == null ? null : Number(f.remaining),
    max: f.max_value != null ? Number(f.max_value) : (f.limit != null ? Number(f.limit) : null),
    resetAt: toMs(f.reset_after || f.reset_at || f.resets_at)
  }));
  return {
    features,
    blocked: Array.isArray(j.blocked_features) ? j.blocked_features.map(String) : [],
    defaultModel: j.default_model_slug || null,
    at: now
  };
}

// ---------- state ----------

async function loadState() {
  const s = await chrome.storage.local.get(ACCOUNT_KEYS.map(K));
  return {
    snapshot: s[K("snapshot")] || null,
    history: s[K("history")] || {},
    capHits: s[K("capHits")] || {},
    fired: s[K("fired")] || [],
    msgLog: s[K("msgLog")] || []
  };
}

async function saveState(snap, history, fired) {
  await chrome.storage.local.set({ [K("snapshot")]: snap, [K("history")]: history, [K("fired")]: fired });
}

function allWindows(snap) {
  const out = [];
  if (!snap || !snap.usage) return out;
  for (const w of snap.usage.windows) out.push({ key: w.id, name: cumWindowLabel(w.windowSec), w });
  for (const x of snap.usage.extra) {
    x.windows.forEach((w, i) => out.push({ key: x.id + ":" + i, name: x.name + " · " + cumWindowLabel(w.windowSec), w }));
  }
  return out;
}

// Burn-rate forecast: needs ≥12 minutes of rising samples within the
// current window. Sets w.forecastMs only when the limit would be hit before
// the window resets.
function updateHistoryAndForecast(snap, history, now) {
  for (const { key, w } of allWindows(snap)) {
    if (w.pct == null) continue;
    let h = history[key];
    if (!h || (w.resetAt && h.resetAt && Math.abs(h.resetAt - w.resetAt) > 10 * 60e3) || (h.samples.length && w.pct < h.samples[h.samples.length - 1].pct - 1)) {
      h = { resetAt: w.resetAt || null, samples: [] };
    }
    h.resetAt = w.resetAt || h.resetAt;
    const last = h.samples[h.samples.length - 1];
    if (!last || now - last.t > 50e3 || last.pct !== w.pct) h.samples.push({ t: now, pct: w.pct });
    h.samples = h.samples.filter((s) => now - s.t <= 4 * 3600e3).slice(-300);
    history[key] = h;

    w.forecastMs = null;
    const base = h.samples.find((s) => now - s.t <= 60 * 60e3);
    if (base && now - base.t >= 12 * 60e3 && w.pct > base.pct && w.pct < 100) {
      const rate = (w.pct - base.pct) / (now - base.t);
      const eta = (100 - w.pct) / rate;
      if (!w.resetAt || now + eta < w.resetAt) w.forecastMs = eta;
    }
  }
  for (const k of Object.keys(history)) {
    const h = history[k];
    if (!h.samples.length || now - h.samples[h.samples.length - 1].t > 8 * 86400e3) delete history[k];
  }
}

// ---------- notifications & badge ----------

function notify(id, title, message) {
  try {
    // v1.0.3: a private window can be a different account; say so.
    const where = CTX === "default" ? "" : " (private window)";
    chrome.notifications.create(CTX === "default" ? id : id + "|" + CTX, {
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: title + where,
      message,
      priority: 1
    });
  } catch (_) {}
}

async function checkThresholds(snap, fired, settings) {
  if (!settings.notify) return fired;
  const ths = (settings.thresholds || []).map(Number).filter((n) => n > 0 && n <= 100).sort((a, b) => a - b);
  for (const { key, name, w } of allWindows(snap)) {
    if (w.pct == null) continue;
    const crossed = ths.filter((t) => w.pct >= t);
    if (!crossed.length) continue;
    const top = crossed[crossed.length - 1];
    const resetKey = w.resetAt ? Math.round(w.resetAt / 600e3) : "x";
    const fid = `${key}|${resetKey}|${top}`;
    if (fired.includes(fid)) continue;
    // Mark every lower threshold for this window as fired too, so a jump
    // from 60% to 95% produces one alert, not two.
    for (const t of crossed) fired.push(`${key}|${resetKey}|${t}`);
    const reset = w.resetAt ? ` Resets in ${cumFmtDuration(w.resetAt - Date.now())}.` : "";
    notify("cgum-" + fid, top >= 100 ? `${name} limit reached` : `${name} usage at ${Math.round(w.pct)}%`,
      `ChatGPT ${name.toLowerCase()} usage is at ${Math.round(w.pct)}%.${reset}`);
  }
  return fired.slice(-300);
}

const BADGE_COLORS = { green: "#10a37f", amber: "#d99a06", orange: "#ea6a12", red: "#dc2626" };
function computeBadge(snap, settings) {
  const p = snap && snap.usage && snap.usage.windows[0];
  if (!settings.badge || !p || p.pct == null) return { text: "" };
  const pct = Math.round(p.pct);
  return { text: pct >= 100 ? "MAX" : String(pct), color: BADGE_COLORS[cumLevel(pct)] || "#555" };
}
async function paintBadge(b, tabId) {
  const t = tabId == null ? {} : { tabId };
  await chrome.action.setBadgeText({ ...t, text: b.text });
  if (!b.text) return;
  await chrome.action.setBadgeBackgroundColor({ ...t, color: b.color });
  try { await chrome.action.setBadgeTextColor({ ...t, color: "#ffffff" }); } catch (_) {}
}
// v1.0.3: the normal window paints the global badge, as before. Any other jar
// paints tab-specific badges on ITS tabs only (a tab-specific value wins over
// the global one), so a private window never shows the normal account's %.
async function updateBadge(snap, settings) {
  const ctx = CTX;   // captured: this can be called late, and CTX moves on
  try {
    const b = computeBadge(snap, settings);
    if (ctx === "default") { await paintBadge(b); return; }
    for (const t of await chrome.tabs.query({})) if (ctxOfTab(t) === ctx) { try { await paintBadge(b, t.id); } catch (_) {} }
  } catch (_) {}
}
function refreshAllBadges(settings) {
  activeCtxs().then((list) => {
    for (const c of list) inCtx(c, async () => { await updateBadge((await loadState()).snapshot, settings); }).catch(() => {});
  }).catch(() => {});
}
// Tab-specific badges reset when a tab navigates, and a new private tab would
// otherwise inherit the global (normal-account) badge: repaint on tab events.
async function refreshTabBadge(tab) {
  try {
    if (!tab || tab.id == null) return;
    const ctx = ctxOfTab(tab);
    if (ctx === "default") return;
    await inCtx(ctx, async () => {
      try { await paintBadge(computeBadge((await loadState()).snapshot, await getSettings()), tab.id); } catch (_) {}
    });
  } catch (_) {}
}
if (chrome.tabs && chrome.tabs.onActivated) {
  chrome.tabs.onActivated.addListener(({ tabId }) => {
    chrome.tabs.get(tabId).then(refreshTabBadge).catch(() => {});
  });
  chrome.tabs.onUpdated.addListener((_id, info, tab) => {
    if (info.status === "complete" || info.status === "loading") refreshTabBadge(tab);
  });
}

// ---------- refresh ----------

async function refresh(opts) {
  opts = opts || {};
  const now = Date.now();
  if (opts.forceAuth) {
    if (CTX === "default") auth = null;
    ID_BY_CTX.delete(CTX);
    await resolveCtxAccount();   // v1.0.3: the account may have changed
  }
  const settings = await getSettings();
  const st = await loadState();
  const prev = st.snapshot || {};
  const snap = {
    fetchedAt: now,
    usage: prev.usage || null,
    features: prev.features || null,
    plan: prev.plan || null,
    error: null,
    usageUnavailable: false
  };

  try {
    // Signed out, or a private window with no chatgpt.com tab: nothing to ask.
    if (CURRENT_ID_ERROR && (CURRENT_ID_ERROR.code === "signed_out" || CURRENT_ID_ERROR.code === "no_tab")) throw CURRENT_ID_ERROR;
    if (CURRENT_ID && CURRENT_ID.plan) snap.plan = CURRENT_ID.plan;
    const r = await api("/backend-api/wham/usage");
    if (r && r.ok && r.json) {
      const u = parseUsage(r.json, now);
      snap.usage = u;
      snap.usageAt = now;
      if (u && u.plan) snap.plan = u.plan;
      snap.usageUnavailable = !u || (!u.windows.length && !u.extra.length);
    } else if (r && (r.status === 404 || r.status === 403 || r.status === 400)) {
      snap.usage = null;
      snap.usageUnavailable = true;
    } else {
      snap.error = { code: "http", message: `Usage request failed (${r ? r.status : "no response"})` };
    }

    const needFeatures = opts.force || opts.features || !prev.features || now - (prev.features.at || 0) > FEATURES_EVERY_MS;
    if (needFeatures) {
      const f = await api("/backend-api/conversation/init", {
        method: "POST",
        body: { gizmo_id: null, requested_default_model: null, conversation_id: null, timezone_offset_min: new Date().getTimezoneOffset() }
      }).catch((e) => { if (e && e.message === "ctx_expired") throw e; return null; });
      if (f && f.ok && f.json) snap.features = parseFeatures(f.json, now);
    }
  } catch (e) {
    if (e && e.message === "ctx_expired") throw e;
    snap.error = { code: e.code || "error", message: e.message || String(e) };
    if (e.code === "signed_out") { snap.usage = null; snap.features = null; }
  }

  updateHistoryAndForecast(snap, st.history, now);
  const fired = await checkThresholds(snap, st.fired, settings);
  await saveState(snap, st.history, fired);
  await updateBadge(snap, settings);
  return snap;
}

// Fresh data the page fetched itself — merge without a network call.
async function mergeFromPage(kind, data) {
  const now = Date.now();
  const settings = await getSettings();
  const st = await loadState();
  const snap = Object.assign({ fetchedAt: now }, st.snapshot || {});
  if (kind === "usage") {
    const u = parseUsage(data, now);
    if (!u || (!u.windows.length && !u.extra.length)) return;
    snap.usage = u; snap.usageAt = now; snap.usageUnavailable = false; snap.error = null;
    if (u.plan) snap.plan = u.plan;
  } else if (kind === "features") {
    const f = parseFeatures(data, now);
    if (!f) return;
    snap.features = f;
  }
  updateHistoryAndForecast(snap, st.history, now);
  const fired = await checkThresholds(snap, st.fired, settings);
  await saveState(snap, st.history, fired);
  await updateBadge(snap, settings);
}

const followUpTimers = new Map();   // ctx -> timer
function scheduleFollowUp(ms) {
  const ctx = CTX;   // the follow-up belongs to the window that asked
  clearTimeout(followUpTimers.get(ctx));
  followUpTimers.set(ctx, setTimeout(() => {
    followUpTimers.delete(ctx);
    pollCtx(ctx, { features: true }).catch(() => {});
  }, ms));
}

// ---------- messages log, caps ----------

async function logMessage(model, at) {
  const got = await chrome.storage.local.get(K("msgLog"));
  const msgLog = got[K("msgLog")];
  const log = Array.isArray(msgLog) ? msgLog : [];
  const now = Date.now();
  log.push({ t: at || now, m: String(model || "auto").slice(0, 80) });
  const pruned = log.filter((e) => now - e.t <= LOG_KEEP_MS).slice(-LOG_MAX);
  await chrome.storage.local.set({ [K("msgLog")]: pruned });

  const settings = await getSettings();
  if (settings.notify && settings.modelCaps.length) {
    for (const c of cumCapUsage(pruned, settings.modelCaps, now)) {
      if (!cumModelMatches(c.cap.model, model)) continue;
      const pct = c.limit ? (c.used / c.limit) * 100 : 0;
      const ths = (settings.thresholds || []).filter((t) => pct >= t);
      if (!ths.length) continue;
      const top = Math.max(...ths);
      const gotF = await chrome.storage.local.get(K("fired"));
      const f = Array.isArray(gotF[K("fired")]) ? gotF[K("fired")] : [];
      const bucket = Math.floor(now / (CUM_CONFIG.WINDOWS[c.cap.window] || CUM_CONFIG.WINDOWS.day).ms);
      const fid = `cap|${c.cap.model}|${c.cap.window}|${bucket}|${top}`;
      if (f.includes(fid)) continue;
      f.push(fid);
      await chrome.storage.local.set({ [K("fired")]: f.slice(-300) });
      notify("cgum-" + fid, `${c.cap.model}: ${c.used} of ${c.limit} used`,
        `You've sent ${c.used} of your ${c.limit} ${c.cap.model} messages in the last ${(CUM_CONFIG.WINDOWS[c.cap.window] || {}).label || c.cap.window} (counted in this browser).`);
    }
  }
}

async function recordCap(msg) {
  const gotC = await chrome.storage.local.get(K("capHits"));
  const hits = gotC[K("capHits")] || {};
  const now = Date.now();
  const key = String(msg.model || "auto");
  const resetAt = msg.resetAt ? Date.parse(msg.resetAt) : null;
  const prev = hits[key];
  hits[key] = { model: key, at: now, resetAt: isNaN(resetAt) ? null : resetAt, message: msg.message || "" };
  for (const k of Object.keys(hits)) {
    const h = hits[k];
    if ((h.resetAt && h.resetAt < now) || (!h.resetAt && now - h.at > 6 * 3600e3)) delete hits[k];
  }
  await chrome.storage.local.set({ [K("capHits")]: hits });
  const settings = await getSettings();
  if (settings.notify && (!prev || now - prev.at > 30 * 60e3)) {
    const when = hits[key] && hits[key].resetAt ? ` Resets in ${cumFmtDuration(hits[key].resetAt - now)}.` : "";
    notify("cgum-cap-" + key + "-" + now, `ChatGPT limit reached${key !== "auto" ? " · " + key : ""}`,
      (msg.message || "ChatGPT reported a usage limit.").slice(0, 180) + when);
  }
}

// ---------- chat tokens ----------

const tokenCache = new Map(); // id -> { at, result }

async function chatTokens(conversationId, force) {
  if (!conversationId) return null;
  const ck = (CURRENT_ACCT || CTX) + "|" + conversationId;   // v1.0.3: per account
  const c = tokenCache.get(ck);
  if (!force && c && Date.now() - c.at < 20000) return c.result;
  const r = await api("/backend-api/conversation/" + conversationId);
  if (!r || !r.ok || !r.json) return null;
  const result = CUM_TOKENS.fromConversation(r.json);
  tokenCache.set(ck, { at: Date.now(), result });
  if (tokenCache.size > 50) tokenCache.delete(tokenCache.keys().next().value);
  return result;
}

// ---------- wiring ----------

async function schedulePolling() {
  const s = await getSettings();
  await chrome.alarms.clear(POLL_ALARM);
  await chrome.alarms.create(POLL_ALARM, { periodInMinutes: Math.max(1, Number(s.pollMinutes) || 1), delayInMinutes: 0.1 });
}

// Uninstall page gets ?v=<version>&b=<browser>&d=<days installed> so feedback
// can be read in context. Nothing else about the user is sent. Days change, so
// the URL is refreshed on startup and once a day from the poll alarm.
function browserName() {
  const ua = (self.navigator && navigator.userAgent) || "";
  if (/Edg\//.test(ua)) return "edge";
  if (/OPR\//.test(ua)) return "opera";
  if (self.navigator && navigator.brave) return "brave";
  if (/Firefox\//.test(ua)) return "firefox";
  return "chrome";
}

let uninstallUrlSetAt = 0;
async function updateUninstallUrl() {
  if (!CUM_CONFIG.UNINSTALL_URL) return;
  try {
    let { installedAt } = await chrome.storage.local.get("installedAt");
    if (!installedAt) { installedAt = Date.now(); await chrome.storage.local.set({ installedAt }); }
    const days = Math.max(0, Math.floor((Date.now() - installedAt) / 86400e3));
    const base = cumUtm(CUM_CONFIG.UNINSTALL_URL, "uninstall", "feedback");
    const url = base + "&v=" + encodeURIComponent(chrome.runtime.getManifest().version) +
      "&b=" + encodeURIComponent(browserName()) + "&d=" + days;
    await chrome.runtime.setUninstallURL(url);
    uninstallUrlSetAt = Date.now();
  } catch (_) {}
}

chrome.runtime.onInstalled.addListener(async (details) => {
  const { settings } = await chrome.storage.local.get("settings");
  await chrome.storage.local.set({ settings: mergeDefaults(settings) });
  if (details.reason === "install") await chrome.storage.local.set({ installedAt: Date.now() });
  await schedulePolling();
  if (details.reason === "install" && CUM_CONFIG.INSTALL_URL) {
    chrome.tabs.create({ url: cumUtm(CUM_CONFIG.INSTALL_URL, "install", "onboarding") });
  }
  await updateUninstallUrl();
  pollAll({ force: true }).catch(() => {});
});

chrome.runtime.onStartup.addListener(() => { schedulePolling(); updateUninstallUrl(); pollAll().catch(() => {}); });

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name !== POLL_ALARM) return;
  pollAll().catch(() => {});
  if (Date.now() - uninstallUrlSetAt > 12 * 3600e3) updateUninstallUrl();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.settings) return;
  const o = mergeDefaults(changes.settings.oldValue), n = mergeDefaults(changes.settings.newValue);
  if (o.pollMinutes !== n.pollMinutes) schedulePolling();
  if (o.badge !== n.badge) refreshAllBadges(n);   // v1.0.3: every window, not only the normal one
});

// v1.0.3: a login cookie changed in ANY jar (sign in / out, workspace switch):
// forget who each window is, and re-read soon. Rate-limited, because a session
// cookie can also be re-issued while the page is simply open.
let cookiePollAt = 0, cookieTimer = null;
if (chrome.cookies && chrome.cookies.onChanged) {
  chrome.cookies.onChanged.addListener(({ cookie }) => {
    const domain = String((cookie && cookie.domain) || "").replace(/^\./, "");
    if (!(domain === "chatgpt.com" || domain.endsWith(".chatgpt.com"))) return;
    if (cookie.name !== "_account" && !/session-token/.test(cookie.name)) return;
    forgetIdentities();
    if (cookieTimer) return;
    cookieTimer = setTimeout(() => {
      cookieTimer = null;
      if (Date.now() - cookiePollAt < 20000) return;
      cookiePollAt = Date.now();
      pollAll().catch(() => {});
    }, 1000);
  });
}

chrome.notifications.onClicked.addListener((id) => {
  if (!String(id).startsWith("cgum-")) return;
  chatgptTabs().then((tabs) => {
    if (tabs.length) { chrome.tabs.update(tabs[0].id, { active: true }); chrome.windows.update(tabs[0].windowId, { focused: true }); }
    else chrome.tabs.create({ url: ORIGIN + "/" });
  });
  chrome.notifications.clear(id);
});

async function handleMessage(msg, sender) {
  switch (msg.type) {
    case "whoami":
      // v1.0.3: tells a tab / popup which storage prefix is ITS account's.
      return { ctx: CTX, prefix: acctPrefix(), error: CURRENT_ID_ERROR ? (CURRENT_ID_ERROR.code || "error") : null };
    case "refresh": {
      const snap = await refresh({ force: !!msg.force, forceAuth: !!msg.force });
      return { snapshot: snap };
    }
    case "message_sent":
      await logMessage(msg.model, msg.at);
      return { ok: true };
    case "completion_done":
      scheduleFollowUp(msg.failed ? 1500 : 4000);
      return { ok: true };
    case "cap_hit":
      await recordCap(msg);
      scheduleFollowUp(1500);
      return { ok: true };
    case "page_usage":
      await mergeFromPage("usage", msg.data);
      return { ok: true };
    case "page_features":
      await mergeFromPage("features", msg.data);
      return { ok: true };
    case "chatTokens":
      try { return { result: await chatTokens(msg.conversationId, !!msg.force) }; }
      catch (e) { if (e && e.message === "ctx_expired") throw e; return { error: e.code || "error" }; }
    case "open-review": {
      await chrome.storage.local.set({ rate_us_clicked: true, rate_us_clicked_at: Date.now() });
      const url = cumStoreUrl() || CUM_CONFIG.PRODUCT_URL;
      await chrome.tabs.create({ url });
      return { ok: true };
    }
    case "openOptions":
      chrome.runtime.openOptionsPage();
      return { ok: true };
    case "openTab":
      if (msg.url) chrome.tabs.create({ url: msg.url });
      return { ok: true };
    default:
      return null;
  }
}

// v1.0.3: every message is handled inside the cookie jar it came from: the
// sender's tab, or msg.tabId for the popup (which has no sender tab).
const CTX_FREE_MESSAGES = new Set(["open-review", "openOptions", "openTab"]);
async function ctxForMessage(msg, sender) {
  if (sender && sender.tab) return ctxOfTab(sender.tab);
  if (msg && typeof msg.tabId === "number") {
    try { return ctxOfTab(await chrome.tabs.get(msg.tabId)); } catch (_) {}
  }
  return "default";
}
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;
  const fail = (e) => sendResponse({ error: String((e && e.message) || e) });   // never leave the caller hanging
  if (CTX_FREE_MESSAGES.has(msg.type)) { handleMessage(msg, sender).then(sendResponse, fail); return true; }
  ctxForMessage(msg, sender)
    .then((ctx) => inCtx(ctx, () => handleMessage(msg, sender)))
    .then(sendResponse, fail);
  return true;
});
