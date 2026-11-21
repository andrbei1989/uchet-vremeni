"use strict";
/* продолжение: отрисовка, действия, события */
function renderScanner() {
  var meBox = $("#meCard");
  if (S.me) {
    var emp = findEmp(S.me.empCode);
    meBox.innerHTML =
      '<div class="me"><div class="avatar">' + esc(initials((emp && emp.name) || S.me.empName)) + "</div>" +
      '<div class="stack" style="gap:1px;flex:1"><div style="font-weight:650">' + esc((emp && emp.name) || S.me.empName || S.me.empCode) + "</div>" +
      '<div class="muted small mono">' + esc(S.me.empCode) + " · PIN " + esc(fmtPin(S.me.pin)) + "</div></div>" +
      '<button class="btn sm ghost" data-action="unbind">Сменить</button></div>' +
      (S.me.verified ? '<div class="badge green" style="margin-top:8px">Привязан к этому телефону · подтверждён таблицей</div>'
        : '<div class="badge" style="margin-top:8px">Локальная привязка</div>');
  } else {
    meBox.innerHTML = '<div class="me"><div class="avatar" style="background:#f1f5f9;color:#64748b">?</div>' +
      '<div class="stack" style="gap:1px;flex:1"><div style="font-weight:650">Телефон не привязан</div>' +
      '<div class="muted small">Отсканируйте свой регистрационный QR</div></div></div>';
  }
  var rec = S.rec.slice().sort(function (a, b) { return new Date(b.ts) - new Date(a.ts); }).slice(0, 5);
  var list = $("#recentList");
  if (!rec.length) {
    list.innerHTML = '<div class="empty">Пока нет отметок. Отсканируйте постер «ВХОД».</div>';
  } else {
    list.innerHTML = rec.map(function (r) {
      var isIn = r.type === "in";
      return '<div class="row between" style="padding:8px 0;border-bottom:1px solid #f1f5f9">' +
        '<div class="row" style="gap:9px"><span class="badge ' + (isIn ? "green" : "blue") + '">' + (isIn ? "вход" : "выход") + "</span>" +
        '<div class="stack" style="gap:0"><div style="font-weight:600;font-size:13.5px">' + esc(r.empName) + "</div>" +
        '<div class="muted" style="font-size:11.5px">' + dmy(r.ts) + " · " + hhmm(r.ts) +
        (r.noGeo ? " · без гео" : r.inZone ? " · в зоне" : " · вне зоны") + "</div></div></div>" +
        '<span class="badge ' + (r.synced ? "green" : "") + '">' + (r.synced ? "✓" : "…") + "</span></div>";
    }).join("");
  }
  if (cam.running) setCamBtn(true);
}

var repRange = { from: null, to: null, emp: "" };
function startOfWeek(d) {
  d = new Date(d);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}
function rangeFor(mode) {
  var now = new Date(), from, to;
  to = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);
  if (mode === "day") from = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  else if (mode === "week") from = startOfWeek(now);
  else from = new Date(now.getFullYear(), now.getMonth(), 1);
  return { from: from, to: to };
}
function pairsFor(list) {
  var byEmpDay = {}, i, r, key;
  list = list.slice().sort(function (a, b) { return new Date(a.ts) - new Date(b.ts); });
  for (i = 0; i < list.length; i++) {
    r = list[i];
    key = r.empCode + "|" + dayKey(r.ts);
    if (!byEmpDay[key]) byEmpDay[key] = [];
    byEmpDay[key].push(r);
  }
  var out = [];
  Object.keys(byEmpDay).forEach(function (k) {
    var seq = byEmpDay[k], open = null;
    seq.forEach(function (r2) {
      if (r2.type === "in") {
        if (open) out.push({ empCode: r2.empCode, empName: r2.empName, day: dayKey(r2.ts), in: open, out: null, broken: "no-out" });
        open = r2;
      } else if (r2.type === "out") {
        if (open) { out.push({ empCode: r2.empCode, empName: r2.empName, day: dayKey(r2.ts), in: open, out: r2 }); open = null; }
        else out.push({ empCode: r2.empCode, empName: r2.empName, day: dayKey(r2.ts), in: null, out: r2, broken: "no-in" });
      }
    });
    if (open) out.push({ empCode: open.empCode, empName: open.empName, day: dayKey(open.ts), in: open, out: null, broken: "no-out" });
  });
  return out;
}
function hoursOf(p) {
  if (!p.in || !p.out) return 0;
  var ms = new Date(p.out.ts) - new Date(p.in.ts);
  if (ms <= 0) return 0;
  var h = ms / 3600000;
  var lunch = Number(S.set.lunchMinutes) || 0;
  if (h > 6 && lunch > 0) h -= lunch / 60;
  return h > 0 ? h : 0;
}
function isLate(p) {
  if (!p.in) return false;
  var d = new Date(p.in.ts);
  var st = String(S.set.workStart || "09:00").split(":");
  var limit = new Date(d.getFullYear(), d.getMonth(), d.getDate(), Number(st[0]) || 0, Number(st[1]) || 0);
  limit = new Date(limit.getTime() + (Number(S.set.lateTolerance) || 0) * 60000);
  return d > limit;
}
function fmtHours(h) { return (Math.round(h * 10) / 10).toFixed(1); }
function filteredRecords() {
  var from = repRange.from ? new Date(repRange.from) : rangeFor("month").from;
  var to = repRange.to ? new Date(new Date(repRange.to).setHours(23, 59, 59)) : rangeFor("month").to;
  return S.rec.filter(function (r) {
    var t = new Date(r.ts);
    if (t < from || t > to) return false;
    if (repRange.emp && r.empCode !== repRange.emp) return false;
    return true;
  });
}

function renderReport() {
  var fromEl = $("#repFrom"), toEl = $("#repTo"), empEl = $("#repEmp");
  if (!repRange.from) { var r0 = rangeFor("month"); repRange.from = r0.from; repRange.to = r0.to; }
  if (fromEl && !fromEl.value) fromEl.value = dayKey(repRange.from);
  if (toEl && !toEl.value) toEl.value = dayKey(repRange.to);
  if (empEl && empEl.options.length <= 1) {
    empEl.innerHTML = '<option value="">Все сотрудники</option>' +
      S.emp.map(function (e) { return '<option value="' + esc(e.empCode) + '">' + esc(e.name) + "</option>"; }).join("");
    empEl.value = repRange.emp;
  }
  var recs = filteredRecords();
  var pairs = pairsFor(recs);
  var totalH = 0, lateCount = 0, shifts = 0, todayOn = 0;
  var today = dayKey(new Date());
  recs.forEach(function (r) { if (dayKey(r.ts) === today && r.type === "in") todayOn++; });
  var byEmp = {};
  pairs.forEach(function (p) {
    if (!byEmp[p.empCode]) byEmp[p.empCode] = { empCode: p.empCode, empName: p.empName, hours: 0, days: {}, shifts: 0, late: 0, broken: 0 };
    var a = byEmp[p.empCode];
    a.hours += hoursOf(p);
    if (p.in) a.days[p.day] = true;
    if (p.in && p.out) { a.shifts++; totalH += hoursOf(p); shifts++; }
    if (isLate(p)) { a.late++; lateCount++; }
    if (p.broken) a.broken++;
  });
  $("#repKpi").innerHTML =
    '<div class="box"><div class="v">' + fmtHours(totalH) + '</div><div class="l">часов</div></div>' +
    '<div class="box"><div class="v">' + shifts + '</div><div class="l">смен</div></div>' +
    '<div class="box"><div class="v">' + lateCount + '</div><div class="l">опозданий</div></div>' +
    '<div class="box"><div class="v">' + todayOn + '</div><div class="l">сейчас на смене</div></div>';
  var rows = Object.keys(byEmp).map(function (k) { return byEmp[k]; });
  rows.sort(function (a, b) { return b.hours - a.hours; });
  var host = $("#repList");
  if (!rows.length) { host.innerHTML = '<div class="empty">За выбранный период отметок нет.</div>'; return; }
  host.innerHTML = rows.map(function (a) {
    var days = Object.keys(a.days).length;
    var own = pairs.filter(function (p) { return p.empCode === a.empCode; }).sort(function (x, y) { return y.day.localeCompare(x.day); });
    var detail = own.map(function (p) {
      var late = isLate(p);
      var coords = p.in && p.in.lat !== null && p.in.lat !== undefined
        ? '<a href="https://maps.google.com/?q=' + p.in.lat + "," + p.in.lng + '" target="_blank" rel="noopener" class="mono" style="font-size:11px">' + p.in.lat + ", " + p.in.lng + "</a>"
        : '<span class="muted small">без гео</span>';
      return "<tr><td>" + esc(p.day.split("-").reverse().join(".")) + "</td>" +
        "<td>" + (p.in ? hhmm(p.in.ts) : '<span style="color:#dc2626">—</span>') + "</td>" +
        "<td>" + (p.out ? hhmm(p.out.ts) : '<span style="color:#dc2626">не закрыта</span>') + "</td>" +
        '<td class="num">' + (p.broken ? "—" : fmtHours(hoursOf(p))) + "</td>" +
        "<td>" + (late ? '<span class="badge amber">опозд.</span>' : '<span class="muted">—</span>') + "</td>" +
        "<td>" + coords + "</td>" +
        "<td>" + esc((p.in && p.in.source === "manual") ? "ручн." : "QR") + "</td></tr>";
    }).join("");
    return '<details class="emp"><summary>' +
      '<div class="avatar" style="width:34px;height:34px;font-size:12px">' + esc(initials(a.empName)) + "</div>" +
      '<div style="flex:1"><div style="font-weight:650;font-size:13.5px">' + esc(a.empName) + "</div>" +
      '<div class="muted" style="font-size:11.5px">дней: ' + days + " · смен: " + a.shifts +
      (a.late ? " · опозданий: " + a.late : "") +
      (a.broken ? ' · <span style="color:#dc2626">разрывов: ' + a.broken + "</span>" : "") + "</div></div>" +
      '<div style="font-weight:700">' + fmtHours(a.hours) + " ч</div></summary>" +
      '<table class="tbl" style="margin-top:8px"><thead><tr><th>Дата</th><th>Вход</th><th>Выход</th><th class="num">Часы</th><th></th><th>Координаты</th><th></th></tr></thead><tbody>' + detail + "</tbody></table></details>";
  }).join("");
}

function serverRow(code) {
  var rows = (S.srv && S.srv.rows) || [];
  for (var i = 0; i < rows.length; i++) if (rows[i].empCode === code) return rows[i];
  return null;
}

function renderCodes() {
  $("#posterBox").innerHTML =
    '<div class="poster"><div class="qrbox" style="width:100%">' + qrImg(payloadIn(), 360) + "</div>" +
    '<div class="word in">ВХОД</div><div class="muted small">приложите к экрану телефона</div></div>' +
    '<div class="poster"><div class="qrbox" style="width:100%">' + qrImg(payloadOut(), 360) + "</div>" +
    '<div class="word out">ВЫХОД</div><div class="muted small">после окончания смены</div></div>';
  $("#regCount").textContent = S.emp.length;
  $("#regGrid").innerHTML = S.emp.map(function (e) {
    var srv = serverRow(e.empCode);
    var used = (srv && srv.deviceId) || e.boundAt;
    var badge = used ? '<span class="badge red">использован</span>' : '<span class="badge green">свободен</span>';
    var when = (srv && srv.boundAt) || (e.boundAt ? dmy(e.boundAt) + " " + hhmm(e.boundAt) : "");
    return '<div class="qr-item">' + qrImg(payloadReg(e), 140) +
      '<div style="flex:1;min-width:0"><div class="nm">' + esc(e.name) + '</div><div class="cd">' + esc(e.empCode) + "</div>" +
      '<div style="margin-top:4px">' + badge + "</div>" +
      (when ? '<div class="cd">' + esc(when) + "</div>" : "") +
      '<div class="row" style="margin-top:5px;gap:4px">' +
      '<button class="btn sm ghost" data-action="show-qr" data-code="' + esc(e.empCode) + '">QR</button>' +
      '<button class="btn sm ghost" data-action="regen-one" data-code="' + esc(e.empCode) + '">↻</button>' +
      "</div></div></div>";
  }).join("");
}

var pinsVisible = false;
function renderEmployees() {
  $("#empList").innerHTML = S.emp.map(function (e) {
    var pin = pinFor(e);
    var srv = serverRow(e.empCode);
    var bound = (srv && srv.deviceId) ? "сервер" : (e.boundAt ? "локально" : "");
    var status = srv
      ? (srv.status === "заблокирован" ? '<span class="badge red">заблокирован</span>' : '<span class="badge green">активен</span>')
      : (e.boundAt ? '<span class="badge blue">привязан</span>' : '<span class="badge">не зарегистрирован</span>');
    return '<div class="card tight" style="margin-bottom:8px">' +
      '<div class="row" style="gap:9px">' +
      '<div class="avatar" style="width:34px;height:34px;font-size:12px">' + esc(initials(e.name)) + "</div>" +
      '<div style="flex:1;min-width:0"><input class="input" style="min-height:36px;padding:6px 9px;font-size:13.5px;font-weight:600" data-emp-name="' + esc(e.empCode) + '" value="' + esc(e.name) + '">' +
      '<div class="row" style="margin-top:5px;gap:5px;flex-wrap:wrap">' +
      '<span class="badge mono">' + esc(e.empCode) + "</span>" +
      '<span class="badge mono">' + (pinsVisible ? esc(pin) : esc(fmtPin(pin))) + "</span>" +
      status + (bound ? '<span class="badge">' + esc(bound) + "</span>" : "") +
      "</div></div>" +
      '<input type="checkbox" style="width:20px;height:20px;accent-color:var(--accent)" data-emp-active="' + esc(e.empCode) + '"' + (e.active === false ? "" : " checked") + ">" +
      "</div>" +
      '<div class="row" style="margin-top:8px;gap:5px;flex-wrap:wrap">' +
      '<button class="btn sm ghost" data-action="show-qr" data-code="' + esc(e.empCode) + '">QR</button>' +
      '<button class="btn sm ghost" data-action="regen-one" data-code="' + esc(e.empCode) + '">Перевыпустить</button>' +
      (srv ? '<button class="btn sm danger" data-action="revoke" data-code="' + esc(e.empCode) + '">Отозвать</button>' +
             '<button class="btn sm ghost" data-action="unblock" data-code="' + esc(e.empCode) + '">Разрешить</button>' : "") +
      "</div></div>";
  }).join("");

  var rows = (S.srv && S.srv.rows) || [];
  var host = $("#serverList");
  if (!rows.length) {
    host.innerHTML = '<div class="empty">Нет данных. Заполните URL в настройках и нажмите «Загрузить».</div>';
    return;
  }
  host.innerHTML = '<div style="overflow-x:auto"><table class="tbl"><thead><tr><th>Код</th><th>ФИО</th><th>PIN</th><th>Устройство</th><th>Дата</th><th>Статус</th><th></th></tr></thead><tbody>' +
    rows.map(function (r) {
      var blocked = r.status === "заблокирован";
      return '<tr><td class="mono" style="font-size:11.5px">' + esc(r.empCode) + "</td><td>" + esc(r.empName) + "</td>" +
        '<td class="mono">' + esc(r.pin) + "</td><td>" + esc(r.deviceLabel) + "</td><td>" + esc(r.boundAt) + "</td>" +
        "<td>" + (blocked ? '<span class="badge red">блок</span>' : '<span class="badge green">активен</span>') + "</td>" +
        '<td><button class="btn sm ghost" data-action="' + (blocked ? "unblock" : "revoke") + '" data-code="' + esc(r.empCode) + '">' +
        (blocked ? "Разрешить" : "Отозвать") + "</button></td></tr>";
    }).join("") + "</tbody></table></div>";
}

function renderSettings() {
  document.querySelectorAll("[data-set]").forEach(function (el) {
    var key = el.dataset.set;
    if (el.type === "checkbox") el.checked = !!S.set[key];
    else el.value = S.set[key] === undefined || S.set[key] === null ? "" : S.set[key];
  });
  var badge = $("#pingBadge");
  if (!S.set.sheetUrl) { badge.className = "badge"; badge.textContent = "не настроено"; }
  else if (S.srv.lastPing) { badge.className = "badge green"; badge.textContent = "подключено"; }
  else { badge.className = "badge amber"; badge.textContent = "не проверено"; }
  var q = unsyncedCount();
  $("#queueBtn").textContent = q ? "Очередь: " + q : "Очередь пуста";
  var pre = $("#gsPre");
  if (pre) pre.textContent = ($("#gsSrc").textContent || "").trim();
}
function unsyncedCount() { return S.rec.filter(function (r) { return !r.synced; }).length; }

var NAV = [
  { k: "scanner", t: "Сканер", d: "M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2M3 12h18" },
  { k: "report", t: "Табель", d: "M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z" },
  { k: "codes", t: "QR-коды", d: "M3 3h6v6H3zM15 3h6v6h-6zM3 15h6v6H3zM15 15h2v2h-2zM19 15h2v2h-2zM15 19h2v2h-2zM19 19h2v2h-2z" },
  { k: "employees", t: "Люди", d: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 7a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM22 21v-2a4 4 0 0 0-3-3.9" },
  { k: "settings", t: "Настройки", d: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM4 12a8 8 0 0 1 .2-1.8l-1.4-1.1 2-3.4 1.7.7A8 8 0 0 1 9 5.2L9.3 3.4h5.4L15 5.2c.6.3 1.2.7 1.7 1.2l1.7-.7 2 3.4-1.4 1.1A8 8 0 0 1 20 12a8 8 0 0 1-.2 1.8l1.4 1.1-2 3.4-1.7-.7c-.5.5-1.1.9-1.7 1.2l-.3 1.8H9.3L9 18.8a8 8 0 0 1-1.7-1.2l-1.7.7-2-3.4 1.4-1.1A8 8 0 0 1 4 12z" }
];
var current = "scanner";

function buildNav() {
  $("#nav").innerHTML = NAV.map(function (n) {
    return '<button data-action="nav" data-view="' + n.k + '" id="nav-' + n.k + '"><svg viewBox="0 0 24 24"><path d="' + n.d + '"/></svg><span>' + n.t + "</span></button>";
  }).join("");
}
function show(view) {
  current = view;
  if (view !== "scanner" && cam.running) camStop();
  NAV.forEach(function (n) {
    var sec = $("#v-" + n.k);
    if (sec) sec.classList.toggle("active", n.k === view);
    var b = $("#nav-" + n.k);
    if (b) b.classList.toggle("on", n.k === view);
  });
  var titles = { scanner: "Сканер", report: "Табель", codes: "QR-коды", employees: "Сотрудники", settings: "Настройки" };
  $("#topTitle").textContent = titles[view] || "";
  $("#topSub").textContent = view === "scanner" ? "Приложите QR к камере" : "Учёт рабочего времени";
  if (view === "report") renderReport();
  if (view === "codes") renderCodes();
  if (view === "employees") renderEmployees();
  if (view === "settings") renderSettings();
  if (view === "scanner") renderScanner();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

var actions = {
  "cam-toggle": function () { camStart(); },
  "close": function () { closeModal(); },
  "manual-submit": function () { manualPunch(); },
  "go-report": function () { show("report"); },
  "period": function (el) {
    var r = rangeFor(el.dataset.period);
    repRange.from = r.from; repRange.to = r.to;
    $("#repFrom").value = dayKey(r.from); $("#repTo").value = dayKey(r.to);
    renderReport();
  },
  "punch-confirm": function () { commitPunch(); },
  "gps-retry": function (el) {
    var emp = findEmp(el.dataset.code);
    closeModal();
    if (emp) proceedPunch(emp, el.dataset.type, el.dataset.verified === "1");
  },
  "no-geo": function (el) {
    var emp = findEmp(el.dataset.code);
    if (emp) proceedPunchNoGeo(emp, el.dataset.type, el.dataset.verified === "1");
  },
  "punch-retry": function (el) { closeModal(); startPunch(el.dataset.type); },
  "punch-offline": function (el) { closeModal(); startPunchOffline(el.dataset.type); },
  "reg-retry": function (el) { closeModal(); startRegistration(el.dataset.code, el.dataset.token); },
  "bind-local": function (el) {
    var emp = findEmp(el.dataset.code);
    if (emp) bindDevice(emp, pinFor(emp), false);
  },
  "bind-yes": function () {
    if (!pendingReg) return;
    var p = pendingReg; pendingReg = null;
    closeModal();
    startRegistration(p.code, p.token);
  },
  "copy-pin": function (el) {
    var pin = el.dataset.pin || "";
    navigator.clipboard.writeText(pin).then(function () { toast("PIN скопирован"); }, function () { toast(pin); });
  },
  "unbind": function () { S.me = null; saveMe(); renderScanner(); toast("Привязка удалена с этого телефона"); },
  "show-qr": function (el) {
    var e = findEmp(el.dataset.code);
    if (!e) return;
    var srv = serverRow(e.empCode);
    var used = (srv && srv.deviceId) || e.boundAt;
    openModal(sheetHead(e.name, e.empCode + " · регистрационный код") +
      '<div class="qrbox" style="margin-top:12px">' + qrImg(payloadReg(e), 420) + "</div>" +
      (used ? '<div class="warn" style="margin-top:10px">Код уже использован' + (srv && srv.boundAt ? " · " + esc(srv.boundAt) : "") + ". Для нового телефона перевыпустите код.</div>" : "") +
      '<div class="col" style="margin-top:12px"><button class="btn" data-action="dl-qr" data-code="' + esc(e.empCode) + '">Скачать PNG</button>' +
      '<button class="btn ghost" data-action="close">Закрыть</button></div>');
  },
  "dl-qr": function (el) {
    var e = findEmp(el.dataset.code);
    if (e) downloadDataUrl(qrDataUrl(payloadReg(e), 800), "qr-" + e.empCode + ".png");
  },
  "regen-one": function (el) {
    var e = findEmp(el.dataset.code);
    if (!e) return;
    if (!confirm("Перевыпустить код для " + e.name + "? Старый QR и PIN перестанут работать.")) return;
    e.token = rand8(); e.boundAt = null; e.verified = false; e.device = "";
    if (S.me && S.me.empCode === e.empCode) { S.me = null; saveMe(); }
    saveEmp(); renderCodes(); renderEmployees(); renderScanner();
    toast("Код перевыпущен");
  },
  "regen-all": function () {
    if (!confirm("Перевыпустить коды всех сотрудников? Все должны будут зарегистрироваться заново.")) return;
    S.emp.forEach(function (e) { e.token = rand8(); e.boundAt = null; e.verified = false; e.device = ""; });
    S.me = null; saveMe(); saveEmp();
    renderCodes(); renderEmployees(); renderScanner();
    toast("Все коды перевыпущены");
  },
  "add-emp": function () {
    var n = S.emp.length + 1;
    S.emp.push({ empCode: "EMP-" + String(n).padStart(3, "0"), name: "Сотрудник " + String(n).padStart(2, "0"), role: "Сотрудник", active: true, token: rand8(), boundAt: null, verified: false, device: "" });
    saveEmp(); renderEmployees(); renderCodes();
    toast("Сотрудник добавлен");
  },
  "pins-toggle": function () {
    if (pinsVisible) { pinsVisible = false; renderEmployees(); $("#pinsBtn").textContent = "Показать PIN"; return; }
    openModal(sheetHead("Код администратора", "Нужен для просмотра PIN сотрудников") +
      '<input class="input mono" type="password" inputmode="numeric" id="adminPinEntry" style="margin-top:12px" placeholder="••••">' +
      '<div class="col" style="margin-top:12px"><button class="btn primary" data-action="pin-check">Открыть</button>' +
      '<button class="btn ghost" data-action="close">Отмена</button></div>');
    setTimeout(function () { var f = $("#adminPinEntry"); if (f) f.focus(); }, 60);
  },
  "pin-check": function () {
    var f = $("#adminPinEntry");
    var v = f ? f.value : "";
    if (v === S.set.adminPin) {
      pinsVisible = true; closeModal(); renderEmployees();
      $("#pinsBtn").textContent = "Скрыть PIN";
      toast("PIN открыты на этом экране");
    } else toast("Код администратора неверный");
  },
  "export-pins": function () {
    var head = "Сотрудник;Код;PIN;Статус;Устройство;Дата регистрации";
    var lines = S.emp.map(function (e) {
      var srv = serverRow(e.empCode);
      return [e.name, e.empCode, pinFor(e), srv ? srv.status : (e.boundAt ? "привязан" : "не зарегистрирован"),
        (srv && srv.deviceLabel) || e.device || "",
        (srv && srv.boundAt) || (e.boundAt ? dmy(e.boundAt) + " " + hhmm(e.boundAt) : "")]
        .map(function (x) { return '"' + String(x === null || x === undefined ? "" : x).replace(/"/g, '""') + '"'; }).join(";");
    });
    downloadText("\uFEFF" + head + "\r\n" + lines.join("\r\n"), "pin-employees.csv", "text/csv;charset=utf-8");
  },
  "load-server": async function () {
    if (!S.set.sheetUrl) return toast("Сначала укажите URL веб-приложения");
    toast("Загружаем регистрации…");
    try {
      var r = await jsonp(S.set.sheetUrl, { action: "status", token: S.set.adminPin });
      if (r && r.ok) {
        S.srv.rows = r.rows || []; saveSrv();
        renderEmployees(); renderCodes();
        toast("Загружено строк: " + S.srv.rows.length);
      } else toast("Сервер вернул ошибку");
    } catch (e) { toast(e.message); }
  },
  "revoke": async function (el) {
    var code = el.dataset.code, e = findEmp(code);
    if (!confirm("Отозвать доступ для " + (e ? e.name : code) + "? Отметки с телефона перестанут приниматься.")) return;
    if (!S.set.sheetUrl) {
      if (e) { e.boundAt = null; e.verified = false; }
      if (S.me && S.me.empCode === code) { S.me = null; saveMe(); }
      saveEmp(); renderEmployees(); renderCodes();
      toast("Локальная привязка снята"); return;
    }
    try {
      var r = await jsonp(S.set.sheetUrl, { action: "revoke", empCode: code, unblock: "false", token: S.set.adminPin });
      if (r && r.ok) {
        S.srv.rows.forEach(function (row) { if (row.empCode === code) row.status = "заблокирован"; });
        saveSrv(); renderEmployees(); renderCodes();
        toast("Доступ отозван");
      } else toast("Не удалось отозвать: " + ((r && r.error) || "ошибка"));
    } catch (err) { toast(err.message); }
  },
  "unblock": async function (el) {
    var code = el.dataset.code, e = findEmp(code);
    if (!confirm("Разрешить повторную регистрацию для " + (e ? e.name : code) + "? Старое устройство отвяжется.")) return;
    if (e) { e.boundAt = null; e.verified = false; e.device = ""; }
    if (S.me && S.me.empCode === code) { S.me = null; saveMe(); }
    saveEmp();
    if (!S.set.sheetUrl) { renderEmployees(); renderCodes(); renderScanner(); toast("Можно регистрироваться заново"); return; }
    try {
      var r = await jsonp(S.set.sheetUrl, { action: "revoke", empCode: code, unblock: "true", token: S.set.adminPin });
      if (r && r.ok) {
        S.srv.rows.forEach(function (row) { if (row.empCode === code) { row.status = "активен"; row.deviceId = ""; row.deviceLabel = ""; } });
        saveSrv(); renderEmployees(); renderCodes(); renderScanner();
        toast("Повторная регистрация разрешена");
      } else toast("Ошибка: " + ((r && r.error) || "неизвестно"));
    } catch (err) { toast(err.message); }
  },
  "ping": async function () {
    if (!S.set.sheetUrl) return toast("Вставьте URL веб-приложения");
    toast("Проверяем соединение…");
    try {
      var r = await jsonp(S.set.sheetUrl, { action: "ping" });
      if (r && r.ok) { S.srv.lastPing = new Date().toISOString(); saveSrv(); renderSettings(); toast("Соединение установлено"); }
      else toast("Ответ не распознан");
    } catch (e) { S.srv.lastPing = null; saveSrv(); renderSettings(); toast(e.message); }
  },
  "queue-send": async function () {
    var q = S.rec.filter(function (r) { return !r.synced; });
    if (!q.length) return toast("Очередь пуста");
    if (!S.set.sheetUrl) return toast("URL не задан");
    for (var i = 0; i < q.length; i++) await sendRecord(q[i]);
    renderSettings(); renderScanner();
    toast("Отправлено неотправленных: " + (q.length - unsyncedCount()) + " из " + q.length);
  },
  "csv": function () {
    var pairs = pairsFor(filteredRecords());
    var head = "Код;Сотрудник;Дата;Вход;Выход;Часы;Опоздание;Широта;Долгота;В зоне;Источник";
    var lines = pairs.map(function (p) {
      return [p.empCode, p.empName, p.day.split("-").reverse().join("."),
        p.in ? hhmm(p.in.ts) : "", p.out ? hhmm(p.out.ts) : "",
        p.broken ? "" : fmtHours(hoursOf(p)), isLate(p) ? "да" : "",
        p.in && p.in.lat !== null && p.in.lat !== undefined ? p.in.lat : "",
        p.in && p.in.lng !== null && p.in.lng !== undefined ? p.in.lng : "",
        p.in ? (p.in.inZone ? "да" : "нет") : "",
        p.in ? (p.in.source === "manual" ? "ручной" : "QR") : ""]
        .map(function (x) { return '"' + String(x === null || x === undefined ? "" : x).replace(/"/g, '""') + '"'; }).join(";");
    });
    downloadText("\uFEFF" + head + "\r\n" + lines.join("\r\n"), "tabel-" + dayKey(new Date()) + ".csv", "text/csv;charset=utf-8");
  },
  "send-period": async function () {
    var recs = filteredRecords().filter(function (r) { return !r.synced; });
    if (!recs.length) return toast("Все отметки периода уже отправлены");
    if (!S.set.sheetUrl) return toast("URL не задан");
    for (var i = 0; i < recs.length; i++) await sendRecord(recs[i]);
    toast("Отправлено: " + recs.length);
  },
  "copy-gs": function () {
    var code = ($("#gsSrc").textContent || "").trim();
    navigator.clipboard.writeText(code).then(function () { toast("Код скопирован"); }, function () { toast("Не удалось скопировать — выделите вручную"); });
  },
  "take-coords": async function () {
    toast("Определяем координаты…");
    try {
      var c = await getPosition();
      S.set.officeLat = c.latitude.toFixed(6);
      S.set.officeLng = c.longitude.toFixed(6);
      saveSet(); renderSettings();
      toast("Координаты офиса сохранены");
    } catch (e) { toast(e.message); }
  },
  "backup": function () {
    downloadText(JSON.stringify({ employees: S.emp, records: S.rec, settings: S.set, me: S.me, exportedAt: new Date().toISOString() }, null, 2),
      "ttrack-backup-" + dayKey(new Date()) + ".json", "application/json");
  },
  "clear-records": function () {
    if (!confirm("Удалить все отметки на этом устройстве? Действие необратимо.")) return;
    S.rec = []; saveRec();
    renderScanner(); renderReport(); renderSettings();
    toast("Отметки удалены");
  },
  "print-posters": function () { printPosters(); },
  "print-badges": function () { printBadges(); },
  "download-posters": function () {
    downloadDataUrl(qrDataUrl(payloadIn(), 900), "qr-vhod.png");
    setTimeout(function () { downloadDataUrl(qrDataUrl(payloadOut(), 900), "qr-vyhod.png"); }, 400);
  },
  "download-all": function () {
    S.emp.forEach(function (e, i) {
      setTimeout(function () { downloadDataUrl(qrDataUrl(payloadReg(e), 800), "qr-" + e.empCode + ".png"); }, i * 350);
    });
    toast("Скачиваем " + S.emp.length + " файлов");
  }
};

async function startPunchOffline(type) {
  var emp = findEmp(S.me.empCode);
  if (!emp) return toast("Сотрудник не найден");
  proceedPunch(emp, type, false);
}

function manualPunch() {
  if (!S.set.allowManualPin) return toast("Ручной ввод PIN отключён");
  var pin = ($("#manualPin").value || "").trim();
  var type = $("#manualType").value === "out" ? "out" : "in";
  if (!/^\d{6}$/.test(pin)) return toast("Введите 6 цифр PIN");
  var emp = findEmpByPin(pin);
  if (!emp) return toast("Сотрудник с таким PIN не найден");
  if (!S.me || S.me.pin !== pin) {
    S.me = { empCode: emp.empCode, empName: emp.name, pin: pin, deviceId: S.dev, deviceLabel: deviceLabel(), boundAt: new Date().toISOString(), token: emp.token, verified: false };
    saveMe(); renderScanner();
  }
  window.__punchSource = "manual";
  $("#manualPin").value = "";
  startPunch(type);
}

function printPosters() {
  $("#printArea").innerHTML =
    '<div class="print-poster"><div class="brand">Учёт рабочего времени</div><div class="word in">ВХОД</div>' +
    '<img src="' + qrDataUrl(payloadIn(), 900) + '"><div class="note">Отсканируйте камерой телефона при приходе</div></div>' +
    '<div class="print-poster"><div class="brand">Учёт рабочего времени</div><div class="word out">ВЫХОД</div>' +
    '<img src="' + qrDataUrl(payloadOut(), 900) + '"><div class="note">Отсканируйте камерой телефона при уходе</div></div>';
  doPrint();
}
function printBadges() {
  $("#printArea").innerHTML = '<div class="badge-grid">' + S.emp.slice(0, 15).map(function (e) {
    return '<div class="print-badge"><img src="' + qrDataUrl(payloadReg(e), 500) + '">' +
      '<div class="nm">' + esc(e.name) + '</div><div class="cd">' + esc(e.empCode) + '</div>' +
      '<div class="tt">Код регистрации — отсканируйте один раз</div></div>';
  }).join("") + "</div>";
  doPrint();
}
function doPrint() {
  document.body.classList.add("printing");
  setTimeout(function () {
    window.print();
    setTimeout(function () { document.body.classList.remove("printing"); }, 600);
  }, 120);
}

function downloadDataUrl(url, name) {
  if (!url) return toast("Не удалось сформировать QR");
  var a = document.createElement("a");
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
}
function downloadText(text, name, mime) {
  var blob = new Blob([text], { type: mime || "text/plain;charset=utf-8" });
  var url = URL.createObjectURL(blob);
  var a = document.createElement("a");
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
}

document.addEventListener("click", function (ev) {
  var el = ev.target.closest ? ev.target.closest("[data-action]") : null;
  if (!el) return;
  var name = el.dataset.action;
  if (name === "nav") { show(el.dataset.view); return; }
  var fn = actions[name];
  if (fn) { ev.preventDefault(); fn(el, ev); }
});

document.addEventListener("input", function (ev) {
  var t = ev.target;
  if (t.dataset && t.dataset.set) {
    var k = t.dataset.set;
    if (t.type === "checkbox") S.set[k] = t.checked;
    else if (t.type === "number") S.set[k] = t.value === "" ? "" : Number(t.value);
    else S.set[k] = t.value;
    saveSet();
    return;
  }
  if (t.dataset && t.dataset.empName !== undefined) {
    var e = findEmp(t.dataset.empName);
    if (e) { e.name = t.value; saveEmp(); }
  }
});

document.addEventListener("change", function (ev) {
  var t = ev.target;
  if (t.dataset && t.dataset.empActive !== undefined) {
    var e = findEmp(t.dataset.empActive);
    if (e) { e.active = t.checked; saveEmp(); }
    return;
  }
  if (t.id === "repFrom") { repRange.from = t.value ? new Date(t.value) : null; renderReport(); }
  if (t.id === "repTo") { repRange.to = t.value ? new Date(t.value) : null; renderReport(); }
  if (t.id === "repEmp") { repRange.emp = t.value; renderReport(); }
});

document.addEventListener("keydown", function (ev) {
  if (ev.key === "Enter" && ev.target && ev.target.id === "adminPinEntry") {
    var btn = document.querySelector('[data-action="pin-check"]');
    if (btn) btn.click();
  }
});

buildNav();
renderScanner();
renderSettings();
show("scanner");
if (!camSupported()) { $("#camIdle").textContent = "Камера недоступна в этом браузере"; }
