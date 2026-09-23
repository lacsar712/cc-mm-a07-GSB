const tokenKey = "methane_token";
let token = localStorage.getItem(tokenKey) || "";
let role = localStorage.getItem("methane_role") || "";
let readingsCache = [];

const loginBox = document.querySelector("#login");
const appBox = document.querySelector("#app");
const rows = document.querySelector("#rows");
const live = document.querySelector("#live");
const form = document.querySelector("#form");

const nav = document.querySelector("#nav");
const viewReadings = document.querySelector("#view-readings");
const viewCompare = document.querySelector("#view-compare");
const viewDetail = document.querySelector("#view-detail");
const navReadings = document.querySelector("#nav-readings");
const navCompare = document.querySelector("#nav-compare");

function isWriter() {
  return role === "writer";
}

function levelClass(level) {
  return level === "报警" ? "alarm" : "ok";
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (ch) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]),
  );
}

function paint(list) {
  readingsCache = list;
  rows.innerHTML = list
    .map(
      (r) =>
        `<tr>
          <td>${r.id}</td>
          <td>${escapeHtml(r.site)}</td>
          <td>${r.ch4_pct}</td>
          <td class="${levelClass(r.level)}">${r.level}</td>
          <td>${escapeHtml(r.note)}</td>
          <td>${isWriter() ? `<button data-fix="${r.id}">改正</button>` : ""}</td>
        </tr>`,
    )
    .join("");
  fillLocalSelect();
}

function fillLocalSelect() {
  const sel = document.querySelector("#pin-local");
  sel.innerHTML = readingsCache
    .map((r) => `<option value="${r.id}">#${r.id} ${escapeHtml(r.site)} ${r.ch4_pct}%</option>`)
    .join("");
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || "请求失败");
  return data;
}

function showView(name) {
  viewReadings.hidden = name !== "readings";
  viewCompare.hidden = name !== "compare";
  viewDetail.hidden = name !== "detail";
  navReadings.classList.toggle("active", name === "readings");
  navCompare.classList.toggle("active", name === "compare" || name === "detail");
  if (name === "readings") load();
  if (name === "compare") loadComparisons();
}

function showApp() {
  loginBox.hidden = true;
  appBox.hidden = false;
  nav.hidden = false;
  document.querySelector("#who").textContent = isWriter() ? "检查员" : "查看";
  document.querySelector("#out").hidden = false;
  form.hidden = !isWriter();
  document.querySelector("#pin-form").hidden = !isWriter();
  document.querySelector("#pin-tip").hidden = isWriter();
  document.querySelector("#th-fix").textContent = isWriter() ? "操作" : "";
  connect();
  showView("readings");
}

async function load() {
  paint(await api("/api/readings"));
}

function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws/alerts`);
  ws.onmessage = (ev) => {
    const row = JSON.parse(ev.data);
    live.textContent = `刚推送：${row.site} ${row.level}`;
    if (!viewReadings.hidden) load();
  };
}

/* ---------- 通风对照 ---------- */

function paintComparisons(list) {
  const tbody = document.querySelector("#cmp-rows");
  tbody.innerHTML = list
    .map(
      (c) =>
        `<tr class="clickable" data-open="${c.id}">
          <td>${c.id}</td>
          <td>${escapeHtml(c.local_site)}</td>
          <td>${escapeHtml(c.ref_site)}</td>
          <td>${Math.abs(c.ch4_diff)}</td>
          <td>${c.minutes} 分钟</td>
          <td>${c.source_changed ? '<span class="badge badge-changed">来源已变动</span>' : '<span class="muted">未变动</span>'}</td>
        </tr>`,
    )
    .join("");
  if (list.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" class="muted">还没有钉过对照。</td></tr>`;
  }
}

async function loadComparisons() {
  paintComparisons(await api("/api/comparisons"));
}

function sideHtml(side) {
  const current = side.present
    ? `现值 ${side.current_ch4_pct}% / ${side.current_level}`
    : "来源行已不存在";
  return `
    <div>主键 #${side.reading_id}</div>
    <div>测点：${escapeHtml(side.site)}</div>
    <div class="big ${levelClass(side.level)}">${side.ch4_pct} %</div>
    <div class="${levelClass(side.level)}">${side.level}</div>
    <div class="${side.changed ? "alarm" : "muted"}">${side.changed ? "已变动：" + current : current}</div>
  `;
}

async function openComparison(id) {
  const c = await api(`/api/comparisons/${id}`);
  document.querySelector("#detail-title").textContent =
    `对照 #${c.id}：${c.local_site} ↔ ${c.ref_site}`;
  document.querySelector("#detail-local").innerHTML = sideHtml(c.local);
  document.querySelector("#detail-ref").innerHTML = sideHtml(c.ref);
  document.querySelector("#detail-diff").textContent = Math.abs(c.ch4_diff);
  document.querySelector("#detail-minutes").textContent = c.minutes;
  document.querySelector("#detail-changed").hidden = !c.source_changed;
  document.querySelector("#detail-meta").textContent =
    `钉定于 ${new Date(c.created_at).toLocaleString()}，钉定人 ${c.created_by}`;
  showView("detail");
}

document.querySelector("#pin-form").onsubmit = async (e) => {
  e.preventDefault();
  try {
    const c = await api("/api/comparisons", {
      method: "POST",
      body: JSON.stringify({
        local_reading_id: Number(document.querySelector("#pin-local").value),
        ref_reading_id: Number(document.querySelector("#pin-ref").value),
        minutes: Number(document.querySelector("#pin-minutes").value),
      }),
    });
    document.querySelector("#pin-ref").value = "";
    document.querySelector("#pin-minutes").value = "";
    await openComparison(c.id);
  } catch (err) {
    alert(err.message);
  }
};

document.querySelector("#cmp-rows").onclick = (e) => {
  const tr = e.target.closest("[data-open]");
  if (tr) openComparison(Number(tr.dataset.open));
};

document.querySelector("#back-compare").onclick = () => showView("compare");
navReadings.onclick = () => showView("readings");
navCompare.onclick = () => showView("compare");

/* ---------- 改正班测 ---------- */

rows.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-fix]");
  if (!btn) return;
  const id = Number(btn.dataset.fix);
  const input = prompt("改正后的甲烷浓度（%）：");
  if (input === null) return;
  const value = Number(input);
  if (!Number.isFinite(value) || value < 0) {
    alert("请输入不小于 0 的浓度");
    return;
  }
  try {
    await api(`/api/readings/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ ch4_pct: value }),
    });
    load();
  } catch (err) {
    alert(err.message);
  }
});

/* ---------- 登录 / 上报 ---------- */

document.querySelector("#go").onclick = async () => {
  const data = await api("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({
      username: document.querySelector("#user").value,
      password: document.querySelector("#pass").value,
    }),
  });
  token = data.access_token;
  role = data.role;
  localStorage.setItem(tokenKey, token);
  localStorage.setItem("methane_role", role);
  showApp();
};

form.onsubmit = async (e) => {
  e.preventDefault();
  try {
    await api("/api/readings", {
      method: "POST",
      body: JSON.stringify({
        site: document.querySelector("#site").value,
        ch4_pct: Number(document.querySelector("#ch4").value),
      }),
    });
  } catch (err) {
    live.textContent = err.message;
  }
};

document.querySelector("#out").onclick = () => {
  localStorage.clear();
  location.reload();
};

if (token) showApp();
