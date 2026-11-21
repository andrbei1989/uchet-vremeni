/**
 * Учёт рабочего времени — сервер на Google Apps Script.
 *
 * 1. Создайте Google Таблицу.
 * 2. Расширения → Apps Script, вставьте этот код целиком, сохраните.
 * 3. Развернуть → Новое развёртывание → тип «Веб-приложение».
 *    «Запуск от имени»: Я.  «У кого есть доступ»: Все.
 * 4. Скопируйте ссылку на /exec — её нужно вставить в приложении администратора
 *    (Настройки → URL веб-приложения). После этого печатайте QR-коды заново.
 *
 * Листы «Отметки», «Регистрации» и «Настройки» создаются автоматически.
 */

var SHEET_ATT = 'Отметки';
var SHEET_REG = 'Регистрации';
var SHEET_SET = 'Настройки';

var HEAD_ATT = ['Дата', 'Время', 'Код', 'ФИО', 'Тип', 'Широта', 'Долгота',
  'Точность (м)', 'Расстояние (м)', 'В зоне', 'Источник', 'Устройство', 'Метка ISO'];
var HEAD_REG = ['Дата регистрации', 'Код', 'ФИО', 'Ключ устройства', 'Device ID', 'Устройство',
  'Статус', 'Обновлено'];

function doGet(e) {
  var p = (e && e.parameter) || {};
  var cb = p.callback || '';
  var res;
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(25000);
    var a = String(p.action || '');
    if (a === 'ping') res = { ok: true, ts: new Date().toISOString() };
    else if (a === 'register') res = ttRegister(p);
    else if (a === 'check') res = ttCheck(p);
    else if (a === 'append') res = ttAppend(p);
    else if (a === 'revoke') res = ttRevoke(p);
    else if (a === 'status') res = ttStatus();
    else if (a === 'board') res = ttBoard();
    else if (a === 'read') res = ttRead(p);
    else if (a === 'saveSettings') res = ttSaveSettings(p);
    else if (a === 'getSettings') res = ttGetSettings();
    else res = { ok: false, error: 'unknown_action' };
  } catch (err) {
    res = { ok: false, error: String(err) };
  } finally {
    try { lock.releaseLock(); } catch (ignore) {}
  }
  var out = cb ? cb + '(' + JSON.stringify(res) + ')' : JSON.stringify(res);
  return ContentService.createTextOutput(out)
    .setMimeType(cb ? ContentService.MimeType.JAVASCRIPT : ContentService.MimeType.JSON);
}

/* ---------------- листы ---------------- */
function ttSheet(name, headers) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.appendRow(headers);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, headers.length).setFontWeight('bold');
  }
  return sh;
}
function ttAtt() { return ttSheet(SHEET_ATT, HEAD_ATT); }
function ttReg() { return ttSheet(SHEET_REG, HEAD_REG); }
function ttSet() { return ttSheet(SHEET_SET, ['Параметр', 'Значение']); }

function ttRows(sh) {
  var last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, Math.max(sh.getLastColumn(), 1)).getValues();
}
function ttFmt(d) {
  if (!d) return '';
  return Utilities.formatDate(new Date(d), Session.getScriptTimeZone(), 'dd.MM.yyyy HH:mm');
}
function ttPick(p, names) {
  for (var i = 0; i < names.length; i++) {
    var v = p[names[i]];
    if (v !== undefined && v !== null && String(v) !== '') return String(v);
  }
  return '';
}
function ttRecord(p) {
  if (!p.record) return {};
  try { return JSON.parse(p.record); } catch (err) { return {}; }
}

/* ---------------- геозона ---------------- */
function ttHaversine(lat1, lon1, lat2, lon2) {
  var R = 6371000, toR = Math.PI / 180;
  var dLat = (lat2 - lat1) * toR;
  var dLon = (lon2 - lon1) * toR;
  var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * toR) * Math.cos(lat2 * toR) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return Math.round(2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

/** Настройки офиса хранятся в листе «Настройки»: office_lat, office_lng, radius_m. */
function ttSettings() {
  var out = { lat: null, lng: null, radius: 100 };
  var data = ttRows(ttSet());
  for (var i = 0; i < data.length; i++) {
    var k = String(data[i][0] || '');
    var v = String(data[i][1] || '').replace(',', '.');
    if (k === 'office_lat' && v) out.lat = parseFloat(v);
    if (k === 'office_lng' && v) out.lng = parseFloat(v);
    if (k === 'radius_m' && v) out.radius = parseFloat(v) || 100;
  }
  return out;
}

function ttWriteSetting(key, value) {
  var sh = ttSet();
  var data = ttRows(sh);
  for (var i = 0; i < data.length; i++) {
    if (String(data[i][0]) === key) {
      sh.getRange(i + 2, 2).setValue(value);
      return;
    }
  }
  sh.appendRow([key, value]);
}

function ttSaveSettings(p) {
  if (p.lat !== undefined) ttWriteSetting('office_lat', ttPick(p, ['lat']));
  if (p.lng !== undefined) ttWriteSetting('office_lng', ttPick(p, ['lng']));
  if (p.radius !== undefined) ttWriteSetting('radius_m', ttPick(p, ['radius']));
  var s = ttSettings();
  return { ok: true, lat: s.lat, lng: s.lng, radius: s.radius };
}

function ttGetSettings() {
  var s = ttSettings();
  return { ok: true, lat: s.lat, lng: s.lng, radius: s.radius };
}

/* ---------------- регистрация ---------------- */
function ttRegister(p) {
  var sh = ttReg();
  var data = ttRows(sh);
  var now = new Date();
  var code = ttPick(p, ['empCode', 'code', 'employee']);
  var key = ttPick(p, ['key', 'token', 'pin']);
  var device = ttPick(p, ['deviceId', 'device']);
  var label = ttPick(p, ['deviceLabel', 'deviceName']);
  var name = ttPick(p, ['empName', 'name']);

  for (var i = 0; i < data.length; i++) {
    if (String(data[i][1]) === code) {
      var row = i + 2;
      var bound = String(data[i][4] || '');
      if (bound && bound !== device) {
        return { ok: false, error: 'used', empName: String(data[i][2] || ''), boundAt: ttFmt(data[i][0]) };
      }
      sh.getRange(row, 3, 1, 6).setValues([[name || data[i][2], key || data[i][3], device, label, 'активен', now]]);
      return { ok: true, repeat: true, empCode: code, empName: String(name || data[i][2] || '') };
    }
  }
  sh.appendRow([now, code, name, key, device, label, 'активен', now]);
  return { ok: true, first: true, empCode: code, empName: name };
}

function ttCheck(p) {
  var data = ttRows(ttReg());
  var code = ttPick(p, ['empCode', 'code']);
  var key = ttPick(p, ['key', 'token', 'pin']);
  var device = ttPick(p, ['deviceId', 'device']);
  for (var i = 0; i < data.length; i++) {
    if (!code || String(data[i][1]) !== code) continue;
    if (String(data[i][6]) === 'заблокирован') return { ok: false, error: 'blocked', empCode: data[i][1] };
    var boundDevice = String(data[i][4] || '');
    if (boundDevice && device && boundDevice !== device) {
      return { ok: false, error: 'device_mismatch', empCode: data[i][1] };
    }
    var storedKey = String(data[i][3] || '');
    if (storedKey && key && storedKey !== key) {
      return { ok: false, error: 'invalid_key', empCode: data[i][1] };
    }
    return { ok: true, status: 'active', empCode: data[i][1], empName: String(data[i][2] || '') };
  }
  return { ok: false, error: 'not_registered' };
}

/* ---------------- отметки ---------------- */
function ttAppend(p) {
  var r = ttRecord(p);
  var code = ttPick(p, ['empCode', 'code']) || String(r.empCode || '');
  var name = ttPick(p, ['empName', 'name']) || String(r.empName || '');
  var type = ttPick(p, ['type']) || String(r.type || 'in');
  var ts = r.ts ? new Date(r.ts) : new Date();
  var tz = Session.getScriptTimeZone();
  var date = Utilities.formatDate(ts, tz, 'dd.MM.yyyy');
  var time = Utilities.formatDate(ts, tz, 'HH:mm:ss');

  var lat = r.lat === null || r.lat === undefined ? '' : Number(r.lat);
  var lng = r.lng === null || r.lng === undefined ? '' : Number(r.lng);
  var acc = r.accuracy === null || r.accuracy === undefined ? '' : Number(r.accuracy);
  var device = String(r.deviceLabel || r.device || '');
  var source = r.source === 'manual' ? 'ручной' : 'QR';

  /* геозона считается здесь, а не на телефоне сотрудника */
  var sett = ttSettings();
  var distance = '';
  var zone = 'не настроена';
  if (sett.lat !== null && sett.lng !== null && lat !== '' && lng !== '') {
    distance = ttHaversine(sett.lat, sett.lng, Number(lat), Number(lng));
    zone = distance <= (sett.radius || 100) ? 'в зоне' : 'вне зоны';
  } else if (lat === '' || lng === '') {
    zone = 'без координат';
  }

  ttAtt().appendRow([date, time, code, name, type === 'out' ? 'выход' : 'вход',
    lat, lng, acc, distance, zone, source, device, ts.toISOString()]);

  return {
    ok: true,
    inZone: zone === 'в зоне' ? true : (zone === 'вне зоны' ? false : null),
    zone: zone,
    distance: distance === '' ? null : distance
  };
}

function ttRevoke(p) {
  var sh = ttReg();
  var data = ttRows(sh);
  var code = ttPick(p, ['empCode', 'code']);
  var unblock = String(p.unblock) === 'true' || String(p.unblock) === '1';
  for (var i = 0; i < data.length; i++) {
    if (String(data[i][1]) === code) {
      var row = i + 2;
      if (unblock) {
        sh.getRange(row, 4, 1, 4).setValues([['', '', '', 'активен']]);
      } else {
        sh.getRange(row, 7).setValue('заблокирован');
      }
      sh.getRange(row, 8).setValue(new Date());
      return { ok: true, empCode: code, unblock: unblock };
    }
  }
  return { ok: false, error: 'not_found' };
}

function ttStatus() {
  var data = ttRows(ttReg());
  var rows = [];
  for (var i = 0; i < data.length; i++) {
    rows.push({
      empCode: String(data[i][1] || ''),
      empName: String(data[i][2] || ''),
      deviceId: String(data[i][4] || ''),
      deviceLabel: String(data[i][5] || ''),
      boundAt: ttFmt(data[i][0]),
      status: String(data[i][6] || '')
    });
  }
  return { ok: true, rows: rows };
}

/* ---------------- «кто на смене» ---------------- */
function ttParseTs(dateStr, timeStr, isoStr) {
  if (isoStr) {
    var d = new Date(String(isoStr));
    if (!isNaN(d.getTime())) return d;
  }
  var dm = /(\d{2})\.(\d{2})\.(\d{4})/.exec(String(dateStr || ''));
  var tm = /(\d{2}):(\d{2})(?::(\d{2}))?/.exec(String(timeStr || ''));
  if (!dm) return null;
  return new Date(Number(dm[3]), Number(dm[2]) - 1, Number(dm[1]),
    tm ? Number(tm[1]) : 0, tm ? Number(tm[2]) : 0, tm && tm[3] ? Number(tm[3]) : 0);
}

/** Последняя отметка каждого сотрудника + список зарегистрированных. */
function ttBoard() {
  var regs = ttRows(ttReg());
  var att = ttRows(ttAtt());
  var last = {};
  for (var i = 0; i < att.length; i++) {
    var code = String(att[i][2] || '');
    if (!code) continue;
    var ts = ttParseTs(att[i][0], att[i][1], att[i][12]);
    if (!ts) continue;
    var prev = last[code];
    if (!prev || ts.getTime() > prev.ts.getTime()) {
      last[code] = {
        ts: ts,
        type: String(att[i][4] || ''),
        date: String(att[i][0] || ''),
        time: String(att[i][1] || ''),
        zone: String(att[i][9] || ''),
        distance: att[i][8],
        lat: att[i][5],
        lng: att[i][6],
        device: String(att[i][11] || ''),
        source: String(att[i][10] || '')
      };
    }
  }
  var rows = [];
  for (var j = 0; j < regs.length; j++) {
    var rc = String(regs[j][1] || '');
    if (!rc) continue;
    var l = last[rc];
    var onShift = l && l.type === 'вход';
    rows.push({
      empCode: rc,
      empName: String(regs[j][2] || ''),
      registered: String(regs[j][6] || '') === 'активен',
      blocked: String(regs[j][6] || '') === 'заблокирован',
      deviceLabel: String(regs[j][5] || ''),
      onShift: !!onShift,
      lastType: l ? l.type : '',
      lastDate: l ? l.date : '',
      lastTime: l ? l.time : '',
      lastIso: l ? l.ts.toISOString() : '',
      zone: l ? l.zone : '',
      distance: l ? l.distance : '',
      device: l ? l.device : ''
    });
  }
  rows.sort(function (a, b) {
    if (a.onShift !== b.onShift) return a.onShift ? -1 : 1;
    return String(b.lastIso).localeCompare(String(a.lastIso));
  });
  var sett = ttSettings();
  return { ok: true, rows: rows, settings: { lat: sett.lat, lng: sett.lng, radius: sett.radius }, now: new Date().toISOString() };
}

/** Все отметки за период — для табеля в приложении администратора. */
function ttRead(p) {
  var from = ttPick(p, ['from']) ? new Date(ttPick(p, ['from'])) : null;
  var to = ttPick(p, ['to']) ? new Date(ttPick(p, ['to'])) : null;
  var att = ttRows(ttAtt());
  var out = [];
  for (var i = 0; i < att.length; i++) {
    var ts = ttParseTs(att[i][0], att[i][1], att[i][12]);
    if (!ts) continue;
    if (from && ts < from) continue;
    if (to && ts > to) continue;
    out.push({
      empCode: String(att[i][2] || ''),
      empName: String(att[i][3] || ''),
      type: String(att[i][4] || '') === 'выход' ? 'out' : 'in',
      date: String(att[i][0] || ''),
      time: String(att[i][1] || ''),
      ts: ts.toISOString(),
      lat: att[i][5] === '' ? null : Number(att[i][5]),
      lng: att[i][6] === '' ? null : Number(att[i][6]),
      accuracy: att[i][7] === '' ? null : Number(att[i][7]),
      distance: att[i][8] === '' ? null : Number(att[i][8]),
      zone: String(att[i][9] || ''),
      inZone: String(att[i][9] || '') === 'в зоне',
      source: String(att[i][10] || '') === 'ручной' ? 'manual' : 'qr',
      device: String(att[i][11] || '')
    });
  }
  out.sort(function (a, b) { return a.ts.localeCompare(b.ts); });
  return { ok: true, rows: out, count: out.length };
}

