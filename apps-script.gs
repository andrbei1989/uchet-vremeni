/**
 * Учёт рабочего времени — сервер на Google Apps Script.
 * Версия 4.
 *
 * Установка (один раз):
 * 1. Создайте Google Таблицу.
 * 2. Расширения → Apps Script. Удалите всё, что там есть, вставьте этот код целиком, сохраните.
 * 3. Развернуть → Новое развёртывание → тип «Веб-приложение».
 *    «Запуск от имени»: Я.  «У кого есть доступ»: Все.
 * 4. Скопируйте ссылку на /exec и вставьте её в приложении администратора.
 *    При первом входе приложение попросит придумать пароль администратора.
 *
 * Обновление кода: Развернуть → Управление развёртываниями → ✎ → Версия: «Новая версия» → Развернуть.
 * Так ссылка /exec останется прежней и QR-коды перепечатывать не придётся.
 *
 * Листы «Сотрудники», «Отметки» и «Настройки» создаются автоматически.
 */

var VERSION = 4;

var SHEET_EMP = 'Сотрудники';
var SHEET_ATT = 'Отметки';
var SHEET_SET = 'Настройки';

var HEAD_EMP = ['Код', 'ФИО', 'Ключ QR', 'Статус', 'Телефон', 'Привязан', 'Секрет телефона', 'Обновлено'];
var HEAD_ATT = ['Дата', 'Время', 'Код', 'ФИО', 'Тип', 'Широта', 'Долгота',
  'Точность (м)', 'Расстояние (м)', 'В зоне', 'Источник', 'Устройство', 'Метка ISO'];

/* колонки листа «Сотрудники» (с нуля) */
var E_CODE = 0, E_NAME = 1, E_KEY = 2, E_STATUS = 3, E_DEVICE = 4, E_BOUND = 5, E_SECRET = 6, E_UPD = 7;

var ST_ACTIVE = 'активен';
var ST_BLOCKED = 'заблокирован';

var DUP_WINDOW_MS = 2 * 60 * 1000;   /* повторный скан того же постера в течение 2 минут не создаёт новую строку */

var PUBLIC_ACTIONS = { ping: 1, setup: 1, register: 1, punch: 1 };
var ADMIN_ACTIONS = {
  login: 1, changePassword: 1, employees: 1, addEmployee: 1, updateEmployee: 1,
  regenKey: 1, board: 1, read: 1, getSettings: 1, saveSettings: 1
};

function doGet(e) {
  var p = (e && e.parameter) || {};
  var cb = String(p.callback || '');
  if (cb && !/^[A-Za-z_$][\w$]{0,63}$/.test(cb)) cb = '';
  var res;
  var lock = LockService.getScriptLock();
  try {
    if (!lock.tryLock(25000)) throw new Error('busy');
    res = ttRoute(String(p.action || ''), p);
  } catch (err) {
    res = { ok: false, error: String(err && err.message || err) };
  } finally {
    try { lock.releaseLock(); } catch (ignore) {}
  }
  var out = cb ? cb + '(' + JSON.stringify(res) + ')' : JSON.stringify(res);
  return ContentService.createTextOutput(out)
    .setMimeType(cb ? ContentService.MimeType.JAVASCRIPT : ContentService.MimeType.JSON);
}

function ttRoute(a, p) {
  if (PUBLIC_ACTIONS[a]) {
    if (a === 'ping') return { ok: true, version: VERSION, configured: ttHasPassword(), ts: new Date().toISOString() };
    if (a === 'setup') return ttSetup(p);
    if (a === 'register') return ttRegister(p);
    if (a === 'punch') return ttPunch(p);
  }
  if (ADMIN_ACTIONS[a]) {
    var auth = ttAuth(p);
    if (!auth.ok) return auth;
    if (a === 'login') return { ok: true, version: VERSION };
    if (a === 'changePassword') return ttChangePassword(p);
    if (a === 'employees') return { ok: true, rows: ttEmployeeList() };
    if (a === 'addEmployee') return ttAddEmployee(p);
    if (a === 'updateEmployee') return ttUpdateEmployee(p);
    if (a === 'regenKey') return ttRegenKey(p);
    if (a === 'board') return ttBoard();
    if (a === 'read') return ttRead(p);
    if (a === 'getSettings') return { ok: true, settings: ttSettings() };
    if (a === 'saveSettings') return ttSaveSettings(p);
  }
  return { ok: false, error: 'unknown_action' };
}

/* ================= пароль администратора ================= */
function ttProps() { return PropertiesService.getScriptProperties(); }
function ttHash(s) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(s), Utilities.Charset.UTF_8);
  return bytes.map(function (b) { return ('0' + (b & 255).toString(16)).slice(-2); }).join('');
}
function ttHasPassword() { return !!ttProps().getProperty('admin_hash'); }
function ttSetPassword(pw) {
  var salt = Utilities.getUuid();
  ttProps().setProperties({ admin_salt: salt, admin_hash: ttHash(salt + '|' + pw) });
}

function ttSetup(p) {
  if (ttHasPassword()) return { ok: false, error: 'already_configured' };
  var pw = String(p.pw || '');
  if (pw.length < 6) return { ok: false, error: 'weak_password' };
  ttSetPassword(pw);
  ttEmp(); ttAtt(); ttSet();
  return { ok: true, version: VERSION };
}

/** Проверка пароля + защита от подбора: после 10 ошибок вход закрыт на 15 минут. */
function ttAuth(p) {
  if (!ttHasPassword()) return { ok: false, error: 'not_configured' };
  var cache = CacheService.getScriptCache();
  var fails = Number(cache.get('auth_fails') || 0);
  if (fails >= 10) return { ok: false, error: 'locked' };
  var props = ttProps();
  var good = ttHash(props.getProperty('admin_salt') + '|' + String(p.pw || '')) === props.getProperty('admin_hash');
  if (!good) {
    cache.put('auth_fails', String(fails + 1), 900);
    return { ok: false, error: 'bad_password' };
  }
  return { ok: true };
}

function ttChangePassword(p) {
  var np = String(p.newpw || '');
  if (np.length < 6) return { ok: false, error: 'weak_password' };
  ttSetPassword(np);
  return { ok: true };
}

/* ================= листы ================= */
function ttSheet(name, headers, textCols) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(name);
  if (sh && sh.getLastColumn() > 0) {
    /* лист от старой версии приложения с другими столбцами — не трогаем его данные, а откладываем в сторону */
    var head = sh.getRange(1, 1, 1, headers.length).getValues()[0].map(ttStr);
    if (head.join('|') !== headers.join('|')) {
      var old = name + ' (старая версия)', n = 2;
      while (ss.getSheetByName(old)) old = name + ' (старая версия ' + (n++) + ')';
      sh.setName(old);
      sh = null;
    }
  }
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    sh.setFrozenRows(1);
    /* текстовый формат, чтобы Таблица не превращала «21.11.2026» и коды в даты и числа */
    (textCols || []).forEach(function (c) { sh.getRange(2, c, sh.getMaxRows() - 1, 1).setNumberFormat('@'); });
  }
  return sh;
}
function ttEmp() { return ttSheet(SHEET_EMP, HEAD_EMP, [1, 3, 6, 7, 8]); }
function ttAtt() { return ttSheet(SHEET_ATT, HEAD_ATT, [1, 2, 3, 13]); }
function ttSet() { return ttSheet(SHEET_SET, ['Параметр', 'Значение'], [1, 2]); }

function ttRows(sh) {
  var last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, Math.max(sh.getLastColumn(), 1)).getValues();
}
function ttStr(v) { return v === null || v === undefined ? '' : String(v).trim(); }
function ttTz() { return Session.getScriptTimeZone(); }
function ttFmt(d, pattern) { return Utilities.formatDate(d, ttTz(), pattern); }
function ttWhen(v) {
  if (!v) return '';
  var d = v instanceof Date ? v : new Date(String(v));
  return isNaN(d.getTime()) ? ttStr(v) : ttFmt(d, 'dd.MM.yyyy HH:mm');
}
function ttRand(n) {
  var a = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', s = '';
  var raw = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  for (var i = 0; i < n; i++) s += a[parseInt(raw.substr(i * 2, 2), 16) % a.length];
  return s;
}
function ttSecret() { return (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, ''); }
function ttNum(v) {
  if (v === null || v === undefined || v === '') return null;
  var n = Number(String(v).replace(',', '.'));
  return isFinite(n) ? n : null;
}

/* ================= настройки ================= */
var SETTING_KEYS = {
  office_lat: 'lat', office_lng: 'lng', radius_m: 'radius',
  work_start: 'workStart', work_end: 'workEnd', lunch_min: 'lunchMinutes', late_min: 'lateTolerance'
};
function ttSettings() {
  var out = { lat: null, lng: null, radius: 100, workStart: '09:00', workEnd: '18:00', lunchMinutes: 60, lateTolerance: 10 };
  ttRows(ttSet()).forEach(function (r) {
    var k = SETTING_KEYS[ttStr(r[0])];
    if (!k) return;
    var v = ttStr(r[1]);
    if (v === '') return;
    if (k === 'workStart' || k === 'workEnd') out[k] = v;
    else { var n = ttNum(v); if (n !== null) out[k] = n; }
  });
  return out;
}
function ttWriteSetting(key, value) {
  var sh = ttSet();
  var data = ttRows(sh);
  for (var i = 0; i < data.length; i++) {
    if (ttStr(data[i][0]) === key) { sh.getRange(i + 2, 2).setValue(String(value)); return; }
  }
  sh.appendRow([key, String(value)]);
}
function ttSaveSettings(p) {
  Object.keys(SETTING_KEYS).forEach(function (key) {
    var field = SETTING_KEYS[key];
    if (p[field] === undefined) return;
    var v = ttStr(p[field]);
    if (field === 'workStart' || field === 'workEnd') {
      if (v && !/^\d{1,2}:\d{2}$/.test(v)) return;
    } else if (v !== '' && ttNum(v) === null) return;
    ttWriteSetting(key, v);
  });
  return { ok: true, settings: ttSettings() };
}

/* ================= сотрудники ================= */
function ttFindEmp(code) {
  var sh = ttEmp();
  var data = ttRows(sh);
  code = ttStr(code).toUpperCase();
  for (var i = 0; i < data.length; i++) {
    if (ttStr(data[i][E_CODE]).toUpperCase() === code && code) return { sh: sh, row: i + 2, r: data[i] };
  }
  return null;
}
function ttEmpPublic(r) {
  return {
    code: ttStr(r[E_CODE]),
    name: ttStr(r[E_NAME]),
    key: ttStr(r[E_KEY]),
    status: ttStr(r[E_STATUS]) || ST_ACTIVE,
    device: ttStr(r[E_DEVICE]),
    boundAt: ttWhen(r[E_BOUND]),
    bound: !!ttStr(r[E_SECRET])
  };
}
function ttEmployeeList() {
  return ttRows(ttEmp()).filter(function (r) { return ttStr(r[E_CODE]); }).map(ttEmpPublic);
}
function ttAddEmployee(p) {
  var name = ttStr(p.name).slice(0, 80);
  if (!name) return { ok: false, error: 'name_required' };
  var max = 0;
  ttRows(ttEmp()).forEach(function (r) {
    var m = /^EMP-(\d+)$/i.exec(ttStr(r[E_CODE]));
    if (m) max = Math.max(max, Number(m[1]));
  });
  var code = 'EMP-' + ('00' + (max + 1)).slice(-3);
  var row = [code, name, ttRand(8), ST_ACTIVE, '', '', '', new Date().toISOString()];
  ttEmp().appendRow(row);
  return { ok: true, employee: ttEmpPublic(row) };
}
function ttUpdateEmployee(p) {
  var f = ttFindEmp(p.code);
  if (!f) return { ok: false, error: 'not_found' };
  if (p.name !== undefined) {
    var nm = ttStr(p.name).slice(0, 80);
    if (!nm) return { ok: false, error: 'name_required' };
    f.r[E_NAME] = nm;
  }
  if (p.status !== undefined) {
    if (p.status !== ST_ACTIVE && p.status !== ST_BLOCKED) return { ok: false, error: 'bad_status' };
    f.r[E_STATUS] = p.status;
  }
  f.r[E_UPD] = new Date().toISOString();
  f.sh.getRange(f.row, 1, 1, HEAD_EMP.length).setValues([f.r.slice(0, HEAD_EMP.length)]);
  return { ok: true, employee: ttEmpPublic(f.r) };
}
/** Новый QR-ключ: старый QR перестаёт работать, телефон отвязывается. */
function ttRegenKey(p) {
  var f = ttFindEmp(p.code);
  if (!f) return { ok: false, error: 'not_found' };
  f.r[E_KEY] = ttRand(8);
  f.r[E_DEVICE] = ''; f.r[E_BOUND] = ''; f.r[E_SECRET] = '';
  f.r[E_UPD] = new Date().toISOString();
  f.sh.getRange(f.row, 1, 1, HEAD_EMP.length).setValues([f.r.slice(0, HEAD_EMP.length)]);
  return { ok: true, employee: ttEmpPublic(f.r) };
}

/* ================= привязка телефона ================= */
function ttRegister(p) {
  var f = ttFindEmp(p.code);
  if (!f) return { ok: false, error: 'unknown_code' };
  var r = f.r;
  if (ttStr(r[E_KEY]) !== ttStr(p.key).toUpperCase()) return { ok: false, error: 'old_qr' };
  if (ttStr(r[E_STATUS]) === ST_BLOCKED) return { ok: false, error: 'blocked' };
  var secret = ttStr(r[E_SECRET]);
  if (secret) {
    /* тот же телефон сканирует код повторно — просто подтверждаем */
    if (ttStr(p.secret) && ttStr(p.secret) === secret) {
      return { ok: true, repeat: true, code: ttStr(r[E_CODE]), name: ttStr(r[E_NAME]), secret: secret, boundAt: ttWhen(r[E_BOUND]) };
    }
    return { ok: false, error: 'used', boundAt: ttWhen(r[E_BOUND]) };
  }
  secret = ttSecret();
  var now = new Date();
  r[E_DEVICE] = ttStr(p.device).slice(0, 60) || 'Телефон';
  r[E_BOUND] = now.toISOString();
  r[E_SECRET] = secret;
  r[E_UPD] = now.toISOString();
  f.sh.getRange(f.row, 1, 1, HEAD_EMP.length).setValues([r.slice(0, HEAD_EMP.length)]);
  return { ok: true, first: true, code: ttStr(r[E_CODE]), name: ttStr(r[E_NAME]), secret: secret, boundAt: ttWhen(now) };
}

/* ================= отметка ================= */
function ttHaversine(lat1, lon1, lat2, lon2) {
  var R = 6371000, toR = Math.PI / 180;
  var dLat = (lat2 - lat1) * toR, dLon = (lon2 - lon1) * toR;
  var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * toR) * Math.cos(lat2 * toR) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return Math.round(2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

function ttPunch(p) {
  var type = p.type === 'out' ? 'out' : (p.type === 'in' ? 'in' : '');
  if (!type) return { ok: false, error: 'bad_type' };
  var f = ttFindEmp(p.code);
  if (!f) return { ok: false, error: 'not_registered' };
  var r = f.r;
  var secret = ttStr(r[E_SECRET]);
  if (!secret || secret !== ttStr(p.secret)) return { ok: false, error: 'not_registered' };
  if (ttStr(r[E_STATUS]) === ST_BLOCKED) return { ok: false, error: 'blocked' };

  var code = ttStr(r[E_CODE]), name = ttStr(r[E_NAME]);
  var typeRu = type === 'out' ? 'выход' : 'вход';
  var now = new Date();

  /* повторный скан того же постера */
  var att = ttAtt();
  var last = ttLastPunch(att, code);
  if (last && last.type === typeRu && now.getTime() - last.ts.getTime() < DUP_WINDOW_MS) {
    return ttPunchReply(type, name, code, last.ts, last.zone, last.distance, true);
  }

  var lat = ttNum(p.lat), lng = ttNum(p.lng), acc = ttNum(p.acc);
  var sett = ttSettings();
  var distance = '', zone;
  if (lat === null || lng === null) zone = 'без координат';
  else if (sett.lat === null || sett.lng === null) zone = 'не настроена';
  else {
    distance = ttHaversine(sett.lat, sett.lng, lat, lng);
    zone = distance <= (sett.radius || 100) ? 'в зоне' : 'вне зоны';
  }

  att.appendRow([ttFmt(now, 'dd.MM.yyyy'), ttFmt(now, 'HH:mm:ss'), code, name, typeRu,
    lat === null ? '' : lat, lng === null ? '' : lng, acc === null ? '' : Math.round(acc),
    distance, zone, 'QR', ttStr(r[E_DEVICE]), now.toISOString()]);

  return ttPunchReply(type, name, code, now, zone, distance, false, last);
}

function ttPunchReply(type, name, code, ts, zone, distance, duplicate, prev) {
  var out = {
    ok: true, type: type, name: name, code: code, duplicate: !!duplicate,
    date: ttFmt(ts, 'dd.MM.yyyy'), time: ttFmt(ts, 'HH:mm'),
    zone: zone, distance: distance === '' || distance === null ? null : Number(distance)
  };
  /* подсказка сотруднику: забыл отметить выход вчера / выход без входа */
  if (!duplicate && prev) {
    if (type === 'in' && prev.type === 'вход') out.warning = 'prev_open';
    if (type === 'out' && prev.type === 'выход') out.warning = 'no_in';
  } else if (!duplicate && !prev && type === 'out') out.warning = 'no_in';
  return out;
}

function ttParseTs(row) {
  var iso = row[12];
  if (iso instanceof Date) return iso;
  if (iso) { var d = new Date(String(iso)); if (!isNaN(d.getTime())) return d; }
  return null;
}

function ttLastPunch(att, code) {
  var data = ttRows(att);
  for (var i = data.length - 1; i >= 0; i--) {
    if (ttStr(data[i][2]) !== code) continue;
    var ts = ttParseTs(data[i]);
    if (!ts) continue;
    return { ts: ts, type: ttStr(data[i][4]), zone: ttStr(data[i][9]), distance: ttNum(data[i][8]) };
  }
  return null;
}

/* ================= для администратора ================= */
/** Кто сейчас на работе: последняя отметка каждого сотрудника. */
function ttBoard() {
  var last = {};
  ttRows(ttAtt()).forEach(function (row) {
    var code = ttStr(row[2]);
    var ts = ttParseTs(row);
    if (!code || !ts) return;
    if (!last[code] || ts.getTime() >= last[code].ts.getTime()) {
      last[code] = { ts: ts, type: ttStr(row[4]), zone: ttStr(row[9]), distance: ttNum(row[8]) };
    }
  });
  var rows = ttEmployeeList().map(function (e) {
    var l = last[e.code];
    return {
      code: e.code, name: e.name, status: e.status, bound: e.bound, device: e.device,
      onShift: !!(l && l.type === 'вход'),
      lastType: l ? (l.type === 'выход' ? 'out' : 'in') : '',
      lastIso: l ? l.ts.toISOString() : '',
      lastText: l ? ttFmt(l.ts, 'dd.MM.yyyy HH:mm') : '',
      zone: l ? l.zone : '',
      distance: l ? l.distance : null
    };
  });
  rows.sort(function (a, b) {
    if (a.onShift !== b.onShift) return a.onShift ? -1 : 1;
    return String(b.lastIso).localeCompare(String(a.lastIso));
  });
  return { ok: true, rows: rows, now: new Date().toISOString() };
}

/** Все отметки за период — для табеля. */
function ttRead(p) {
  var from = p.from ? new Date(String(p.from)) : null;
  var to = p.to ? new Date(String(p.to)) : null;
  var out = [];
  ttRows(ttAtt()).forEach(function (row) {
    var ts = ttParseTs(row);
    if (!ts) return;
    if (from && !isNaN(from) && ts < from) return;
    if (to && !isNaN(to) && ts > to) return;
    out.push({
      code: ttStr(row[2]), name: ttStr(row[3]),
      type: ttStr(row[4]) === 'выход' ? 'out' : 'in',
      ts: ts.toISOString(),
      lat: ttNum(row[5]), lng: ttNum(row[6]), accuracy: ttNum(row[7]), distance: ttNum(row[8]),
      zone: ttStr(row[9]), device: ttStr(row[11])
    });
  });
  out.sort(function (a, b) { return a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0; });
  return { ok: true, rows: out };
}
