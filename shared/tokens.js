// shared/tokens.js — estimate how many tokens a ChatGPT conversation sends
// with every new message. Used by background.js (after a fetch) and by the
// content script (when the page loads a conversation itself).
//
// Input: the JSON of GET /backend-api/conversation/<id>
//   { mapping: { <nodeId>: { id, parent, children, message } }, current_node }
// Only the active branch is counted: walk `parent` back from current_node,
// so edits and regenerations that aren't on screen don't inflate the number.
//
// Counted: user + assistant text, code / execution output, tool / browsing
// results, custom instructions (sent with every turn), images at the
// published tile formula. Skipped: reasoning ("thoughts", "reasoning_recap") —
// prior-turn reasoning is not carried forward — and hidden system scaffolding.
// File attachments read via retrieval aren't in the response and aren't
// counted; the tooltip says so.
//
// The tokenizer (o200k) isn't shipped here; the word/symbol-piece estimator
// tracks it within ~10-15% on English and code, enough for a "~36.9K" readout.

var CUM_TOKENS = (function () {
  const WIDE_RE = /[぀-ヿ㐀-䶿一-鿿가-힯豈-﫿]/g;
  const PIECE_RE = /[A-Za-zÀ-ɏͰ-ϿЀ-ӿ]+|\d+|\s{2,}|[^\sA-Za-z\d]+/g;

  function estimate(str) {
    if (!str || typeof str !== "string") return 0;
    let tokens = 0;
    const wide = str.match(WIDE_RE);
    if (wide) { tokens += wide.length; str = str.replace(WIDE_RE, " "); }
    const pieces = str.match(PIECE_RE);
    if (!pieces) return tokens;
    for (const p of pieces) {
      const c = p.charCodeAt(0);
      if (c <= 32) { tokens += 1; continue; }
      if (c >= 48 && c <= 57) { tokens += Math.ceil(p.length / 3); continue; }
      if (!/[A-Za-zÀ-ɏͰ-ϿЀ-ӿ]/.test(p[0])) {
        tokens += /^[\x21-\x7e]+$/.test(p) ? Math.ceil(p.length / 2) : p.length;
        continue;
      }
      tokens += p.length <= 6 ? 1 : Math.ceil(p.length / 4.5);
    }
    return tokens;
  }

  // OpenAI's published image formula (high detail): fit in 2048x2048, scale
  // shortest side to 768, then 170 per 512px tile + 85.
  function imageTokens(w, h) {
    w = +w || 1024; h = +h || 1024;
    let s = Math.min(1, 2048 / Math.max(w, h)); w *= s; h *= s;
    s = Math.min(1, 768 / Math.min(w, h)); w *= s; h *= s;
    const tiles = Math.ceil(w / 512) * Math.ceil(h / 512);
    return 85 + 170 * tiles;
  }

  function textOf(node, out, depth) {
    depth = depth || 0;
    if (node == null || depth > 6) return;
    if (typeof node === "string") { out.push(node); return; }
    if (Array.isArray(node)) { for (const n of node) textOf(n, out, depth + 1); return; }
    if (typeof node !== "object") return;
    for (const k of ["text", "title", "content", "result", "summary", "snippet", "body"]) {
      if (node[k] != null) textOf(node[k], out, depth + 1);
    }
  }

  const SKIP_TYPES = /^(thoughts|reasoning_recap|model_editable_context|system_error)$/;

  function messageTokens(msg) {
    const r = { text: 0, images: 0 };
    if (!msg || !msg.content) return r;
    const c = msg.content;
    const type = String(c.content_type || "");
    if (SKIP_TYPES.test(type)) return r;
    if (type === "user_editable_context") {
      r.text += estimate(c.user_profile || "") + estimate(c.user_instructions || "");
      return r;
    }
    if (type === "code" || type === "execution_output") {
      r.text += estimate(c.text || "");
      return r;
    }
    const parts = Array.isArray(c.parts) ? c.parts : [];
    for (const p of parts) {
      if (typeof p === "string") { r.text += estimate(p); continue; }
      if (p && typeof p === "object") {
        const pt = String(p.content_type || "");
        if (/image_asset_pointer/.test(pt)) { r.images += imageTokens(p.width, p.height); continue; }
        if (/audio|video/.test(pt)) continue;
        const out = []; textOf(p, out); r.text += estimate(out.join("\n"));
      }
    }
    if (!parts.length) {
      const out = []; textOf(c, out); r.text += estimate(out.join("\n"));
    }
    return r;
  }

  function fromConversation(conv) {
    const result = { total: 0, user: 0, assistant: 0, tools: 0, images: 0, context: 0, messages: 0, title: "" };
    if (!conv || !conv.mapping) return null;
    result.title = conv.title || "";
    const map = conv.mapping;
    let id = conv.current_node;
    if (!id || !map[id]) {
      // Fallback: the deepest leaf.
      const leaves = Object.values(map).filter((n) => !n.children || !n.children.length);
      id = leaves.length ? leaves[leaves.length - 1].id : null;
    }
    const seen = new Set();
    while (id && map[id] && !seen.has(id)) {
      seen.add(id);
      const node = map[id];
      const msg = node.message;
      if (msg) {
        const role = (msg.author && msg.author.role) || "";
        const meta = msg.metadata || {};
        const t = messageTokens(msg);
        const type = msg.content && msg.content.content_type;
        if (type === "user_editable_context") {
          result.context += t.text;
        } else if (role === "system" && meta.is_visually_hidden_from_conversation) {
          // scaffolding — skip
        } else if (role === "user") {
          result.user += t.text; result.images += t.images; result.messages++;
        } else if (role === "assistant") {
          result.assistant += t.text; result.images += t.images;
          if (type === "text" || type === "multimodal_text") result.messages++;
        } else if (role === "tool") {
          result.tools += t.text; result.images += t.images;
        }
      }
      id = node.parent;
    }
    result.total = result.user + result.assistant + result.tools + result.images + result.context;
    return result;
  }

  return { estimate, imageTokens, fromConversation };
})();
