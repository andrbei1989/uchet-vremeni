"use strict";
/* Учёт рабочего времени — панель администратора. Все данные живут на сервере (Google Таблица). */

var AUTH_KEY = "tt4_admin";
/* сервер этой организации; его можно сменить на экране входа («Другой сервер») */
var DEFAULT_SERVER = "https://script.google.com/macros/s/AKfycby5_KTl2-IpW_wwsVHOQJ9Pb1IEfW_BpI2LPGkfRcZuRUk9XyasibLjQX-TkBq4W8xP/exec";

/* ================= утилиты ================= */
function $(sel, root) { return (root || document).querySelector(sel); }
function esc(s) {
  return String(s === undefined || s === null ? "" : s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}
function lsGet(k, d) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } }
function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
function lsDel(k) { try { localStorage.removeItem(k); } catch (e) {} }
function pad(n) { return String(n).padStart(2, "0"); }
function dayKey(d) { d = new Date(d); return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
function hhmm(d) { d = new Date(d); return pad(d.getHours()) + ":" + pad(d.getMinutes()); }
function dmy(d) { d = new Date(d); return pad(d.getDate()) + "." + pad(d.getMonth() + 1) + "." + d.getFullYear(); }
function initials(name) {
  var p = String(name || "").trim().split(/\s+/);
  return ((p[0] || "?")[0] + (p[1] ? p[1][0] : "")).toUpperCase();
}
var toastTimer = null;
function toast(msg) {
  var t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { t.classList.remove("show"); }, 3000);
}
function validServer(u) { return /^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(String(u || "").trim()); }

var ERRORS = {
  bad_password: "Неверный пароль",
  locked: "Слишком много неверных паролей. Подождите 15 минут.",
  not_configured: "Пароль администратора ещё не задан",
  weak_password: "Пароль должен быть не короче 6 символов",
  already_configured: "Пароль уже задан",
  name_required: "Укажите ФИО",
  not_found: "Сотрудник не найден",
  unknown_action: "Сервер устарел: обновите код Apps Script до версии 4",
  busy: "Сервер занят, попробуйте ещё раз",
  bad_time: "Неверная дата или время",
  future_time: "Нельзя добавить отметку в будущем",
  row_changed: "Таблицу изменили вручную — обновите табель и попробуйте снова",
  needs_authorization: "Нужно разрешить доступ в Apps Script — см. инструкцию в «Автоматике»",
  bad_tg_token: "Неверный токен бота",
  tg_not_configured: "Сначала сохраните токен бота",
  tg_no_messages: "Бот ещё не получил ни одного сообщения: откройте бота в Telegram и нажмите «Старт», затем повторите",
  tg_not_linked: "Чат не подключён"
};
function errText(e) { return ERRORS[e] || String(e || "ошибка"); }

/* ================= сервер ================= */
var AUTH = lsGet(AUTH_KEY, null); /* { server, pw } */

function call(params, server) {
  server = server || (AUTH && AUTH.server);
  return new Promise(function (resolve, reject) {
    if (!validServer(server)) return reject(new Error("Ссылка должна быть вида https://script.google.com/macros/s/…/exec"));
    var cb = "__tt" + Math.random().toString(36).slice(2, 10);
    var url = server.trim() + "?callback=" + cb;
    Object.keys(params).forEach(function (k) {
      if (params[k] !== undefined && params[k] !== null) url += "&" + encodeURIComponent(k) + "=" + encodeURIComponent(params[k]);
    });
    var sc = document.createElement("script"), done = false;
    var timer = setTimeout(function () { finish(function () { reject(new Error("Сервер не ответил за 20 секунд")); }); }, 20000);
    function finish(fn) {
      if (done) return;
      done = true; clearTimeout(timer);
      try { delete window[cb]; } catch (e) { window[cb] = undefined; }
      if (sc.parentNode) sc.parentNode.removeChild(sc);
      fn();
    }
    window[cb] = function (d) { finish(function () { resolve(d || {}); }); };
    sc.onerror = function () { finish(function () { reject(new Error("Не удалось связаться с сервером. Проверьте ссылку и что доступ к веб-приложению — «Все».")); }); };
    sc.src = url;
    document.head.appendChild(sc);
  });
}
/* админский запрос: подставляет пароль, при неверном пароле выкидывает на вход */
async function admin(params) {
  var r = await call(Object.assign({ pw: AUTH.pw }, params));
  if (!r.ok && (r.error === "bad_password" || r.error === "not_configured")) {
    logout();
    throw new Error(errText(r.error));
  }
  if (!r.ok) { var err = new Error(errText(r.error)); err.code = r.error; throw err; }
  return r;
}

/* ================= состояние ================= */
var S = {
  employees: [],
  board: null,
  boardAt: null,
  settings: { lat: null, lng: null, radius: 100, workStart: "09:00", workEnd: "18:00", lunchMinutes: 60, lateTolerance: 10, workDays: "12345" },
  records: [],
  recordsKey: ""
};

async function loadEmployees() { S.employees = (await admin({ action: "employees" })).rows || []; }
async function loadSettings() { S.settings = (await admin({ action: "getSettings" })).settings || S.settings; }
function findEmp(code) { return S.employees.filter(function (e) { return e.code === code; })[0] || null; }

/* ================= QR ================= */
var qrCache = {};
function qrDataUrl(text, size) {
  size = size || 240;
  if (!window.QRCode) return null;
  var key = text + "@" + size;
  if (qrCache[key]) return qrCache[key];
  try {
    var holder = document.createElement("div");
    new window.QRCode(holder, { text: text, width: size, height: size, colorDark: "#0f172a", colorLight: "#ffffff", correctLevel: window.QRCode.CorrectLevel.M });
    var cv = holder.querySelector("canvas");
    var url = cv ? cv.toDataURL("image/png") : null;
    if (url) qrCache[key] = url;
    return url;
  } catch (e) { return null; }
}
function empBase() { return location.origin + location.pathname.replace(/[^/]*$/, "") + "emp.html"; }
function linkIn() { return empBase() + "?t=in&s=" + encodeURIComponent(AUTH.server); }
function linkOut() { return empBase() + "?t=out&s=" + encodeURIComponent(AUTH.server); }
function linkReg(e) { return empBase() + "?r=" + encodeURIComponent(e.code) + "&k=" + encodeURIComponent(e.key) + "&s=" + encodeURIComponent(AUTH.server); }
function qrImg(text, size) {
  var url = qrDataUrl(text, size);
  if (!url) return '<div class="empty">QR-библиотека не загрузилась — проверьте интернет и обновите страницу</div>';
  return '<img src="' + url + '" alt="QR">';
}

/* ================= модальные окна ================= */
function openModal(html) {
  var host = $("#modalHost");
  host.innerHTML = '<div class="overlay"><div class="sheet" role="dialog" aria-modal="true">' + html + "</div></div>";
  var ov = host.firstChild;
  ov.addEventListener("click", function (e) { if (e.target === ov) closeModal(); });
}
function closeModal() { $("#modalHost").innerHTML = ""; }
function sheetHead(title, sub) {
  return '<div class="row between" style="align-items:flex-start"><div class="stack" style="gap:2px"><h2>' + esc(title) + "</h2>" +
    (sub ? '<div class="muted small">' + esc(sub) + "</div>" : "") + "</div>" +
    '<button class="btn sm ghost" data-action="close">✕</button></div>';
}
var confirmFn = null;
function ask(title, text, okLabel, fn, danger) {
  confirmFn = fn;
  openModal(sheetHead(title) + '<div class="muted" style="margin-top:8px">' + text + "</div>" +
    '<div class="col" style="margin-top:14px"><button class="btn ' + (danger ? "danger" : "primary") + '" data-action="confirm-yes">' + esc(okLabel) + "</button>" +
    '<button class="btn ghost" data-action="close">Отмена</button></div>');
}

/* ================= «На смене» ================= */
var boardTimer = null;
function renderBoard() {
  var rows = (S.board && S.board.rows) || [];
  var onShift = rows.filter(function (r) { return r.onShift; });
  $("#boardHead").innerHTML =
    '<div class="row between"><div class="stack" style="gap:2px">' +
      '<div style="font-size:26px;font-weight:800;letter-spacing:-.02em">' + onShift.length +
        ' <span class="muted" style="font-size:15px;font-weight:600">на работе</span></div>' +
      '<div class="muted small">' + (S.boardAt ? "Обновлено в " + esc(hhmm(S.boardAt)) + " · автообновление раз в минуту" : "Загрузка…") + "</div>" +
    "</div>" +
    '<button class="btn sm primary" data-action="board-refresh">Обновить</button></div>' +
    '<div class="row wrap" style="margin-top:10px;gap:6px">' +
      '<span class="badge green">' + onShift.length + " на смене</span>" +
      '<span class="badge">' + (rows.length - onShift.length) + " не на смене</span>" +
      '<span class="badge blue">' + rows.filter(function (r) { return r.bound; }).length + " из " + rows.length + " телефонов привязано</span>" +
    "</div>";
  var host = $("#boardMain");
  if (S.board && !rows.length) {
    host.innerHTML = '<div class="card empty">Сотрудников пока нет.<br><button class="btn primary" style="margin-top:10px" data-action="nav" data-view="employees">Добавить сотрудников</button></div>';
    return;
  }
  host.innerHTML = rows.map(function (r) {
    var on = r.onShift;
    var last = r.lastType
      ? (r.autoClosed ? "не отметил выход · вход " + esc(r.lastText) : (r.lastType === "in" ? "вошёл " : "вышел ") + esc(r.lastText))
      : (r.bound ? "отметок ещё не было" : "телефон не привязан");
    var zone = "";
    if (r.autoClosed) zone = ' <span class="badge amber">закрыто автоматически</span>';
    else if (r.lastType && r.zone === "вне зоны") zone = ' <span class="badge red">вне зоны' + (r.distance ? " · " + r.distance + " м" : "") + "</span>";
    else if (r.lastType && r.zone === "без координат") zone = ' <span class="badge amber">без геопозиции</span>';
    else if (r.lastType && r.zone === "в зоне") zone = ' <span class="badge green">в зоне</span>';
    return '<div class="card tight" style="border-left:4px solid ' + (on ? "#16a34a" : "#e2e8f0") + '">' +
      '<div class="row" style="gap:10px">' +
        '<div class="avatar" style="width:36px;height:36px;font-size:13px;background:' + (on ? "#eafaf0" : "#f1f5f9") + ";color:" + (on ? "#15803d" : "#64748b") + '">' + esc(initials(r.name)) + "</div>" +
        '<div style="flex:1;min-width:0">' +
          '<div style="font-weight:650;font-size:14px">' + esc(r.name) + (r.status === "заблокирован" ? ' <span class="badge red">заблокирован</span>' : "") + "</div>" +
          '<div class="muted" style="font-size:12px;margin-top:2px">' + last + zone + "</div>" +
        "</div>" +
        '<span class="badge ' + (on ? "green" : "") + '">' + (on ? "на смене" : "не на смене") + "</span>" +
      "</div></div>";
  }).join("");
}
async function refreshBoard(silent) {
  try {
    S.board = await admin({ action: "board" });
    S.boardAt = new Date();
    if (current === "board") renderBoard();
    if (!silent) toast("Обновлено");
  } catch (e) { if (!silent) toast(e.message); }
}

/* ================= «Табель» ================= */
var rep = { from: null, to: null, emp: "" };
function rangeFor(mode) {
  var now = new Date(), from;
  var to = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (mode === "day") from = to;
  else if (mode === "week") from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7));
  else from = new Date(now.getFullYear(), now.getMonth(), 1);
  return { from: from, to: to };
}
function parseDay(v) { var p = String(v).split("-"); return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2])); }

async function loadRecords(force) {
  if (!rep.from) { var r0 = rangeFor("month"); rep.from = r0.from; rep.to = r0.to; }
  var from = new Date(rep.from.getFullYear(), rep.from.getMonth(), rep.from.getDate());
  var to = new Date(rep.to.getFullYear(), rep.to.getMonth(), rep.to.getDate(), 23, 59, 59, 999);
  var key = from.toISOString() + "|" + to.toISOString();
  if (!force && key === S.recordsKey) return;
  $("#repList").innerHTML = '<div class="spinner"></div>';
  try {
    S.records = (await admin({ action: "read", from: from.toISOString(), to: to.toISOString() })).rows || [];
    S.recordsKey = key;
  } catch (e) {
    $("#repList").innerHTML = '<div class="empty">' + esc(e.message) + "</div>";
    throw e;
  }
}

function pairsFor(list) {
  var by = {}, out = [];
  list.slice().sort(function (a, b) { return a.ts < b.ts ? -1 : 1; }).forEach(function (r) {
    (by[r.code] = by[r.code] || []).push(r);
  });
  Object.keys(by).forEach(function (code) {
    var open = null;
    by[code].forEach(function (r) {
      if (r.type === "in") {
        if (open) out.push({ code: code, name: open.name, day: dayKey(open.ts), in: open, out: null, broken: "no-out" });
        open = r;
      } else if (r.source === "авто") {
        /* смену закрыл сервер ночью: выхода не было, часы не считаем */
        if (open) { out.push({ code: code, name: open.name, day: dayKey(open.ts), in: open, out: r, broken: "auto" }); open = null; }
      } else if (open && dayKey(r.ts) === dayKey(open.ts)) {
        out.push({ code: code, name: open.name, day: dayKey(open.ts), in: open, out: r });
        open = null;
      } else if (open && new Date(r.ts) - new Date(open.ts) < 16 * 3600000) {
        /* ночная смена: выход на следующий день, но не позже 16 часов */
        out.push({ code: code, name: open.name, day: dayKey(open.ts), in: open, out: r });
        open = null;
      } else {
        if (open) { out.push({ code: code, name: open.name, day: dayKey(open.ts), in: open, out: null, broken: "no-out" }); open = null; }
        out.push({ code: code, name: r.name, day: dayKey(r.ts), in: null, out: r, broken: "no-in" });
      }
    });
    if (open) {
      var still = dayKey(open.ts) === dayKey(new Date());
      out.push({ code: code, name: open.name, day: dayKey(open.ts), in: open, out: null, broken: still ? "open" : "no-out" });
    }
  });
  return out;
}
function hoursOf(p) {
  if (!p.in || !p.out || p.broken) return 0;
  var h = (new Date(p.out.ts) - new Date(p.in.ts)) / 3600000;
  var lunch = Number(S.settings.lunchMinutes) || 0;
  if (h > 6 && lunch > 0) h -= lunch / 60;
  return h > 0 ? h : 0;
}
function isLate(p) {
  if (!p.in) return false;
  var d = new Date(p.in.ts);
  var st = String(S.settings.workStart || "09:00").split(":");
  var limit = new Date(d.getFullYear(), d.getMonth(), d.getDate(), Number(st[0]) || 0, Number(st[1]) || 0);
  return d.getTime() > limit.getTime() + (Number(S.settings.lateTolerance) || 0) * 60000;
}
function fmtHours(h) { return (Math.round(h * 10) / 10).toFixed(1).replace(".", ","); }
function zoneBadge(r) {
  if (!r) return "";
  if (r.zone === "в зоне") return '<span class="badge green">в зоне</span>';
  if (r.zone === "вне зоны") return '<span class="badge red">' + (r.distance ? r.distance + " м" : "вне зоны") + "</span>";
  if (r.zone === "без координат") return '<span class="badge amber">без гео</span>';
  return "";
}
function manualMark(r) {
  if (!r || r.source !== "администратор") return "";
  return ' <span class="badge blue" title="' + esc(r.note || "Добавил администратор") + '">вручную</span>';
}
function mapLink(r) {
  if (!r || r.lat === null || r.lat === undefined) return "";
  return ' <a href="https://maps.google.com/?q=' + r.lat + "," + r.lng + '" target="_blank" rel="noopener" class="small">карта</a>';
}
function reportPairs() {
  var list = S.records.filter(function (r) { return !rep.emp || r.code === rep.emp; });
  return pairsFor(list);
}

function renderReport() {
  $("#repFrom").value = dayKey(rep.from);
  $("#repTo").value = dayKey(rep.to);
  var sel = $("#repEmp");
  sel.innerHTML = '<option value="">Все сотрудники</option>' + S.employees.map(function (e) {
    return '<option value="' + esc(e.code) + '">' + esc(e.name) + "</option>";
  }).join("");
  sel.value = rep.emp;

  var pairs = reportPairs();
  var totalH = 0, late = 0, shifts = 0, issues = 0, byEmp = {};
  pairs.forEach(function (p) {
    var a = byEmp[p.code] = byEmp[p.code] || { code: p.code, name: (findEmp(p.code) || {}).name || p.name, hours: 0, days: {}, shifts: 0, late: 0, broken: 0, outZone: 0, pairs: [] };
    a.pairs.push(p);
    if (p.in) a.days[p.day] = 1;
    if (p.in && p.out && !p.broken) { var h = hoursOf(p); a.hours += h; totalH += h; a.shifts++; shifts++; }
    if (isLate(p)) { a.late++; late++; }
    if (p.broken === "no-in" || p.broken === "no-out" || p.broken === "auto") { a.broken++; issues++; }
    if ((p.in && p.in.zone === "вне зоны") || (p.out && p.out.zone === "вне зоны")) a.outZone++;
  });
  $("#repKpi").innerHTML =
    '<div class="box"><div class="v">' + fmtHours(totalH) + '</div><div class="l">часов</div></div>' +
    '<div class="box"><div class="v">' + shifts + '</div><div class="l">смен</div></div>' +
    '<div class="box"><div class="v">' + late + '</div><div class="l">опозданий</div></div>' +
    '<div class="box"><div class="v">' + issues + '</div><div class="l">без пары</div></div>';
  var list = Object.keys(byEmp).map(function (k) { return byEmp[k]; }).sort(function (a, b) { return a.name.localeCompare(b.name, "ru"); });
  if (!list.length) { $("#repList").innerHTML = '<div class="empty">За выбранный период отметок нет.</div>'; return; }
  $("#repList").innerHTML = list.map(function (a) {
    var rows = a.pairs.slice().sort(function (x, y) { return y.day.localeCompare(x.day); }).map(function (p) {
      var outCell = p.broken === "auto" ? '<span style="color:#dc2626">нет выхода</span> <span class="badge amber">авто</span>'
        : p.out ? hhmm(p.out.ts) + " " + zoneBadge(p.out) + manualMark(p.out)
        : (p.broken === "open" ? '<span class="badge green">на смене</span>' : '<span style="color:#dc2626">нет выхода</span>');
      var dayTs = p.in ? p.in.ts : p.out.ts;
      return "<tr><td>" + esc(dmy(dayTs).slice(0, 5)) + "</td>" +
        "<td>" + (p.in ? hhmm(p.in.ts) + " " + zoneBadge(p.in) + manualMark(p.in) + mapLink(p.in) : '<span style="color:#dc2626">нет входа</span>') +
        (isLate(p) ? ' <span class="badge amber">опозд.</span>' : "") + "</td>" +
        "<td>" + outCell + "</td>" +
        '<td class="num">' + (p.in && p.out && !p.broken ? fmtHours(hoursOf(p)) : "—") + "</td>" +
        '<td><button class="btn sm ghost" data-action="edit-day" data-code="' + esc(a.code) + '" data-day="' + dayKey(dayTs) + '" title="Исправить">✎</button></td></tr>';
    }).join("");
    return '<details class="emp"><summary>' +
      '<div class="avatar" style="width:34px;height:34px;font-size:12px">' + esc(initials(a.name)) + "</div>" +
      '<div style="flex:1"><div style="font-weight:650;font-size:13.5px">' + esc(a.name) + "</div>" +
      '<div class="muted" style="font-size:11.5px">дней: ' + Object.keys(a.days).length + " · смен: " + a.shifts +
      (a.late ? " · опозданий: " + a.late : "") +
      (a.broken ? ' · <span style="color:#dc2626">без пары: ' + a.broken + "</span>" : "") +
      (a.outZone ? ' · <span style="color:#dc2626">вне зоны: ' + a.outZone + "</span>" : "") + "</div></div>" +
      '<div style="font-weight:700">' + fmtHours(a.hours) + " ч</div></summary>" +
      '<div style="overflow-x:auto"><table class="tbl" style="margin-top:8px"><thead><tr><th>Дата</th><th>Вход</th><th>Выход</th><th class="num">Часы</th><th></th></tr></thead><tbody>' +
      rows + "</tbody></table></div></details>";
  }).join("");
}
async function showReport(force) {
  try { await loadRecords(force); } catch (e) { return; }
  if (current === "report") renderReport();
}

/* ================= QR-коды ================= */
function renderCodes() {
  $("#posterBox").innerHTML =
    '<div class="poster"><div class="qrbox" style="width:100%">' + qrImg(linkIn(), 360) + "</div>" +
    '<div class="word in">ВХОД</div></div>' +
    '<div class="poster"><div class="qrbox" style="width:100%">' + qrImg(linkOut(), 360) + "</div>" +
    '<div class="word out">ВЫХОД</div></div>';
  var free = S.employees.filter(function (e) { return !e.bound; });
  $("#regCount").textContent = free.length + " не привязано";
  if (!S.employees.length) {
    $("#regGrid").innerHTML = '<div class="empty" style="grid-column:1/-1">Сначала добавьте сотрудников.</div>';
    return;
  }
  $("#regGrid").innerHTML = S.employees.map(function (e) {
    return '<div class="qr-item" style="' + (e.bound ? "opacity:.6" : "") + '">' +
      (e.bound ? '<div style="width:52px;height:52px;display:grid;place-items:center;font-size:22px">📱</div>' : qrImg(linkReg(e), 140)) +
      '<div style="flex:1;min-width:0"><div class="nm">' + esc(e.name) + '</div><div class="cd">' + esc(e.code) + "</div>" +
      '<div style="margin-top:4px">' + (e.bound ? '<span class="badge blue">привязан ' + esc(e.boundAt) + "</span>" : '<span class="badge green">ждёт привязки</span>') + "</div>" +
      (e.bound ? "" : '<button class="btn sm ghost" style="margin-top:5px" data-action="show-qr" data-code="' + esc(e.code) + '">Показать крупно</button>') +
      "</div></div>";
  }).join("");
}

/* ================= «Сотрудники» ================= */
function renderEmployees() {
  var host = $("#empList");
  if (!S.employees.length) { host.innerHTML = '<div class="card empty">Список пуст. Добавьте первого сотрудника выше.</div>'; return; }
  host.innerHTML = S.employees.map(function (e) {
    var blocked = e.status === "заблокирован";
    return '<div class="card tight">' +
      '<div class="row" style="gap:10px">' +
        '<div class="avatar" style="width:36px;height:36px;font-size:13px">' + esc(initials(e.name)) + "</div>" +
        '<div style="flex:1;min-width:0"><div style="font-weight:650">' + esc(e.name) + "</div>" +
          '<div class="row wrap" style="gap:5px;margin-top:4px">' +
            '<span class="badge mono">' + esc(e.code) + "</span>" +
            (blocked ? '<span class="badge red">заблокирован</span>' : "") +
            (e.bound ? '<span class="badge blue">' + esc(e.device || "телефон") + " · " + esc(e.boundAt) + "</span>" : '<span class="badge amber">телефон не привязан</span>') +
          "</div></div>" +
      "</div>" +
      '<div class="row wrap" style="margin-top:10px;gap:6px">' +
        (e.bound ? "" : '<button class="btn sm" data-action="show-qr" data-code="' + esc(e.code) + '">QR привязки</button>') +
        '<button class="btn sm ghost" data-action="rename" data-code="' + esc(e.code) + '">Переименовать</button>' +
        '<button class="btn sm ghost" data-action="regen" data-code="' + esc(e.code) + '">' + (e.bound ? "Сменить телефон" : "Новый QR") + "</button>" +
        '<button class="btn sm ' + (blocked ? "ghost" : "danger") + '" data-action="toggle-block" data-code="' + esc(e.code) + '">' + (blocked ? "Разблокировать" : "Заблокировать") + "</button>" +
      "</div></div>";
  }).join("");
}

/* ================= «Настройки» ================= */
function renderSettings() {
  var s = S.settings;
  $("#setLat").value = s.lat === null ? "" : s.lat;
  $("#setLng").value = s.lng === null ? "" : s.lng;
  $("#setRadius").value = s.radius;
  $("#setStart").value = s.workStart;
  $("#setEnd").value = s.workEnd;
  $("#setLunch").value = s.lunchMinutes;
  $("#setLate").value = s.lateTolerance;
  $("#serverUrl").textContent = AUTH.server;
  var days = String(s.workDays || "");
  $("#setDays").innerHTML = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"].map(function (d, i) {
    return '<label class="chk" style="padding:0 6px 0 0"><input type="checkbox" data-day="' + (i + 1) + '"' + (days.indexOf(String(i + 1)) >= 0 ? " checked" : "") + "> " + d + "</label>";
  }).join("");
  $("#tgOutZone").checked = s.tgOutZone !== "0";
  $("#tgAbsent").checked = s.tgAbsent !== "0";
  $("#tgDaily").checked = s.tgDaily !== "0";
  var tg = $("#tgBadge");
  if (s.tgLinked) { tg.className = "badge green"; tg.textContent = "подключено: " + s.tgChat; }
  else if (s.tgToken) { tg.className = "badge amber"; tg.textContent = "токен есть, чат не подключён"; }
  else { tg.className = "badge"; tg.textContent = "не подключено"; }
  $("#tgHow").open = !s.tgLinked && !s.tgToken;
  var ab = $("#autoBadge");
  if (s.automation === true) { ab.className = "badge green"; ab.textContent = "включена"; }
  else if (s.automation === false) { ab.className = "badge amber"; ab.textContent = "выключена"; }
  else if (s.automation === null) { ab.className = "badge red"; ab.textContent = "нужен доступ"; }
  else { ab.className = "badge"; ab.textContent = "…"; }
  $("#autoHelp").classList.toggle("hidden", s.automation !== null);
  $("#backupInfo").innerHTML = s.lastBackup
    ? "Последняя копия: " + esc(s.lastBackup) + (s.lastBackupUrl ? ' · <a href="' + esc(s.lastBackupUrl) + '" target="_blank" rel="noopener">открыть</a>' : "")
    : "Копий ещё не было.";
}
function workDaysValue() {
  return Array.prototype.map.call(document.querySelectorAll("#setDays input:checked"), function (c) { return c.dataset.day; }).join("");
}

/* ================= навигация ================= */
var NAV = [
  { k: "board", t: "На смене", d: "M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM2 21v-1a5 5 0 0 1 5-5h4a5 5 0 0 1 5 5v1M17 4.5a4 4 0 0 1 0 7M18 15a5 5 0 0 1 4 5v1" },
  { k: "report", t: "Табель", d: "M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z" },
  { k: "codes", t: "QR-коды", d: "M3 3h6v6H3zM15 3h6v6h-6zM3 15h6v6H3zM15 15h2v2h-2zM19 15h2v2h-2zM15 19h2v2h-2zM19 19h2v2h-2z" },
  { k: "employees", t: "Сотрудники", d: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 7a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM22 21v-2a4 4 0 0 0-3-3.9" },
  { k: "settings", t: "Настройки", d: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM4 12a8 8 0 0 1 .2-1.8l-1.4-1.1 2-3.4 1.7.7A8 8 0 0 1 9 5.2L9.3 3.4h5.4L15 5.2c.6.3 1.2.7 1.7 1.2l1.7-.7 2 3.4-1.4 1.1A8 8 0 0 1 20 12a8 8 0 0 1-.2 1.8l1.4 1.1-2 3.4-1.7-.7c-.5.5-1.1.9-1.7 1.2l-.3 1.8H9.3L9 18.8a8 8 0 0 1-1.7-1.2l-1.7.7-2-3.4 1.4-1.1A8 8 0 0 1 4 12z" }
];
var TITLES = { login: "Учёт рабочего времени", board: "На смене", report: "Табель", codes: "QR-коды", employees: "Сотрудники", settings: "Настройки" };
var current = "login";

function buildNav() {
  $("#nav").innerHTML = NAV.map(function (n) {
    return '<button data-action="nav" data-view="' + n.k + '" id="nav-' + n.k + '"><svg viewBox="0 0 24 24"><path d="' + n.d + '"/></svg><span>' + n.t + "</span></button>";
  }).join("");
}
function show(view) {
  current = view;
  document.querySelectorAll("section.view").forEach(function (s) { s.classList.toggle("active", s.id === "v-" + view); });
  NAV.forEach(function (n) { var b = $("#nav-" + n.k); if (b) b.classList.toggle("on", n.k === view); });
  $("#nav").classList.toggle("hidden", view === "login");
  $("#topTitle").textContent = TITLES[view];
  $("#topSub").textContent = view === "login" ? "Панель администратора" : view === "board" ? "Кто сейчас на работе" : "Учёт рабочего времени";
  if (view === "board") { renderBoard(); refreshBoard(true); }
  if (view === "report") { renderReport(); showReport(false); }
  if (view === "codes") renderCodes();
  if (view === "employees") renderEmployees();
  if (view === "settings") renderSettings();
  window.scrollTo(0, 0);
}

/* ================= вход ================= */
var setupMode = false;
async function doLogin() {
  /* поле «Другой сервер» учитываем, только если его раскрыли и вписали правильную ссылку:
     браузеры любят подставлять в скрытые поля логины из автозаполнения */
  var typed = $("#loginUrl").value.trim();
  var custom = $("#loginUrl").closest("details").open && typed && typed !== DEFAULT_SERVER;
  if (custom && !validServer(typed)) return toast("Ссылка в «Другой сервер» должна быть вида https://script.google.com/macros/s/…/exec");
  var server = custom ? typed : DEFAULT_SERVER;
  var pw = $("#loginPw").value;
  var btn = $("#loginBtn");
  btn.disabled = true;
  try {
    var ping = await call({ action: "ping" }, server);
    if (!ping.ok || !ping.version) throw new Error("Сервер ответил, но это старая версия. Обновите код Apps Script.");
    if (!ping.configured) {
      if (!setupMode) {
        setupMode = true;
        $("#setupBox").classList.remove("hidden");
        btn.textContent = "Задать пароль и войти";
        $("#loginPw2").focus();
        return;
      }
      if (pw.length < 6) throw new Error(errText("weak_password"));
      if (pw !== $("#loginPw2").value) throw new Error("Пароли не совпадают");
      var su = await call({ action: "setup", pw: pw }, server);
      if (!su.ok) throw new Error(errText(su.error));
    } else {
      var li = await call({ action: "login", pw: pw }, server);
      if (!li.ok) throw new Error(errText(li.error));
    }
    AUTH = { server: server, pw: pw };
    lsSet(AUTH_KEY, AUTH);
    $("#loginPw").value = ""; $("#loginPw2").value = "";
    await enter();
  } catch (e) {
    toast(e.message);
  } finally {
    btn.disabled = false;
  }
}
async function enter() {
  $("#toast").classList.remove("show");
  show("board");
  try {
    await Promise.all([loadEmployees(), loadSettings()]);
  } catch (e) { toast(e.message); }
  if (boardTimer) clearInterval(boardTimer);
  boardTimer = setInterval(function () { if (current === "board" && !document.hidden) refreshBoard(true); }, 60000);
}
function logout() {
  AUTH = null; lsDel(AUTH_KEY);
  if (boardTimer) clearInterval(boardTimer);
  S.employees = []; S.board = null; S.records = []; S.recordsKey = "";
  closeModal();
  show("login");
}

/* ================= печать и файлы ================= */
function doPrint(html) {
  $("#printArea").innerHTML = html;
  document.body.classList.add("printing");
  setTimeout(function () {
    window.print();
    setTimeout(function () { document.body.classList.remove("printing"); }, 600);
  }, 150);
}
function downloadDataUrl(url, name) {
  if (!url) return toast("Не удалось сформировать QR");
  var a = document.createElement("a");
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
}
function downloadText(text, name, mime) {
  var url = URL.createObjectURL(new Blob([text], { type: mime }));
  var a = document.createElement("a");
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
}
var gsCode = null;
async function getGsCode() {
  if (gsCode) return gsCode;
  var r = await fetch("apps-script.gs", { cache: "no-cache" });
  if (!r.ok) throw new Error("Не удалось загрузить код сервера");
  gsCode = await r.text();
  return gsCode;
}
function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
  return new Promise(function (resolve, reject) {
    var ta = document.createElement("textarea");
    ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy") ? resolve() : reject(); } catch (e) { reject(e); }
    ta.remove();
  });
}
function upsertEmp(emp) {
  var i = S.employees.findIndex(function (e) { return e.code === emp.code; });
  if (i >= 0) S.employees[i] = emp; else S.employees.push(emp);
}

/* ================= действия ================= */
var actions = {
  "close": closeModal,
  "confirm-yes": function () { var fn = confirmFn; confirmFn = null; closeModal(); if (fn) fn(); },
  "login": doLogin,
  "logout": function () { ask("Выйти?", "Пароль администратора будет удалён с этого устройства. Данные в таблице не пострадают.", "Выйти", logout, true); },
  "board-refresh": function () { refreshBoard(false); },
  "report-refresh": function () { showReport(true); },
  "period": function (el) {
    var r = rangeFor(el.dataset.period);
    rep.from = r.from; rep.to = r.to;
    renderReport(); showReport(false);
  },
  "csv": function () {
    var pairs = reportPairs();
    var head = ["Код", "Сотрудник", "Дата", "Вход", "Зона входа", "Выход", "Зона выхода", "Часы", "Опоздание", "Замечание"];
    var lines = pairs.map(function (p) {
      var e = findEmp(p.code);
      return [p.code, e ? e.name : p.name, dmy(p.in ? p.in.ts : p.out.ts),
        p.in ? hhmm(p.in.ts) : "", p.in ? p.in.zone : "",
        p.out && p.broken !== "auto" ? hhmm(p.out.ts) : "", p.out && p.broken !== "auto" ? p.out.zone : "",
        p.in && p.out && !p.broken ? fmtHours(hoursOf(p)) : "", isLate(p) ? "да" : "",
        brokenText(p)]
        .map(function (x) { return '"' + String(x === null || x === undefined ? "" : x).replace(/"/g, '""') + '"'; }).join(";");
    });
    downloadText("﻿" + head.join(";") + "\r\n" + lines.join("\r\n"), "tabel-" + dayKey(rep.from) + "_" + dayKey(rep.to) + ".csv", "text/csv;charset=utf-8");
  },
  "add-emp": async function () {
    var f = $("#newEmpName");
    var name = f.value.trim();
    if (!name) { f.focus(); return toast("Введите ФИО"); }
    try {
      var r = await admin({ action: "addEmployee", name: name });
      upsertEmp(r.employee);
      f.value = "";
      renderEmployees();
      toast("Добавлен " + r.employee.name + " (" + r.employee.code + ")");
    } catch (e) { toast(e.message); }
  },
  "rename": function (el) {
    var e = findEmp(el.dataset.code);
    if (!e) return;
    openModal(sheetHead("Переименовать", e.code) +
      '<input class="input" id="renameField" style="margin-top:12px" maxlength="80" value="' + esc(e.name) + '">' +
      '<div class="col" style="margin-top:12px"><button class="btn primary" data-action="rename-save" data-code="' + esc(e.code) + '">Сохранить</button>' +
      '<button class="btn ghost" data-action="close">Отмена</button></div>');
    setTimeout(function () { var f = $("#renameField"); if (f) { f.focus(); f.select(); } }, 50);
  },
  "rename-save": async function (el) {
    var name = ($("#renameField").value || "").trim();
    if (!name) return toast("Введите ФИО");
    try {
      var r = await admin({ action: "updateEmployee", code: el.dataset.code, name: name });
      upsertEmp(r.employee); closeModal(); renderEmployees(); toast("Сохранено");
    } catch (e) { toast(e.message); }
  },
  "regen": function (el) {
    var e = findEmp(el.dataset.code);
    if (!e) return;
    ask(e.bound ? "Сменить телефон?" : "Выпустить новый QR?",
      (e.bound ? "Телефон «" + esc(e.device) + "» будет отвязан, отметки с него перестанут приниматься. " : "") +
      "Старый QR-код " + esc(e.name) + " перестанет работать — выдайте сотруднику новый.",
      "Выпустить новый QR", async function () {
        try {
          var r = await admin({ action: "regenKey", code: e.code });
          upsertEmp(r.employee); renderEmployees();
          actions["show-qr"]({ dataset: { code: e.code } });
        } catch (err) { toast(err.message); }
      }, e.bound);
  },
  "toggle-block": function (el) {
    var e = findEmp(el.dataset.code);
    if (!e) return;
    var blocked = e.status === "заблокирован";
    var go = async function () {
      try {
        var r = await admin({ action: "updateEmployee", code: e.code, status: blocked ? "активен" : "заблокирован" });
        upsertEmp(r.employee); renderEmployees();
        toast(blocked ? "Разблокирован" : "Заблокирован");
      } catch (err) { toast(err.message); }
    };
    if (blocked) go();
    else ask("Заблокировать?", esc(e.name) + " не сможет отмечаться, пока вы не разблокируете. Отметки в таблице сохранятся.", "Заблокировать", go, true);
  },
  "show-qr": function (el) {
    var e = findEmp(el.dataset.code);
    if (!e) return;
    if (e.bound) return toast("Телефон уже привязан. Чтобы выдать новый код — «Сменить телефон».");
    openModal(sheetHead(e.name, e.code + " · личный код привязки") +
      '<div class="qrbox" style="margin-top:12px">' + qrImg(linkReg(e), 420) + "</div>" +
      '<div class="muted small" style="margin-top:10px">Сотрудник наводит камеру своего телефона на этот код — телефон привязывается. Код срабатывает один раз.</div>' +
      '<div class="col" style="margin-top:12px"><button class="btn" data-action="dl-qr" data-code="' + esc(e.code) + '">Скачать PNG</button>' +
      '<button class="btn ghost" data-action="close">Закрыть</button></div>');
  },
  "dl-qr": function (el) {
    var e = findEmp(el.dataset.code);
    if (e) downloadDataUrl(qrDataUrl(linkReg(e), 800), "qr-" + e.code + ".png");
  },
  "print-posters": function () {
    /* печатные постеры видят сотрудники — на русском и казахском */
    var brand = '<div class="brand">Учёт рабочего времени<br><span class="kz">Жұмыс уақытын есепке алу</span></div>';
    doPrint(
      '<div class="print-poster">' + brand + '<div class="word in">ВХОД<span class="kz">КІРУ</span></div>' +
      '<img src="' + qrDataUrl(linkIn(), 900) + '"><div class="note">Наведите камеру телефона, когда пришли на работу' +
      '<span class="kz">Жұмысқа келгенде телефон камерасын бағыттаңыз</span></div></div>' +
      '<div class="print-poster">' + brand + '<div class="word out">ВЫХОД<span class="kz">ШЫҒУ</span></div>' +
      '<img src="' + qrDataUrl(linkOut(), 900) + '"><div class="note">Наведите камеру телефона, когда уходите' +
      '<span class="kz">Жұмыстан кетерде телефон камерасын бағыттаңыз</span></div></div>');
  },
  "download-posters": function () {
    downloadDataUrl(qrDataUrl(linkIn(), 900), "qr-vhod.png");
    setTimeout(function () { downloadDataUrl(qrDataUrl(linkOut(), 900), "qr-vyhod.png"); }, 400);
  },
  "print-badges": function () {
    var free = S.employees.filter(function (e) { return !e.bound && e.status !== "заблокирован"; });
    if (!free.length) return toast("Все телефоны уже привязаны");
    doPrint('<div class="badge-grid">' + free.map(function (e) {
      return '<div class="print-badge"><img src="' + qrDataUrl(linkReg(e), 500) + '">' +
        '<div class="nm">' + esc(e.name) + '</div><div class="cd">' + esc(e.code) + "</div>" +
        '<div class="tt">Личный код. Отсканируйте камерой своего телефона один раз' +
        '<span class="kz">Жеке код. Өз телефоныңыздың камерасымен бір рет сканерлеңіз</span></div></div>';
    }).join("") + "</div>");
  },
  "download-all": function () {
    var free = S.employees.filter(function (e) { return !e.bound && e.status !== "заблокирован"; });
    if (!free.length) return toast("Все телефоны уже привязаны");
    free.forEach(function (e, i) {
      setTimeout(function () { downloadDataUrl(qrDataUrl(linkReg(e), 800), "qr-" + e.code + ".png"); }, i * 350);
    });
    toast("Скачиваем файлов: " + free.length);
  },
  "take-coords": function () {
    if (!navigator.geolocation) return toast("Браузер не поддерживает геолокацию");
    toast("Определяем координаты…");
    navigator.geolocation.getCurrentPosition(function (p) {
      $("#setLat").value = p.coords.latitude.toFixed(6);
      $("#setLng").value = p.coords.longitude.toFixed(6);
      toast("Координаты взяты, точность " + Math.round(p.coords.accuracy) + " м. Нажмите «Сохранить».");
    }, function () { toast("Не удалось определить координаты"); }, { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 });
  },
  "save-settings": async function () {
    var lat = $("#setLat").value.trim().replace(",", "."), lng = $("#setLng").value.trim().replace(",", ".");
    if ((lat || lng) && (isNaN(Number(lat)) || isNaN(Number(lng)) || !lat || !lng)) return toast("Проверьте широту и долготу");
    try {
      var r = await admin({
        action: "saveSettings", lat: lat, lng: lng,
        radius: $("#setRadius").value || 100,
        workStart: $("#setStart").value, workEnd: $("#setEnd").value,
        lunchMinutes: $("#setLunch").value || 0, lateTolerance: $("#setLate").value || 0,
        workDays: workDaysValue(),
        tgOutZone: $("#tgOutZone").checked ? "1" : "0", tgAbsent: $("#tgAbsent").checked ? "1" : "0", tgDaily: $("#tgDaily").checked ? "1" : "0"
      });
      S.settings = r.settings; renderSettings();
      toast("Настройки сохранены");
    } catch (e) { toast(e.message); }
  },
  "change-pw": async function () {
    var np = $("#newPw").value;
    if (np.length < 6) return toast(errText("weak_password"));
    try {
      await admin({ action: "changePassword", newpw: np });
      AUTH.pw = np; lsSet(AUTH_KEY, AUTH);
      $("#newPw").value = "";
      toast("Пароль изменён. На других устройствах войдите заново.");
    } catch (e) { toast(e.message); }
  },
  "copy-gs": async function () {
    try { await copyText(await getGsCode()); toast("Код сервера скопирован"); }
    catch (e) { toast("Не удалось скопировать — выделите код вручную"); }
  }
};

document.addEventListener("click", function (ev) {
  var el = ev.target.closest ? ev.target.closest("[data-action]") : null;
  if (!el) return;
  var name = el.dataset.action;
  if (name === "nav") { closeModal(); show(el.dataset.view); return; }
  var fn = actions[name];
  if (fn) { ev.preventDefault(); fn(el, ev); }
});
document.addEventListener("change", function (ev) {
  var t = ev.target;
  if (t.id === "repFrom" && t.value) { rep.from = parseDay(t.value); if (rep.to < rep.from) rep.to = rep.from; renderReport(); showReport(false); }
  if (t.id === "repTo" && t.value) { rep.to = parseDay(t.value); if (rep.to < rep.from) rep.from = rep.to; renderReport(); showReport(false); }
  if (t.id === "repEmp") { rep.emp = t.value; renderReport(); }
});
document.addEventListener("keydown", function (ev) {
  if (ev.key !== "Enter" || !ev.target) return;
  var id = ev.target.id;
  if (id === "loginPw" || id === "loginPw2" || id === "loginUrl") doLogin();
  if (id === "newEmpName") actions["add-emp"]();
  if (id === "renameField") { var b = $('[data-action="rename-save"]'); if (b) b.click(); }
});
document.addEventListener("visibilitychange", function () {
  if (!document.hidden && AUTH && current === "board") refreshBoard(true);
});

function brokenText(p) {
  return { "no-in": "нет входа", "no-out": "нет выхода", "auto": "нет выхода (закрыто автоматически)", "open": "на смене" }[p.broken] || "";
}

/* ================= табель Excel ================= */
var MONTHS = ["Январь", "Февраль", "Март", "Апрель", "Май", "Июнь", "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"];
async function exportXlsx() {
  if (!window.XLSX) throw new Error("Модуль Excel не загрузился — обновите страницу");
  var base = rep.from || new Date();
  var y = base.getFullYear(), m = base.getMonth();
  var first = new Date(y, m, 1), last = new Date(y, m + 1, 0, 23, 59, 59, 999);
  var nDays = last.getDate();
  toast("Готовим табель за " + MONTHS[m].toLowerCase() + "…");
  var recs = (await admin({ action: "read", from: first.toISOString(), to: last.toISOString() })).rows || [];
  var pairs = pairsFor(recs);
  var workDays = String(S.settings.workDays || "12345");
  var isOff = function (d) { var wd = new Date(y, m, d).getDay(); return workDays.indexOf(String(wd === 0 ? 7 : wd)) < 0; };
  var WD = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];

  var codes = S.employees.map(function (e) { return e.code; });
  pairs.forEach(function (p) { if (codes.indexOf(p.code) < 0) codes.push(p.code); });
  var nameOf = function (code) { var e = findEmp(code); if (e) return e.name; var p = pairs.filter(function (x) { return x.code === code; })[0]; return p ? p.name : code; };

  var head = ["№", "Сотрудник", "Код"];
  var headStyled = head.map(function (h) { return { v: h, s: 1 }; });
  for (var d = 1; d <= nDays; d++) headStyled.push({ v: d + "\n" + WD[new Date(y, m, d).getDay()], s: isOff(d) ? 3 : 1 });
  ["Дней", "Часов", "Опозданий", "Без пары"].forEach(function (h) { headStyled.push({ v: h, s: 1 }); });

  var rows = [
    [{ v: "Табель учёта рабочего времени — " + MONTHS[m] + " " + y, s: 5 }],
    [{ v: "Рабочее время " + S.settings.workStart + "–" + S.settings.workEnd + ", обед " + (S.settings.lunchMinutes || 0) +
      " мин (вычитается из смен длиннее 6 ч), опоздание — позже " + S.settings.workStart + " + " + (S.settings.lateTolerance || 0) + " мин. Сформировано " +
      dmy(new Date()) + " " + hhmm(new Date()), s: 7 }],
    [],
    headStyled
  ];
  var dayTotals = new Array(nDays + 1).fill(0), grand = 0;
  codes.forEach(function (code, idx) {
    var own = pairs.filter(function (p) { return p.code === code; });
    var hours = {}, broken = {}, daysSet = {}, late = 0, bad = 0, total = 0;
    own.forEach(function (p) {
      var dd = new Date((p.in || p.out).ts).getDate();
      if (p.in && p.out && !p.broken) { var h = hoursOf(p); hours[dd] = (hours[dd] || 0) + h; total += h; }
      if (p.in) daysSet[dd] = 1;
      if (p.broken === "no-in" || p.broken === "no-out" || p.broken === "auto") { broken[dd] = 1; bad++; }
      if (isLate(p)) late++;
    });
    var row = [{ v: idx + 1, s: 0 }, { v: nameOf(code), s: 9 }, { v: code, s: 0 }];
    for (var d2 = 1; d2 <= nDays; d2++) {
      var hv = hours[d2] ? Math.round(hours[d2] * 10) / 10 : null;
      if (hv) dayTotals[d2] += hv;
      if (broken[d2] && !hv) row.push({ v: "?", s: 8 });
      else row.push({ v: hv, s: isOff(d2) ? 4 : 2 });
    }
    grand += total;
    row.push({ v: Object.keys(daysSet).length, s: 0 }, { v: Math.round(total * 10) / 10, s: 6 }, { v: late, s: 0 }, { v: bad, s: bad ? 8 : 0 });
    rows.push(row);
  });
  var tot = [{ v: "", s: 9 }, { v: "Итого", s: 9 }, { v: "", s: 9 }];
  for (var d3 = 1; d3 <= nDays; d3++) tot.push({ v: dayTotals[d3] ? Math.round(dayTotals[d3] * 10) / 10 : null, s: 6 });
  tot.push({ v: "", s: 9 }, { v: Math.round(grand * 10) / 10, s: 6 });
  rows.push(tot, [], [{ v: "Числа — отработанные часы. «?» — нет входа или выхода, нужна проверка. Закрашены выходные дни.", s: 7 }]);
  var cols = [5, 28, 10];
  for (var d4 = 1; d4 <= nDays; d4++) cols.push(5.5);
  cols.push(7, 8, 11, 9);

  var shiftRows = [["Дата", "Сотрудник", "Код", "Вход", "Зона входа", "Выход", "Зона выхода", "Часы", "Опоздание", "Замечание", "Примечание"]
    .map(function (h) { return { v: h, s: 1 }; })];
  pairs.slice().sort(function (a, b) { return a.day === b.day ? nameOf(a.code).localeCompare(nameOf(b.code), "ru") : a.day < b.day ? -1 : 1; })
    .forEach(function (p) {
      var notes = [p.in && p.in.note, p.out && p.out.note].filter(Boolean).join("; ");
      shiftRows.push([dmy((p.in || p.out).ts), nameOf(p.code), p.code,
        p.in ? hhmm(p.in.ts) : "", p.in ? p.in.zone : "",
        p.out && p.broken !== "auto" ? hhmm(p.out.ts) : "", p.out && p.broken !== "auto" ? p.out.zone : "",
        { v: p.in && p.out && !p.broken ? Math.round(hoursOf(p) * 100) / 100 : null, s: 2 },
        isLate(p) ? "да" : "", { v: brokenText(p), s: p.broken && p.broken !== "open" ? 8 : 0 }, notes]);
    });

  var blob = XLSX.build([
    { name: "Табель", rows: rows, cols: cols, freeze: { row: 4, col: 2 } },
    { name: "Смены", rows: shiftRows, cols: [11, 28, 10, 8, 14, 8, 14, 7, 11, 30, 50], freeze: { row: 1, col: 0 } }
  ]);
  var url = URL.createObjectURL(blob);
  var a = document.createElement("a");
  a.href = url; a.download = "tabel-" + y + "-" + pad(m + 1) + ".xlsx";
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(function () { URL.revokeObjectURL(url); }, 3000);
  toast("Табель за " + MONTHS[m].toLowerCase() + " скачан");
  return blob;
}

/* ================= правка отметок ================= */
function nowLocalDate() { return dayKey(new Date()); }
function punchForm(code, day) {
  var opts = S.employees.map(function (e) {
    return '<option value="' + esc(e.code) + '"' + (e.code === code ? " selected" : "") + ">" + esc(e.name) + "</option>";
  }).join("");
  return '<div class="card tight" style="margin-top:12px;box-shadow:none"><h3>Добавить отметку</h3>' +
    (code ? '<input type="hidden" id="pfEmp" value="' + esc(code) + '">' :
      '<label class="field" style="margin-top:8px">Сотрудник<select class="input" id="pfEmp">' + opts + "</select></label>") +
    '<div class="grid3" style="margin-top:8px">' +
      '<label class="field">Тип<select class="input" id="pfType"><option value="in">Вход</option><option value="out">Выход</option></select></label>' +
      '<label class="field">Дата<input class="input" type="date" id="pfDate" value="' + esc(day || nowLocalDate()) + '" max="' + nowLocalDate() + '"></label>' +
      '<label class="field">Время<input class="input" type="time" id="pfTime" value="' + esc(S.settings.workEnd || "18:00") + '"></label>' +
    "</div>" +
    '<label class="field" style="margin-top:8px">Причина<input class="input" id="pfNote" maxlength="200" placeholder="Например: забыл отметить выход"></label>' +
    '<button class="btn primary block" style="margin-top:10px" data-action="punch-save">Добавить</button></div>';
}
function dayPunches(code, day) {
  return S.records.filter(function (r) { return r.code === code && dayKey(r.ts) === day; })
    .sort(function (a, b) { return a.ts < b.ts ? -1 : 1; });
}
function openDayEditor(code, day) {
  var e = findEmp(code) || { name: code };
  var list = dayPunches(code, day);
  var rows = list.length ? list.map(function (r) {
    var src = r.source === "авто" ? '<span class="badge amber">закрыто автоматически</span>'
      : r.source === "администратор" ? '<span class="badge blue">вручную</span>' : zoneBadge(r);
    return '<div class="row between" style="padding:8px 0;border-bottom:1px solid #f1f5f9">' +
      '<div><b>' + (r.type === "in" ? "Вход" : "Выход") + " " + hhmm(r.ts) + "</b> " + src +
      (r.note ? '<div class="muted small">' + esc(r.note) + "</div>" : "") + "</div>" +
      '<button class="btn sm danger" data-action="punch-void" data-row="' + r.row + '" data-ts="' + esc(r.ts) + '" data-code="' + esc(r.code) + '">Аннулировать</button></div>';
  }).join("") : '<div class="muted small" style="padding:8px 0">Отметок за этот день нет.</div>';
  openModal(sheetHead(e.name, "Отметки за " + dmy(parseDay(day))) +
    '<div style="margin-top:8px">' + rows + "</div>" +
    '<div class="muted small" style="margin-top:8px">Аннулированная отметка остаётся в таблице с пометкой, но не учитывается в табеле.</div>' +
    punchForm(code, day));
}
Object.assign(actions, {
  "tg-save": async function () {
    var tok = $("#tgToken").value.trim();
    if (!tok) return toast("Вставьте токен от @BotFather");
    try {
      var r = await admin({ action: "saveSettings", tgToken: tok });
      S.settings = r.settings; $("#tgToken").value = ""; renderSettings();
      toast("Токен сохранён. Напишите боту «Старт» и нажмите «Подключить чат».");
    } catch (e) { toast(e.message); }
  },
  "tg-link": async function () {
    toast("Ищем ваш чат…");
    try {
      var r = await admin({ action: "tgLink" });
      await loadSettings(); renderSettings();
      toast("Подключено: " + r.chat + ". Бот прислал подтверждение.");
    } catch (e) { toast(e.message); if (e.code === "needs_authorization") { S.settings.automation = null; renderSettings(); } }
  },
  "tg-test": async function () {
    try { await admin({ action: "tgTest" }); toast("Сообщение отправлено — проверьте Telegram"); }
    catch (e) { toast(/not_linked/.test(e.message) ? "Сначала подключите чат" : e.message); }
  },
  "auto-install": async function () {
    toast("Включаем…");
    try { var r = await admin({ action: "installAutomation" }); S.settings = r.settings; renderSettings(); toast("Автоматика включена"); }
    catch (e) { S.settings.automation = null; renderSettings(); toast(e.message); }
  },
  "backup-now": async function () {
    toast("Делаем копию таблицы…");
    try { var r = await admin({ action: "backupNow" }); await loadSettings(); renderSettings(); toast("Копия сохранена: " + r.name); }
    catch (e) { if (e.code === "needs_authorization") { S.settings.automation = null; renderSettings(); } toast(e.message); }
  },
  "xlsx": async function () { try { await exportXlsx(); } catch (e) { toast(e.message); } },
  "edit-day": function (el) { openDayEditor(el.dataset.code, el.dataset.day); },
  "punch-add": function () {
    if (!S.employees.length) return toast("Сначала добавьте сотрудников");
    openModal(sheetHead("Добавить отметку", "Если сотрудник забыл отметиться или сел телефон") + punchForm("", ""));
  },
  "punch-save": async function () {
    var code = $("#pfEmp").value, date = $("#pfDate").value, time = $("#pfTime").value;
    if (!code || !date || !time) return toast("Заполните сотрудника, дату и время");
    var p = date.split("-"), t = time.split(":");
    var ts = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]), Number(t[0]), Number(t[1]));
    if (ts.getTime() > Date.now() + 5 * 60000) return toast(errText("future_time"));
    try {
      await admin({ action: "addPunch", code: code, type: $("#pfType").value, ts: ts.toISOString(), note: $("#pfNote").value.trim() });
      toast("Отметка добавлена");
      await loadRecords(true);
      if (current === "report") renderReport();
      openDayEditor(code, dayKey(ts));
    } catch (e) { toast(e.message); }
  },
  "punch-void": function (el) {
    var code = el.dataset.code, row = el.dataset.row, ts = el.dataset.ts;
    ask("Аннулировать отметку?", "Отметка " + esc(hhmm(ts)) + " перестанет учитываться в табеле. В таблице она останется с пометкой «аннулировано».",
      "Аннулировать", async function () {
        try {
          await admin({ action: "voidPunch", code: code, row: row, ts: ts });
          toast("Отметка аннулирована");
          await loadRecords(true);
          if (current === "report") renderReport();
          openDayEditor(code, dayKey(ts));
        } catch (e) { toast(e.message); if (e.code === "row_changed") { await loadRecords(true); renderReport(); } }
      }, true);
  }
});

/* ================= старт ================= */
buildNav();
(function () { var r0 = rangeFor("month"); rep.from = r0.from; rep.to = r0.to; })();
getGsCode().then(function (t) { $("#gsPre").textContent = t; }).catch(function () { $("#gsPre").textContent = "Код лежит в файле apps-script.gs в репозитории."; });
/* старые данные версии 3 больше не используются */
["ttrack_employees", "ttrack_records", "ttrack_settings", "ttrack_me", "ttrack_device_id", "ttrack_server", "tt_board"].forEach(lsDel);
$("#loginUrl").value = (AUTH && AUTH.server) || DEFAULT_SERVER;
if (AUTH && validServer(AUTH.server)) enter();
else show("login");
