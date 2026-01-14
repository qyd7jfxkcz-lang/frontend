/* Frontend-only chatbot:
 * - loads backend/data/data.json (bilingual intents)
 * - rules-first, then retrieval fallback (token overlap)
 * - stores chat logs in localStorage for admin dashboard
 */

const DATA_URL = "./data/data.json";
const STORAGE_KEY = "iasc_chat_logs_v1";
const NAME_KEY = "iasc_user_name_v1";
const MODE_KEY = "iasc_mode_v1"; // "local" | "api"
const API_URL_KEY = "iasc_api_url_v1";
const API_KEY_KEY = "iasc_api_key_v1";
const PROFILE_KEY = "iasc_profile_v1";
const THEME_KEY = "iasc_theme_v1"; // "dark" | "light"
// Backend API URL - Railway deployment
const BACKEND_API_URL = "https://backend-production-3e3b.up.railway.app/chat";
// Local development fallback
const LOCAL_API_URL = "http://127.0.0.1:5000/chat";
// Auto-detect: use Railway URL if not on localhost, otherwise use local
const DEFAULT_API_URL = (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1") 
  ? LOCAL_API_URL 
  : BACKEND_API_URL;
const API_TIMEOUT_MS = 12000;
const API_RETRIES = 2;

const $ = (id) => document.getElementById(id);
const messagesEl = $("messages");
const statusLine = $("statusLine");
const typingEl = $("typing");
const clearBtn = $("clearBtn");
const quickRepliesEl = $("quickReplies");
const langSelect = $("langSelect");
const modeSelect = $("modeSelect");
const nameInput = $("nameInput");
const composer = $("composer");
const promptEl = $("prompt");
const apiUrlInput = $("apiUrlInput");
const apiKeyInput = $("apiKeyInput");
const apiHealthEl = $("apiHealth");
const programInput = $("programInput");
const levelSelect = $("levelSelect");
const themeToggleBtn = $("themeToggleBtn");
const installBtn = $("installBtn");
const exportJsonBtn = $("exportJsonBtn");
const exportCsvBtn = $("exportCsvBtn");
const attachBtn = $("attachBtn");
const fileInput = $("fileInput");
const composerBelow = $("composerBelow");
const attachmentChip = $("attachmentChip");
const attachmentLabel = $("attachmentLabel");
const removeAttachmentBtn = $("removeAttachmentBtn");
const scrollFab = $("scrollFab");

let pendingAttachment = "";
let pendingAttachmentName = "";
let deferredInstallPrompt = null;

function nowISO() {
  return new Date().toISOString();
}

function formatTime(tsISO) {
  try {
    const d = new Date(tsISO);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderMarkdownSafe(text) {
  // Minimal, safe markdown:
  // - links: [label](url)
  // - inline code: `code`
  // - bold: **text**
  // - italic: *text*
  // - newlines to <br/>
  // No raw HTML allowed.
  let s = escapeHtml(text);
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_m, label, url) => {
    const safeLabel = escapeHtml(label);
    const safeUrl = escapeHtml(url);
    return `<a href="${safeUrl}" target="_blank" rel="noreferrer">${safeLabel}</a>`;
  });
  s = s.replace(/`([^`]+)`/g, (_m, code) => `<code>${escapeHtml(code)}</code>`);
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  s = s.replace(/\n/g, "<br/>");
  return s;
}

function detectLang(text) {
  const s = String(text || "");
  return /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]/.test(s) ? "ar" : "en";
}

function normalizeArabic(s) {
  let x = String(s || "").trim().replace(/\s+/g, " ");
  // Remove diacritics + tatweel
  x = x.replace(/[\u064B-\u065F\u0670\u0640]/g, "");
  // Normalize variants
  x = x
    .replace(/أ|إ|آ/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي")
    .replace(/ة/g, "ه");
  return x;
}

function normalizeEnglish(s) {
  return String(s || "").trim().replace(/\s+/g, " ").toLowerCase();
}

function normalize(text, lang) {
  return lang === "ar" ? normalizeArabic(text) : normalizeEnglish(text);
}

function loadStopwords(lang) {
  // Minimal list (we avoid external deps).
  if (lang === "ar") {
    return new Set(["في", "على", "من", "الى", "إلى", "عن", "هذا", "هذه", "ذلك", "تلك", "و", "يا", "هل"]);
  }
  return new Set(["the", "a", "an", "and", "or", "to", "of", "in", "on", "for", "with", "is", "are"]);
}

function tokenize(text, lang) {
  const s = normalize(text, lang);
  if (!s) return [];
  const stop = loadStopwords(lang);
  const parts = s.split(/[^\w\u0600-\u06FF]+/g).filter(Boolean);
  return parts.filter((t) => !stop.has(t));
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union ? inter / union : 0;
}

function pick(arr) {
  if (!arr || !arr.length) return "";
  return arr[Math.floor(Math.random() * arr.length)];
}

function setDir(lang) {
  if (lang === "ar") {
    document.documentElement.lang = "ar";
    document.body.setAttribute("dir", "rtl");
  } else {
    document.documentElement.lang = "en";
    document.body.setAttribute("dir", "ltr");
  }
}

let typingTimeoutId = null;

function setTyping(on, responseLang) {
  if (!typingEl) return;
  
  // Clear any existing timeout
  if (typingTimeoutId) {
    clearTimeout(typingTimeoutId);
    typingTimeoutId = null;
  }
  
  const t = typingEl.querySelector(".typing__text");
  const lang = responseLang === "ar" ? "ar" : "en";
  if (t) t.textContent = lang === "ar" ? "… جاري الكتابة" : "Assistant is typing…";
  typingEl.hidden = !on;
  
  if (on) {
    messagesEl.scrollTop = messagesEl.scrollHeight;
    // Safety: auto-clear typing after 30 seconds max
    typingTimeoutId = setTimeout(() => {
      typingEl.hidden = true;
      typingTimeoutId = null;
    }, 30000);
  }
}

function addMessage(role, text, meta, extra) {
  const ts = (extra && extra.ts) || nowISO();
  const time = formatTime(ts);
  const msgId = (extra && extra.id) || ts;

  const msg = document.createElement("div");
  msg.className = `msg ${role === "user" ? "msg--user" : "msg--bot"}`;
  msg.dataset.msgId = msgId;

  const bubble = document.createElement("div");
  bubble.className = "bubble";
  const content = document.createElement("div");
  content.className = "bubble__content";
  content.innerHTML = role === "bot" ? renderMarkdownSafe(text) : escapeHtml(text).replace(/\n/g, "<br/>");
  bubble.appendChild(content);

  let metaText = "";
  if (role === "user") {
    const name = (extra && extra.name) || "You";
    metaText = `${name}${time ? ` • ${time}` : ""}`;
  } else {
    metaText = meta ? `${meta}${time ? ` • ${time}` : ""}` : time;
  }
  if (metaText) {
    const m = document.createElement("div");
    m.className = "meta";
    m.textContent = metaText;
    bubble.appendChild(m);
  }

  if (role === "bot") {
    const actions = document.createElement("div");
    actions.className = "bubble__actions";

    const mkBtn = (label, title) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "iconBtn";
      b.textContent = label;
      b.title = title;
      return b;
    };

    const copyBtn = mkBtn("Copy", "Copy response");
    copyBtn.addEventListener("click", async () => {
      const plain = String(text || "");
      try {
        await navigator.clipboard.writeText(plain);
        copyBtn.textContent = "Copied";
        setTimeout(() => (copyBtn.textContent = "Copy"), 900);
      } catch {
        // Fallback: no clipboard permission.
        window.prompt("Copy this text:", plain);
      }
    });

    const upBtn = mkBtn("👍", "Helpful");
    upBtn.setAttribute("aria-pressed", "false");
    const downBtn = mkBtn("👎", "Not helpful");
    downBtn.setAttribute("aria-pressed", "false");

    const setReaction = (value) => {
      upBtn.setAttribute("aria-pressed", value === "up" ? "true" : "false");
      downBtn.setAttribute("aria-pressed", value === "down" ? "true" : "false");
      // Best-effort: attach feedback to the newest matching log entry.
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        const logs = raw ? JSON.parse(raw) : [];
        for (let i = logs.length - 1; i >= 0; i--) {
          const r = logs[i];
          if (r && (r.id === msgId || (r.ts === ts && String(r.botText || "") === String(text || "")))) {
            r.feedback = value || "";
            logs[i] = r;
            localStorage.setItem(STORAGE_KEY, JSON.stringify(logs));
            break;
          }
        }
      } catch {
        // ignore
      }
    };
    upBtn.addEventListener("click", () => setReaction(upBtn.getAttribute("aria-pressed") === "true" ? "" : "up"));
    downBtn.addEventListener("click", () => setReaction(downBtn.getAttribute("aria-pressed") === "true" ? "" : "down"));

    actions.appendChild(copyBtn);
    actions.appendChild(upBtn);
    actions.appendChild(downBtn);
    bubble.appendChild(actions);
  }

  msg.appendChild(bubble);
  messagesEl.appendChild(msg);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function loadLogs() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveLog(entry) {
  const logs = loadLogs();
  logs.push(entry);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(logs));
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
  const header = [
    "ts",
    "id",
    "lang",
    "source",
    "tag",
    "confidence",
    "mode",
    "userName",
    "program",
    "level",
    "feedback",
    "userText",
    "botText",
  ];
  const esc = (v) => `"${String(v ?? "").replaceAll('"', '""')}"`;
  const lines = [header.join(",")];
  for (const r of rows) {
    lines.push(
      [
        esc(r.ts),
        esc(r.id),
        esc(r.lang),
        esc(r.source),
        esc(r.tag),
        esc(r.confidence),
        esc(r.mode),
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

function loadUserName() {
  try {
    return (localStorage.getItem(NAME_KEY) || "").trim() || "Guest";
  } catch {
    return "Guest";
  }
}

function setUserName(name) {
  const v = (name || "").trim() || "Guest";
  localStorage.setItem(NAME_KEY, v);
  return v;
}

function loadMode() {
  try {
    return localStorage.getItem(MODE_KEY) || "local";
  } catch {
    return "local";
  }
}

function setMode(mode) {
  const v = mode === "api" ? "api" : "local";
  localStorage.setItem(MODE_KEY, v);
  return v;
}

function apiUrl() {
  try {
    return localStorage.getItem(API_URL_KEY) || DEFAULT_API_URL;
  } catch {
    return DEFAULT_API_URL;
  }
}

function setApiUrl(url) {
  const v = String(url || "").trim() || DEFAULT_API_URL;
  localStorage.setItem(API_URL_KEY, v);
  return v;
}

function apiKey() {
  try {
    return localStorage.getItem(API_KEY_KEY) || "";
  } catch {
    return "";
  }
}

function setApiKey(key) {
  const v = String(key || "").trim();
  localStorage.setItem(API_KEY_KEY, v);
  return v;
}

function loadProfile() {
  try {
    const raw = localStorage.getItem(PROFILE_KEY);
    const obj = raw ? JSON.parse(raw) : {};
    return {
      program: String(obj.program || "").trim(),
      level: String(obj.level || "").trim(),
    };
  } catch {
    return { program: "", level: "" };
  }
}

function saveProfile(profile) {
  const v = {
    program: String(profile?.program || "").trim(),
    level: String(profile?.level || "").trim(),
  };
  localStorage.setItem(PROFILE_KEY, JSON.stringify(v));
  return v;
}

function loadTheme() {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

function setTheme(theme) {
  const v = theme === "light" ? "light" : "dark";
  localStorage.setItem(THEME_KEY, v);
  document.documentElement.setAttribute("data-theme", v);
  return v;
}

function setApiHealthBadge(state, text) {
  if (!apiHealthEl) return;
  if (state === "hidden") {
    apiHealthEl.innerHTML = "";
    return;
  }
  const dotClass =
    state === "ok" ? "dot dot--ok" : state === "warn" ? "dot dot--warn" : "dot dot--bad";
  apiHealthEl.innerHTML = `<span class="badge"><span class="${dotClass}"></span>${escapeHtml(text || "")}</span>`;
}

function healthUrlFromChatUrl(chatUrl) {
  try {
    const u = new URL(chatUrl);
    u.pathname = u.pathname.replace(/\/chat\/?$/, "/health");
    if (!u.pathname.endsWith("/health")) u.pathname = "/health";
    return u.toString();
  } catch {
    return "";
  }
}

async function checkApiHealth() {
  if (!apiHealthEl) return;
  const hu = healthUrlFromChatUrl(apiUrl());
  if (!hu) {
    setApiHealthBadge("warn", "API URL invalid");
    return;
  }
  setApiHealthBadge("warn", "Checking API…");
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    const res = await fetch(hu, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) {
      setApiHealthBadge("bad", `Health ${res.status}`);
      return;
    }
    const out = await res.json().catch(() => ({}));
    const hasModel = !!out.has_model;
    setApiHealthBadge("ok", hasModel ? "API OK (model)" : "API OK (no model)");
  } catch (e) {
    const msg = e && (e.name === "AbortError" || String(e).includes("AbortError")) ? "Health timeout" : "API offline";
    setApiHealthBadge("bad", msg);
  }
}

function setAttachmentUI() {
  if (!composerBelow) return;
  const has = !!pendingAttachment;
  composerBelow.hidden = !has;
  if (has && attachmentLabel) {
    const n = pendingAttachmentName ? `${pendingAttachmentName}` : "Attached text";
    attachmentLabel.textContent = `${n} (${pendingAttachment.length} chars)`;
  }
}

function clearAttachment() {
  pendingAttachment = "";
  pendingAttachmentName = "";
  if (fileInput) fileInput.value = "";
  setAttachmentUI();
}

function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

async function callApiChat(text, lang, userName = "Guest") {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  const headers = { "content-type": "application/json" };
  const key = apiKey();
  if (key) headers["x-api-key"] = key;
  try {
    const res = await fetch(apiUrl(), {
      method: "POST",
      headers,
      body: JSON.stringify({ text, lang, user_name: userName }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw new Error(`API error ${res.status}: ${t || res.statusText}`);
    }
    return await res.json();
  } catch (e) {
    // Normalize abort errors for user-facing messages.
    if (e && (e.name === "AbortError" || String(e).includes("AbortError"))) {
      throw new Error(`API request timed out after ${Math.round(API_TIMEOUT_MS / 1000)}s.`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function callApiChatWithRetry(text, lang, userName = "Guest") {
  let lastErr = null;
  for (let attempt = 0; attempt <= API_RETRIES; attempt++) {
    try {
      return await callApiChat(text, lang, userName);
    } catch (e) {
      lastErr = e;
      const msg = String(e?.message || e || "");
      const retryable =
        msg.includes("timed out") ||
        msg.includes("Failed to fetch") ||
        msg.includes("NetworkError") ||
        msg.includes("TypeError");
      if (!retryable || attempt === API_RETRIES) break;
      await sleep(450 * Math.pow(2, attempt));
    }
  }
  throw lastErr;
}

function buildRules() {
  const rx = (p, flags) => new RegExp(p, flags);
  return [
    {
      name: "greeting",
      tagHint: "greeting",
      en: [rx("^\\s*(hi|hello|hey|good (morning|afternoon|evening))\\b", "i")],
      ar: [rx("^\\s*(مرحبا|اهلا|أهلا|السلام عليكم|صباح الخير|مساء الخير)\\b", "i")],
      response: {
        en: "Hi! Ask me about registration, exams, policies/grading, or library resources.",
        ar: "مرحباً! اسألني عن التسجيل، الامتحانات، السياسات/الدرجات، أو موارد المكتبة.",
      },
    },
    {
      name: "integrity",
      tagHint: "academic_integrity",
      en: [rx("\\b(plagiar(ism|ize)|cheat(ing)?|academic integrity|turnitin)\\b", "i")],
      ar: [rx("(انتحال|غش|نزاه(ه|ة) اكاديمي(ه|ة)?|turnitin|تورنتن)", "i")],
      response: {
        en: "Academic integrity is serious. Follow your course syllabus and the university integrity policy. If unsure, ask the instructor and always cite sources.",
        ar: "النزاهة الأكاديمية أمر مهم. التزم بخطة المقرر ولائحة النزاهة الرسمية. إذا كنت غير متأكد اسأل المدرس ووثّق المصادر دائماً.",
      },
    },
    {
      name: "exam_conflict",
      tagHint: "exam_conflict",
      en: [
        rx("\\b(exam|final|midterm).*(conflict|clash|overlap)\\b", "i"),
        rx("\\b(two|2)\\s+(exams|finals|midterms)\\b.*\\b(same time|same slot)\\b", "i"),
      ],
      ar: [
        rx("(تعارض|تداخل).*(امتحان|اختبار|نهائي|ميدترم)", "i"),
        rx("(اختبارين|امتحانين).*(بنفس|نفس).*(الوقت|الفتره|الفترة)", "i"),
      ],
      response: {
        en: "For exam conflicts or missed exams, contact the exams office/registrar ASAP. These requests usually have strict deadlines and may require documentation.",
        ar: "في حالة تعارض الامتحانات أو الغياب عن اختبار، تواصل فوراً مع شؤون الاختبارات/التسجيل. غالباً توجد مواعيد نهائية صارمة وقد تُطلب وثائق.",
      },
    },
    {
      name: "library_remote",
      tagHint: "library_access",
      en: [rx("\\b(vpn|proxy|off[\\s-]?campus|remote access)\\b", "i")],
      ar: [rx("(vpn|بروكسي|خارج الجامعه|خارج الجامعة|وصول خارجي|الوصول من البيت)", "i")],
      response: {
        en: "For off-campus library access, start from the library website and use portal login + VPN/proxy if required.",
        ar: "للوصول لمصادر المكتبة خارج الجامعة ابدأ من موقع المكتبة واستخدم تسجيل الدخول وقد تحتاج VPN/Proxy.",
      },
    },
  ];
}

function matchRule(text, rules, detectedLang) {
  const norm = normalize(text, detectedLang);
  for (const r of rules) {
    const list = detectedLang === "ar" ? r.ar : r.en;
    for (const rx of list || []) {
      if (rx.test(norm)) return r;
    }
  }
  return null;
}

function buildIndex(dataset) {
  const idx = { en: [], ar: [] };
  for (const intent of dataset.intents || []) {
    const patterns = intent.patterns || {};
    for (const lang of ["en", "ar"]) {
      for (const p of patterns[lang] || []) {
        const set = new Set(tokenize(p, lang));
        if (set.size) idx[lang].push({ tag: intent.tag, tokens: set });
      }
    }
  }
  return idx;
}

function retrieveIntent(text, index, detectedLang) {
  const q = new Set(tokenize(text, detectedLang));
  if (!q.size) return { tag: null, score: 0 };
  let bestTag = null;
  let best = 0;
  for (const row of index[detectedLang] || []) {
    const s = jaccard(q, row.tokens);
    if (s > best) {
      best = s;
      bestTag = row.tag;
    }
  }
  return { tag: bestTag, score: best };
}

function resolveResponse(datasetByTag, tag, responseLang) {
  const intent = datasetByTag.get(tag) || datasetByTag.get("fallback");
  if (!intent) {
    return responseLang === "ar"
      ? "عذراً — لم أتمكن من العثور على إجابة."
      : "Sorry — I couldn't find an answer.";
  }
  const resp = intent.responses || {};
  const pool = resp[responseLang] && resp[responseLang].length ? resp[responseLang] : (resp.en || []);
  const picked = pick(pool);
  return picked || (responseLang === "ar" ? "عذراً — لم أتمكن من العثور على إجابة." : "Sorry — I couldn't find an answer.");
}

async function loadDataset() {
  const res = await fetch(DATA_URL, { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to load dataset: ${res.status}`);
  return await res.json();
}

async function main() {
  const rules = buildRules();
  let dataset = null;
  let datasetByTag = new Map();
  let index = { en: [], ar: [] };

  // initial UI
  addMessage("bot", "Hi! Ask me about registration, exams, policies/grading, or library resources.", "ready");
  setTheme(loadTheme());

  // PWA
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./service-worker.js").catch(() => {});
  }

  // hydrate controls
  if (nameInput) nameInput.value = loadUserName();
  if (modeSelect) modeSelect.value = loadMode();
  if (apiUrlInput) apiUrlInput.value = apiUrl();
  if (apiKeyInput) apiKeyInput.value = apiKey();
  const profile = loadProfile();
  if (programInput) programInput.value = profile.program;
  if (levelSelect) levelSelect.value = profile.level;

  if (themeToggleBtn) {
    themeToggleBtn.addEventListener("click", () => {
      const next = loadTheme() === "light" ? "dark" : "light";
      setTheme(next);
    });
  }

  if (programInput || levelSelect) {
    const save = () => saveProfile({ program: programInput?.value || "", level: levelSelect?.value || "" });
    programInput?.addEventListener("change", save);
    levelSelect?.addEventListener("change", save);
  }

  if (apiUrlInput) {
    apiUrlInput.addEventListener("change", () => {
      const v = setApiUrl(apiUrlInput.value);
      apiUrlInput.value = v;
      if (modeSelect && modeSelect.value === "api") {
        statusLine.textContent = `Mode: API (${apiUrl()}) — start backend/app/api.py`;
      }
      checkApiHealth();
    });
  }
  if (apiKeyInput) {
    apiKeyInput.addEventListener("change", () => {
      setApiKey(apiKeyInput.value);
      checkApiHealth();
    });
  }

  // chips
  document.querySelectorAll(".chip").forEach((btn) => {
    btn.addEventListener("click", () => {
      const q = btn.getAttribute("data-q") || "";
      promptEl.value = q;
      promptEl.focus();
    });
  });

  // language changes
  langSelect.addEventListener("change", () => {
    const v = langSelect.value;
    if (v === "ar") setDir("ar");
    if (v === "en") setDir("en");
    if (v === "auto") setDir("en");
  });

  if (nameInput) {
    nameInput.addEventListener("change", () => setUserName(nameInput.value));
  }

  if (modeSelect) {
    modeSelect.addEventListener("change", () => {
      const m = setMode(modeSelect.value);
      // Never leave the typing indicator stuck when switching modes.
      setTyping(false, langSelect?.value === "ar" ? "ar" : "en");
      if (m === "api") checkApiHealth();
      if (m === "api") {
        statusLine.textContent = `Mode: API (${apiUrl()}) — start backend/app/api.py`;
      } else {
        statusLine.textContent = dataset
          ? `Dataset loaded: ${dataset.intents?.length || 0} intents`
          : "Mode: Local dataset (loading…)";
      }
    });
  }

  if (clearBtn) {
    clearBtn.addEventListener("click", () => {
      const ok = window.confirm("Clear chat messages on screen? (Saved admin logs will remain.)");
      if (!ok) return;
      messagesEl.innerHTML = "";
      setTyping(false, langSelect?.value === "ar" ? "ar" : "en");
      clearAttachment();
      addMessage("bot", "Cleared. Ask me about registration, exams, policies/grading, or library resources.", "ready");
      promptEl.focus();
    });
  }

  // Only load dataset if in local mode
  const currentMode = modeSelect ? modeSelect.value : "local";
  if (currentMode === "local") {
    try {
      dataset = await loadDataset();
      for (const it of dataset.intents || []) datasetByTag.set(it.tag, it);
      index = buildIndex(dataset);
      statusLine.textContent = `Dataset loaded: ${dataset.intents?.length || 0} intents`;
    } catch (e) {
      const isCorsError = e.message.includes("CORS") || e.message.includes("Access-Control") || e.message.includes("Origin null");
      const errorMsg = isCorsError
        ? "⚠️ CORS error: Please use an HTTP server (run: python3 -m http.server 8000 from project root)"
        : `Dataset load failed: ${e.message}. Start a local server (see frontend/README.md).`;
      statusLine.textContent = errorMsg;
      console.error("Dataset load error:", e);
    }
  } else {
    // API mode - no need for local dataset
    statusLine.textContent = `Mode: API (${apiUrl()}) — checking connection...`;
    checkApiHealth();
  }

  if (exportJsonBtn) {
    exportJsonBtn.addEventListener("click", () => download("chat_logs.json", JSON.stringify(loadLogs(), null, 2), "application/json"));
  }
  if (exportCsvBtn) {
    exportCsvBtn.addEventListener("click", () => download("chat_logs.csv", toCSV(loadLogs()), "text/csv"));
  }

  if (attachBtn && fileInput) {
    attachBtn.addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", () => {
      const f = fileInput.files && fileInput.files[0];
      if (!f) return;
      const reader = new FileReader();
      reader.onload = () => {
        const raw = String(reader.result || "");
        // Cap to avoid huge prompts.
        pendingAttachment = raw.slice(0, 6000);
        pendingAttachmentName = f.name;
        setAttachmentUI();
        promptEl.focus();
      };
      reader.readAsText(f);
    });
  }

  removeAttachmentBtn?.addEventListener("click", () => clearAttachment());
  setAttachmentUI();

  // Scroll UX: show a "scroll to bottom" button when not at bottom.
  if (messagesEl && scrollFab) {
    const recompute = () => {
      const delta = messagesEl.scrollHeight - (messagesEl.scrollTop + messagesEl.clientHeight);
      scrollFab.hidden = delta < 140;
    };
    messagesEl.addEventListener("scroll", recompute);
    window.addEventListener("resize", recompute);
    recompute();
    scrollFab.addEventListener("click", () => scrollToBottom());
  }

  // Composer auto-grow (up to max-height in CSS)
  if (promptEl) {
    const resize = () => {
      promptEl.style.height = "auto";
      promptEl.style.height = `${Math.min(promptEl.scrollHeight, 180)}px`;
    };
    promptEl.addEventListener("input", resize);
    resize();
  }

  // PWA install prompt (when supported)
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    if (installBtn) installBtn.hidden = false;
  });
  installBtn?.addEventListener("click", async () => {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice.catch(() => {});
    deferredInstallPrompt = null;
    installBtn.hidden = true;
  });

  // Enter to send, Shift+Enter for newline
  if (promptEl) {
    promptEl.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" && !ev.shiftKey) {
        ev.preventDefault();
        composer?.requestSubmit?.();
      }
    });
  }

  function setQuickReplies(items) {
    if (!quickRepliesEl) return;
    const qs = (items || []).filter(Boolean).slice(0, 5);
    if (!qs.length) {
      quickRepliesEl.hidden = true;
      quickRepliesEl.innerHTML = "";
      return;
    }
    quickRepliesEl.hidden = false;
    quickRepliesEl.innerHTML = qs.map((q) => `<button class="chip" type="button" data-q="${escapeHtml(q)}">${escapeHtml(q)}</button>`).join("");
    quickRepliesEl.querySelectorAll("button").forEach((btn) => {
      btn.addEventListener("click", () => {
        const q = btn.getAttribute("data-q") || "";
        promptEl.value = q;
        promptEl.focus();
      });
    });
  }

  function suggestionsFor(tag, lang) {
    const ar = lang === "ar";
    if (tag === "course_registration_deadline" || tag === "course_registration_add_drop") {
      return ar
        ? ["آخر موعد للإضافة والحذف؟", "كيف أعرف نافذة التسجيل حقي؟", "عندي حظر يمنع التسجيل"]
        : ["What is the add/drop deadline?", "How do I check my registration window?", "I have a registration hold"];
    }
    if (tag === "exam_schedule" || tag === "exam_conflict" || tag === "exam_makeup") {
      return ar
        ? ["وين ألقى جدول الامتحانات؟", "عندي تعارض امتحانين", "فاتني الاختبار—وش أسوي؟"]
        : ["Where can I find the exam timetable?", "I have an exam conflict", "I missed an exam—what should I do?"];
    }
    if (tag === "gpa_calculation") {
      return ar ? ["احسب معدلي الفصلي", "كيف أرفع معدلي؟", "هل إعادة المادة تؤثر؟"] : ["Calculate my semester GPA", "How can I raise my GPA?", "Does repeating a course affect GPA?"];
    }
    if (tag === "library_access") {
      return ar ? ["الوصول للمجلات من البيت", "يطلع لي Access denied", "هل أحتاج VPN؟"] : ["Off-campus journal access", "I get 'Access denied'", "Do I need a VPN?"];
    }
    return ar ? ["متى يبدأ التسجيل؟", "كيف أحجز موعد إرشاد؟", "سياسة الدرجات"] : ["When does registration open?", "How do I contact my advisor?", "How is my grade calculated?"];
  }

  composer.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const q = (promptEl.value || "").trim();
    if (!q) return;
    
    // Safety: clear any stuck typing indicator before new request
    setTyping(false, langSelect?.value === "ar" ? "ar" : "en");
    
    promptEl.value = "";

    const userName = nameInput ? setUserName(nameInput.value) : "Guest";
    const ts = nowISO();
    const id = ts;
    const detectedLang = detectLang(q);
    const ui = langSelect.value;
    const responseLang = ui === "auto" ? detectedLang : ui;
    setDir(responseLang === "ar" ? "ar" : "en");

    setQuickReplies([]);

    const profileNow = saveProfile({ program: programInput?.value || "", level: levelSelect?.value || "" });
    const fullUserText = pendingAttachment
      ? `${q}\n\n---\nAttached context:\n${pendingAttachment}`
      : q;
    pendingAttachment = "";

    addMessage("user", q, "", { name: userName, ts, id });

    let tag = "fallback";
    let source = "fallback";
    let confidence = 0;

    if (modeSelect && modeSelect.value === "api") {
      setTyping(true, responseLang);
      
      // Safety timeout: always clear typing after max time
      const safetyTimeout = setTimeout(() => {
        setTyping(false, responseLang);
      }, API_TIMEOUT_MS * (API_RETRIES + 2) + 2000);
      
      callApiChatWithRetry(fullUserText, responseLang, userName)
        .then((out) => {
          clearTimeout(safetyTimeout);
          setTyping(false, responseLang);
          
          const reply = out.text || "";
          tag = out.intent || "unknown";
          source = out.source || "api";
          confidence = Number(out.confidence || 0);
          
          // Add analytics info to meta if available
          let metaText = `${source} • ${tag} • ${confidence.toFixed(2)}`;
          if (out.analytics) {
            const analytics = out.analytics;
            if (analytics.sentiment) {
              metaText += ` • ${analytics.sentiment.label} sentiment`;
            }
            if (analytics.entities && analytics.entities.length > 0) {
              metaText += ` • ${analytics.entities.length} entities`;
            }
          }
          
          addMessage("bot", reply, metaText, { ts, id, analytics: out.analytics });
          setQuickReplies(suggestionsFor(tag, responseLang));
          saveLog({
            ts,
            id,
            userName,
            userText: fullUserText,
            botText: reply,
            tag,
            source,
            lang: out.lang || responseLang,
            confidence,
            mode: "api",
            program: profileNow.program,
            level: profileNow.level,
            feedback: "",
          });
        })
        .catch((err) => {
          clearTimeout(safetyTimeout);
          setTyping(false, responseLang);
          const msg =
            responseLang === "ar"
              ? `تعذر الاتصال بالـ API. تأكد من تشغيل backend/app/api.py.\n${String(err.message || err)}`
              : `API request failed. Make sure backend/app/api.py is running.\n${String(err.message || err)}`;
          addMessage("bot", msg, "api error", { ts, id });
          setQuickReplies(suggestionsFor("fallback", responseLang));
        })
        .finally(() => {
          // Extra safety: always clear typing in finally block
          clearTimeout(safetyTimeout);
          setTyping(false, responseLang);
        });
      return;
    }

    if (dataset) {
      const ruleHit = matchRule(fullUserText, rules, detectedLang);
      if (ruleHit) {
        tag = ruleHit.tagHint || "rule_match";
        source = "rule";
        confidence = 1;
        const reply = ruleHit.response[responseLang] || ruleHit.response.en;
        addMessage("bot", reply, `${source} • ${tag}`, { ts, id });
        setQuickReplies(suggestionsFor(tag, responseLang));
        saveLog({ ts, id, userName, userText: fullUserText, botText: reply, tag, source, lang: responseLang, confidence, mode: "local", program: profileNow.program, level: profileNow.level, feedback: "" });
        return;
      }

      const r = retrieveIntent(fullUserText, index, detectedLang);
      if (r.tag && r.score >= 0.25) {
        tag = r.tag;
        source = "retrieval";
        confidence = r.score;
      }

      const reply = resolveResponse(datasetByTag, tag, responseLang);
      addMessage("bot", reply, `${source} • ${tag} • ${confidence.toFixed(2)}`, { ts, id });
      setQuickReplies(suggestionsFor(tag, responseLang));
      saveLog({ ts, id, userName, userText: fullUserText, botText: reply, tag, source, lang: responseLang, confidence, mode: "local", program: profileNow.program, level: profileNow.level, feedback: "" });
      return;
    }

    // dataset missing: minimal fallback
    const fallback = responseLang === "ar"
      ? "لا يمكنني تحميل البيانات حالياً. شغّل خادماً محلياً ثم أعد المحاولة."
      : "I can't load the dataset right now. Start a local server and try again.";
    addMessage("bot", fallback, "offline", { ts, id });
    setQuickReplies(suggestionsFor("fallback", responseLang));
  });
}

main();


