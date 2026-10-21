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
      r = await fetch(ORIGIN + "/api/auth/session", { credentials: "include", cache: "no-store", headers: { accept: "application/json" } });
    } catch (e) {
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
    r = await fetch(ORIGIN + path, {
      method: (opts && opts.method) || "GET",
      credentials: "include",
      cache: "no-store",
      headers,
      body: opts && opts.body ? JSON.stringify(opts.body) : undefined
    });
  } catch (e) { throw apiError("network", "Couldn't reach chatgpt.com"); }
  if (r.status === 401 && !retried) { auth = null; return directApi(path, opts, true); }
  const json = await r.json().catch(() => null);
  return { status: r.status, ok: r.ok, json };
}

async function chatgptTabs() {
  try { return await chrome.tabs.query({ url: ORIGIN + "/*" }); } catch (_) { return []; }
}

async function tabApi(path, opts) {
  const tabs = await chatgptTabs();
  for (const t of tabs) {
    try {
      const res = await chrome.tabs.sendMessage(t.id, { type: "proxyFetch", path, opts });
      if (res && res.status) return res;
    } catch (_) {}
  }
  return null;
}

async function api(path, opts) {
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
  const s = await chrome.storage.local.get(["snapshot", "history", "capHits", "fired", "msgLog"]);
  return {
    snapshot: s.snapshot || null,
    history: s.history || {},
    capHits: s.capHits || {},
    fired: s.fired || [],
    msgLog: s.msgLog || []
  };
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
    chrome.notifications.create(id, {
      type: "basic",
      iconUrl: "icons/icon128.png",
      title,
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

async function updateBadge(snap, settings) {
  try {
    const p = snap && snap.usage && snap.usage.windows[0];
    if (!settings.badge || !p || p.pct == null) { await chrome.action.setBadgeText({ text: "" }); return; }
    const pct = Math.round(p.pct);
    await chrome.action.setBadgeText({ text: pct >= 100 ? "MAX" : String(pct) });
    const colors = { green: "#10a37f", amber: "#d99a06", orange: "#ea6a12", red: "#dc2626" };
    await chrome.action.setBadgeBackgroundColor({ color: colors[cumLevel(pct)] || "#555" });
    try { await chrome.action.setBadgeTextColor({ color: "#ffffff" }); } catch (_) {}
  } catch (_) {}
}

// ---------- refresh ----------

let refreshing = null;

async function refresh(opts) {
  opts = opts || {};
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const now = Date.now();
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
      if (opts.forceAuth) auth = null;
      // Plan name is a nicety; a failed session read here is handled (and
      // relayed through a tab if needed) by api() below.
      try { const a = await getAuth(false); snap.plan = a.plan || snap.plan; }
      catch (e) { if (e.code === "signed_out") throw e; }
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
        }).catch(() => null);
        if (f && f.ok && f.json) snap.features = parseFeatures(f.json, now);
      }
    } catch (e) {
      snap.error = { code: e.code || "error", message: e.message || String(e) };
      if (e.code === "signed_out") { snap.usage = null; snap.features = null; }
    }

    updateHistoryAndForecast(snap, st.history, now);
    const fired = await checkThresholds(snap, st.fired, settings);
    await chrome.storage.local.set({ snapshot: snap, history: st.history, fired });
    await updateBadge(snap, settings);
    return snap;
  })();
  try { return await refreshing; } finally { refreshing = null; }
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
  await chrome.storage.local.set({ snapshot: snap, history: st.history, fired });
  await updateBadge(snap, settings);
}

let followUpTimer = null;
function scheduleFollowUp(ms) {
  clearTimeout(followUpTimer);
  followUpTimer = setTimeout(() => { refresh({ features: true }).catch(() => {}); }, ms);
}

// ---------- messages log, caps ----------

async function logMessage(model, at) {
  const { msgLog } = await chrome.storage.local.get("msgLog");
  const log = Array.isArray(msgLog) ? msgLog : [];
  const now = Date.now();
  log.push({ t: at || now, m: String(model || "auto").slice(0, 80) });
  const pruned = log.filter((e) => now - e.t <= LOG_KEEP_MS).slice(-LOG_MAX);
  await chrome.storage.local.set({ msgLog: pruned });

  const settings = await getSettings();
  if (settings.notify && settings.modelCaps.length) {
    for (const c of cumCapUsage(pruned, settings.modelCaps, now)) {
      if (!cumModelMatches(c.cap.model, model)) continue;
      const pct = c.limit ? (c.used / c.limit) * 100 : 0;
      const ths = (settings.thresholds || []).filter((t) => pct >= t);
      if (!ths.length) continue;
      const top = Math.max(...ths);
      const { fired } = await chrome.storage.local.get("fired");
      const f = Array.isArray(fired) ? fired : [];
      const bucket = Math.floor(now / (CUM_CONFIG.WINDOWS[c.cap.window] || CUM_CONFIG.WINDOWS.day).ms);
      const fid = `cap|${c.cap.model}|${c.cap.window}|${bucket}|${top}`;
      if (f.includes(fid)) continue;
      f.push(fid);
      await chrome.storage.local.set({ fired: f.slice(-300) });
      notify("cgum-" + fid, `${c.cap.model}: ${c.used} of ${c.limit} used`,
        `You've sent ${c.used} of your ${c.limit} ${c.cap.model} messages in the last ${(CUM_CONFIG.WINDOWS[c.cap.window] || {}).label || c.cap.window} (counted in this browser).`);
    }
  }
}

async function recordCap(msg) {
  const { capHits } = await chrome.storage.local.get("capHits");
  const hits = capHits || {};
  const now = Date.now();
  const key = String(msg.model || "auto");
  const resetAt = msg.resetAt ? Date.parse(msg.resetAt) : null;
  const prev = hits[key];
  hits[key] = { model: key, at: now, resetAt: isNaN(resetAt) ? null : resetAt, message: msg.message || "" };
  for (const k of Object.keys(hits)) {
    const h = hits[k];
    if ((h.resetAt && h.resetAt < now) || (!h.resetAt && now - h.at > 6 * 3600e3)) delete hits[k];
  }
  await chrome.storage.local.set({ capHits: hits });
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
  const c = tokenCache.get(conversationId);
  if (!force && c && Date.now() - c.at < 20000) return c.result;
  const r = await api("/backend-api/conversation/" + conversationId);
  if (!r || !r.ok || !r.json) return null;
  const result = CUM_TOKENS.fromConversation(r.json);
  tokenCache.set(conversationId, { at: Date.now(), result });
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
  refresh({ force: true }).catch(() => {});
});

chrome.runtime.onStartup.addListener(() => { schedulePolling(); updateUninstallUrl(); refresh({}).catch(() => {}); });

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name !== POLL_ALARM) return;
  refresh({}).catch(() => {});
  if (Date.now() - uninstallUrlSetAt > 12 * 3600e3) updateUninstallUrl();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.settings) return;
  const o = mergeDefaults(changes.settings.oldValue), n = mergeDefaults(changes.settings.newValue);
  if (o.pollMinutes !== n.pollMinutes) schedulePolling();
  if (o.badge !== n.badge) chrome.storage.local.get("snapshot").then(({ snapshot }) => updateBadge(snapshot, n));
});

chrome.notifications.onClicked.addListener((id) => {
  if (!String(id).startsWith("cgum-")) return;
  chatgptTabs().then((tabs) => {
    if (tabs.length) { chrome.tabs.update(tabs[0].id, { active: true }); chrome.windows.update(tabs[0].windowId, { focused: true }); }
    else chrome.tabs.create({ url: ORIGIN + "/" });
  });
  chrome.notifications.clear(id);
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;
  (async () => {
    switch (msg.type) {
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
        catch (e) { return { error: e.code || "error" }; }
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
  })().then(sendResponse, (e) => sendResponse({ error: String(e && e.message || e) }));
  return true;
});
