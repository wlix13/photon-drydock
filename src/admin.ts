// A browser-facing admin panel served at /admin.
//
// It is a self-contained HTML page (inline CSS + JS, no external dependencies so
// it works offline and under a strict CSP) that drives the existing /v2/ JSON
// API from the browser:
//   - GET  /v2/_catalog                     -> repositories
//   - GET  /v2/<name>/tags/list             -> tags of a repository
//   - GET  /v2/<name>/manifests/<reference> -> manifest (details)
//   - GET  /v2/<name>/blobs/<digest>        -> image config (created/arch/os)
//   - DELETE /v2/<name>/manifests/<ref>     -> delete a tag or a whole manifest
//   - POST /v2/<name>/gc?mode=...           -> garbage collection
//
// Authentication and authorization are handled by the main fetch handler and the
// per-method capability checks in token.ts: viewing needs "pull", while delete/GC
// need "push". A read-only user can browse but their DELETE/POST calls return 401,
// which the UI surfaces as an "insufficient permissions" message.

const ADMIN_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Registry Admin</title>
<style>
  :root {
    --bg: #f6f7f9;
    --panel: #ffffff;
    --panel-2: #fafbfc;
    --border: #e4e7eb;
    --text: #1f2328;
    --muted: #656d76;
    --accent: #2563eb;
    --accent-fg: #ffffff;
    --danger: #cf222e;
    --danger-bg: #ffebe9;
    --badge-bg: #eef1f4;
    --shadow: 0 1px 2px rgba(0,0,0,.06), 0 1px 3px rgba(0,0,0,.05);
    --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0d1117;
      --panel: #161b22;
      --panel-2: #12161c;
      --border: #30363d;
      --text: #e6edf3;
      --muted: #8b949e;
      --accent: #388bfd;
      --accent-fg: #ffffff;
      --danger: #f85149;
      --danger-bg: #3a0f11;
      --badge-bg: #21262d;
      --shadow: 0 1px 2px rgba(0,0,0,.4);
    }
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    background: var(--bg);
    color: var(--text);
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  header {
    position: sticky; top: 0; z-index: 20;
    display: flex; align-items: center; gap: 14px;
    padding: 12px 20px;
    background: color-mix(in srgb, var(--panel) 88%, transparent);
    backdrop-filter: saturate(1.4) blur(8px);
    border-bottom: 1px solid var(--border);
  }
  .brand { display: flex; align-items: center; gap: 10px; font-weight: 650; }
  .brand svg { color: var(--accent); }
  .brand small { color: var(--muted); font-weight: 500; font-size: 12px; }
  .grow { flex: 1; }
  .search {
    display: flex; align-items: center; gap: 8px;
    background: var(--panel); border: 1px solid var(--border);
    border-radius: 8px; padding: 6px 10px; min-width: 200px;
  }
  .search input { border: 0; outline: 0; background: transparent; color: var(--text); width: 100%; font-size: 13px; }
  .search svg { color: var(--muted); flex: none; }
  main { max-width: 1000px; margin: 0 auto; padding: 20px; }
  .statusbar { display: flex; align-items: center; gap: 10px; color: var(--muted); font-size: 13px; margin-bottom: 14px; }
  .statusbar .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--muted); opacity: .5; }

  button {
    font: inherit; cursor: pointer; border-radius: 8px;
    border: 1px solid var(--border); background: var(--panel); color: var(--text);
    padding: 6px 12px; transition: background .12s, border-color .12s, opacity .12s;
  }
  button:hover { background: var(--panel-2); }
  button:active { transform: translateY(0.5px); }
  button:disabled { opacity: .5; cursor: not-allowed; }
  button.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-fg); }
  button.primary:hover { filter: brightness(1.06); background: var(--accent); }
  button.danger { color: var(--danger); }
  button.danger:hover { background: var(--danger-bg); border-color: var(--danger); }
  button.sm { padding: 3px 9px; font-size: 12px; }

  .repo {
    background: var(--panel); border: 1px solid var(--border);
    border-radius: 10px; margin-bottom: 10px; box-shadow: var(--shadow); overflow: hidden;
  }
  .repo-head, .tag-head {
    display: flex; align-items: center; gap: 10px;
    padding: 12px 14px; cursor: pointer; user-select: none;
  }
  .repo-head:hover, .tag-head:hover { background: var(--panel-2); }
  .repo-name { font-weight: 600; }
  .caret { display: inline-flex; color: var(--muted); transition: transform .15s ease; flex: none; }
  .open > .caret, .caret.open { transform: rotate(90deg); }
  .badge {
    font-size: 12px; color: var(--muted); background: var(--badge-bg);
    border-radius: 999px; padding: 1px 9px; white-space: nowrap;
  }
  .badge.mono { font-family: var(--mono); }
  .repo-body, .tag-body { display: none; }
  .repo.open > .repo-body, .tag.open > .tag-body { display: block; }
  .repo-body { border-top: 1px solid var(--border); background: var(--panel-2); }

  .tag { border-bottom: 1px solid var(--border); }
  .tag:last-child { border-bottom: 0; }
  .tag-head { padding: 10px 14px 10px 30px; }
  .tag-name { font-family: var(--mono); font-size: 13px; }
  .tag-body { padding: 4px 14px 16px 30px; }

  .kv { display: grid; grid-template-columns: 130px 1fr; gap: 6px 14px; align-items: start; }
  .kv dt { color: var(--muted); font-size: 12px; padding-top: 2px; }
  .kv dd { margin: 0; }
  .mono { font-family: var(--mono); font-size: 12.5px; word-break: break-all; }
  .copy { cursor: pointer; border: 0; background: transparent; color: inherit; padding: 0; font: inherit; text-align: left; }
  .copy:hover { color: var(--accent); background: transparent; }
  .platforms { display: flex; flex-wrap: wrap; gap: 6px; }
  .plat { font-family: var(--mono); font-size: 12px; border: 1px solid var(--border); border-radius: 6px; padding: 1px 7px; }
  .row-actions { margin-top: 14px; display: flex; gap: 8px; flex-wrap: wrap; }
  .muted { color: var(--muted); }
  .spin { display: inline-block; width: 13px; height: 13px; border: 2px solid var(--border); border-top-color: var(--accent); border-radius: 50%; animation: sp .7s linear infinite; vertical-align: -2px; }
  @keyframes sp { to { transform: rotate(360deg); } }

  .empty { text-align: center; color: var(--muted); padding: 60px 20px; }
  .empty svg { color: var(--border); }

  /* Modal */
  .overlay {
    position: fixed; inset: 0; z-index: 40; display: none;
    align-items: center; justify-content: center;
    background: rgba(0,0,0,.4); padding: 20px;
  }
  .overlay.show { display: flex; }
  .dialog {
    background: var(--panel); border: 1px solid var(--border); border-radius: 12px;
    box-shadow: 0 12px 40px rgba(0,0,0,.35); width: 100%; max-width: 440px; padding: 20px;
  }
  .dialog h3 { margin: 0 0 8px; font-size: 16px; }
  .dialog p { margin: 0 0 16px; color: var(--muted); }
  .dialog .mono { color: var(--text); }
  .dialog-actions { display: flex; justify-content: flex-end; gap: 8px; }
  .choices { display: flex; flex-direction: column; gap: 8px; margin: 0 0 18px; }
  .choice { display: flex; gap: 10px; align-items: flex-start; border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; cursor: pointer; }
  .choice:hover { background: var(--panel-2); }
  .choice input { margin-top: 3px; }
  .choice .t { font-weight: 600; }
  .choice .d { color: var(--muted); font-size: 12.5px; }

  /* Toasts */
  #toasts { position: fixed; right: 16px; bottom: 16px; z-index: 60; display: flex; flex-direction: column; gap: 8px; }
  .toast {
    background: var(--panel); border: 1px solid var(--border); border-left: 3px solid var(--accent);
    border-radius: 8px; box-shadow: var(--shadow); padding: 10px 14px; max-width: 360px; font-size: 13px;
    animation: slidein .18s ease;
  }
  .toast.error { border-left-color: var(--danger); }
  .toast.success { border-left-color: #2da44e; }
  @keyframes slidein { from { opacity: 0; transform: translateY(6px); } }
</style>
</head>
<body>
<header>
  <div class="brand">
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 2l9 5v10l-9 5-9-5V7z"/><path d="M3 7l9 5 9-5M12 12v10"/></svg>
    <span>Container Registry <small>/ admin</small></span>
  </div>
  <div class="grow"></div>
  <label class="search">
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>
    <input id="filter" type="search" placeholder="Filter repositories" autocomplete="off" />
  </label>
  <button id="refresh">Refresh</button>
</header>
<main>
  <div class="statusbar"><span id="status">Loading…</span></div>
  <div id="repos"></div>
  <div id="loadmore" style="display:none; text-align:center; margin-top:8px;"><button id="loadmore-btn">Load more repositories</button></div>
</main>

<div class="overlay" id="overlay"><div class="dialog" id="dialog"></div></div>
<div id="toasts"></div>

<script>
"use strict";
(function () {
  var PAGE_SIZE = 1000;
  var MANIFEST_ACCEPT = [
    "application/vnd.oci.image.index.v1+json",
    "application/vnd.docker.distribution.manifest.list.v2+json",
    "application/vnd.oci.image.manifest.v1+json",
    "application/vnd.docker.distribution.manifest.v2+json"
  ].join(", ");

  var els = {
    repos: document.getElementById("repos"),
    status: document.getElementById("status"),
    filter: document.getElementById("filter"),
    refresh: document.getElementById("refresh"),
    loadmore: document.getElementById("loadmore"),
    loadmoreBtn: document.getElementById("loadmore-btn"),
    overlay: document.getElementById("overlay"),
    dialog: document.getElementById("dialog"),
    toasts: document.getElementById("toasts")
  };

  var catalogCursor = null;
  var repoEls = []; // { name, el }

  // --- tiny hyperscript helper (avoids innerHTML, so text is always escaped) ---
  function h(tag, props) {
    var el = document.createElement(tag);
    if (props) {
      for (var k in props) {
        var v = props[k];
        if (v == null) continue;
        if (k === "class") el.className = v;
        else if (k === "text") el.textContent = v;
        else if (k === "html") el.innerHTML = v; // only used with static strings
        else if (k.indexOf("on") === 0 && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
        else el.setAttribute(k, v);
      }
    }
    for (var i = 2; i < arguments.length; i++) {
      var c = arguments[i];
      if (c == null || c === false) continue;
      if (Array.isArray(c)) {
        for (var j = 0; j < c.length; j++) {
          var cc = c[j];
          if (cc == null) continue;
          el.appendChild(typeof cc === "string" ? document.createTextNode(cc) : cc);
        }
      } else {
        el.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
      }
    }
    return el;
  }

  function caret() {
    return h("span", { class: "caret", html: '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 4l4 4-4 4"/></svg>' });
  }

  function fmtBytes(n) {
    if (n == null || isNaN(n)) return "—";
    if (n === 0) return "0 B";
    var u = ["B", "KB", "MB", "GB", "TB"];
    var i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), u.length - 1);
    return (n / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1) + " " + u[i];
  }
  function fmtDate(s) {
    if (!s) return "—";
    var d = new Date(s);
    return isNaN(d.getTime()) ? s : d.toLocaleString();
  }
  function shortDigest(d) {
    if (!d) return "—";
    var m = /^([a-z0-9]+):([0-9a-f]+)$/i.exec(d);
    if (!m) return d;
    return m[1] + ":" + m[2].slice(0, 16);
  }

  function toast(msg, kind) {
    var t = h("div", { class: "toast" + (kind ? " " + kind : ""), text: msg });
    els.toasts.appendChild(t);
    setTimeout(function () {
      t.style.transition = "opacity .3s";
      t.style.opacity = "0";
      setTimeout(function () { t.remove(); }, 300);
    }, kind === "error" ? 6000 : 3500);
  }

  // Encode a repository name for use in a path, preserving the "/" separators.
  function encodeName(name) {
    return name.split("/").map(encodeURIComponent).join("/");
  }

  async function api(path, opts) {
    opts = opts || {};
    opts.credentials = "same-origin";
    var res = await fetch(path, opts);
    if (res.status === 401) {
      var e = new Error("unauthorized");
      e.unauthorized = true;
      throw e;
    }
    return res;
  }

  function handleError(err, action) {
    if (err && err.unauthorized) {
      toast("Not authorized to " + action + ". Your credentials may be read-only or your session expired.", "error");
    } else {
      toast("Failed to " + action + ": " + (err && err.message ? err.message : "unknown error"), "error");
    }
  }

  // ---------------- Catalog ----------------
  async function loadCatalog(reset) {
    if (reset) {
      catalogCursor = null;
      repoEls = [];
      els.repos.innerHTML = "";
      els.loadmore.style.display = "none";
    }
    els.status.textContent = "Loading repositories…";
    try {
      var url = "/v2/_catalog?n=" + PAGE_SIZE + (catalogCursor ? "&last=" + encodeURIComponent(catalogCursor) : "");
      var res = await api(url, { headers: { Accept: "application/json" } });
      if (!res.ok) throw new Error("HTTP " + res.status);
      var data = await res.json();
      var repos = (data.repositories || []).slice().sort();
      for (var i = 0; i < repos.length; i++) addRepo(repos[i]);

      // Determine whether there is another page from the Link header cursor.
      var link = res.headers.get("Link");
      if (repos.length >= PAGE_SIZE && link && link.indexOf("last=") >= 0) {
        catalogCursor = link.substring(link.indexOf("last=") + 5).split(";")[0].trim();
        els.loadmore.style.display = catalogCursor ? "block" : "none";
      } else {
        catalogCursor = null;
        els.loadmore.style.display = "none";
      }
      updateStatus();
      if (repoEls.length === 0) showEmpty();
    } catch (err) {
      handleError(err, "load repositories");
      els.status.textContent = "Error loading repositories.";
    }
  }

  function showEmpty() {
    els.repos.appendChild(
      h("div", { class: "empty" },
        h("div", { html: '<svg width="46" height="46" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M12 2l9 5v10l-9 5-9-5V7z"/><path d="M3 7l9 5 9-5M12 12v10"/></svg>' }),
        h("p", null, "No repositories yet. Push an image to get started.")
      )
    );
  }

  function updateStatus() {
    var shown = repoEls.filter(function (r) { return r.el.style.display !== "none"; }).length;
    var total = repoEls.length;
    els.status.textContent = total === 0 ? "No repositories" :
      (shown === total ? total + " repositor" + (total === 1 ? "y" : "ies") : shown + " of " + total + " repositories");
  }

  // ---------------- Repository ----------------
  function addRepo(name) {
    var head = h("div", { class: "repo-head" },
      caret(),
      h("span", { class: "repo-name", text: name }),
      h("span", { class: "badge", text: "tags", title: "Expand to load tags" }),
      h("span", { class: "grow", style: "flex:1" }),
      h("button", { class: "sm", title: "Run garbage collection on this repository", onclick: function (e) { e.stopPropagation(); openGCDialog(name); } }, "Garbage collect")
    );
    var body = h("div", { class: "repo-body" });
    var repo = h("div", { class: "repo" }, head, body);
    repo._loaded = false;
    head.addEventListener("click", function () {
      var open = repo.classList.toggle("open");
      if (open && !repo._loaded) loadTags(name, body, head);
    });
    els.repos.appendChild(repo);
    repoEls.push({ name: name, el: repo });
    return repo;
  }

  async function loadTags(name, body, head) {
    body.innerHTML = "";
    body.appendChild(h("div", { class: "muted", style: "padding:12px 14px 12px 30px" }, h("span", { class: "spin" }), " Loading tags…"));
    try {
      var res = await api("/v2/" + encodeName(name) + "/tags/list?n=" + PAGE_SIZE, { headers: { Accept: "application/json" } });
      if (!res.ok) throw new Error("HTTP " + res.status);
      var data = await res.json();
      var tags = (data.tags || []).slice().sort();
      body.innerHTML = "";
      var badge = head.querySelector(".badge");
      badge.textContent = tags.length + (tags.length === 1 ? " tag" : " tags");
      body.parentNode._loaded = true;
      if (tags.length === 0) {
        body.appendChild(h("div", { class: "muted", style: "padding:12px 14px 12px 30px" }, "No tags."));
        return;
      }
      for (var i = 0; i < tags.length; i++) body.appendChild(makeTag(name, tags[i]));
    } catch (err) {
      body.innerHTML = "";
      body.appendChild(h("div", { class: "muted", style: "padding:12px 14px 12px 30px" }, "Failed to load tags."));
      handleError(err, "load tags for " + name);
    }
  }

  // ---------------- Tag ----------------
  function makeTag(name, tag) {
    var sizeBadge = h("span", { class: "badge mono", text: "" });
    var head = h("div", { class: "tag-head" },
      caret(),
      h("span", { class: "tag-name", text: tag }),
      h("span", { style: "flex:1" }),
      sizeBadge,
      h("button", { class: "sm danger", title: "Delete this tag", onclick: function (e) { e.stopPropagation(); confirmDeleteTag(name, tag, tagEl); } }, "Delete")
    );
    var body = h("div", { class: "tag-body" });
    var tagEl = h("div", { class: "tag" }, head, body);
    tagEl._loaded = false;
    head.addEventListener("click", function () {
      var open = tagEl.classList.toggle("open");
      if (open && !tagEl._loaded) loadTagDetails(name, tag, body, sizeBadge, tagEl);
    });
    return tagEl;
  }

  async function loadTagDetails(name, tag, body, sizeBadge, tagEl) {
    body.innerHTML = "";
    body.appendChild(h("div", { class: "muted" }, h("span", { class: "spin" }), " Loading manifest…"));
    try {
      var res = await api("/v2/" + encodeName(name) + "/manifests/" + encodeURIComponent(tag), { headers: { Accept: MANIFEST_ACCEPT } });
      if (!res.ok) throw new Error("HTTP " + res.status);
      var digest = res.headers.get("Docker-Content-Digest") || "";
      var contentType = res.headers.get("Content-Type") || "";
      var manifest = await res.json();
      tagEl._loaded = true;
      tagEl._digest = digest;
      var view = await describeManifest(name, manifest, contentType);
      if (view.totalSize != null) sizeBadge.textContent = fmtBytes(view.totalSize);
      renderTagDetails(body, name, tag, digest, view);
    } catch (err) {
      body.innerHTML = "";
      body.appendChild(h("div", { class: "muted" }, "Failed to load manifest details."));
      handleError(err, "load manifest for " + name + ":" + tag);
    }
  }

  // Turn a raw manifest into a display model, fetching the config blob for images.
  async function describeManifest(name, manifest, contentType) {
    var v = { mediaType: manifest.mediaType || contentType || "unknown", kind: "unknown", totalSize: null, layers: null, platforms: null, created: null, arch: null, os: null };

    if (manifest.manifests) {
      // Image index / manifest list (multi-arch).
      v.kind = "index";
      v.platforms = manifest.manifests.map(function (m) {
        var p = m.platform || {};
        var label = (p.os || "?") + "/" + (p.architecture || "?") + (p.variant ? "/" + p.variant : "");
        return { label: label, digest: m.digest, size: m.size };
      });
      v.totalSize = manifest.manifests.reduce(function (a, m) { return a + (m.size || 0); }, 0);
    } else if (manifest.config && manifest.layers) {
      // Single image manifest.
      v.kind = "image";
      v.layers = manifest.layers.length;
      v.totalSize = (manifest.config.size || 0) + manifest.layers.reduce(function (a, l) { return a + (l.size || 0); }, 0);
      // Fetch the config blob for created date + platform (best-effort).
      try {
        var cres = await api("/v2/" + encodeName(name) + "/blobs/" + encodeURIComponent(manifest.config.digest), { headers: { Accept: "application/json" } });
        if (cres.ok) {
          var cfg = await cres.json();
          v.created = cfg.created || null;
          v.arch = cfg.architecture || null;
          v.os = cfg.os || null;
        }
      } catch (e) { /* config is best-effort */ }
    } else if (manifest.fsLayers) {
      v.kind = "image-v1";
      v.layers = manifest.fsLayers.length;
      v.arch = manifest.architecture || null;
    }
    return v;
  }

  function digestField(digest) {
    return h("button", {
      class: "copy mono", title: "Click to copy " + digest,
      onclick: function () {
        if (navigator.clipboard) navigator.clipboard.writeText(digest).then(function () { toast("Digest copied", "success"); });
      }
    }, shortDigest(digest));
  }

  function renderTagDetails(body, name, tag, digest, v) {
    body.innerHTML = "";
    var kv = h("dl", { class: "kv" });
    function row(k, valNode) { kv.appendChild(h("dt", { text: k })); kv.appendChild(h("dd", null, valNode)); }

    row("Digest", digest ? digestField(digest) : h("span", { class: "muted" }, "—"));
    row("Media type", h("span", { class: "mono", text: v.mediaType }));
    row("Total size", document.createTextNode(v.totalSize != null ? fmtBytes(v.totalSize) : "—"));

    if (v.kind === "index") {
      var pl = h("div", { class: "platforms" }, v.platforms.map(function (p) { return h("span", { class: "plat", text: p.label, title: p.digest }); }));
      row("Platforms", pl);
      row("", h("span", { class: "muted", text: v.platforms.length + " manifest" + (v.platforms.length === 1 ? "" : "s") + " (size shown is the manifest list, not the full images)" }));
    } else if (v.kind === "image") {
      row("Layers", document.createTextNode(v.layers != null ? String(v.layers) : "—"));
      if (v.os || v.arch) row("Platform", h("span", { class: "mono", text: (v.os || "?") + "/" + (v.arch || "?") }));
      row("Created", document.createTextNode(fmtDate(v.created)));
    } else if (v.kind === "image-v1") {
      row("Layers", document.createTextNode(String(v.layers)));
      if (v.arch) row("Architecture", h("span", { class: "mono", text: v.arch }));
      row("", h("span", { class: "muted", text: "Schema v1 (legacy) manifest" }));
    }

    body.appendChild(kv);
    body.appendChild(
      h("div", { class: "row-actions" },
        h("button", { class: "sm danger", onclick: function () { confirmDeleteManifest(name, tag, digest); } }, "Delete manifest + all its tags")
      )
    );
  }

  // ---------------- Destructive actions ----------------
  function confirmDeleteTag(name, tag, tagEl) {
    openDialog({
      title: "Delete tag",
      body: [h("p", null, "Remove the tag ", h("span", { class: "mono", text: tag }), " from ", h("span", { class: "mono", text: name }), "? The underlying manifest and other tags are kept.")],
      confirmLabel: "Delete tag",
      danger: true,
      onConfirm: async function () {
        await deleteRef(name, tag, "delete tag " + tag);
        if (tagEl && tagEl.parentNode) tagEl.remove();
        toast("Tag " + tag + " deleted", "success");
      }
    });
  }

  function confirmDeleteManifest(name, tag, digest) {
    if (!digest) { toast("Manifest digest is unknown; cannot delete by digest.", "error"); return; }
    openDialog({
      title: "Delete manifest",
      body: [h("p", null, "Delete manifest ", h("span", { class: "mono", text: shortDigest(digest) }), " from ", h("span", { class: "mono", text: name }), " and every tag pointing at it? This cannot be undone.")],
      confirmLabel: "Delete manifest",
      danger: true,
      onConfirm: async function () {
        await deleteRef(name, digest, "delete manifest");
        toast("Manifest deleted. Refreshing tags…", "success");
        refreshRepo(name);
      }
    });
  }

  async function deleteRef(name, reference, action) {
    var res = await api("/v2/" + encodeName(name) + "/manifests/" + encodeURIComponent(reference), { method: "DELETE" });
    if (!res.ok && res.status !== 202) throw new Error("HTTP " + res.status);
  }

  function openGCDialog(name) {
    var mode = "untagged";
    function choice(value, title, desc) {
      var input = h("input", { type: "radio", name: "gcmode", value: value });
      if (value === mode) input.checked = true;
      input.addEventListener("change", function () { mode = value; });
      return h("label", { class: "choice" }, input, h("div", null, h("div", { class: "t", text: title }), h("div", { class: "d", text: desc })));
    }
    openDialog({
      title: "Garbage collect " + name,
      body: [
        h("p", null, "Reclaim storage by removing manifests and unreferenced blobs."),
        h("div", { class: "choices" },
          choice("untagged", "Untagged", "Remove manifests that have no tag, then prune blobs they alone referenced."),
          choice("unreferenced", "Unreferenced", "Remove blobs not referenced by any manifest (keeps all tagged manifests).")
        )
      ],
      confirmLabel: "Run garbage collection",
      onConfirm: async function () {
        var res = await api("/v2/" + encodeName(name) + "/gc?mode=" + mode, { method: "POST" });
        if (!res.ok) throw new Error("HTTP " + res.status);
        var out = await res.json().catch(function () { return {}; });
        toast("Garbage collection (" + mode + ") " + (out && out.success === false ? "reported failure" : "completed") + " for " + name, out && out.success === false ? "error" : "success");
        refreshRepo(name);
      }
    });
  }

  // Reload the tags of an already-expanded repository (after a mutation).
  function refreshRepo(name) {
    var entry = repoEls.find(function (r) { return r.name === name; });
    if (!entry) return;
    var repo = entry.el;
    repo._loaded = false;
    if (repo.classList.contains("open")) {
      var body = repo.querySelector(".repo-body");
      var head = repo.querySelector(".repo-head");
      loadTags(name, body, head);
    }
  }

  // ---------------- Dialog ----------------
  function openDialog(opts) {
    els.dialog.innerHTML = "";
    var confirmBtn = h("button", { class: opts.danger ? "danger" : "primary" }, opts.confirmLabel || "Confirm");
    var cancelBtn = h("button", null, "Cancel");
    cancelBtn.addEventListener("click", closeDialog);
    confirmBtn.addEventListener("click", async function () {
      confirmBtn.disabled = true;
      cancelBtn.disabled = true;
      var prev = confirmBtn.textContent;
      confirmBtn.innerHTML = '<span class="spin"></span> Working…';
      try {
        await opts.onConfirm();
        closeDialog();
      } catch (err) {
        handleError(err, (opts.confirmLabel || "confirm").toLowerCase());
        confirmBtn.disabled = false;
        cancelBtn.disabled = false;
        confirmBtn.textContent = prev;
      }
    });
    var content = [h("h3", { text: opts.title })];
    (opts.body || []).forEach(function (b) { content.push(b); });
    content.push(h("div", { class: "dialog-actions" }, cancelBtn, confirmBtn));
    content.forEach(function (c) { els.dialog.appendChild(c); });
    els.overlay.classList.add("show");
  }
  function closeDialog() { els.overlay.classList.remove("show"); els.dialog.innerHTML = ""; }
  els.overlay.addEventListener("click", function (e) { if (e.target === els.overlay) closeDialog(); });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeDialog(); });

  // ---------------- Filter ----------------
  els.filter.addEventListener("input", function () {
    var q = els.filter.value.trim().toLowerCase();
    repoEls.forEach(function (r) { r.el.style.display = (!q || r.name.toLowerCase().indexOf(q) >= 0) ? "" : "none"; });
    updateStatus();
  });

  els.refresh.addEventListener("click", function () { loadCatalog(true); });
  els.loadmoreBtn.addEventListener("click", function () { loadCatalog(false); });

  loadCatalog(true);
})();
</script>
</body>
</html>`;

export function adminPageResponse(): Response {
  return new Response(ADMIN_HTML, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      // The shell itself is tiny and must never be served stale from a proxy.
      "Cache-Control": "no-store",
    },
  });
}
