// page-injector.js (MAIN world, document_start)
//
// Wraps window.fetch on chatgpt.com so the meter can see, without touching
// what the page itself receives:
//   1. Every message the user sends (POST /backend-api/conversation or
//      /backend-api/f/conversation): which model it went to.
//   2. The reply stream: the conversation id, when it ends, and any
//      limit / usage-cap signal inside it.
//   3. A refused send (HTTP 429/403): the cap message and its reset time.
//   4. Responses the page fetches anyway that carry usage data:
//      /backend-api/conversation/init  (limits_progress — feature quotas)
//      /backend-api/wham/usage         (5-hour / weekly windows)
//      /backend-api/conversation/<id>  (the chat itself, for its token size)
//
// Responses are always read from a clone() / tee(); the page keeps the
// original. Nothing is sent anywhere except to this extension's content
// script via window.postMessage on the same origin.
//
// Debug: run  localStorage.cgum_debug = "1"  on chatgpt.com and reload.

(function () {
  if (window.__chatgptUsageMeterInjected) return;
  window.__chatgptUsageMeterInjected = true;

  const ORIGINAL_FETCH = window.fetch;
  const SOURCE = "chatgpt-usage-meter";
  const DEBUG = (() => { try { return localStorage.getItem("cgum_debug") === "1"; } catch (_) { return false; } })();
  const dlog = (...a) => { if (DEBUG) try { console.log("[CGUM inject]", ...a); } catch (_) {} };

  function post(payload) {
    try { window.postMessage({ source: SOURCE, payload }, window.location.origin); } catch (_) {}
  }

  function normalizeUrl(input) {
    try {
      const raw = typeof input === "string" ? input
        : (input instanceof URL) ? input.href
        : (input && typeof input.url === "string") ? input.url : "";
      if (!raw) return "";
      return new URL(raw, window.location.href).href;
    } catch (_) { return ""; }
  }

  const RE_SEND = /\/backend-api\/(?:f\/)?conversation\/?(?:\?|$)/;
  const RE_INIT = /\/backend-api\/conversation\/init\/?(?:\?|$)/;
  const RE_WHAM = /\/backend-api\/wham\/usage\/?(?:\?|$)/;
  const RE_CONV = /\/backend-api\/conversation\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?(?:\?|$)/i;
  const RE_UUID = /"conversation_id"\s*:\s*"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/i;

  // Phrases ChatGPT uses when a model or feature is capped. Matched loosely
  // because the exact wording and JSON shape change between releases.
  const RE_CAP = /(usage cap|usage limit|rate[ _-]?limit|reached (?:our|your|the) limit|hit (?:your|the) limit|limit reached|too many (?:messages|requests)|message cap|you['’]ve reached)/i;

  function methodOf(input, init) {
    return String((init && init.method) || (input && input.method) || "GET").toUpperCase();
  }

  async function bodyText(input, init) {
    try {
      if (init && typeof init.body === "string") return init.body;
      if (input && typeof input.clone === "function" && !(init && init.body)) {
        return await input.clone().text();
      }
    } catch (_) {}
    return "";
  }

  function modelFromBody(text) {
    if (!text) return null;
    try {
      const j = JSON.parse(text);
      return {
        model: typeof j.model === "string" ? j.model : null,
        action: typeof j.action === "string" ? j.action : null,
        conversationId: typeof j.conversation_id === "string" ? j.conversation_id : null,
        thinking: j.thinking_effort || j.reasoning_effort || null
      };
    } catch (_) {
      const m = /"model"\s*:\s*"([^"]+)"/.exec(text);
      return m ? { model: m[1], action: null, conversationId: null } : null;
    }
  }

  // "try again after 3:42 PM", "resets at 15:42", "in 2 hours", "in 45 minutes"
  function resetFromText(text) {
    if (!text) return null;
    let m = /(?:after|at|until)\s+(\d{1,2}):(\d{2})\s*([AaPp][Mm])?/.exec(text);
    if (m) {
      let h = +m[1]; const min = +m[2]; const ap = (m[3] || "").toLowerCase();
      if (ap === "pm" && h < 12) h += 12;
      if (ap === "am" && h === 12) h = 0;
      const d = new Date(); d.setHours(h, min, 0, 0);
      if (d.getTime() < Date.now() - 60000) d.setDate(d.getDate() + 1);
      return d.toISOString();
    }
    m = /in\s+(\d+)\s*(day|hour|hr|minute|min)s?/i.exec(text);
    if (m) {
      const n = +m[1]; const u = m[2].toLowerCase();
      const ms = u.startsWith("day") ? n * 86400e3 : u.startsWith("h") ? n * 3600e3 : n * 60e3;
      return new Date(Date.now() + ms).toISOString();
    }
    m = /"(?:reset_at|resets_at|reset_after|clears_in)"\s*:\s*"?([^",}]+)"?/.exec(text);
    if (m) {
      const v = m[1].trim();
      if (/^\d+$/.test(v)) {
        const n = +v;
        // seconds-from-now vs epoch seconds
        return new Date(n > 1e9 ? n * 1000 : Date.now() + n * 1000).toISOString();
      }
      const t = Date.parse(v);
      if (!isNaN(t)) return new Date(t).toISOString();
    }
    return null;
  }

  function capMessage(text) {
    if (!text) return "";
    try {
      const j = JSON.parse(text);
      const d = j.detail || j.error || j;
      const msg = (d && (d.message || d.msg || d.text)) || (typeof d === "string" ? d : "");
      if (msg) return String(msg).slice(0, 300);
    } catch (_) {}
    const m = RE_CAP.exec(text);
    if (!m) return "";
    const start = Math.max(0, m.index - 80);
    return text.slice(start, m.index + 200).replace(/\s+/g, " ").replace(/^[^A-Za-z]+/, "").slice(0, 300);
  }

  async function readJsonClone(res) {
    try { return await res.clone().json(); } catch (_) { return null; }
  }

  // Read an SSE body from a tee'd branch. Only looks at the text; never
  // reconstructs ChatGPT's message. Limits buffer to the tail it needs.
  async function scanStream(stream, ctx) {
    const reader = stream.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let convId = ctx.conversationId || null;
    let capSeen = false;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        if (!convId) {
          const m = RE_UUID.exec(buf);
          if (m) convId = m[1];
        }
        // Inspect complete events only; keep the unfinished tail.
        const cut = buf.lastIndexOf("\n\n");
        if (cut !== -1) {
          const events = buf.slice(0, cut);
          buf = buf.slice(cut + 2);
          if (!capSeen && /error|limit|cap/i.test(events)) {
            for (const line of events.split("\n")) {
              if (!line.startsWith("data:")) continue;
              const data = line.slice(5).trim();
              if (!data || data === "[DONE]") continue;
              // Only error/limit-shaped events — not the assistant's own text,
              // which may legitimately talk about "rate limits".
              let j = null; try { j = JSON.parse(data); } catch (_) {}
              if (!j || typeof j !== "object") continue;
              const typ = String(j.type || j.event || (j.error && "error") || "").toLowerCase();
              const looksLimit =
                /limit|cap|error|moderation/.test(typ) ||
                (j.error && RE_CAP.test(JSON.stringify(j.error))) ||
                (j.message_limit || j.rate_limit || j.usage_limit);
              if (!looksLimit) continue;
              const raw = JSON.stringify(j);
              if (!RE_CAP.test(raw)) continue;
              capSeen = true;
              post({ kind: "cap_hit", model: ctx.model, message: capMessage(raw), resetAt: resetFromText(raw), source: "stream" });
            }
          }
          if (buf.length > 200000) buf = buf.slice(-20000);
        }
      }
    } catch (e) {
      dlog("stream scan error", e);
    } finally {
      post({ kind: "completion_done", conversationId: convId || ctx.conversationId || null, model: ctx.model });
    }
  }

  async function handleSend(input, init, url) {
    const text = await bodyText(input, init);
    const info = modelFromBody(text) || {};
    // "next" = new message, "variant" = regenerate, "continue" = continue.
    // Anything else (e.g. title generation) isn't a user message.
    if (info.action && !/^(next|variant|continue)$/.test(info.action)) return null;
    const ctx = { model: info.model || "auto", conversationId: info.conversationId, action: info.action || "next" };
    ctx.at = Date.now();
    dlog("send", ctx);
    return ctx;
  }

  async function patchedFetch(input, init) {
    const url = normalizeUrl(input);
    const method = methodOf(input, init);
    let ctx = null;

    if (url && method === "POST" && RE_SEND.test(url) && !RE_INIT.test(url)) {
      try { ctx = await handleSend(input, init, url); } catch (_) {}
    }

    const res = await ORIGINAL_FETCH.apply(window, arguments);

    try {
      if (ctx) {
        if (res.status === 429 || res.status === 403) {
          let t = ""; try { t = await res.clone().text(); } catch (_) {}
          const ra = res.headers.get("retry-after");
          let resetAt = resetFromText(t);
          if (!resetAt && ra) {
            const n = Number(ra);
            resetAt = isFinite(n) ? new Date(Date.now() + n * 1000).toISOString()
              : (isNaN(Date.parse(ra)) ? null : new Date(Date.parse(ra)).toISOString());
          }
          if (res.status === 429 || RE_CAP.test(t)) {
            post({ kind: "cap_hit", model: ctx.model, message: capMessage(t) || "Usage limit reached", resetAt, status: res.status, source: "http" });
          }
          post({ kind: "completion_done", conversationId: ctx.conversationId, model: ctx.model, failed: true });
          return res;
        }
        // Counted only once ChatGPT accepted it — a refused send isn't usage.
        if (res.ok) post({ kind: "message_sent", model: ctx.model, action: ctx.action, conversationId: ctx.conversationId, at: ctx.at });
        const ct = res.headers.get("content-type") || "";
        if (res.body && /event-stream|text\/plain|octet-stream/i.test(ct)) {
          const [a, b] = res.body.tee();
          scanStream(b, ctx);
          return new Response(a, { status: res.status, statusText: res.statusText, headers: res.headers });
        }
        // Non-streaming (e.g. a resume handle): treat as done.
        post({ kind: "completion_done", conversationId: ctx.conversationId, model: ctx.model });
        return res;
      }

      if (url && res.ok) {
        if (RE_INIT.test(url)) {
          readJsonClone(res).then((j) => j && post({ kind: "features", data: j }));
        } else if (RE_WHAM.test(url)) {
          readJsonClone(res).then((j) => j && post({ kind: "usage", data: j }));
        } else if (method === "GET") {
          const m = RE_CONV.exec(url);
          if (m) readJsonClone(res).then((j) => j && j.mapping && post({ kind: "conversation", conversationId: m[1], data: j }));
        }
      }
    } catch (e) {
      dlog("patch error", e);
    }
    return res;
  }

  try {
    Object.defineProperty(patchedFetch, "name", { value: "fetch" });
    window.fetch = patchedFetch;
  } catch (_) {}
})();
