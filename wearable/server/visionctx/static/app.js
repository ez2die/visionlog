"use strict";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const FRAMESIZES = ["QVGA", "VGA", "SVGA", "XGA", "HD", "SXGA", "UXGA"];
const state = { tab: "devices", devices: [], tasks: null, sessions: [], active: null, ann: null };

async function api(path, opts = {}) {
  const res = await fetch("api/" + path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).detail || msg; } catch {}
    throw new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
  }
  return res.status === 204 ? null : res.json();
}

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 2200);
}

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) e.setAttribute(k, v === true ? "" : v);
  }
  e.append(...children.flat().filter((c) => c !== null && c !== undefined));
  return e;
}

const pct = (v) => (v === null || v === undefined ? "—" : (v * 100).toFixed(1) + "%");
const fmtTime = (ms) => new Date(ms).toLocaleTimeString("zh-CN", { hour12: false });
const fmtDate = (ms) => new Date(ms).toLocaleString("zh-CN", { hour12: false });
const mountName = (m) => state.tasks?.mounts[m] || m;
const taskById = (id) => state.tasks?.tasks.find((t) => t.id === id);

// --- tabs --------------------------------------------------------------------

$$("nav button").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));

async function showTab(tab) {
  state.tab = tab;
  $$("nav button").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  $$(".tab").forEach((s) => s.classList.toggle("active", s.id === "tab-" + tab));
  if (tab === "session") await refreshSessions();
  if (tab === "annotate") await loadAnnotateSessions();
  if (tab === "report") await loadReport();
}

// --- devices -------------------------------------------------------------------

async function refreshDevices() {
  try {
    state.devices = await api("devices");
  } catch { return; }
  $("#no-devices").hidden = state.devices.length > 0;
  const list = $("#device-list");
  for (const d of state.devices) {
    let card = $(`[data-device="${d.device_id}"]`, list);
    if (!card) {
      card = deviceCard(d);
      list.append(card);
    }
    updateDeviceCard(card, d);
  }
  const sel = $("#start-form [name=device_id]");
  const cur = sel.value;
  sel.replaceChildren(...state.devices.map((d) =>
    el("option", { value: d.device_id }, `${d.name}${d.online ? "" : "（离线）"}`)));
  if (cur) sel.value = cur;
}

function deviceCard(d) {
  const form = el("form", { class: "cam-form" },
    el("label", {}, "分辨率", el("select", { name: "framesize" }, FRAMESIZES.map((f) => el("option", { value: f }, f)))),
    el("label", {}, "JPEG 质量 (4–63, 小=清晰)", el("input", { name: "quality", type: "number", min: 4, max: 63 })),
    el("label", {}, "帧率 fps", el("input", { name: "fps", type: "number", min: 0.1, max: 10, step: 0.1 })),
    el("label", {}, "亮度", el("input", { name: "brightness", type: "number", min: -2, max: 2 })),
    el("label", {}, "对比度", el("input", { name: "contrast", type: "number", min: -2, max: 2 })),
    el("label", {}, "饱和度", el("input", { name: "saturation", type: "number", min: -2, max: 2 })),
    el("label", {}, "曝光补偿", el("input", { name: "ae_level", type: "number", min: -2, max: 2 })),
    el("label", { class: "check" }, el("input", { name: "hmirror", type: "checkbox" }), "水平镜像"),
    el("label", { class: "check" }, el("input", { name: "vflip", type: "checkbox" }), "垂直翻转"),
    el("label", { class: "check" }, el("input", { name: "streaming", type: "checkbox" }), "推流"),
    el("button", { type: "submit", class: "primary" }, "应用"),
  );
  const card = el("div", { class: "panel device", "data-device": d.device_id },
    el("h2", {}, el("span", { class: "dot" }), el("span", { class: "name" }),
      el("button", { type: "button", onclick: () => renameDevice(d.device_id) }, "改名")),
    el("div", { class: "stats" }),
    el("div", { class: "live" }, el("img", { src: `api/devices/${d.device_id}/live.mjpg`, alt: "实时画面" })),
    el("div", { class: "row" },
      el("button", { type: "button", onclick: (e) => capture(d.device_id, e.target) }, "高清拍摄 (UXGA)"),
      el("span", { class: "capture-result hint" })),
    form,
  );
  fillCamForm(form, d.config);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const camera = {};
    for (const input of $$("input, select", form)) {
      camera[input.name] = input.type === "checkbox" ? input.checked
        : input.tagName === "SELECT" ? input.value : Number(input.value);
    }
    try {
      const d2 = await api(`devices/${d.device_id}`, { method: "PATCH", body: { camera } });
      fillCamForm(form, d2.config);
      toast("已应用" + (d2.online ? "" : "（设备离线，下次连接时下发）"));
    } catch (err) { toast("失败：" + err.message); }
  });
  return card;
}

function fillCamForm(form, cfg) {
  for (const input of $$("input, select", form)) {
    if (!(input.name in cfg)) continue;
    if (input.type === "checkbox") input.checked = !!cfg[input.name];
    else input.value = cfg[input.name];
  }
}

function updateDeviceCard(card, d) {
  $(".dot", card).classList.toggle("on", d.online);
  $(".name", card).textContent = d.name + (d.sensor ? ` · ${d.sensor}` : "");
  const s = d.status || {};
  const a = d.applied_config || {};
  const items = d.online ? [
    ["帧率", d.fps.toFixed(1)],
    ["分辨率", a.framesize || "—"],
    ["信号", s.rssi !== undefined ? s.rssi + " dBm" : "—"],
    ["温度", s.temp_c !== undefined ? s.temp_c.toFixed(0) + "°C" : "—"],
    ["电池", s.battery_mv !== undefined ? (s.battery_mv / 1000).toFixed(2) + " V" : "未接"],
    ["对时", s.time_synced ? "✓" : "✗"],
    ["丢帧", s.frames_dropped ?? "—"],
  ] : [["离线", "最后在线 " + fmtDate(d.last_seen_ms)]];
  $(".stats", card).replaceChildren(...items.map(([k, v]) => el("span", {}, k + " ", el("b", {}, String(v)))));
}

async function renameDevice(id) {
  const name = prompt("设备名称（例如 Pod-A）");
  if (!name) return;
  await api(`devices/${id}`, { method: "PATCH", body: { name } });
  $(`[data-device="${id}"]`)?.remove();
  refreshDevices();
}

async function capture(id, btn) {
  btn.disabled = true;
  const out = $(".capture-result", btn.closest(".device"));
  try {
    const f = await api(`devices/${id}/capture`, { method: "POST", body: {} });
    out.replaceChildren(el("a", { href: `api/frames/${f.id}.jpg`, target: "_blank" },
      `已保存 ${f.width}×${f.height}, ${(f.bytes / 1024).toFixed(0)} KB`));
  } catch (err) { out.textContent = "失败：" + err.message; }
  btn.disabled = false;
}

// --- sessions & live marking ------------------------------------------------------

async function loadTasks() {
  state.tasks = await api("tasks");
  $("#start-form [name=mount]").replaceChildren(
    ...Object.entries(state.tasks.mounts).map(([k, v]) => el("option", { value: k }, v)));
  $("#start-form [name=task]").replaceChildren(
    ...state.tasks.tasks.map((t) => el("option", { value: t.id }, t.name)));
}

async function refreshSessions() {
  state.sessions = await api("sessions");
  const active = state.sessions.find((s) => !s.ended_ms);
  setActive(active || null);
  const t = $("#session-table");
  t.replaceChildren(
    el("tr", {}, ["#", "开始", "受试者", "位置", "任务", "帧", "打标", "状态", ""].map((h) => el("th", {}, h))),
    ...state.sessions.map((s) => el("tr", {},
      el("td", {}, s.id), el("td", {}, fmtDate(s.started_ms)), el("td", {}, s.participant),
      el("td", {}, mountName(s.mount)), el("td", {}, taskById(s.task)?.name || s.task),
      el("td", {}, s.frame_count), el("td", {}, s.mark_count),
      el("td", {}, s.ended_ms ? "已结束" : "进行中"),
      el("td", {},
        el("button", { onclick: async () => { await showTab("annotate"); $("#ann-session").value = s.id; openAnnotate(s.id); } }, "标注"),
        " ",
        el("button", { class: "danger", onclick: () => deleteSession(s) }, "删除")),
    )));
}

async function deleteSession(s) {
  if (!confirm(`删除第 ${s.id} 轮（${s.participant}）的全部画面、打标和标注？不可恢复。`)) return;
  await api(`sessions/${s.id}`, { method: "DELETE" });
  refreshSessions();
}

$("#start-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  try {
    await api("sessions", { method: "POST", body: {
      device_id: f.get("device_id"), participant: f.get("participant"), mount: f.get("mount"),
      task: f.get("task"), notes: f.get("notes") || "", keep_frames: f.get("keep_frames") === "on",
    } });
    refreshSessions();
  } catch (err) { toast("无法开始：" + err.message); }
});

function setActive(session) {
  const changed = state.active?.id !== session?.id;
  state.active = session;
  $("#session-start").hidden = !!session;
  $("#session-active").hidden = !session;
  if (!session || !changed) return;
  const task = taskById(session.task);
  $("#active-title").textContent = `第 ${session.id} 轮 · ${session.participant} · ${mountName(session.mount)} · ${task?.name || session.task}`;
  $("#active-instructions").textContent = task?.instructions || "";
  $("#active-live").src = `api/devices/${session.device_id}/live.mjpg`;
  $("#target-buttons").replaceChildren(...(task?.targets || []).map((t, i) =>
    el("button", { "data-key": String(i + 1), onclick: (e) => addMark("gaze", t, e.currentTarget) },
      t, " ", el("kbd", {}, String(i + 1)))));
  loadRecentMarks();
}

async function addMark(kind, target = "", btn = null, note = "") {
  if (!state.active) return;
  const offset_ms = Number($("#offset-ms").value) || 0;
  btn?.classList.add("flash");
  setTimeout(() => btn?.classList.remove("flash"), 200);
  try {
    await api(`sessions/${state.active.id}/marks`, { method: "POST", body: { kind, target, note, offset_ms } });
    loadRecentMarks();
  } catch (err) { toast("打标失败：" + err.message); }
}

async function loadRecentMarks() {
  if (!state.active) return;
  const marks = await api(`sessions/${state.active.id}/marks`);
  const label = { gaze: "看", reposition: "调整", note: "备注" };
  $("#recent-marks").replaceChildren(...marks.slice(-30).reverse().map((m) => el("li", {},
    `${fmtTime(m.ts_ms)} ${label[m.kind]} ${m.target}${m.note ? " · " + m.note : ""}`,
    el("button", { onclick: async () => { await api(`marks/${m.id}`, { method: "DELETE" }); loadRecentMarks(); } }, "撤销"))));
}

$("#mark-reposition").addEventListener("click", (e) => addMark("reposition", "", e.currentTarget));
$("#mark-note").addEventListener("click", () => {
  const note = prompt("备注");
  if (note) addMark("note", "", null, note);
});
$("#end-session").addEventListener("click", async () => {
  if (!state.active || !confirm("结束本轮？")) return;
  await api(`sessions/${state.active.id}/end`, { method: "POST" });
  $("#active-live").removeAttribute("src");
  refreshSessions();
});

// --- annotation -----------------------------------------------------------------------

async function loadAnnotateSessions() {
  const sessions = await api("sessions");
  const sel = $("#ann-session");
  const cur = sel.value;
  sel.replaceChildren(el("option", { value: "" }, "选择轮次…"), ...sessions.map((s) =>
    el("option", { value: s.id }, `#${s.id} ${s.participant} · ${mountName(s.mount)} · ${taskById(s.task)?.name || s.task} (${s.mark_count} 标)`)));
  if (cur) sel.value = cur;
}

$("#ann-session").addEventListener("change", (e) => e.target.value && openAnnotate(Number(e.target.value)));
$("#ann-only-open").addEventListener("change", () => state.ann && openAnnotate(state.ann.sessionId));

async function openAnnotate(sessionId) {
  const all = (await api(`sessions/${sessionId}/marks?candidates=true`)).filter((m) => m.kind === "gaze");
  const onlyOpen = $("#ann-only-open").checked;
  const marks = onlyOpen ? all.filter((m) => m.target_in_frame === null) : all;
  state.ann = { sessionId, all, marks, i: 0 };
  $("#ann-body").hidden = marks.length === 0;
  $("#ann-empty").hidden = marks.length > 0;
  updateProgress();
  if (marks.length) showMark(0);
}

function updateProgress() {
  const done = state.ann.all.filter((m) => m.target_in_frame !== null).length;
  $("#ann-progress").textContent = `已标注 ${done} / ${state.ann.all.length}`;
}

function showMark(i) {
  const a = state.ann;
  a.i = Math.max(0, Math.min(i, a.marks.length - 1));
  const m = a.marks[a.i];
  const cands = m.candidates;
  // Default frame: saved choice, else the candidate nearest the mark.
  const nearest = cands.reduce((best, c) => (!best || Math.abs(c.dt_ms) < Math.abs(best.dt_ms) ? c : best), null);
  a.frameId = m.frame_id ?? nearest?.id ?? null;
  a.values = {
    target_in_frame: m.target_in_frame, centered: m.centered, occluded: m.occluded, useful: m.useful,
  };
  $("#ann-title").textContent = `${a.i + 1} / ${a.marks.length} · 目标：${m.target || "（未指定）"} · ${fmtTime(m.ts_ms)}`;
  $("#ann-strip").replaceChildren(...cands.map((c) => el("figure", {
    "data-id": c.id, class: c.auto_ok ? "" : "bad", onclick: () => selectFrame(c.id),
  }, el("img", { src: `api/frames/${c.id}.jpg`, loading: "lazy" }),
    el("figcaption", {}, `${c.dt_ms > 0 ? "+" : ""}${(c.dt_ms / 1000).toFixed(1)}s${c.auto_ok ? "" : " ⚠"}`))));
  if (!cands.length) $("#ann-strip").append(el("p", { class: "hint" }, "该时刻附近没有画面（设备断流？）。可直接标记为未入画。"));
  selectFrame(a.frameId);
  renderToggles();
}

function selectFrame(id) {
  state.ann.frameId = id;
  $$("#ann-strip figure").forEach((f) => f.classList.toggle("sel", Number(f.dataset.id) === id));
  const img = $("#ann-img");
  if (id) img.src = `api/frames/${id}.jpg`;
  else img.removeAttribute("src");
}

function renderToggles() {
  for (const b of $$(".toggles button")) {
    const v = state.ann.values[b.dataset.field];
    b.classList.toggle("yes", v === 1 || v === true);
    b.classList.toggle("no", v === 0 || v === false);
  }
}

function toggle(field, value) {
  const v = state.ann.values;
  v[field] = value ?? !(v[field] === 1 || v[field] === true);
  if (field === "target_in_frame" && !v.target_in_frame) {
    // A target that is not in frame can be neither centered nor useful.
    v.centered = false;
    v.useful = false;
    v.occluded = v.occluded ?? false;
  }
  renderToggles();
}

$$(".toggles button").forEach((b) => b.addEventListener("click", () => toggle(b.dataset.field)));

async function saveAnnotation() {
  const a = state.ann;
  const m = a.marks[a.i];
  const v = a.values;
  if (v.target_in_frame === null || v.target_in_frame === undefined) {
    toast("先判断目标是否入画（Y / N）");
    return;
  }
  const bool = (x) => (x === null || x === undefined ? false : !!x);
  const body = {
    frame_id: a.frameId, target_in_frame: !!v.target_in_frame,
    centered: bool(v.centered), occluded: bool(v.occluded), useful: bool(v.useful),
  };
  await api(`marks/${m.id}/annotation`, { method: "PUT", body });
  Object.assign(m, body, { frame_id: a.frameId });
  const inAll = a.all.find((x) => x.id === m.id);
  Object.assign(inAll, m);
  updateProgress();
  if (a.i < a.marks.length - 1) showMark(a.i + 1);
  else toast("这一轮标注完成");
}

function stepFrame(delta) {
  const ids = $$("#ann-strip figure").map((f) => Number(f.dataset.id));
  if (!ids.length) return;
  const i = ids.indexOf(state.ann.frameId);
  selectFrame(ids[Math.max(0, Math.min(ids.length - 1, (i < 0 ? 0 : i) + delta))]);
}

$("#ann-save").addEventListener("click", saveAnnotation);
$("#ann-prev").addEventListener("click", () => showMark(state.ann.i - 1));

// --- keyboard ----------------------------------------------------------------------------

document.addEventListener("keydown", (e) => {
  if (e.target.matches("input, select, textarea") || e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if (state.tab === "session" && state.active) {
    const btn = $(`#target-buttons [data-key="${e.key}"]`);
    if (btn) { btn.click(); e.preventDefault(); }
    else if (k === "r") $("#mark-reposition").click();
    else if (k === "n") $("#mark-note").click();
  } else if (state.tab === "annotate" && state.ann && !$("#ann-body").hidden) {
    const map = { y: ["target_in_frame", true], n: ["target_in_frame", false], c: ["centered"], o: ["occluded"], u: ["useful"] };
    if (map[k]) toggle(...map[k]);
    else if (e.key === "ArrowLeft") stepFrame(-1);
    else if (e.key === "ArrowRight") stepFrame(1);
    else if (e.key === "Enter") saveAnnotation();
    else if (k === "j") showMark(state.ann.i - 1);
    else if (k === "k") showMark(state.ann.i + 1);
    else return;
    e.preventDefault();
  }
});

// --- report --------------------------------------------------------------------------------

const REPORT_COLS = [
  ["target_in_frame_rate", "入画率", pct],
  ["target_center_rate", "居中率", pct],
  ["occlusion_rate", "遮挡率", pct],
  ["useful_frame_rate", "有效帧率(人工)", pct],
  ["reposition_rate", "调整率", pct],
  ["auto_ok_rate", "自动质检通过", pct],
  ["effective_fps", "实际 fps", (v) => v ?? "—"],
  ["annotated", "已标注/打标", null],
  ["participants", "受试者", (v) => v],
  ["frames", "帧数", (v) => v],
];

async function loadReport() {
  const group = $("#report-group").value;
  $("#report-csv").href = `api/report.csv?group=${group}`;
  const rows = await api(`report?group=${group}`);
  const keys = group.split(",");
  const keyLabel = { mount: "位置", task: "任务", participant: "受试者" };
  const keyFmt = { mount: mountName, task: (t) => taskById(t)?.name || t, participant: (p) => p };
  $("#report-table").replaceChildren(
    el("tr", {}, ...keys.map((k) => el("th", {}, keyLabel[k])), ...REPORT_COLS.map(([, h]) => el("th", {}, h))),
    ...rows.map((r) => el("tr", {},
      ...keys.map((k) => el("td", {}, keyFmt[k](r[k]))),
      ...REPORT_COLS.map(([f, , fmt]) => {
        if (f === "annotated") return el("td", {}, `${r.annotated} / ${r.gaze_marks}`);
        const cls = f === "target_in_frame_rate" && r.target_in_frame_band ? "band-" + r.target_in_frame_band
          : f === "reposition_rate" && r.reposition_over_limit ? "over" : undefined;
        return el("td", { class: cls }, fmt(r[f]));
      }))),
  );
  if (!rows.length) $("#report-table").append(el("tr", {}, el("td", { colspan: 12, class: "hint" }, "还没有数据。")));
}
$("#report-group").addEventListener("change", loadReport);

// --- boot --------------------------------------------------------------------------------------

(async () => {
  await loadTasks();
  await refreshDevices();
  refreshSessions();
  setInterval(refreshDevices, 2000);
})();
