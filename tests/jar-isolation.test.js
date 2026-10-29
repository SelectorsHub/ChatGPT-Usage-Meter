// Simulates a normal and an incognito cookie jar signed in to different/same ChatGPT accounts,
// account hops, bot-wall fallbacks, a private window without a chatgpt.com tab and legacy-data migration.
// Usage: node tests/jar-isolation.test.js <path-to-extension-folder>
const fs = require("fs"), vm = require("vm"), path = require("path");
const dir = process.argv[2];
const read = (f) => fs.readFileSync(path.join(dir, f), "utf8");

// --- fake browser: two cookie jars, each signed in to a different account ---
const UUID = (c) => [8, 4, 4, 4, 12].map((n) => c.repeat(n)).join("-");
const jars = {
  default:   { user: "user-MAIN",   acct: UUID("a"), pct: 11 },
  incognito: { user: "user-SECOND", acct: UUID("b"), pct: 77 },
};
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const tokenOf = (jar) => "h." + b64u({ exp: Math.floor(Date.now() / 1000) + 3600, "https://api.openai.com/auth": { chatgpt_user_id: jars[jar].user } }) + ".s";
const sessionJson = (jar) => ({ accessToken: tokenOf(jar), expires: new Date(Date.now() + 3600e3).toISOString(), user: { id: jars[jar].user, email: jar + "@example.com" }, account: { id: jars[jar].acct, planType: "plus" } });
const resp = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body, text: async () => JSON.stringify(body) });
const win = (pct, secs) => ({ used_percent: pct, reset_at: Math.floor(Date.now() / 1000) + 3600, limit_window_seconds: secs });
const usageBody = (pct) => ({ plan_type: "plus", rate_limit: { primary_window: win(pct, 18000), secondary_window: win(5, 604800) } });
function backend(jar, p) {
  if (p === "/backend-api/wham/usage") return { status: 200, body: usageBody(jars[jar].pct) };
  if (p === "/backend-api/conversation/init") return { status: 200, body: { limits_progress: [], default_model_slug: "auto" } };
  return { status: 404, body: {} };
}

const T1 = { id: 1, url: "https://chatgpt.com/c/a", incognito: false, active: true };
const T2 = { id: 2, url: "https://chatgpt.com/c/b", incognito: true,  active: true };
const tabs = [T1, T2];
const fetchLog = [], badges = [], notes = [];
const store = {};
let workerBlocked = false, sessionBlocked = false;

const noop = () => {};
const ev = () => ({ addListener: noop });
const chrome = {
  runtime: { onMessage: { addListener: (f) => (chrome._onMsg = f) }, onInstalled: ev(), onStartup: ev(), lastError: null,
             getURL: (p) => p, setUninstallURL: async () => {}, getManifest: () => ({ version: "1.0.3" }), id: "x" },
  storage: { onChanged: ev(), local: {
    get: async (k) => { const keys = typeof k === "string" ? [k] : Array.isArray(k) ? k : Object.keys(k || {}); const o = {}; for (const x of keys) if (x in store) o[x] = JSON.parse(JSON.stringify(store[x])); return o; },
    set: async (o) => { for (const k in o) store[k] = JSON.parse(JSON.stringify(o[k])); },
    remove: async (k) => { for (const x of (Array.isArray(k) ? k : [k])) delete store[x]; } } },
  alarms: { create: async () => {}, clear: async () => {}, onAlarm: ev() },
  action: { setBadgeText: async (o) => badges.push(o), setBadgeBackgroundColor: async () => {}, setBadgeTextColor: async () => {} },
  notifications: { create: (id, o) => notes.push({ id, title: o.title }), onClicked: ev(), clear: noop },
  cookies: { onChanged: ev(), get: async (d) => (d.name === "_account" ? { value: jars.default.acct } : null) },   // the worker only ever sees the DEFAULT jar
  windows: { update: noop },
  tabs: {
    query: async (q) => tabs.filter((t) => !q || !q.url || t.url.startsWith("https://chatgpt.com")),
    get: async (id) => [T1, T2].find((t) => t.id === id),
    create: async () => ({}), update: noop, onActivated: ev(), onUpdated: ev(),
    // proxyFetch / proxySession: the "content script" of that tab talks with THAT tab's jar
    sendMessage: async (id, msg) => {
      const jar = [T1, T2].find((t) => t.id === id).incognito ? "incognito" : "default";
      if (msg.type === "proxySession") {
        fetchLog.push({ via: "tab" + id, jar, path: "/api/auth/session" });
        return { status: 200, identity: ctx.cumIdentity(sessionJson(jar), jars[jar].acct) };
      }
      if (msg.type === "proxyFetch") {
        fetchLog.push({ via: "tab" + id, jar, path: msg.path });
        const r = backend(jar, msg.path);
        return { status: r.status, ok: r.status === 200, json: r.body };
      }
      return null;
    },
  },
};
// the worker's own fetch always carries the DEFAULT jar's cookies
const fetch = async (url, init) => {
  const p = new URL(url).pathname;
  fetchLog.push({ via: "worker", jar: "default", path: p });
  const blocked = { status: 403, ok: false, json: async () => { throw new Error("not json"); }, text: async () => "<html>" };
  if (p === "/api/auth/session") return sessionBlocked ? blocked : resp(200, sessionJson("default"));
  if (workerBlocked) return blocked;
  if (!init || !init.headers || init.headers.authorization !== "Bearer " + tokenOf("default")) return resp(401, {});
  const r = backend("default", p);
  return resp(r.status, r.body);
};
const ctx = { chrome, fetch, console: { log: noop, info: noop, warn: noop, error: console.error, debug: noop }, setTimeout, clearTimeout, setInterval, Date, URL, atob, AbortController, importScripts: noop, self: { navigator: { userAgent: "test" } } };
vm.createContext(ctx);
for (const f of ["shared/config.js", "shared/tokens.js", "background.js"]) vm.runInContext(read(f), ctx, { filename: f });

const run = (code) => vm.runInContext(code, ctx);
const forget = () => run("forgetIdentities()");   // what the login-cookie listener does
const pollAll = () => run("pollAll()");
const ask = (msg, sender) => new Promise((res) => chrome._onMsg(msg, sender || {}, res));
const P = (jar, who) => "acct:" + (who || jars[jar]).user + "~" + (who || jars[jar]).acct + ":";
const MAIN = { user: "user-MAIN", acct: UUID("a") }, SECOND = { user: "user-SECOND", acct: UUID("b") }, THIRD = { user: "user-THIRD", acct: UUID("c") };
const pctOf = (k) => store[k] && store[k].usage && store[k].usage.windows[0] && store[k].usage.windows[0].pct;
let failures = 0;
const check = (name, cond, extra) => { console.log((cond ? "PASS " : "FAIL ") + name + (cond ? "" : "  " + JSON.stringify(extra))); if (!cond) failures++; };

(async () => {
  // identity helpers
  check("user id falls back to the JWT claim", ctx.cumUserId({ accessToken: tokenOf("default") }) === "user-MAIN");
  check("same user, other workspace -> other key", ctx.cumAcctKey({ userId: "u", accountId: "w1" }) !== ctx.cumAcctKey({ userId: "u", accountId: "w2" }));

  // legacy (pre-1.0.3) un-prefixed data of the main account must be migrated, not lost
  store["snapshot"] = { fetchedAt: 1, usage: null, legacy: true };
  store["fired"] = ["old|1|75"];
  store["msgLog"] = [{ t: Date.now(), m: "gpt-x" }];

  // 1) two different accounts, normal + incognito
  await pollAll();
  const wham = (v) => fetchLog.filter((f) => f.via === v && f.path === "/backend-api/wham/usage");
  check("normal account stored under its own key", pctOf(P("default") + "snapshot") === 11, Object.keys(store));
  check("incognito account stored under ITS key", pctOf(P("incognito") + "snapshot") === 77, Object.keys(store));
  check("pointers tell each window its account", store["ptr:default"] === P("default") && store["ptr:incognito"] === P("incognito"), { d: store["ptr:default"], i: store["ptr:incognito"] });
  check("no window-level fallback keys when both accounts are known", !Object.keys(store).some((k) => k.startsWith("ctx:")), Object.keys(store));
  check("legacy data migrated under its account, old keys removed", store[P("default") + "fired"].includes("old|1|75") && store[P("default") + "msgLog"].length === 1 && !("snapshot" in store) && !("fired" in store) && !("msgLog" in store), Object.keys(store));
  check("the worker asked for usage once (normal window only); the incognito one went through its own tab", wham("worker").length === 1 && wham("tab2").length === 1 && wham("tab1").length === 0, fetchLog);
  check("incognito requests only ever left through the incognito tab", fetchLog.filter((f) => f.via === "tab2").every((f) => f.jar === "incognito"));

  // 2) each window is told its own account
  const w1 = await ask({ type: "whoami" }, { tab: T1 }), w2 = await ask({ type: "whoami" }, { tab: T2 }), wp = await ask({ type: "whoami", tabId: 2 }, {});
  check("whoami: tab 1 -> main, tab 2 -> second, popup of window 2 -> second", w1.prefix === P("default") && w2.prefix === P("incognito") && wp.prefix === P("incognito"), { w1, w2, wp });

  // 3) page-side events land in the window's own account
  await ask({ type: "message_sent", model: "gpt-x", at: Date.now() }, { tab: T2 });
  check("message sent in incognito counted for the second account only", (store[P("incognito") + "msgLog"] || []).length === 1 && store[P("default") + "msgLog"].length === 1, Object.keys(store));
  await ask({ type: "page_usage", data: usageBody(99) }, { tab: T2 });
  check("usage seen by the incognito page merged into the second account only", pctOf(P("incognito") + "snapshot") === 99 && pctOf(P("default") + "snapshot") === 11, { s: pctOf(P("incognito") + "snapshot"), m: pctOf(P("default") + "snapshot") });

  // 4) badges and notifications
  check("global badge only ever shows the normal account", badges.filter((b) => b.tabId == null).every((b) => b.text === "" || b.text === "11"), badges);
  check("incognito tab gets its own tab-specific badge", badges.filter((b) => b.tabId === 2).some((b) => b.text === "99"), badges);
  check("incognito alerts are labelled and have their own id", notes.length > 0 && notes.every((n) => /private window/.test(n.title) && /\|incognito$/.test(n.id)), notes);

  // 5) incognito hops to ANOTHER account and back: each account keeps its own entry
  store[P("incognito") + "fired"] = ["keep-me"];
  jars.incognito = { user: "user-THIRD", acct: UUID("c"), pct: 33 }; forget(); await pollAll();
  check("third account got its own entry, second untouched", pctOf(P(null, THIRD) + "snapshot") === 33 && store[P(null, SECOND) + "fired"][0] === "keep-me" && store["ptr:incognito"] === P(null, THIRD), Object.keys(store));
  jars.incognito = { user: "user-SECOND", acct: UUID("b"), pct: 90 }; forget(); await pollAll();
  check("back on the second account: its data restored, not wiped", pctOf(P(null, SECOND) + "snapshot") === 90 && store[P(null, SECOND) + "fired"].includes("keep-me"), store[P(null, SECOND) + "fired"]);
  check("normal account untouched by all of this", pctOf(P(null, MAIN) + "snapshot") === 11);

  // 6) SAME account in normal and incognito windows: one shared entry
  const before = Object.keys(store).filter((k) => k.startsWith("acct:")).length;
  jars.incognito = { user: "user-MAIN", acct: jars.default.acct, pct: 42 }; forget(); await pollAll();
  const a = await ask({ type: "whoami" }, { tab: T1 }), c = await ask({ type: "whoami" }, { tab: T2 });
  check("same account in both windows -> same entry", a.prefix === c.prefix && a.prefix === P(null, MAIN), { a, c });
  check("...and no extra account entry was created", Object.keys(store).filter((k) => k.startsWith("acct:")).length === before, Object.keys(store));

  // 7) the worker is refused (bot wall): the relay must use a tab of the SAME window, never the incognito one
  jars.incognito = { user: "user-SECOND", acct: UUID("b"), pct: 90 };
  jars.default.pct = 15; forget(); workerBlocked = true; sessionBlocked = true;
  const mark = fetchLog.length;
  await run('pollCtx("default")');
  const used = fetchLog.slice(mark);
  check("bot wall: normal window refreshed through its own tab", pctOf(P(null, MAIN) + "snapshot") === 15 && used.some((f) => f.via === "tab1"), { used, pct: pctOf(P(null, MAIN) + "snapshot") });
  check("bot wall: the incognito tab was never used for the normal account", used.every((f) => f.via !== "tab2"), used);
  workerBlocked = false; sessionBlocked = false;

  // 8) private window without a chatgpt.com tab: nothing is fetched, nothing of the normal account is shown
  T2.url = "https://example.com/"; forget();
  const mark2 = fetchLog.length;
  await run('pollCtx("incognito")');
  const snap = store["ctx:incognito:snapshot"];
  check("no tab: window-level snapshot says so", snap && snap.error && snap.error.code === "no_tab" && !snap.usage, snap);
  check("no tab: no request was made for that window", fetchLog.slice(mark2).length === 0, fetchLog.slice(mark2));
  check("no tab: the window points at its own keys, not the normal account's", (await ask({ type: "whoami", tabId: 2 }, {})).prefix === "ctx:incognito:", store["ptr:incognito"]);

  // 9) the private window opens chatgpt.com again: its tab gets ITS account's badge back
  T2.url = "https://chatgpt.com/c/b"; forget(); badges.length = 0;
  await ctx.refreshTabBadge(T2);
  check("tab badge repainted from the second account's data", badges.some((b) => b.tabId === 2 && b.text === "90") && badges.every((b) => b.tabId === 2), badges);

  console.log(failures ? "\nRESULT: FAIL (" + failures + ")" : "\nRESULT: PASS - accounts isolated, stored per account");
  process.exit(failures ? 1 : 0);
})();
