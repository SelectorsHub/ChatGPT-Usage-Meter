// content-script.js (isolated world, document_idle)
//
// 1. Bridge: relays what page-injector.js sees (messages sent, cap hits,
//    usage responses, stream ends) to the service worker.
// 2. proxyFetch: lets the service worker run a same-origin API call through
//    this tab when a direct call from the worker is refused.
// 3. The usage strip, mounted just above ChatGPT's composer.
//
// Everything is drawn with DOM APIs — no innerHTML from data, no remote
// resources (chatgpt.com's CSP would block extension images anyway; tool
// icons are read as data: URLs).

(function () {
  if (window.__cgumContent) return;
  window.__cgumContent = true;

  const C = CUM_CONFIG;
  const HOST_ID = "chatgpt-usage-overlay";
  const HIDE_MS = 12 * 3600e3;
  const UUID_IN_PATH = /\/c\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

  let alive = true;
  const send = (msg) => {
    if (!alive) return Promise.resolve(null);
    try { return chrome.runtime.sendMessage(msg).catch(() => null); }
    catch (_) { alive = false; return Promise.resolve(null); } // extension reloaded
  };

  // ---------------------------------------------------------------- state
  const S = {
    settings: null,
    snapshot: null,
    capHits: {},
    msgLog: [],
    hiddenUntil: 0,
    promoDismissed: "",
    convId: null,
    tokens: null,          // result for convId
    tokensFor: null,
    fit: 0,
    autoCollapsed: false
  };
  const pageConversations = new Map(); // id -> tokens result from the page's own fetch

  // ---------------------------------------------------------------- bridge
  window.addEventListener("message", (ev) => {
    if (ev.source !== window || !ev.data || ev.data.source !== "chatgpt-usage-meter") return;
    const p = ev.data.payload || {};
    switch (p.kind) {
      case "message_sent":
        send({ type: "message_sent", model: p.model, at: p.at });
        break;
      case "cap_hit":
        send({ type: "cap_hit", model: p.model, message: p.message, resetAt: p.resetAt });
        break;
      case "completion_done":
        send({ type: "completion_done", failed: !!p.failed });
        setTimeout(() => loadTokens(true), 1500);
        break;
      case "usage":
        send({ type: "page_usage", data: p.data });
        break;
      case "features":
        send({ type: "page_features", data: p.data });
        break;
      case "conversation": {
        const r = CUM_TOKENS.fromConversation(p.data);
        if (r) {
          pageConversations.set(p.conversationId, r);
          if (p.conversationId === S.convId) { S.tokens = r; S.tokensFor = S.convId; render(); }
        }
        break;
      }
    }
  });

  let cachedToken = null;
  async function pageToken(force) {
    if (!force && cachedToken && cachedToken.exp > Date.now() + 60000) return cachedToken.token;
    const r = await fetch("/api/auth/session", { credentials: "include", cache: "no-store" });
    const j = await r.json().catch(() => null);
    if (!j || !j.accessToken) return null;
    cachedToken = { token: j.accessToken, exp: j.expires ? Date.parse(j.expires) : Date.now() + 10 * 60e3 };
    return cachedToken.token;
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.type !== "proxyFetch") return;
    (async () => {
      try {
        const token = await pageToken(false);
        if (!token) return { status: 401, ok: false, json: null };
        const headers = { accept: "application/json", authorization: "Bearer " + token };
        const acct = (document.cookie.match(/(?:^|;\s*)_account=([^;]+)/) || [])[1];
        if (acct && /^[0-9a-f-]{36}$/i.test(acct)) headers["chatgpt-account-id"] = acct;
        const o = msg.opts || {};
        if (o.body) headers["content-type"] = "application/json";
        const r = await fetch(msg.path, { method: o.method || "GET", credentials: "include", cache: "no-store", headers, body: o.body ? JSON.stringify(o.body) : undefined });
        return { status: r.status, ok: r.ok, json: await r.json().catch(() => null) };
      } catch (e) {
        return { status: 0, ok: false, json: null };
      }
    })().then(sendResponse);
    return true;
  });

  // ---------------------------------------------------------------- storage
  async function loadAll() {
    const s = await chrome.storage.local.get(["settings", "snapshot", "capHits", "msgLog", "stripHiddenUntil", "promoDismissed"]);
    S.settings = mergeSettings(s.settings);
    S.snapshot = s.snapshot || null;
    S.capHits = s.capHits || {};
    S.msgLog = s.msgLog || [];
    S.hiddenUntil = s.stripHiddenUntil || 0;
    S.promoDismissed = s.promoDismissed || "";
  }

  function mergeSettings(s) {
    const d = C.DEFAULT_SETTINGS; s = s || {};
    return Object.assign({}, d, s, { fields: Object.assign({}, d.fields, s.fields || {}) },
      { modelCaps: Array.isArray(s.modelCaps) ? s.modelCaps : [] });
  }

  async function saveSettings(patch) {
    const { settings } = await chrome.storage.local.get("settings");
    const cur = mergeSettings(settings);
    const next = Object.assign({}, cur, patch);
    if (patch.fields) next.fields = Object.assign({}, cur.fields, patch.fields);
    await chrome.storage.local.set({ settings: next });
  }

  chrome.storage.onChanged.addListener((ch, area) => {
    if (area !== "local") return;
    let dirty = false;
    if (ch.settings) { S.settings = mergeSettings(ch.settings.newValue); dirty = true; }
    if (ch.snapshot) { S.snapshot = ch.snapshot.newValue || null; dirty = true; }
    if (ch.capHits) { S.capHits = ch.capHits.newValue || {}; dirty = true; }
    if (ch.msgLog) { S.msgLog = ch.msgLog.newValue || []; dirty = true; }
    if (ch.stripHiddenUntil) { S.hiddenUntil = ch.stripHiddenUntil.newValue || 0; dirty = true; }
    if (ch.promoDismissed) { S.promoDismissed = ch.promoDismissed.newValue || ""; dirty = true; }
    if (dirty) render();
  });

  // ---------------------------------------------------------------- chat tokens
  let tokenReq = 0;
  async function loadTokens(force) {
    const id = S.convId;
    if (!id || !S.settings || !S.settings.fields.chatTokens) return;
    if (!force && pageConversations.has(id)) { S.tokens = pageConversations.get(id); S.tokensFor = id; render(); return; }
    const n = ++tokenReq;
    const res = await send({ type: "chatTokens", conversationId: id, force: !!force });
    if (n !== tokenReq || id !== S.convId) return;
    if (res && res.result) { S.tokens = res.result; S.tokensFor = id; pageConversations.set(id, res.result); render(); }
  }

  function watchUrl() {
    let last = "";
    setInterval(() => {
      if (location.href === last) return;
      last = location.href;
      const m = UUID_IN_PATH.exec(location.pathname);
      const id = m ? m[1] : null;
      if (id !== S.convId) {
        S.convId = id;
        S.tokens = id && pageConversations.has(id) ? pageConversations.get(id) : null;
        S.tokensFor = S.tokens ? id : null;
        render();
        if (id) setTimeout(() => loadTokens(false), 900);
      }
    }, 700);
  }

  // ---------------------------------------------------------------- dom helpers
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
      else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? "" : String(v));
    }
    for (const k of kids.flat(3)) {
      if (k == null || k === false) continue;
      el.appendChild(typeof k === "string" || typeof k === "number" ? document.createTextNode(String(k)) : k);
    }
    return el;
  }

  const SVG_NS = "http://www.w3.org/2000/svg";
  function svg(markup, cls) {
    // Static, extension-authored markup only.
    const doc = new DOMParser().parseFromString(`<svg xmlns="${SVG_NS}" ${markup}</svg>`, "image/svg+xml");
    const el = document.importNode(doc.documentElement, true);
    if (cls) el.setAttribute("class", cls);
    return el;
  }
  const ICONS = {
    logo: () => svg(`viewBox="0 0 24 24" width="16" height="16" fill="none"><path d="M3.5 16.5a8.5 8.5 0 0 1 17 0" stroke="currentColor" stroke-opacity=".28" stroke-width="3" stroke-linecap="round"/><path d="M3.5 16.5a8.5 8.5 0 0 1 12.2-7.7" stroke="#10a37f" stroke-width="3" stroke-linecap="round"/><path d="M12 16.5l4.6-5.4" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><circle cx="12" cy="16.5" r="2.1" fill="currentColor"/>`, "cgum-logo-svg"),
    gear: () => svg(`viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>`),
    collapse: () => svg(`viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="11 17 6 12 11 7"/><polyline points="18 17 13 12 18 7"/>`),
    expand: () => svg(`viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="13 17 18 12 13 7"/><polyline points="6 17 11 12 6 7"/>`),
    close: () => svg(`viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/>`),
    hourglass: () => svg(`viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2h12M6 22h12M7 2v4a5 5 0 0 0 10 0V2M7 22v-4a5 5 0 0 1 10 0v4"/>`),
    chat: () => svg(`viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>`),
    star: () => svg(`viewBox="0 0 24 24" width="13" height="13" fill="#f5b301"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z"/>`),
    lock: () => svg(`viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>`)
  };

  // Tool icons: read once as data: URLs (the page CSP won't load
  // chrome-extension: images).
  const iconCache = new Map();
  function toolIcon(name) { return assetDataUrl(`icons/tools/${name}.png`); }
  let logoSrc = null;
  async function assetDataUrl(path) {
    const name = path;
    if (iconCache.has(name)) return iconCache.get(name);
    const p = (async () => {
      try {
        const r = await fetch(chrome.runtime.getURL(path));
        const b = await r.blob();
        return await new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = () => res(null); fr.readAsDataURL(b); });
      } catch (_) { return null; }
    })();
    iconCache.set(name, p);
    return p;
  }

  // ---------------------------------------------------------------- theme
  function isDark() {
    const de = document.documentElement;
    if (de.classList.contains("dark")) return true;
    if (de.classList.contains("light")) return false;
    const cs = de.style.colorScheme || getComputedStyle(de).colorScheme || "";
    if (/dark/.test(cs)) return true;
    return window.matchMedia && matchMedia("(prefers-color-scheme: dark)").matches;
  }

  // ---------------------------------------------------------------- mount
  let host = null;

  function findComposer() {
    const input = document.querySelector("#prompt-textarea") ||
      document.querySelector('form [contenteditable="true"]') ||
      document.querySelector("form textarea");
    if (!input) return null;
    return input.closest("form") || null;
  }

  function ensureMounted() {
    const s = S.settings;
    const wanted = s && s.strip && Date.now() >= S.hiddenUntil;
    const form = wanted ? findComposer() : null;
    if (!form || !form.parentElement) {
      if (host && host.isConnected) host.remove();
      return false;
    }
    if (!host) {
      host = h("div", { id: HOST_ID, "data-cgum": "1" });
      ro.observe(host);
    }
    if (host.parentElement !== form.parentElement || host.nextElementSibling !== form) {
      form.parentElement.insertBefore(host, form);
    }
    host.classList.toggle("cgum-dark", isDark());
    host.classList.toggle("cgum-light", !isDark());
    return true;
  }

  let moScheduled = false;
  const mo = new MutationObserver(() => {
    if (moScheduled) return;
    moScheduled = true;
    requestAnimationFrame(() => {
      moScheduled = false;
      const wasMounted = host && host.isConnected;
      const ok = ensureMounted();
      if (ok && (!wasMounted || !host.firstChild)) render();
    });
  });

  const ro = new ResizeObserver(() => fitStrip());

  // ---------------------------------------------------------------- render
  function pctText(p) { return p == null ? "—" : Math.round(p) + "%"; }

  function seg(cls, title, ...kids) {
    return h("span", { class: "cgum-seg " + (cls || ""), title }, ...kids);
  }

  function meter(win, label, shortLabel, opts) {
    const f = S.settings.fields;
    const lvl = cumLevel(win.pct);
    const reset = win.resetAt ? cumFmtDuration(win.resetAt - Date.now()) : "";
    const title = `${label} usage: ${pctText(win.pct)}` +
      (reset ? `\nResets in ${reset} (${new Date(win.resetAt).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })})` : "") +
      (opts && opts.note ? `\n${opts.note}` : "");
    const lab = h("span", { class: "cgum-lbl" + (f.bars ? " cgum-has-bar" : ""), style: f.bars ? { "--p": Math.min(100, win.pct || 0) + "%" } : null },
      h("span", { class: "cgum-long" }, label), h("span", { class: "cgum-short" }, shortLabel));
    const kids = [lab, h("span", { class: `cgum-pct cgum-${lvl}` }, pctText(win.pct))];
    if (opts && opts.showReset && reset) {
      const rc = "cgum-reset " + (opts.resetClass || "");
      kids.push(h("span", { class: "cgum-dot " + rc }, "·"), h("span", { class: rc }, "Reset in ", h("b", null, reset)));
    }
    if (f.forecast && win.forecastMs) {
      const fl = win.forecastMs < 30 * 60e3 ? "red" : win.forecastMs < 90 * 60e3 ? "orange" : "amber";
      kids.push(h("span", { class: `cgum-chip cgum-chip-${fl}`, title: `At your current pace you'll reach this limit in about ${cumFmtDuration(win.forecastMs)} — before it resets.` },
        ICONS.hourglass(), h("span", null, "~" + cumFmtDuration(win.forecastMs) + " left")));
    }
    return seg("cgum-meter " + ((opts && opts.cls) || ""), title, kids);
  }

  function activeCapHit() {
    const now = Date.now();
    const hits = Object.values(S.capHits || {}).filter((x) => (x.resetAt ? x.resetAt > now : now - x.at < 3 * 3600e3));
    hits.sort((a, b) => b.at - a.at);
    return hits[0] || null;
  }

  function buildSegments() {
    const s = S.settings, f = s.fields, snap = S.snapshot;
    const segs = [];
    const usage = snap && snap.usage;
    const wins = usage ? usage.windows : [];

    if (snap && snap.error && snap.error.code === "signed_out") {
      segs.push(seg("cgum-muted", "Sign in to chatgpt.com in this browser profile.", "Sign in to see usage"));
    } else if (!snap) {
      segs.push(seg("cgum-muted", "Fetching your usage…", "Loading…"));
    }

    const feats = (snap && snap.features && snap.features.features || []).filter((x) => x.remaining != null);
    const thinking = feats.find((x) => x.id === "reason");

    // Thinking ("reason") is the chat-side allowance with a short reset —
    // the closest ChatGPT has to a session meter — so it leads the strip.
    if (f.thinking && thinking) {
      const lvl = thinking.remaining === 0 ? "red" : thinking.remaining <= 1 ? "orange" : "neutral";
      const reset = thinking.resetAt ? cumFmtDuration(thinking.resetAt - Date.now()) : "";
      const kids = [
        h("span", { class: "cgum-lbl" }, "Thinking"),
        h("span", { class: `cgum-val cgum-${lvl}` }, `${thinking.remaining} left`)
      ];
      if (reset && f.resetPrimary) kids.push(h("span", { class: "cgum-dot cgum-reset cgum-reset-p" }, "·"), h("span", { class: "cgum-reset cgum-reset-p" }, "Reset in ", h("b", null, reset)));
      segs.push(seg("cgum-thinking", `Thinking messages left: ${thinking.remaining}` + (reset ? `\nResets in ${reset} (${new Date(thinking.resetAt).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })})` : "") + "\nReported by ChatGPT for your plan.", kids));
    }

    wins.forEach((w, i) => {
      const isPrimary = i === 0;
      if (isPrimary ? !f.primary : !f.secondary) return;
      const label = cumWindowLabel(w.windowSec);
      const short = w.windowSec === 18000 ? "5h" : w.windowSec === 604800 ? "W" : cumWindowLabel(w.windowSec, true);
      segs.push(meter(w, "Codex " + label.toLowerCase(), short,
        { showReset: isPrimary ? f.resetPrimary : f.resetSecondary, resetClass: isPrimary ? "cgum-reset-p" : "cgum-reset-s",
          note: "Codex usage reported by ChatGPT for your plan (also used by agent / Work tasks). Plain chat isn't counted here." }));
    });

    if (f.extraLimits && usage) {
      for (const x of usage.extra) {
        const w = x.windows.reduce((a, b) => ((b.pct || 0) > (a.pct || 0) ? b : a), x.windows[0]);
        segs.push(meter(w, x.name, x.name.split(" ")[0], { showReset: false, cls: "cgum-extra", note: x.windows.map((ww) => `${cumWindowLabel(ww.windowSec)}: ${pctText(ww.pct)}`).join(" · ") }));
      }
    }

    if (f.credits && usage && usage.credits && (usage.credits.hasCredits || usage.credits.balance)) {
      const c = usage.credits;
      segs.push(seg("cgum-credits", "Credits on this account (used after plan limits run out).",
        h("span", { class: "cgum-lbl" }, h("span", { class: "cgum-long" }, "Credits"), h("span", { class: "cgum-short" }, "Cr")),
        h("span", { class: "cgum-val" }, c.unlimited ? "∞" : c.balance != null ? String(Math.round(c.balance * 100) / 100) : "on")));
    }

    if (f.features && feats.length) {
      const list = feats.filter((x) => x.id !== "reason" || !f.thinking)
        .sort((a, b) => a.remaining - b.remaining || (a.resetAt || 0) - (b.resetAt || 0)).slice(0, 1);
      for (const ft of list) {
        const low = ft.remaining === 0 ? "red" : ft.remaining <= 2 ? "orange" : "neutral";
        const reset = ft.resetAt ? `\nResets in ${cumFmtDuration(ft.resetAt - Date.now())}` : "";
        segs.push(seg("cgum-feature", `${ft.name}: ${ft.remaining} left${reset}\nAll feature quotas are in the toolbar popup.`,
          h("span", { class: "cgum-lbl" }, h("span", { class: "cgum-long" }, ft.name), h("span", { class: "cgum-short" }, ft.name.split(" ")[0])),
          h("span", { class: `cgum-val cgum-${low}` }, `${ft.remaining} left`)));
      }
    }

    if (f.modelCaps && s.modelCaps.length) {
      for (const c of cumCapUsage(S.msgLog, s.modelCaps)) {
        const pct = (c.used / c.limit) * 100;
        const win = (C.WINDOWS[c.cap.window] || {}).label || c.cap.window;
        segs.push(seg("cgum-cap", `${c.cap.model}: ${c.used} of ${c.limit} messages in the last ${win}` +
          (c.freesAt ? `\nNext message frees up in ${cumFmtDuration(c.freesAt - Date.now())}` : "") + "\nCounted from messages sent in this browser.",
          h("span", { class: "cgum-lbl" }, c.cap.model),
          h("span", { class: `cgum-val cgum-${cumLevel(pct)}` }, `${c.used}/${c.limit}`)));
      }
    }

    const hit = activeCapHit();
    if (hit) {
      const when = hit.resetAt ? cumFmtDuration(hit.resetAt - Date.now()) : "";
      segs.push(seg("cgum-hit", (hit.message || "ChatGPT reported a usage limit.") + (when ? `\nResets in ${when}` : ""),
        ICONS.lock(), h("span", { class: "cgum-long" }, "Limit hit" + (hit.model && hit.model !== "auto" ? " · " + hit.model : "")),
        h("span", { class: "cgum-short" }, "Limit"), when ? h("b", null, " " + when) : null));
    }

    if (f.chatTokens && S.convId && S.tokens && S.tokensFor === S.convId) {
      const t = S.tokens;
      const lvl = t.total >= 150000 ? "orange" : t.total >= 100000 ? "amber" : "neutral";
      const tip = `This chat is about ${t.total.toLocaleString()} tokens — roughly what ChatGPT re-reads with each new message here.\n` +
        `You ${cumFmtTokens(t.user)} · ChatGPT ${cumFmtTokens(t.assistant)} · Tools ${cumFmtTokens(t.tools)} · Images ${cumFmtTokens(t.images)}` +
        (t.context ? ` · Custom instructions ${cumFmtTokens(t.context)}` : "") +
        `\nEstimate. Files read by search, memory and the system prompt aren't included.\nLong chat? Starting a new one is the cheapest message you can send.`;
      segs.push(seg("cgum-tokens", tip,
        h("span", { class: "cgum-lbl cgum-long" }, "Chat"), h("span", { class: "cgum-short cgum-ic" }, ICONS.chat()),
        h("span", { class: `cgum-val cgum-${lvl}` }, "~" + cumFmtTokens(t.total), h("span", { class: "cgum-tok-word" }, " tokens"))));
    }

    if (snap && snap.error && snap.error.code !== "signed_out" && !wins.length) {
      segs.unshift(seg("cgum-muted", (snap.error.message || "Couldn't fetch usage.") + "\nRetrying automatically. Open the toolbar popup to refresh now.", "Usage unavailable"));
    }

    if (snap && snap.usageUnavailable && !wins.length && !(snap.features && snap.features.features.length) && !(snap.error && snap.error.code === "signed_out")) {
      segs.push(seg("cgum-muted", "ChatGPT isn't reporting usage windows for this account right now. Feature quotas, caps you define and limit hits are still tracked.", "No limits reported"));
    }
    return segs;
  }

  function logoButton() {
    const b = h("a", {
      class: "cgum-logo", href: cumUtm(C.PRODUCT_URL, "strip-logo", "about"), target: "_blank", rel: "noopener",
      title: `${C.NAME} — offered by SelectorsHub\nClick for more free tools`
    }, logoSrc ? h("img", { class: "cgum-logo-img", src: logoSrc, alt: "", width: 18, height: 18 }) : ICONS.logo(),
      h("span", { class: "cgum-byline" }, "by SelectorsHub"));
    b.addEventListener("click", (e) => {
      if (e.ctrlKey || e.metaKey || e.shiftKey || e.button === 1) return;
      e.preventDefault();
      toggleLogoMenu(b);
    });
    return b;
  }

  function promoLine() {
    const snap = S.snapshot;
    const atLimit = (snap && snap.usage && snap.usage.windows.some((w) => w.pct >= 100)) || activeCapHit();
    if (!atLimit) return null;
    const keyBase = (snap && snap.usage && (snap.usage.windows.find((w) => w.pct >= 100) || {}).resetAt) || (activeCapHit() || {}).resetAt || "x";
    const key = String(keyBase);
    if (S.promoDismissed === key) return null;
    const idx = Math.abs([...key].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) | 0, 7)) % C.TOOLS.length;
    const tool = C.TOOLS[idx];
    const dismiss = () => chrome.storage.local.set({ promoDismissed: key });
    return h("span", { class: "cgum-seg cgum-promo" },
      h("a", { href: cumUtm(tool.url, "limit-reached"), target: "_blank", rel: "noopener", title: tool.desc, onclick: dismiss },
        h("span", { class: "cgum-long" }, "Meanwhile, try "), h("span", { class: "cgum-short" }, "Try "), tool.name, " →"),
      h("button", { class: "cgum-icon-btn cgum-promo-x", title: "Hide until the next reset", onclick: dismiss }, ICONS.close()));
  }

  function render() {
    if (!S.settings) return;
    if (!ensureMounted()) return;
    closeMenusIfDetached();
    const s = S.settings;
    const collapsed = s.collapsed || S.autoCollapsed;
    host.textContent = "";

    const strip = h("div", { class: "cgum-strip" + (collapsed ? " cgum-collapsed" : "") + (S.fit ? ` cgum-fit-${S.fit}` : ""), role: "status", "aria-label": `${C.NAME}` });
    strip.appendChild(logoButton());

    if (collapsed) {
      strip.appendChild(h("span", { class: "cgum-sep" }));
      strip.appendChild(collapsedSummary());
    } else {
      const segs = buildSegments();
      for (const sgm of segs) { strip.appendChild(h("span", { class: "cgum-sep" })); strip.appendChild(sgm); }
      const promo = promoLine();
      if (promo) { strip.appendChild(h("span", { class: "cgum-sep" })); strip.appendChild(promo); }
    }

    const ctrls = h("span", { class: "cgum-ctrls" });
    const store = cumStoreUrl();
    if (store && !collapsed) {
      ctrls.appendChild(h("a", { class: "cgum-rate", href: cumUtm(store, "strip", "rate"), target: "_blank", rel: "noopener", title: "Enjoying the meter? A quick rating helps a lot." },
        ICONS.star(), h("span", { class: "cgum-rate-txt" }, "Rate us")));
    }
    const gear = h("button", { class: "cgum-icon-btn", title: "Choose what the strip shows", "aria-label": "Strip settings" }, ICONS.gear());
    gear.addEventListener("click", (e) => { e.stopPropagation(); toggleGearMenu(gear); });
    ctrls.appendChild(gear);
    if (!S.autoCollapsed) {
      ctrls.appendChild(h("button", {
        class: "cgum-icon-btn", title: s.collapsed ? "Expand" : "Collapse", "aria-label": s.collapsed ? "Expand" : "Collapse",
        onclick: () => saveSettings({ collapsed: !s.collapsed })
      }, s.collapsed ? ICONS.expand() : ICONS.collapse()));
    }
    ctrls.appendChild(h("button", {
      class: "cgum-icon-btn cgum-x", title: "Hide for 12 hours (turn it back on from the toolbar popup)", "aria-label": "Hide",
      onclick: () => chrome.storage.local.set({ stripHiddenUntil: Date.now() + HIDE_MS })
    }, ICONS.close()));
    strip.appendChild(h("span", { class: "cgum-sep" }));
    strip.appendChild(ctrls);

    host.appendChild(strip);
    if (!collapsed && !S.autoCollapsed) requestAnimationFrame(() => fitStrip());
  }

  function collapsedSummary() {
    const snap = S.snapshot, f = S.settings.fields;
    const box = h("span", { class: "cgum-seg cgum-summary" });
    const wins = (snap && snap.usage && snap.usage.windows) || [];
    const th = f.thinking && snap && snap.features && snap.features.features.find((x) => x.id === "reason" && x.remaining != null);
    if (th) box.appendChild(h("span", { class: "cgum-mini", title: `Thinking: ${th.remaining} left` + (th.resetAt ? ` · resets in ${cumFmtDuration(th.resetAt - Date.now())}` : "") },
      h("span", { class: "cgum-mini-lbl" }, "Think"), h("span", { class: "cgum-val" + (th.remaining === 0 ? " cgum-red" : "") }, String(th.remaining))));
    wins.forEach((w, i) => {
      if (i === 0 ? !f.primary : !f.secondary) return;
      const lbl = i === 0 ? (w.windowSec === 18000 ? "5h" : cumWindowLabel(w.windowSec, true)) : "W";
      box.appendChild(h("span", { class: "cgum-mini", title: `${cumWindowLabel(w.windowSec)}: ${pctText(w.pct)}` + (w.resetAt ? ` · resets in ${cumFmtDuration(w.resetAt - Date.now())}` : "") },
        h("span", { class: "cgum-mini-lbl" }, lbl), h("span", { class: `cgum-pct cgum-${cumLevel(w.pct)}` }, pctText(w.pct))));
    });
    const hit = activeCapHit();
    if (hit) box.appendChild(h("span", { class: "cgum-mini cgum-hit", title: hit.message || "Limit reached" }, ICONS.lock()));
    if (f.chatTokens && S.tokens && S.tokensFor === S.convId) {
      box.appendChild(h("span", { class: "cgum-mini", title: `This chat: ~${S.tokens.total.toLocaleString()} tokens` }, ICONS.chat(), h("span", { class: "cgum-val" }, cumFmtTokens(S.tokens.total))));
    }
    if (!box.firstChild) box.appendChild(h("span", { class: "cgum-muted" }, snap ? "—" : "…"));
    return box;
  }

  // Shed detail level by level until the strip fits; if it still doesn't,
  // show the collapsed view (a layout state — the saved setting is untouched).
  let fitting = false;
  function fitStrip() {
    if (fitting || !host || !host.isConnected || !S.settings) return;
    fitting = true;
    try {
      const avail = host.clientWidth;
      if (!avail) return;
      const strip = host.querySelector(".cgum-strip");
      if (!strip) return;
      if (S.autoCollapsed) {
        // Try to return to expanded when there's room again.
        if (avail > (S.lastExpandedNeed || 0) + 8) { S.autoCollapsed = false; S.fit = 0; render(); }
        return;
      }
      if (S.settings.collapsed) return;
      for (let lvl = 0; lvl <= 4; lvl++) {
        strip.classList.remove("cgum-fit-1", "cgum-fit-2", "cgum-fit-3", "cgum-fit-4");
        if (lvl) strip.classList.add("cgum-fit-" + lvl);
        if (strip.scrollWidth <= avail + 1) { S.fit = lvl; return; }
      }
      S.lastExpandedNeed = strip.scrollWidth;
      S.autoCollapsed = true;
      render();
    } finally { fitting = false; }
  }

  // ---------------------------------------------------------------- menus
  let openMenu = null;
  function closeMenu() { if (openMenu) { openMenu.el.remove(); openMenu = null; } }
  function closeMenusIfDetached() { if (openMenu && (!openMenu.anchor.isConnected)) closeMenu(); }
  document.addEventListener("click", (e) => { if (openMenu && !openMenu.el.contains(e.target) && !openMenu.anchor.contains(e.target)) closeMenu(); }, true);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeMenu(); }, true);

  function placeMenu(menu, anchor) {
    menu.classList.toggle("cgum-dark", isDark());
    menu.classList.toggle("cgum-light", !isDark());
    document.body.appendChild(menu);
    const r = anchor.getBoundingClientRect();
    const mw = menu.offsetWidth, mh = menu.offsetHeight;
    let left = Math.min(Math.max(8, r.left), window.innerWidth - mw - 8);
    let top = r.top - mh - 8;
    const above = r.top - 16, below = window.innerHeight - r.bottom - 16;
    if (mh > above && mh <= below) top = r.bottom + 8;
    else if (mh > above) {
      // Neither side fits: use the roomier one and let the menu scroll.
      if (below > above) { top = r.bottom + 8; menu.style.maxHeight = below + "px"; }
      else { menu.style.maxHeight = above + "px"; top = r.top - Math.min(mh, above) - 8; }
    }
    menu.style.left = left + "px";
    menu.style.top = Math.max(8, top) + "px";
  }

  function toggleGearMenu(anchor) {
    if (openMenu && openMenu.kind === "gear") { closeMenu(); return; }
    closeMenu();
    const s = S.settings, f = s.fields;
    const row = (label, checked, onChange, note) => {
      const cb = h("input", { type: "checkbox", class: "cgum-cb" }); cb.checked = !!checked;
      cb.addEventListener("change", () => onChange(cb.checked));
      return h("label", { class: "cgum-mrow" }, cb, h("span", null, label), note ? h("span", { class: "cgum-mnote" }, note) : null);
    };
    const field = (k, label, note) => row(label, f[k], (v) => saveSettings({ fields: { [k]: v } }), note);
    const menu = h("div", { class: "cgum-menu cgum-gear-menu", role: "menu" },
      h("div", { class: "cgum-mhead" }, "Show in strip"),
      field("thinking", "Thinking left", "chat limit"),
      field("primary", "Codex usage", "5-hour / monthly"),
      field("resetPrimary", "Reset times"),
      field("secondary", "Codex weekly usage", "paid plans"),
      field("resetSecondary", "Weekly reset time"),
      field("forecast", "Limit forecast", "when on pace to run out"),
      field("bars", "Usage bars"),
      field("extraLimits", "Other limits", "per-feature windows"),
      field("features", "Feature quotas", "deep research, images…"),
      field("credits", "Credits"),
      field("modelCaps", "My model caps", s.modelCaps.length ? "" : "set in Settings"),
      field("chatTokens", "Chat tokens"),
      h("div", { class: "cgum-msep" }),
      row("Desktop notifications", s.notify, (v) => saveSettings({ notify: v })),
      h("div", { class: "cgum-msep" }),
      h("button", { class: "cgum-mlink", onclick: () => { send({ type: "openOptions" }); closeMenu(); } }, "All settings…"));
    placeMenu(menu, anchor);
    openMenu = { el: menu, anchor, kind: "gear" };
  }

  function toggleLogoMenu(anchor) {
    if (openMenu && openMenu.kind === "logo") { closeMenu(); return; }
    closeMenu();
    const items = C.TOOLS.map((t) => {
      const img = h("img", { class: "cgum-tool-ic", alt: "", width: 20, height: 20 });
      toolIcon(t.icon).then((src) => { if (src) img.src = src; else img.remove(); });
      return h("a", { class: "cgum-tool", href: cumUtm(t.url, "logo-menu"), target: "_blank", rel: "noopener", onclick: closeMenu },
        img, h("span", { class: "cgum-tool-txt" }, h("span", { class: "cgum-tool-name" }, t.name), h("span", { class: "cgum-tool-desc" }, t.desc)));
    });
    const menu = h("div", { class: "cgum-menu cgum-logo-menu", role: "menu" },
      h("div", { class: "cgum-mhead" }, "Offered by SelectorsHub · more free tools"),
      h("div", { class: "cgum-tools" }, items),
      h("div", { class: "cgum-msep" }),
      h("a", { class: "cgum-mlink", href: cumUtm(C.ALL_TOOLS_URL, "logo-menu-all"), target: "_blank", rel: "noopener" }, "See all 15+ free tools →"),
      h("a", { class: "cgum-mlink", href: cumUtm(C.PRODUCT_URL, "logo-menu-about", "about"), target: "_blank", rel: "noopener" }, `About ${C.NAME}`),
      h("div", { class: "cgum-mfoot" }, "Not affiliated with OpenAI."));
    placeMenu(menu, anchor);
    openMenu = { el: menu, anchor, kind: "logo" };
  }

  // ---------------------------------------------------------------- boot
  (async () => {
    await loadAll();
    assetDataUrl("icons/logo64.png").then((src) => { if (src) { logoSrc = src; render(); } });
    mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
    watchUrl();
    render();
    // Keep reset countdowns fresh between polls.
    setInterval(() => { if (host && host.isConnected && !openMenu) render(); }, 30000);
    if (!S.snapshot || Date.now() - (S.snapshot.fetchedAt || 0) > 60000) send({ type: "refresh" });
  })();
})();
