
"use strict";
var K = { emp: "ttrack_employees", rec: "ttrack_records", set: "ttrack_settings", me: "ttrack_me", dev: "ttrack_device_id", srv: "ttrack_server" };

function lsGet(k, dflt) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : dflt; } catch (e) { return dflt; } }
function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
function rand8() {
  var a = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789", s = "", i;
  for (i = 0; i < 8; i++) s += a[Math.floor(Math.random() * a.length)];
  return s;
}
function deviceId() {
  var v = lsGet(K.dev, null);
  if (!v) { v = "dev_" + rand8(); lsSet(K.dev, v); }
  return v;
}
function deviceLabel() {
  var ua = navigator.userAgent || "";
  if (/iPhone|iPad|iPod/i.test(ua)) return "iPhone / iPad";
  if (/Android/i.test(ua)) return "Android";
  if (/Windows/i.test(ua)) return "Windows";
  if (/Macintosh|Mac OS X/i.test(ua)) return "Mac";
  return "Браузер";
}

var DEFAULT_SETTINGS = {
  sheetUrl: "", checkRegistration: false, checkAttendance: false, adminPhone: "",
  officeLat: "", officeLng: "", radius: 100,
  workStart: "09:00", workEnd: "18:00", lunchMinutes: 60, lateTolerance: 10,
  adminPin: "1234", allowManualPin: true
};

function makeEmployees(n) {
  var arr = [], i, code;
  for (i = 1; i <= n; i++) {
    code = "EMP-" + String(i).padStart(3, "0");
    arr.push({ empCode: code, name: "Сотрудник " + String(i).padStart(2, "0"), role: "Сотрудник", active: true, token: rand8(), boundAt: null, verified: false, device: "" });
  }
  return arr;
}

var S = {
  emp: lsGet(K.emp, null) || makeEmployees(15),
  rec: lsGet(K.rec, []) || [],
  set: Object.assign({}, DEFAULT_SETTINGS, lsGet(K.set, {}) || {}),
  me: lsGet(K.me, null),
  dev: deviceId(),
  srv: lsGet(K.srv, { rows: [], lastPing: null })
};
if (!lsGet(K.emp, null)) lsSet(K.emp, S.emp);

function saveEmp() { lsSet(K.emp, S.emp); }
function saveRec() { lsSet(K.rec, S.rec); }
function saveSet() { lsSet(K.set, S.set); }
function saveMe() { lsSet(K.me, S.me); }
function saveSrv() { lsSet(K.srv, S.srv); }

function esc(s) {
  return String(s === undefined || s === null ? "" : s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}
function $(sel, root) { return (root || document).querySelector(sel); }
function pad(n) { return String(n).padStart(2, "0"); }
function dayKey(d) { d = new Date(d); return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
function hhmm(d) { d = new Date(d); return pad(d.getHours()) + ":" + pad(d.getMinutes()); }
function hhmmss(d) { d = new Date(d); return hhmm(d) + ":" + pad(d.getSeconds()); }
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
  toastTimer = setTimeout(function () { t.classList.remove("show"); }, 2800);
}

function findEmp(code) {
  for (var i = 0; i < S.emp.length; i++) if (S.emp[i].empCode === code) return S.emp[i];
  return null;
}
function pinFor(emp) {
  var str = String(emp.token) + String(emp.empCode), hash = 2166136261, i;
  for (i = 0; i < str.length; i++) { hash ^= str.charCodeAt(i); hash = Math.imul(hash, 16777619); }
  var s = String((hash >>> 0) % 1000000).padStart(6, "0");
  if (s[0] === "0") s = "1" + s.slice(1);
  return s;
}
function findEmpByPin(pin) {
  for (var i = 0; i < S.emp.length; i++) if (pinFor(S.emp[i]) === pin) return S.emp[i];
  return null;
}
function fmtPin(pin) { return "••• " + String(pin || "").slice(-3); }
function pinSpaced(pin) { return String(pin || "").replace(/(\d{3})(?=\d)/g, "$1 "); }

function haversine(lat1, lon1, lat2, lon2) {
  var R = 6371000, toR = Math.PI / 180;
  var dLat = (lat2 - lat1) * toR, dLon = (lon2 - lon1) * toR;
  var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(lat1 * toR) * Math.cos(lat2 * toR) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return Math.round(2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}
function zoneInfo(lat, lng) {
  var oLat = parseFloat(S.set.officeLat), oLng = parseFloat(S.set.officeLng);
  var radius = parseFloat(S.set.radius) || 100;
  if (isNaN(oLat) || isNaN(oLng)) return { inZone: false, distance: null, configured: false };
  if (lat === null || lat === undefined) return { inZone: false, distance: null, configured: true };
  var d = haversine(oLat, oLng, lat, lng);
  return { inZone: d <= radius, distance: d, configured: true };
}
function getPosition() {
  return new Promise(function (resolve, reject) {
    if (!navigator.geolocation) return reject(new Error("Браузер не поддерживает геолокацию"));
    navigator.geolocation.getCurrentPosition(
      function (p) { resolve(p.coords); },
      function (e) {
        var m = "Не удалось определить геопозицию";
        if (e && e.code === 1) m = "Доступ к геолокации запрещён";
        if (e && e.code === 3) m = "Геопозиция не определилась за 15 секунд";
        reject(new Error(m));
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
    );
  });
}

function jsonp(base, params) {
  return new Promise(function (resolve, reject) {
    if (!base) return reject(new Error("URL веб-приложения не задан"));
    var clean = String(base).trim();
    if (!/^https:\/\/script\.google\.com\/macros\/s\/.+\/exec/.test(clean)) {
      return reject(new Error("Ссылка должна быть вида https://script.google.com/macros/s/…/exec"));
    }
    var cb = "__tt_" + Math.random().toString(36).slice(2, 10);
    var url = clean.indexOf("?") >= 0 ? clean + "&" : clean + "?";
    url += "callback=" + encodeURIComponent(cb);
    Object.keys(params || {}).forEach(function (k) {
      var v = params[k];
      if (v !== undefined && v !== null) url += "&" + encodeURIComponent(k) + "=" + encodeURIComponent(v);
    });
    var sc = document.createElement("script");
    var done = false;
    var timer = setTimeout(function () { finish(function () { reject(new Error("Таблица не ответила за 12 секунд")); }); }, 12000);
    function finish(fn) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { delete window[cb]; } catch (e) { window[cb] = undefined; }
      if (sc.parentNode) sc.parentNode.removeChild(sc);
      fn();
    }
    window[cb] = function (data) { finish(function () { resolve(data); }); };
    sc.onerror = function () { finish(function () { reject(new Error("Не удалось связаться с Google Таблицами")); }); };
    sc.src = url;
    document.head.appendChild(sc);
  });
}

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
function payloadIn() { return "TTQ|IN|v1"; }
function payloadOut() { return "TTQ|OUT|v1"; }
function payloadReg(emp) { return "TTR|" + emp.empCode + "|" + emp.token; }
function qrImg(text, size) {
  var url = qrDataUrl(text, size);
  if (!url) return '<div class="empty">QR-библиотека не загрузилась — проверьте интернет и обновите страницу</div>';
  return '<img src="' + url + '" alt="QR">';
}

var cam = { stream: null, raf: null, detector: null, lastText: "", lastAt: 0, running: false };
function camSupported() { return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia); }

async function camStart() {
  if (cam.running) { camStop(); return; }
  if (!camSupported()) { toast("Камера недоступна: нужен HTTPS и обычная вкладка браузера"); return; }
  try {
    cam.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 1280 } }, audio: false });
  } catch (e) {
    var m = "Не удалось включить камеру";
    if (e && e.name === "NotAllowedError") m = "Разрешите доступ к камере в настройках браузера";
    if (e && e.name === "NotFoundError") m = "Камера не найдена";
    if (location.protocol !== "https:" && location.hostname !== "localhost") m = "Камера работает только по HTTPS";
    toast(m);
    return;
  }
  var v = $("#cam");
  v.srcObject = cam.stream;
  try { await v.play(); } catch (e) {}
  $("#camWrap").classList.add("on");
  $("#camIdle").style.display = "none";
  cam.running = true;
  setCamBtn(true);
  if ("BarcodeDetector" in window) {
    try { cam.detector = new window.BarcodeDetector({ formats: ["qr_code"] }); } catch (e) { cam.detector = null; }
  }
  camLoop();
}
function camStop() {
  cam.running = false;
  if (cam.raf) cancelAnimationFrame(cam.raf);
  cam.raf = null;
  if (cam.stream) { cam.stream.getTracks().forEach(function (t) { t.stop(); }); cam.stream = null; }
  var w = $("#camWrap");
  if (w) w.classList.remove("on");
  var idle = $("#camIdle");
  if (idle) idle.style.display = "block";
  setCamBtn(false);
}
function setCamBtn(on) {
  var b = $("#camBtn");
  if (!b) return;
  b.innerHTML = on ? "Выключить камеру" : "Включить камеру";
}
var scanCanvas = null;
async function camLoop() {
  if (!cam.running) return;
  var v = $("#cam");
  if (v && v.readyState === 4) {
    var text = null;
    if (cam.detector) {
      try { var codes = await cam.detector.detect(v); if (codes && codes.length) text = codes[0].rawValue; } catch (e) {}
    }
    if (!text && window.jsQR) {
      try {
        if (!scanCanvas) scanCanvas = document.createElement("canvas");
        var w = 420, h = Math.round(w * (v.videoHeight / v.videoWidth) || w);
        scanCanvas.width = w; scanCanvas.height = h;
        var ctx = scanCanvas.getContext("2d", { willReadFrequently: true });
        ctx.drawImage(v, 0, 0, w, h);
        var img = ctx.getImageData(0, 0, w, h);
        var res = window.jsQR(img.data, w, h, { inversionAttempts: "dontInvert" });
        if (res && res.data) text = res.data;
      } catch (e) {}
    }
    if (text) onDecoded(text);
  }
  cam.raf = requestAnimationFrame(function () { setTimeout(camLoop, 180); });
}
function onDecoded(text) {
  var now = Date.now();
  if (text === cam.lastText && now - cam.lastAt < 2500) return;
  cam.lastText = text; cam.lastAt = now;
  handlePayload(text, "qr");
}

function openModal(html, opts) {
  opts = opts || {};
  var host = $("#modalHost");
  host.innerHTML = '<div class="overlay"><div class="sheet" role="dialog" aria-modal="true">' + html + "</div></div>";
  if (opts.closable !== false) {
    var ov = host.firstChild;
    ov.addEventListener("click", function (e) { if (e.target === ov) closeModal(); });
  }
}
function closeModal() { $("#modalHost").innerHTML = ""; }
function sheetHead(title, sub) {
  return '<div class="row between" style="align-items:flex-start"><div class="stack" style="gap:2px"><h2>' + esc(title) + "</h2>" +
    (sub ? '<div class="muted small">' + esc(sub) + "</div>" : "") + "</div>" +
    '<button class="btn sm ghost" data-action="close">✕</button></div>';
}
function spinnerSheet(title, sub) { return sheetHead(title, sub) + '<div class="spinner"></div>'; }

var pendingReg = null;
var punchDraft = null;

async function startRegistration(code, token) {
  var emp = findEmp(code);
  if (!emp) {
    openModal(sheetHead("Код не распознан", "Код " + code + " отсутствует в списке сотрудников.") +
      '<button class="btn block primary" style="margin-top:14px" data-action="close">Понятно</button>');
    return;
  }
  if (emp.token !== token) {
    openModal(sheetHead("Код устарел", "Этот регистрационный QR был перевыпущен. Возьмите у администратора актуальный.") +
      '<button class="btn block primary" style="margin-top:14px" data-action="close">Понятно</button>');
    return;
  }
  var pin = pinFor(emp);
  if (S.me && S.me.empCode === emp.empCode) { showPinSheet(emp, pin, "repeat"); return; }

  if (S.set.sheetUrl && S.set.checkRegistration) {
    openModal(spinnerSheet("Проверяем код…", "Это займёт пару секунд"), { closable: false });
    var reply;
    try {
      reply = await jsonp(S.set.sheetUrl, {
        action: "register", token: token, empCode: emp.empCode, empName: emp.name,
        pin: pin, deviceId: S.dev, deviceLabel: deviceLabel()
      });
    } catch (e) {
      openModal(sheetHead("Сервер недоступен", e.message) +
        '<div class="warn" style="margin-top:10px">Проверка включена, поэтому без связи регистрация не выполняется — так одноразовый код нельзя использовать дважды.</div>' +
        '<div class="col" style="margin-top:14px">' +
        '<button class="btn primary" data-action="reg-retry" data-code="' + esc(code) + '" data-token="' + esc(token) + '">Повторить</button>' +
        '<button class="btn" data-action="bind-local" data-code="' + esc(code) + '">Зарегистрироваться без проверки</button>' +
        '<button class="btn ghost" data-action="close">Отмена</button></div>');
      return;
    }
    if (reply && reply.ok === false && reply.error === "used") {
      openModal(sheetHead("Этот код уже использован", "Одноразовый код привязан к другому телефону.") +
        '<div class="err" style="margin-top:10px">Зарегистрирован: ' + esc(reply.empName || emp.name) +
        (reply.boundAt ? " · " + esc(reply.boundAt) : "") + "</div>" +
        '<div class="muted small" style="margin-top:10px">Чтобы привязать новый телефон: «Сотрудники» → «Разрешить повторную регистрацию» для ' + esc(emp.empCode) + ", затем отсканируйте код заново.</div>" +
        '<button class="btn block primary" style="margin-top:14px" data-action="close">Понятно</button>');
      return;
    }
    if (!reply || reply.ok === false) {
      openModal(sheetHead("Не удалось зарегистрировать", "Сервер вернул ошибку.") +
        '<div class="err" style="margin-top:10px">' + esc((reply && reply.error) || "неизвестная ошибка") + "</div>" +
        '<button class="btn block primary" style="margin-top:14px" data-action="close">Понятно</button>');
      return;
    }
    bindDevice(emp, pin, true);
    return;
  }

  if (S.me && S.me.empCode !== emp.empCode) {
    pendingReg = { code: code, token: token };
    openModal(sheetHead("Сменить сотрудника?", "Телефон привязан к " + (S.me.empName || S.me.empCode) + ".") +
      '<div class="muted small" style="margin-top:6px">Новый PIN заменит предыдущий на этом устройстве.</div>' +
      '<div class="col" style="margin-top:14px">' +
      '<button class="btn primary" data-action="bind-yes">Привязать ' + esc(emp.name) + "</button>" +
      '<button class="btn ghost" data-action="close">Отмена</button></div>');
    return;
  }
  bindDevice(emp, pin, false);
}

function bindDevice(emp, pin, verified) {
  S.me = { empCode: emp.empCode, empName: emp.name, pin: pin, deviceId: S.dev, deviceLabel: deviceLabel(), boundAt: new Date().toISOString(), token: emp.token, verified: !!verified };
  emp.boundAt = S.me.boundAt;
  emp.verified = !!verified;
  emp.device = deviceLabel();
  saveMe(); saveEmp();
  showPinSheet(emp, pin, "first");
}

function showPinSheet(emp, pin, mode) {
  openModal(sheetHead(mode === "repeat" ? "Вы уже зарегистрированы" : "Регистрация завершена", emp.name + " · " + emp.empCode) +
    '<div class="pinbig" style="margin-top:14px">' + esc(pinSpaced(pin)) + "</div>" +
    '<div class="muted small" style="margin-top:10px;text-align:center">PIN сохранён на этом телефоне и подставляется автоматически при отметке. Показывать его никому не нужно.</div>' +
    '<button class="btn block ghost" style="margin-top:12px" data-action="copy-pin" data-pin="' + esc(pin) + '">Скопировать PIN</button>' +
    '<button class="btn block primary" style="margin-top:8px" data-action="close">Готово</button>');
}

async function startPunch(type) {
  if (!S.me) {
    openModal(sheetHead("Вы не зарегистрированы", "На этом телефоне нет PIN сотрудника.") +
      '<div class="muted small" style="margin-top:6px">Отсканируйте свой регистрационный QR-код или введите PIN вручную на главном экране.</div>' +
      '<button class="btn block primary" style="margin-top:14px" data-action="close">Понятно</button>');
    return;
  }
  var emp = findEmp(S.me.empCode);
  if (!emp) {
    openModal(sheetHead("Сотрудник не найден", "Код " + S.me.empCode + " удалён из списка.") +
      '<button class="btn block primary" style="margin-top:14px" data-action="close">Понятно</button>');
    return;
  }
  if (emp.active === false) {
    openModal(sheetHead("Сотрудник неактивен", "Обратитесь к администратору.") +
      '<button class="btn block primary" style="margin-top:14px" data-action="close">Понятно</button>');
    return;
  }
  var i, dup = null;
  for (i = 0; i < S.rec.length; i++) {
    if (S.rec[i].empCode === emp.empCode && S.rec[i].type === type && Date.now() - new Date(S.rec[i].ts).getTime() < 60000) { dup = S.rec[i]; break; }
  }
  if (dup) { toast("Отметка уже сделана"); return; }

  var verified = false;
  if (S.set.sheetUrl && S.set.checkAttendance) {
    openModal(spinnerSheet("Проверяем доступ…", emp.name), { closable: false });
    var chk;
    try {
      chk = await jsonp(S.set.sheetUrl, { action: "check", token: S.me.token, empCode: emp.empCode, pin: S.me.pin, deviceId: S.dev });
    } catch (e) {
      openModal(sheetHead("Сервер недоступен", e.message) +
        '<div class="warn" style="margin-top:10px">Можно отметить без проверки — запись уйдёт в таблицу при следующей синхронизации.</div>' +
        '<div class="col" style="margin-top:14px">' +
        '<button class="btn primary" data-action="punch-retry" data-type="' + type + '">Повторить</button>' +
        '<button class="btn" data-action="punch-offline" data-type="' + type + '">Отметить без проверки</button>' +
        '<button class="btn ghost" data-action="close">Отмена</button></div>');
      return;
    }
    if (chk && chk.ok === false) {
      if (chk.error === "blocked") {
        openModal(sheetHead("Доступ отозван", "Администратор заблокировал отметки с этого телефона.") +
          '<div class="err" style="margin-top:10px">Запись не создана.</div>' +
          (S.set.adminPhone ? '<div class="muted small" style="margin-top:10px">Администратор: ' + esc(S.set.adminPhone) + "</div>" : "") +
          '<button class="btn block primary" style="margin-top:14px" data-action="close">Понятно</button>');
        return;
      }
      if (chk.error === "not_registered") {
        openModal(sheetHead("Телефон не зарегистрирован", "В таблице нет привязки для " + emp.empCode + ".") +
          '<div class="muted small" style="margin-top:6px">Отсканируйте свой регистрационный QR-код.</div>' +
          '<button class="btn block primary" style="margin-top:14px" data-action="close">Понятно</button>');
        return;
      }
    }
    verified = !!(chk && chk.ok);
  }
  proceedPunch(emp, type, verified);
}

async function proceedPunch(emp, type, verified) {
  openModal(spinnerSheet("Определяем геопозицию…", "Разрешите доступ к геоданным"), { closable: false });
  var coords = null, err = null;
  try { coords = await getPosition(); } catch (e) { err = e; }
  if (err) {
    openModal(sheetHead("Геопозиция недоступна", err.message) +
      '<div class="warn" style="margin-top:10px">Можно отметить без координат — запись будет помечена как «без гео».</div>' +
      '<div class="col" style="margin-top:14px">' +
      '<button class="btn primary" data-action="gps-retry" data-code="' + esc(emp.empCode) + '" data-type="' + type + '" data-verified="' + (verified ? 1 : 0) + '">Повторить</button>' +
      '<button class="btn" data-action="no-geo" data-code="' + esc(emp.empCode) + '" data-type="' + type + '" data-verified="' + (verified ? 1 : 0) + '">Отметить без координат</button>' +
      '<button class="btn ghost" data-action="close">Отмена</button></div>');
    return;
  }
  showConfirm(emp, type, verified, coords);
}

function showConfirm(emp, type, verified, coords) {
  var zone = zoneInfo(coords ? coords.latitude : null, coords ? coords.longitude : null);
  var now = new Date();
  var label = type === "in" ? "ВХОД" : "ВЫХОД";
  var color = type === "in" ? "var(--green)" : "var(--accent)";
  var warnings = shiftWarnings(emp, type);
  punchDraft = {
    empCode: emp.empCode, empName: emp.name, pin: S.me ? S.me.pin : "",
    type: type, ts: now.toISOString(),
    lat: coords ? Number(coords.latitude.toFixed(6)) : null,
    lng: coords ? Number(coords.longitude.toFixed(6)) : null,
    accuracy: coords ? Math.round(coords.accuracy) : null,
    distance: zone.distance, inZone: zone.inZone, noGeo: !coords,
    verified: !!verified, deviceId: S.dev, deviceLabel: deviceLabel(),
    source: window.__punchSource || "qr"
  };
  var zoneHtml = !zone.configured ? '<span class="badge">Геозона не настроена</span>'
    : (coords ? (zone.inZone ? '<span class="badge green"><span class="dot"></span>В зоне офиса</span>' : '<span class="badge red"><span class="dot"></span>Вне зоны — ' + zone.distance + " м</span>") : '<span class="badge amber">Без координат</span>');

  openModal(
    sheetHead(label, emp.name + " · " + emp.empCode) +
    '<div class="row" style="margin-top:14px;gap:12px">' +
      '<div class="avatar" style="width:52px;height:52px;font-size:18px">' + esc(initials(emp.name)) + "</div>" +
      '<div class="stack" style="gap:2px"><div style="font-size:22px;font-weight:800;color:' + color + ';letter-spacing:.04em">' + label + "</div>" +
      '<div class="muted small">' + dmy(now) + " · " + hhmmss(now) + "</div></div>" +
    "</div><div class='sep'></div>" +
    '<div class="stack" style="gap:6px;font-size:13.5px">' +
      "<div>" + zoneHtml + "</div>" +
      (coords ? '<div class="muted">Координаты: <span class="mono">' + punchDraft.lat + ", " + punchDraft.lng + "</span> · точность " + punchDraft.accuracy + " м</div>" : "") +
      '<div class="muted">Устройство: ' + esc(deviceLabel()) + (verified ? " · проверено сервером" : "") + "</div>" +
    "</div>" +
    (warnings.length ? '<div class="warn" style="margin-top:10px">' + warnings.map(esc).join("<br>") + "</div>" : "") +
    '<div class="col" style="margin-top:16px"><button class="btn primary" data-action="punch-confirm">Подтвердить</button>' +
    '<button class="btn ghost" data-action="close">Отмена</button></div>'
  );
}

function proceedPunchNoGeo(emp, type, verified) {
  var zone = zoneInfo(null, null);
  punchDraft = {
    empCode: emp.empCode, empName: emp.name, pin: S.me ? S.me.pin : "", type: type, ts: new Date().toISOString(),
    lat: null, lng: null, accuracy: null, distance: zone.distance, inZone: false, noGeo: true,
    verified: !!verified, deviceId: S.dev, deviceLabel: deviceLabel(), source: window.__punchSource || "qr"
  };
  var now = new Date();
  var label = type === "in" ? "ВХОД" : "ВЫХОД";
  var color = type === "in" ? "var(--green)" : "var(--accent)";
  var warnings = shiftWarnings(emp, type);
  openModal(sheetHead(label, emp.name + " · " + emp.empCode) +
    '<div class="row" style="margin-top:14px;gap:12px"><div class="avatar" style="width:52px;height:52px;font-size:18px">' + esc(initials(emp.name)) + "</div>" +
    '<div class="stack" style="gap:2px"><div style="font-size:22px;font-weight:800;color:' + color + ';letter-spacing:.04em">' + label + "</div>" +
    '<div class="muted small">' + dmy(now) + " · " + hhmmss(now) + "</div></div></div><div class='sep'></div>" +
    '<div class="badge amber">Без координат</div>' +
    (warnings.length ? '<div class="warn" style="margin-top:10px">' + warnings.map(esc).join("<br>") + "</div>" : "") +
    '<div class="col" style="margin-top:16px"><button class="btn primary" data-action="punch-confirm">Подтвердить</button>' +
    '<button class="btn ghost" data-action="close">Отмена</button></div>');
}

function shiftWarnings(emp, type) {
  var out = [];
  var today = dayKey(new Date());
  var todays = S.rec.filter(function (r) { return r.empCode === emp.empCode && dayKey(r.ts) === today; })
    .sort(function (a, b) { return new Date(a.ts) - new Date(b.ts); });
  var last = todays[todays.length - 1];
  if (type === "in" && last && last.type === "in") out.push("Вход уже отмечен в " + hhmm(last.ts) + ", смена не закрыта");
  if (type === "out" && (!last || last.type === "out")) out.push("Нет открытой смены — вход сегодня не отмечен");
  return out;
}

function commitPunch() {
  if (!punchDraft) return;
  var rec = Object.assign({}, punchDraft, { id: "r" + Date.now() + Math.random().toString(36).slice(2, 6), synced: false });
  S.rec.push(rec);
  saveRec();
  punchDraft = null;
  closeModal();
  toast("Отметка сохранена");
  renderScanner();
  renderReport();
  if (S.set.sheetUrl) sendRecord(rec);
}

async function sendRecord(rec) {
  try {
    var r = await jsonp(S.set.sheetUrl, { action: "append", token: S.me ? S.me.token : "", empCode: rec.empCode, deviceId: rec.deviceId, record: JSON.stringify(rec) });
    if (r && r.ok) { rec.synced = true; saveRec(); renderScanner(); }
  } catch (e) { rec.synced = false; saveRec(); }
}

function handlePayload(text, source) {
  window.__punchSource = source || "qr";
  var raw = String(text || "").trim();
  if (raw.indexOf("TTR|") === 0) {
    var p = raw.split("|");
    if (p.length >= 3) startRegistration(p[1], p[2]);
    return;
  }
  if (raw.indexOf("TTQ|") === 0) {
    var q = raw.split("|");
    startPunch(String(q[1] || "").toUpperCase() === "OUT" ? "out" : "in");
    return;
  }
  toast("Это не код учёта времени");
}
