// popup.js — toolbar popup. Opening it forces a fresh fetch.
(function () {
  const C = CUM_CONFIG;
  const $ = (id) => document.getElementById(id);
  let state = { settings: null, snapshot: null, capHits: {}, msgLog: [], hiddenUntil: 0 };
  let msgRange = 86400e3;

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "style") el.setAttribute("style", v);
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v);
    }
    for (const k of kids.flat()) if (k != null && k !== false) el.append(k);
    return el;
  }

  function mergeSettings(s) {
    const d = C.DEFAULT_SETTINGS; s = s || {};
    return Object.assign({}, d, s, { fields: Object.assign({}, d.fields, s.fields || {}) },
      { modelCaps: Array.isArray(s.modelCaps) ? s.modelCaps : [] });
  }

  async function load() {
    const s = await chrome.storage.local.get(["settings", "snapshot", "capHits", "msgLog", "stripHiddenUntil"]);
    state.settings = mergeSettings(s.settings);
    state.snapshot = s.snapshot || null;
    state.capHits = s.capHits || {};
    state.msgLog = s.msgLog || [];
    state.hiddenUntil = s.stripHiddenUntil || 0;
  }

  const pct = (p) => (p == null ? "—" : Math.round(p) + "%");
  const when = (t) => new Date(t).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });

  function windowCard(w, label, compact) {
    const lvl = cumLevel(w.pct);
    const card = h("section", { class: "card" + (compact ? " compact" : "") },
      h("div", { class: "row" }, h("span", { class: "lbl" }, label), h("span", { class: "pct lvl-" + lvl }, pct(w.pct))),
      h("div", { class: "bar" }, h("div", { class: "bar-fill bg-" + lvl, style: `width:${Math.min(100, w.pct || 0)}%` })),
      h("div", { class: "sub" }, w.resetAt ? ["Resets in ", h("b", null, cumFmtDuration(w.resetAt - Date.now())), " · " + when(w.resetAt)] : "Reset time not reported"));
    if (w.forecastMs) {
      const fl = w.forecastMs < 30 * 60e3 ? "red" : w.forecastMs < 90 * 60e3 ? "orange" : "amber";
      card.append(h("div", { class: "fc lvl-" + fl }, `⏳ At this pace you'll hit the limit in ~${cumFmtDuration(w.forecastMs)}`));
    }
    return card;
  }

  function render() {
    const s = state.settings, snap = state.snapshot;
    // strip toggle
    const hidden = state.hiddenUntil > Date.now();
    $("show-strip").checked = !!s.strip && !hidden;
    $("strip-sub").textContent = hidden ? `Hidden until ${when(state.hiddenUntil)}` : s.strip ? "Shown on chatgpt.com" : "Off";

    // plan
    if (snap && snap.plan) { $("plan").textContent = snap.plan; $("plan").classList.remove("hidden"); }
    else $("plan").classList.add("hidden");

    // errors
    const err = snap && snap.error;
    const eb = $("error-banner");
    if (err && err.code !== "signed_out") {
      eb.textContent = err.code === "blocked"
        ? "chatgpt.com didn't answer the extension directly. Open a chatgpt.com tab and click refresh."
        : err.message || "Couldn't fetch usage.";
      eb.classList.remove("hidden");
    } else eb.classList.add("hidden");

    // limit hit
    const now = Date.now();
    const hits = Object.values(state.capHits || {}).filter((x) => (x.resetAt ? x.resetAt > now : now - x.at < 3 * 3600e3)).sort((a, b) => b.at - a.at);
    const hb = $("hit-banner");
    if (hits.length) {
      const x = hits[0];
      hb.replaceChildren(h("b", null, "Limit reached" + (x.model && x.model !== "auto" ? " · " + x.model : "")), h("br"),
        (x.message || "ChatGPT reported a usage limit.").slice(0, 200),
        x.resetAt ? h("div", { class: "sub", style: "margin-top:4px" }, "Resets in ", h("b", null, cumFmtDuration(x.resetAt - now)), " · " + when(x.resetAt)) : "");
      hb.classList.remove("hidden");
    } else hb.classList.add("hidden");

    // windows
    const wins = (snap && snap.usage && snap.usage.windows) || [];
    const feats0 = (snap && snap.features && snap.features.features) || [];
    const thinking = feats0.find((x) => x.id === "reason" && x.remaining != null);
    const cards = [];
    if (thinking) {
      const lvl = thinking.remaining === 0 ? "red" : thinking.remaining <= 1 ? "orange" : "green";
      cards.push(h("section", { class: "card" },
        h("div", { class: "row" }, h("span", { class: "lbl" }, "Thinking messages"), h("span", { class: "pct lvl-" + lvl }, thinking.remaining + " left")),
        h("div", { class: "sub", style: "margin-top:6px" }, thinking.resetAt ? ["Resets in ", h("b", null, cumFmtDuration(thinking.resetAt - Date.now())), " · " + when(thinking.resetAt)] : "Reset time not reported")));
    }
    cards.push(...wins.map((w) => windowCard(w, "Codex · " + cumWindowLabel(w.windowSec))));
    $("windows").replaceChildren(...cards);
    const extra = (snap && snap.usage && snap.usage.extra) || [];
    $("extra").replaceChildren(...extra.flatMap((x) => x.windows.map((w) => windowCard(w, `${x.name} · ${cumWindowLabel(w.windowSec)}`, true))));

    // credits
    const cr = snap && snap.usage && snap.usage.credits;
    if (cr && (cr.hasCredits || cr.balance)) {
      $("credits-val").textContent = cr.unlimited ? "Unlimited" : cr.balance != null ? String(Math.round(cr.balance * 100) / 100) : "On";
      $("credits-card").classList.remove("hidden");
    } else $("credits-card").classList.add("hidden");

    // features
    const feats = feats0.filter((x) => x !== thinking);
    if (feats.length) {
      $("features").replaceChildren(...feats.map((f) => {
        const lvl = f.remaining === 0 ? "red" : f.remaining != null && f.remaining <= 3 ? "orange" : "";
        return h("div", { class: "li" },
          h("span", { class: "nm" }, f.name),
          h("span", { class: "vl " + (lvl ? "lvl-" + lvl : "") }, f.remaining == null ? "—" : f.max ? `${f.remaining}/${f.max} left` : `${f.remaining} left`),
          f.resetAt ? h("span", { class: "rs", title: when(f.resetAt) }, "resets " + cumFmtDuration(f.resetAt - now)) : null);
      }));
      $("features-card").classList.remove("hidden");
    } else $("features-card").classList.add("hidden");

    // caps
    const caps = cumCapUsage(state.msgLog, s.modelCaps, now);
    if (caps.length) {
      $("caps").replaceChildren(...caps.map((c) => {
        const p = (c.used / c.limit) * 100, lvl = cumLevel(p);
        return h("div", { class: "li", title: c.freesAt ? `Next slot frees in ${cumFmtDuration(c.freesAt - now)}` : "" },
          h("span", { class: "nm" }, c.cap.model, h("span", { class: "rs" }, " / " + ((C.WINDOWS[c.cap.window] || {}).label || c.cap.window))),
          h("span", { class: "mini-bar" }, h("div", { class: "bg-" + lvl, style: `width:${Math.min(100, p)}%` })),
          h("span", { class: "vl lvl-" + lvl }, `${c.used}/${c.limit}`));
      }));
      $("caps-card").classList.remove("hidden");
    } else $("caps-card").classList.add("hidden");

    // message counts
    const counts = cumModelCounts(state.msgLog, msgRange, now);
    $("msgs").replaceChildren(...(counts.length
      ? counts.slice(0, 6).map(([m, n]) => h("div", { class: "li" }, h("span", { class: "nm" }, m), h("span", { class: "vl" }, String(n))))
      : [h("div", { class: "empty-li" }, "None yet — sends are counted from when the extension was installed.")]));

    // empty / sign-in hints
    const hint = $("empty-hint");
    if (snap && snap.error && snap.error.code === "signed_out") {
      hint.replaceChildren("Sign in to ", h("b", null, "chatgpt.com"), " in this browser profile, then click refresh.");
      hint.classList.remove("hidden");
    } else if (snap && snap.usageUnavailable && !wins.length && !extra.length) {
      hint.replaceChildren(h("b", null, "ChatGPT isn't reporting usage windows for this account."), h("br"),
        "That's normal on some plans. Feature quotas, limit hits and any caps you set are still tracked.");
      hint.classList.remove("hidden");
    } else if (!snap) {
      hint.replaceChildren("Fetching your usage…");
      hint.classList.remove("hidden");
    } else hint.classList.add("hidden");

    $("updated").textContent = snap && snap.fetchedAt ? `Updated ${cumFmtDuration(now - snap.fetchedAt).replace("<1m", "just now").replace(/^(\d.*)$/, "$1 ago")}` : "";
  }

  async function doRefresh(force) {
    $("brand-logo").classList.add("pulsing");
    $("refresh-btn").classList.add("spin");
    try { await chrome.runtime.sendMessage({ type: "refresh", force }); } catch (_) {}
    await load();
    render();
    $("brand-logo").classList.remove("pulsing");
    $("refresh-btn").classList.remove("spin");
  }

  function buildTools() {
    const box = $("tools");
    if (box.childElementCount) return;
    box.append(...C.TOOLS.map((t) => h("a", { class: "tool", href: cumUtm(t.url, "popup"), target: "_blank", rel: "noopener" },
      h("img", { src: `../icons/tools/${t.icon}.png`, alt: "" }), h("span", null, h("b", null, t.name), h("i", null, t.desc)))));
    box.append(h("a", { class: "tool", href: cumUtm(C.ALL_TOOLS_URL, "popup-all"), target: "_blank", rel: "noopener", style: "grid-column: 1 / -1; justify-content:center" },
      h("b", null, "See all 15+ free tools →")));
  }

  // wiring
  $("refresh-btn").addEventListener("click", () => doRefresh(true));
  $("open-options").addEventListener("click", () => chrome.runtime.openOptionsPage());
  $("add-cap").addEventListener("click", () => chrome.runtime.openOptionsPage());
  $("show-strip").addEventListener("change", async (e) => {
    const on = e.target.checked;
    const { settings } = await chrome.storage.local.get("settings");
    await chrome.storage.local.set({ settings: Object.assign(mergeSettings(settings), { strip: on }), stripHiddenUntil: 0 });
  });
  $("msgs-range").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    msgRange = Number(b.dataset.ms);
    for (const x of $("msgs-range").children) x.classList.toggle("on", x === b);
    render();
  });
  $("tools-toggle").addEventListener("click", async () => {
    const open = $("tools").classList.contains("hidden");
    if (open) buildTools();
    $("tools").classList.toggle("hidden", !open);
    $("tools-toggle").setAttribute("aria-expanded", String(open));
    await chrome.storage.local.set({ popupToolsOpen: open });
  });
  const store = cumStoreUrl();
  if (store) { $("rate-link").href = cumUtm(store, "popup", "rate"); $("rate-link").classList.remove("hidden"); }
  $("about-link").href = cumUtm(C.PRODUCT_URL, "popup", "about");

  chrome.storage.onChanged.addListener((ch, area) => {
    if (area !== "local") return;
    if (ch.settings || ch.snapshot || ch.capHits || ch.msgLog || ch.stripHiddenUntil) load().then(render);
  });

  (async () => {
    await load();
    render();
    const { popupToolsOpen } = await chrome.storage.local.get("popupToolsOpen");
    if (popupToolsOpen) { buildTools(); $("tools").classList.remove("hidden"); $("tools-toggle").setAttribute("aria-expanded", "true"); }
    doRefresh(true);
  })();
})();
