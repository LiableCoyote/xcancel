(function () {
  // ---------- routing constants ----------
  const X_HOSTS = new Set([
    "x.com", "www.x.com", "m.x.com",
    "twitter.com", "www.twitter.com", "mobile.twitter.com",
  ]);
  const XCANCEL_HOSTS = new Set(["xcancel.com", "www.xcancel.com"]);
  const YT_HOSTS = new Set([
    "youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com",
  ]);
  const YT_SHORT_HOSTS = new Set(["youtu.be", "www.youtu.be"]);
  const REDDIT_HOSTS = new Set([
    "reddit.com", "www.reddit.com", "old.reddit.com",
    "np.reddit.com", "new.reddit.com", "amp.reddit.com",
  ]);
  const MEDIUM_HOSTS = new Set(["medium.com", "www.medium.com"]);
  const TRACKING_PARAMS = [
    "s", "t", "ref_src", "ref_url", "cxt",
    "utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term",
    "fbclid", "gclid", "mc_cid", "mc_eid", "igshid", "si",
  ];
  const INVIDIOUS = "yewtu.be";
  const REDLIB = "redlib.catsarch.com";
  const SCRIBE = "scribe.rip";
  const WAYBACK_RE =
    /^https?:\/\/web\.archive\.org\/(?:web|save)\/(?:[^\/]+\/)?(https?:\/\/.+)$/i;

  // Declarative host → mirror table (canonical hostname rewrites).
  // Special-shape routes (youtu.be path rewrite, *.medium.com subdomain,
  // Wayback unwrap, AMP unwrap, Wayback wrap) live outside the table.
  const HOST_ROUTES = [
    { hosts: XCANCEL_HOSTS, kind: "Unwrapped X", to: "x.com",       strip: false },
    { hosts: X_HOSTS,       kind: "X post",      to: "xcancel.com" },
    { hosts: YT_HOSTS,      kind: "YouTube",     to: INVIDIOUS },
    { hosts: REDDIT_HOSTS,  kind: "Reddit",      to: REDLIB },
    { hosts: MEDIUM_HOSTS,  kind: "Medium",      to: SCRIBE },
  ];

  function stripTrackers(url) {
    for (const p of TRACKING_PARAMS) url.searchParams.delete(p);
  }

  function unwrapAmp(s) {
    let m = s.match(/^https?:\/\/www\.google\.com\/amp\/s\/(.+)$/i);
    if (m) return "https://" + m[1];
    m = s.match(/^https?:\/\/cdn\.ampproject\.org\/c\/s\/(.+)$/i);
    if (m) return "https://" + m[1];
    m = s.match(/^https?:\/\/[^\/]+\.cdn\.ampproject\.org\/[vc]\/s\/(.+)$/i);
    if (m) return "https://" + m[1];
    return null;
  }

  function routeByHost(url) {
    const h = url.hostname.toLowerCase();
    for (const r of HOST_ROUTES) {
      if (!r.hosts.has(h)) continue;
      url.hostname = r.to;
      url.protocol = "https:";
      if (r.strip !== false) stripTrackers(url);
      return { ok: true, kind: r.kind, value: url.toString() };
    }
    return null;
  }

  function route(raw, waybackMode) {
    const t = raw.trim();
    if (!t) return { ok: false, error: "" };
    const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(t) ? t : "https://" + t;

    const amp = unwrapAmp(withScheme);
    if (amp) {
      const sub = route(amp, waybackMode);
      if (sub.ok) return { ...sub, kind: sub.kind + " (AMP)" };
      return sub;
    }

    const wb = withScheme.match(WAYBACK_RE);
    if (wb) return { ok: true, kind: "Unwrapped", value: wb[1] };

    let url;
    try { url = new URL(withScheme); }
    catch { return { ok: false, error: "Not a valid URL" }; }
    if (url.protocol !== "http:" && url.protocol !== "https:")
      return { ok: false, error: "Only http(s) URLs are supported" };

    const host = url.hostname.toLowerCase();

    if (YT_SHORT_HOSTS.has(host)) {
      const id = url.pathname.split("/").filter(Boolean)[0] || "";
      if (!id) return { ok: false, error: "Missing video ID" };
      const q = new URLSearchParams({ v: id });
      const tParam = url.searchParams.get("t");
      if (tParam) q.set("t", tParam);
      return { ok: true, kind: "YouTube", value: `https://${INVIDIOUS}/watch?${q.toString()}` };
    }

    if (host.endsWith(".medium.com") && !MEDIUM_HOSTS.has(host)) {
      const sub = host.slice(0, -".medium.com".length);
      const tail = url.pathname.startsWith("/") ? url.pathname : "/" + url.pathname;
      url.hostname = SCRIBE; url.protocol = "https:";
      url.pathname = "/@" + sub + tail;
      stripTrackers(url);
      return { ok: true, kind: "Medium", value: url.toString() };
    }

    const tableHit = routeByHost(url);
    if (tableHit) return tableHit;

    stripTrackers(url);
    const original = url.toString();
    let prefix;
    switch (waybackMode) {
      case "save":     prefix = "https://web.archive.org/save/"; break;
      case "calendar": prefix = "https://web.archive.org/web/*/"; break;
      default:         prefix = "https://web.archive.org/web/";
    }
    return { ok: true, kind: "Web page", value: prefix + original, original };
  }

  // Expose for tests.html.
  window.__test = { route };

  // ---------- DOM init (skipped on pages without our shell) ----------
  const $ = (id) => document.getElementById(id);
  const input = $("input");
  if (!input) return;

  const output       = $("output");
  const inputStatus  = $("inputStatus");
  const copyBtn      = $("copyBtn");
  const copyStatus   = $("copyStatus");
  const openLink     = $("openLink");
  const kindBadge    = $("kind");
  const pasteBtn     = $("pasteBtn");
  const autoCopy     = $("autoCopy");
  const wbOptions    = $("waybackOptions");
  const wbRadios     = document.querySelectorAll('input[name="wayback"]');
  const bookmarklet  = $("bookmarklet");
  const waybackInfo  = $("waybackInfo");
  const historyPanel = $("historyPanel");
  const historyList  = $("historyList");
  const clearHistoryBtn = $("clearHistoryBtn");

  // ---------- preferences ----------
  autoCopy.checked = localStorage.getItem("autoCopy") === "1";
  const savedMode = localStorage.getItem("waybackMode");
  if (savedMode) for (const r of wbRadios) if (r.value === savedMode) r.checked = true;

  function currentMode() {
    for (const r of wbRadios) if (r.checked) return r.value;
    return "latest";
  }

  // ---------- render-diff helpers ----------
  function setVal(node, v)        { if (node.value !== v) node.value = v; }
  function setText(node, v)       { if (node.textContent !== v) node.textContent = v; }
  function setHTML(node, v)       { if (node._html !== v) { node.innerHTML = v; node._html = v; } }
  function setHidden(node, h)     { if (node.hidden !== h) node.hidden = h; }
  function setDisabled(node, d)   { if (node.disabled !== d) node.disabled = d; }
  function setHref(node, v) {
    if (v === null) { if (node.hasAttribute("href")) node.removeAttribute("href"); }
    else if (node.getAttribute("href") !== v) node.setAttribute("href", v);
  }

  // ---------- clipboard helpers ----------
  let copyTimer = 0;
  function flash(msg) {
    setText(copyStatus, msg || "Copied!");
    clearTimeout(flash._t);
    flash._t = setTimeout(() => { setText(copyStatus, ""); }, 1200);
  }
  async function writeClipboard(value) {
    try { await navigator.clipboard.writeText(value); return true; }
    catch {
      try { output.select(); return document.execCommand("copy"); }
      catch { return false; }
    }
  }
  function scheduleAutoCopy(value) {
    clearTimeout(copyTimer);
    if (!autoCopy.checked || !value) return;
    copyTimer = setTimeout(async () => {
      if (await writeClipboard(value)) flash("Auto-copied");
    }, 500);
  }

  // ---------- Wayback availability (sessionStorage-backed) ----------
  const AVAIL_KEY = "availCache";
  const AVAIL_MAX = 50;
  function readAvail() {
    try { return JSON.parse(sessionStorage.getItem(AVAIL_KEY) || "{}"); }
    catch { return {}; }
  }
  function writeAvail(map) {
    const keys = Object.keys(map);
    if (keys.length > AVAIL_MAX) {
      for (const k of keys.slice(0, keys.length - AVAIL_MAX)) delete map[k];
    }
    try { sessionStorage.setItem(AVAIL_KEY, JSON.stringify(map)); }
    catch { /* quota — ignore */ }
  }

  let availToken = 0;
  let availTimer = 0;
  function formatTs(d) {
    return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
  }
  function showAvail(res, token) {
    if (token !== availToken) return;
    if (!res) { setHidden(waybackInfo, true); return; }
    if (res.available) {
      setText(waybackInfo, `Latest snapshot: ${formatTs(res.ts)}`);
    } else {
      setHTML(waybackInfo, "No snapshot yet — select <strong>Save Page Now</strong> to create one.");
    }
    setHidden(waybackInfo, false);
  }
  function scheduleAvailability(originalUrl, mode) {
    clearTimeout(availTimer);
    availToken++;
    if (!originalUrl) { setHidden(waybackInfo, true); return; }
    if (mode === "save") {
      setText(waybackInfo, "Will create a fresh snapshot when opened.");
      setHidden(waybackInfo, false);
      return;
    }
    const cache = readAvail();
    if (cache[originalUrl]) {
      showAvail(cache[originalUrl], availToken);
      return;
    }
    const myToken = availToken;
    setText(waybackInfo, "Checking snapshot…");
    setHidden(waybackInfo, false);
    availTimer = setTimeout(async () => {
      try {
        const r = await fetch(
          `https://archive.org/wayback/available?url=${encodeURIComponent(originalUrl)}`,
          { cache: "no-store" }
        );
        const data = await r.json();
        const c = data && data.archived_snapshots && data.archived_snapshots.closest;
        const res = c && c.available
          ? { available: true, ts: c.timestamp }
          : { available: false };
        const m = readAvail();
        m[originalUrl] = res;
        writeAvail(m);
        showAvail(res, myToken);
      } catch {
        if (myToken === availToken) setHidden(waybackInfo, true);
      }
    }, 600);
  }

  // ---------- history ----------
  function getHistory() {
    try { return JSON.parse(localStorage.getItem("history") || "[]"); }
    catch { return []; }
  }
  function pushHistory(entry) {
    const list = getHistory().filter((h) => h.input !== entry.input);
    list.unshift(entry);
    localStorage.setItem("history", JSON.stringify(list.slice(0, 10)));
  }
  function escapeHtml(s) {
    return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }
  function renderHistory() {
    const items = getHistory();
    if (items.length === 0) { setHidden(historyPanel, true); return; }
    setHidden(historyPanel, false);
    historyList.innerHTML = "";
    for (const h of items) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "history-item";
      btn.innerHTML =
        `<span class="badge">${escapeHtml(h.kind)}</span>` +
        `<span class="hi-url">${escapeHtml(h.input)}</span>`;
      btn.addEventListener("click", () => {
        skipNextHistory = true;
        input.value = h.input;
        render();
        input.focus();
      });
      historyList.appendChild(btn);
    }
  }
  let historyTimer = 0;
  let skipNextHistory = false;
  function scheduleHistory(entry) {
    clearTimeout(historyTimer);
    if (skipNextHistory) { skipNextHistory = false; return; }
    historyTimer = setTimeout(() => {
      pushHistory(entry);
      renderHistory();
    }, 1500);
  }

  // ---------- main render ----------
  let lastValue = "";
  function render() {
    const raw = input.value;
    const result = route(raw, currentMode());
    if (result.ok) {
      setVal(output, result.value);
      setText(inputStatus, "");
      setDisabled(copyBtn, false);
      setHref(openLink, result.value);
      setHidden(openLink, false);
      setText(kindBadge, result.kind);
      setHidden(kindBadge, false);
      setHidden(wbOptions, result.kind !== "Web page");
      if (result.kind === "Web page" && result.original) {
        scheduleAvailability(result.original, currentMode());
      } else {
        setHidden(waybackInfo, true);
        availToken++;
        clearTimeout(availTimer);
      }
      if (result.value !== lastValue) {
        lastValue = result.value;
        scheduleAutoCopy(result.value);
        scheduleHistory({ input: raw.trim(), output: result.value, kind: result.kind, at: Date.now() });
      }
    } else {
      setVal(output, "");
      setText(inputStatus, result.error);
      setDisabled(copyBtn, true);
      setHref(openLink, null);
      setHidden(openLink, true);
      setText(kindBadge, "");
      setHidden(kindBadge, true);
      setHidden(wbOptions, true);
      setHidden(waybackInfo, true);
      lastValue = "";
      clearTimeout(copyTimer);
      clearTimeout(historyTimer);
      clearTimeout(availTimer);
      availToken++;
    }
  }

  input.addEventListener("input", render);
  input.addEventListener("paste", () => setTimeout(render, 0));

  copyBtn.addEventListener("click", async () => {
    if (!output.value) return;
    if (await writeClipboard(output.value)) flash();
  });

  pasteBtn.addEventListener("click", async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) { input.value = text; render(); input.focus(); }
    } catch {
      input.focus();
      setText(inputStatus, "Clipboard read blocked — paste manually.");
    }
  });

  autoCopy.addEventListener("change", () => {
    localStorage.setItem("autoCopy", autoCopy.checked ? "1" : "0");
    if (autoCopy.checked && output.value) scheduleAutoCopy(output.value);
  });

  for (const r of wbRadios) {
    r.addEventListener("change", () => {
      localStorage.setItem("waybackMode", r.value);
      render();
    });
  }

  clearHistoryBtn.addEventListener("click", () => {
    localStorage.removeItem("history");
    renderHistory();
  });

  // ---------- bookmarklet href ----------
  const here = location.origin + location.pathname;
  bookmarklet.href =
    "javascript:void(window.open(" + JSON.stringify(here) +
    "+'?u='+encodeURIComponent(location.href),'_blank'))";

  // ---------- service worker ----------
  if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }

  // ---------- initial population (?u=, share target) ----------
  renderHistory();
  const sp = new URLSearchParams(location.search);
  let initial = sp.get("u") || sp.get("url");
  if (!initial) {
    const text = sp.get("text");
    if (text) {
      const m = text.match(/https?:\/\/\S+/);
      initial = m ? m[0] : text.trim();
    }
  }
  if (initial) {
    input.value = initial;
    render();
    history.replaceState(null, "", location.pathname);
  }
})();
