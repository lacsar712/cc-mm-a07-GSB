const tokenKey = "methane_token";
let token = localStorage.getItem(tokenKey) || "";
let role = localStorage.getItem("methane_role") || "";
let readings = [];
let view = "shift";

const loginBox = document.querySelector("#login");
const appBox = document.querySelector("#app");
const live = document.querySelector("#live");
const form = document.querySelector("#form");

function levelClass(level) {
  return level === "报警" ? "alarm" : "ok";
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

function paintRows() {
  document.querySelector("#rows").innerHTML = readings
    .map(
      (r) =>
        `<tr>
          <td>${r.id}</td>
          <td>${r.site}</td>
          <td id="ch4-cell-${r.id}">${r.ch4_pct}</td>
          <td class="${levelClass(r.level)}">${r.level}</td>
          <td>${r.note}</td>
          <td>${role === "writer" ? `<button data-correct="${r.id}">改正</button>` : ""}</td>
        </tr>`,
    )
    .join("");
}

function paintLocalSelect() {
  const sel = document.querySelector("#comp-local");
  sel.innerHTML = readings
    .map((r) => `<option value="${r.id}">#${r.id} ${r.site} ${r.ch4_pct}% ${r.level}</option>`)
    .join("");
}

function compSide(label, c, side) {
  const changed = side === "local" ? c.local_changed : c.ref_changed;
  const site = side === "local" ? c.local_site : c.ref_site;
  const ch4 = side === "local" ? c.local_ch4_pct : c.ref_ch4_pct;
  const level = side === "local" ? c.local_level : c.ref_level;
  const rid = side === "local" ? c.local_reading_id : c.ref_reading_id;
  return `<div>
    <div class="muted">${label} · 班测 #${rid}</div>
    <div>${site}</div>
    <div class="${levelClass(level)}">${ch4}% ${level}</div>
    ${changed ? `<div class="badge">来源已变动</div>` : ""}
  </div>`;
}

function paintComps(list) {
  document.querySelector("#comp-list").innerHTML = list
    .map(
      (c) => `<div class="card">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <strong>对照 #${c.id}</strong>
          ${c.source_changed ? `<span class="badge">来源已变动（差为钉定时存档值）</span>` : ""}
        </div>
        <div style="display:flex;gap:24px;margin:8px 0">
          ${compSide("本机（通风前）", c, "local")}
          ${compSide("参照（通风后）", c, "ref")}
        </div>
        <div>浓度差（绝对值）：<span class="delta">${c.delta_pct}%</span></div>
        <div>通风间隔：${c.vent_minutes} 分钟</div>
        <div class="muted">钉定人：${c.created_by}</div>
      </div>`,
    )
    .join("");
}

function switchView(next) {
  view = next;
  document.querySelector("#page-shift").hidden = view !== "shift";
  document.querySelector("#page-comp").hidden = view !== "comp";
  document.querySelector("#nav-shift").classList.toggle("active", view === "shift");
  document.querySelector("#nav-comp").classList.toggle("active", view === "comp");
  if (view === "comp") loadComps();
}

function showApp() {
  loginBox.hidden = true;
  appBox.hidden = false;
  document.querySelector("#nav").hidden = false;
  document.querySelector("#who").textContent = role === "writer" ? "检查员" : "查看";
  document.querySelector("#out").hidden = false;
  form.hidden = role !== "writer";
  document.querySelector("#comp-form").hidden = role !== "writer";
  connect();
  switchView("shift");
  load();
}

async function load() {
  readings = await api("/api/readings");
  paintRows();
  paintLocalSelect();
  if (view === "comp") loadComps();
}

async function loadComps() {
  paintComps(await api("/api/comparisons"));
}

function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws/alerts`);
  ws.onmessage = () => load();
}

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

document.querySelector("#rows").addEventListener("click", async (e) => {
  const save = e.target.closest("[data-save]");
  if (save) {
    const id = Number(save.dataset.save);
    const value = Number(document.querySelector(`#fix-${id}`).value);
    try {
      await api(`/api/readings/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ ch4_pct: value }),
      });
    } catch (err) {
      live.textContent = err.message;
    }
    return;
  }
  const btn = e.target.closest("[data-correct]");
  if (!btn || role !== "writer") return;
  const id = Number(btn.dataset.correct);
  const cell = document.querySelector(`#ch4-cell-${id}`);
  const current = readings.find((r) => r.id === id).ch4_pct;
  cell.innerHTML = `<input id="fix-${id}" type="number" step="0.01" value="${current}" style="width:80px" /> <button data-save="${id}">保存</button>`;
  cell.querySelector("input").focus();
});

document.querySelector("#comp-form").onsubmit = async (e) => {
  e.preventDefault();
  const msg = document.querySelector("#comp-msg");
  msg.textContent = "";
  try {
    await api("/api/comparisons", {
      method: "POST",
      body: JSON.stringify({
        local_reading_id: Number(document.querySelector("#comp-local").value),
        ref_reading_id: Number(document.querySelector("#comp-ref").value),
        vent_minutes: Number(document.querySelector("#comp-min").value),
      }),
    });
    document.querySelector("#comp-ref").value = "";
    document.querySelector("#comp-min").value = "";
    loadComps();
  } catch (err) {
    msg.textContent = err.message;
  }
};

document.querySelector("#nav-shift").onclick = () => switchView("shift");
document.querySelector("#nav-comp").onclick = () => switchView("comp");

document.querySelector("#out").onclick = () => {
  localStorage.clear();
  location.reload();
};

if (token) showApp();
