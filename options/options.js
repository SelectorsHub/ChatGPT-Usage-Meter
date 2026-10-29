(function () {
  const C = CUM_CONFIG;
  const $ = (id) => document.getElementById(id);
  const FIELD_LABELS = {
    thinking: "Thinking left",
    primary: "Codex usage", resetPrimary: "Reset times",
    secondary: "Codex weekly usage", resetSecondary: "Weekly reset time",
    forecast: "Limit forecast", bars: "Usage bars",
    extraLimits: "Other limits", features: "Feature quotas",
    credits: "Credits", modelCaps: "My model caps", chatTokens: "Chat tokens"
  };
  let settings;
  let logKey = "msgLog";   // v1.0.3: the message log is kept per account

  function merge(s) {
    const d = C.DEFAULT_SETTINGS; s = s || {};
    return Object.assign({}, d, s, { fields: Object.assign({}, d.fields, s.fields || {}) },
      { modelCaps: Array.isArray(s.modelCaps) ? s.modelCaps : [] });
  }

  let savedTimer;
  async function save() {
    await chrome.storage.local.set({ settings });
    $("saved").classList.add("on");
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => $("saved").classList.remove("on"), 1200);
  }

  function renderCaps() {
    const tb = $("caps");
    tb.textContent = "";
    document.querySelector("table.caps").style.display = settings.modelCaps.length ? "" : "none";
    settings.modelCaps.forEach((cap, i) => {
      const tr = document.createElement("tr");
      const model = Object.assign(document.createElement("input"), { type: "text", value: cap.model || "", placeholder: "e.g. gpt-6-pro" });
      model.setAttribute("list", "models");
      const limit = Object.assign(document.createElement("input"), { type: "number", min: 1, value: cap.limit || "" });
      const win = document.createElement("select");
      for (const [k, v] of Object.entries(C.WINDOWS)) win.append(new Option(v.label, k, false, cap.window === k));
      const del = Object.assign(document.createElement("button"), { className: "btn x", textContent: "×", title: "Remove" });
      const upd = () => { settings.modelCaps[i] = { model: model.value.trim(), limit: Number(limit.value) || 0, window: win.value }; save(); };
      model.addEventListener("change", upd); limit.addEventListener("change", upd); win.addEventListener("change", upd);
      del.addEventListener("click", () => { settings.modelCaps.splice(i, 1); save(); renderCaps(); });
      for (const el of [model, limit, win, del]) { const td = document.createElement("td"); td.append(el); tr.append(td); }
      tb.append(tr);
    });
  }

  async function init() {
    try {
      const w = await chrome.runtime.sendMessage({ type: "whoami" });   // answered for the window this page is open in
      if (w && w.prefix) logKey = w.prefix + "msgLog";
    } catch (_) {}
    const s = await chrome.storage.local.get(["settings", logKey]);
    settings = merge(s.settings);
    $("about").href = cumUtm(C.PRODUCT_URL, "options", "about");

    $("pollMinutes").value = String(settings.pollMinutes);
    $("pollMinutes").addEventListener("change", (e) => { settings.pollMinutes = Number(e.target.value); save(); });

    for (const k of ["notify", "badge", "strip", "collapsed"]) {
      $(k).checked = !!settings[k];
      $(k).addEventListener("change", (e) => { settings[k] = e.target.checked; save(); });
    }

    $("thresholds").value = settings.thresholds.join(", ");
    $("thresholds").addEventListener("change", (e) => {
      const t = e.target.value.split(/[,\s]+/).map(Number).filter((n) => n > 0 && n <= 100);
      settings.thresholds = [...new Set(t)].sort((a, b) => a - b);
      e.target.value = settings.thresholds.join(", ");
      save();
    });

    const fields = $("fields");
    for (const [k, label] of Object.entries(FIELD_LABELS)) {
      const cb = Object.assign(document.createElement("input"), { type: "checkbox", checked: !!settings.fields[k] });
      cb.addEventListener("change", () => { settings.fields[k] = cb.checked; save(); });
      const l = document.createElement("label"); l.append(cb, document.createTextNode(label)); fields.append(l);
    }

    const models = [...new Set((s[logKey] || []).map((e) => e.m))].filter((m) => m && m !== "auto").sort();
    $("models").replaceChildren(...models.map((m) => new Option(m)));
    renderCaps();
    $("add-cap").addEventListener("click", () => {
      settings.modelCaps.push({ model: "", limit: 0, window: "week" });
      renderCaps();
      const inputs = $("caps").querySelectorAll("input[type=text]");
      inputs[inputs.length - 1].focus();
    });

    $("clear-log").addEventListener("click", async () => { await chrome.storage.local.set({ [logKey]: [] }); $("saved").textContent = "Cleared"; save().then(() => setTimeout(() => ($("saved").textContent = "Saved"), 1300)); });
    $("reset-hidden").addEventListener("click", async () => { await chrome.storage.local.set({ stripHiddenUntil: 0 }); settings.strip = true; $("strip").checked = true; save(); });
  }
  init();
})();
