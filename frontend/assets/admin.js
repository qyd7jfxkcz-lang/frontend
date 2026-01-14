const AUTH_KEY = "iasc_admin_auth_v1";
const STORAGE_KEY = "iasc_chat_logs_v1";

const DEMO_USER = "admin";
const DEMO_PASS = "admin123";

function $(id) {
  return document.getElementById(id);
}

function nowMs() {
  return Date.now();
}

function setAuth() {
  sessionStorage.setItem(AUTH_KEY, JSON.stringify({ ok: true, ts: nowMs() }));
}

function clearAuth() {
  sessionStorage.removeItem(AUTH_KEY);
}

function isAuthed() {
  try {
    const raw = sessionStorage.getItem(AUTH_KEY);
    if (!raw) return false;
    const obj = JSON.parse(raw);
    return !!obj.ok;
  } catch {
    return false;
  }
}

function loadLogs() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function download(filename, content, type) {
  const blob = new Blob([content], { type: type || "application/octet-stream" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 250);
}

function toCSV(rows) {
  const header = ["ts", "id", "mode", "lang", "source", "tag", "confidence", "userName", "program", "level", "feedback", "userText", "botText"];
  const esc = (v) => `"${String(v ?? "").replaceAll('"', '""')}"`;
  const lines = [header.join(",")];
  for (const r of rows) {
    lines.push(
      [
        esc(r.ts),
        esc(r.id),
        esc(r.mode),
        esc(r.lang),
        esc(r.source),
        esc(r.tag),
        esc(r.confidence),
        esc(r.userName),
        esc(r.program),
        esc(r.level),
        esc(r.feedback),
        esc(r.userText),
        esc(r.botText),
      ].join(",")
    );
  }
  return lines.join("\n");
}

function countBy(rows, key) {
  const m = new Map();
  for (const r of rows) {
    const k = String(r[key] ?? "unknown");
    m.set(k, (m.get(k) || 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

function renderTable(el, entries, max) {
  const top = entries.slice(0, max || 12);
  el.innerHTML = top.map(([k, v]) => `<div><code>${k}</code> — ${v}</div>`).join("");
}

function drawBarChart(canvas, entries, opts) {
  const ctx = canvas.getContext("2d");
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  const bg = "rgba(255,255,255,0.04)";
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);

  const pad = 32;
  const maxBars = (opts && opts.maxBars) || 10;
  const bars = entries.slice(0, maxBars);
  const maxV = Math.max(1, ...bars.map(([, v]) => v));

  const barW = (w - pad * 2) / Math.max(1, bars.length);
  const accent = (opts && opts.color) || "rgba(124,92,255,0.75)";
  const label = "rgba(255,255,255,0.75)";

  ctx.font = "14px ui-sans-serif, system-ui";
  ctx.fillStyle = label;
  ctx.fillText((opts && opts.title) || "", pad, 20);

  bars.forEach(([k, v], i) => {
    const x = pad + i * barW + 8;
    const barH = ((h - pad * 2) * v) / maxV;
    const y = h - pad - barH;
    ctx.fillStyle = accent;
    ctx.fillRect(x, y, Math.max(8, barW - 16), barH);
    ctx.fillStyle = "rgba(255,255,255,0.68)";
    ctx.font = "12px ui-sans-serif, system-ui";
    ctx.fillText(String(v), x, y - 6);
    ctx.fillStyle = "rgba(255,255,255,0.50)";
    const kk = String(k).length > 14 ? String(k).slice(0, 13) + "…" : String(k);
    ctx.fillText(kk, x, h - 14);
  });
}

function renderDashboard() {
  if (!isAuthed()) {
    window.location.href = "./login.html";
    return;
  }

  const logs = loadLogs();
  const overviewText = $("overviewText");
  const intentChart = $("intentChart");
  const langChart = $("langChart");
  const userChart = $("userChart");
  const intentTable = $("intentTable");
  const langTable = $("langTable");
  const userTable = $("userTable");
  const recent = $("recent");
  const userFilter = $("userFilter");
  const modeFilter = $("modeFilter");
  const feedbackFilter = $("feedbackFilter");
  const searchInput = $("searchInput");
  const unresolved = $("unresolved");

  const total = logs.length;
  const last = logs[total - 1];
  const lastAt = last ? last.ts : "—";

  // Build user list and preserve selection on rerenders
  const prevSelected = userFilter?.value || "(all)";
  const users = ["(all)"].concat(
    [...new Set(logs.map((x) => String(x.userName || "Guest")))].sort((a, b) => a.localeCompare(b))
  );
  if (userFilter) {
    userFilter.innerHTML = users.map((u) => `<option value="${u}">${u}</option>`).join("");
    userFilter.value = users.includes(prevSelected) ? prevSelected : "(all)";
  }

  const selectedUser = userFilter?.value || "(all)";
  const selectedMode = modeFilter?.value || "(all)";
  const selectedFeedback = feedbackFilter?.value || "(all)";
  const search = (searchInput?.value || "").trim().toLowerCase();
  const filtered = logs.filter((r) => {
    const u = String(r.userName || "Guest");
    if (selectedUser !== "(all)" && u !== selectedUser) return false;
    const m = String(r.mode || "local");
    if (selectedMode !== "(all)" && m !== selectedMode) return false;
    const fb = String(r.feedback || "");
    if (selectedFeedback === "none" && fb) return false;
    if (selectedFeedback !== "(all)" && selectedFeedback !== "none" && fb !== selectedFeedback) return false;
    if (search) {
      const t = `${r.userText || ""} ${r.botText || ""}`.toLowerCase();
      if (!t.includes(search)) return false;
    }
    return true;
  });

  overviewText.innerHTML = `
    Total messages (all): <code>${total}</code><br/>
    Visible after filters: <code>${filtered.length}</code><br/>
    Last activity: <code>${lastAt}</code><br/>
    Storage key: <code>${STORAGE_KEY}</code>
  `;

  const intents = countBy(filtered, "tag");
  const langs = countBy(filtered, "lang");
  const sources = countBy(filtered, "source");
  const topUsers = countBy(filtered, "userName");

  drawBarChart(intentChart, intents, { title: "Top intents", color: "rgba(124,92,255,0.70)" });
  renderTable(intentTable, intents, 12);

  // Combine lang + source counts into a single list (visual summary).
  const combined = [["lang:en", langs.find(([k]) => k === "en")?.[1] || 0], ["lang:ar", langs.find(([k]) => k === "ar")?.[1] || 0]]
    .concat(sources.map(([k, v]) => [`src:${k}`, v]));
  drawBarChart(langChart, combined, { title: "Language + source", color: "rgba(43,212,255,0.55)" });
  renderTable(langTable, combined, 12);

  if (userChart && userTable) {
    drawBarChart(userChart, topUsers, { title: "Top users", color: "rgba(124,92,255,0.55)", maxBars: 12 });
    renderTable(userTable, topUsers, 12);
  }

  const last50 = filtered.slice(-50).reverse();
  recent.innerHTML = last50
    .map((r) => {
      const safeUser = String(r.userText || "").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
      const safeBot = String(r.botText || "").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
      const safeName = String(r.userName || "Guest").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
      const fb = r.feedback === "up" ? "👍" : r.feedback === "down" ? "👎" : "—";
      return `
        <div style="padding:10px 0; border-bottom: 1px solid rgba(255,255,255,0.10);">
          <div class="meta"><code>${r.ts}</code> • <code>${safeName}</code> • <code>${r.mode || "local"}</code> • <code>${r.lang}</code> • <code>${r.source}</code> • <code>${r.tag}</code> • ${fb}</div>
          <div><strong>User:</strong> ${safeUser}</div>
          <div><strong>Bot:</strong> ${safeBot}</div>
        </div>
      `;
    })
    .join("");

  // Unresolved: explicit 👎 feedback or frequent fallback intent.
  const unresolvedRows = filtered
    .filter((r) => r.feedback === "down" || r.tag === "fallback")
    .slice(-80)
    .reverse();
  if (unresolved) {
    unresolved.innerHTML = unresolvedRows.length
      ? unresolvedRows
          .map((r) => {
            const safeUser = String(r.userText || "").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
            const safeName = String(r.userName || "Guest").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
            const fb = r.feedback === "down" ? "👎" : r.feedback === "up" ? "👍" : "—";
            return `
              <div style="padding:10px 0; border-bottom: 1px solid rgba(255,255,255,0.10);">
                <div class="meta"><code>${r.ts}</code> • <code>${safeName}</code> • <code>${r.mode || "local"}</code> • <code>${r.lang}</code> • <code>${r.tag}</code> • ${fb}</div>
                <div><strong>User:</strong> ${safeUser}</div>
              </div>
            `;
          })
          .join("")
      : `<div class="meta">No unresolved items in the current filter.</div>`;
  }

  $("logoutBtn")?.addEventListener("click", () => {
    clearAuth();
    window.location.href = "./login.html";
  });

  $("refreshBtn")?.addEventListener("click", () => renderDashboard());
  userFilter?.addEventListener("change", () => renderDashboard());
  modeFilter?.addEventListener("change", () => renderDashboard());
  feedbackFilter?.addEventListener("change", () => renderDashboard());
  searchInput?.addEventListener("input", () => renderDashboard());
  $("exportBtn")?.addEventListener("click", () => download("chat_logs.json", JSON.stringify(logs, null, 2), "application/json"));
  $("downloadCsvBtn")?.addEventListener("click", () => download("chat_logs.csv", toCSV(logs), "text/csv"));
  $("clearBtn")?.addEventListener("click", () => {
    const ok = window.confirm("Clear ALL local chat logs? This only affects this browser.");
    if (!ok) return;
    localStorage.removeItem(STORAGE_KEY);
    renderDashboard();
  });
}

function wireLogin() {
  const form = $("loginForm");
  if (!form) return;

  if (isAuthed()) {
    window.location.href = "./dashboard.html";
    return;
  }

  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const u = ($("username").value || "").trim();
    const p = ($("password").value || "").trim();
    const err = $("error");
    if (u === DEMO_USER && p === DEMO_PASS) {
      setAuth();
      window.location.href = "./dashboard.html";
      return;
    }
    err.textContent = "Invalid credentials.";
  });
}

// Entry
if (window.location.pathname.endsWith("/admin/dashboard.html")) {
  renderDashboard();
} else {
  wireLogin();
}


