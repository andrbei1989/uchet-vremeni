/**
 * Учёт рабочего времени — приёмник Google Apps Script.
 * 1. Создайте Google Таблицу.
 * 2. Расширения → Apps Script, вставьте этот файл целиком, сохраните.
 * 3. Развернуть → Новое развёртывание → тип «Веб-приложение».
 *    «Запуск от имени»: Я.  «У кого есть доступ»: Все.
 * 4. Скопируйте ссылку, оканчивающуюся на /exec, и вставьте её в приложении
 *    в Настройки → Онлайн-регистрация → URL веб-приложения.
 * Листы «Отметки» и «Регистрации» создадутся сами при первом запросе.
 */

var SHEET_ATT = 'Отметки';
var SHEET_REG = 'Регистрации';

var HEAD_ATT = ['Дата', 'Время', 'Код', 'ФИО', 'PIN (3)', 'Тип', 'Широта', 'Долгота',
  'Точность (м)', 'Расстояние (м)', 'В зоне', 'Источник', 'Устройство'];
var HEAD_REG = ['Дата регистрации', 'Код', 'ФИО', 'PIN', 'Device ID', 'Устройство',
  'Статус', 'Обновлено'];

function doGet(e) {
  var p = (e && e.parameter) || {};
  var cb = p.callback || '';
  var res;
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
    var a = String(p.action || '');
    if (a === 'ping') res = { ok: true, ts: new Date().toISOString() };
    else if (a === 'register') res = ttRegister(p);
    else if (a === 'check') res = ttCheck(p);
    else if (a === 'append') res = ttAppend(p);
    else if (a === 'revoke') res = ttRevoke(p);
    else if (a === 'status') res = ttStatus();
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

function ttRows(sh) {
  var last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, Math.max(sh.getLastColumn(), 1)).getValues();
}

function ttFmt(d) {
  if (!d) return '';
  return Utilities.formatDate(new Date(d), Session.getScriptTimeZone(), 'dd.MM.yyyy HH:mm');
}

/** Достаёт первое непустое значение из списка возможных имён параметров. */
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

function ttRegister(p) {
  var sh = ttReg();
  var data = ttRows(sh);
  var now = new Date();
  var code = ttPick(p, ['empCode', 'code', 'employee']);
  var pin = ttPick(p, ['pin', 'pinCode']);
  var device = ttPick(p, ['deviceId', 'device']);
  var label = ttPick(p, ['deviceLabel', 'deviceName', 'device']);
  var name = ttPick(p, ['empName', 'name']);

  for (var i = 0; i < data.length; i++) {
    if (String(data[i][1]) === code) {
      var row = i + 2;
      var bound = String(data[i][4] || '');
      if (bound && bound !== device) {
        return { ok: false, error: 'used', empName: data[i][2], boundAt: ttFmt(data[i][0]) };
      }
      sh.getRange(row, 5, 1, 4).setValues([[device, label, 'активен', now]]);
      return { ok: true, repeat: true, pin: data[i][3], empCode: code, empName: data[i][2] };
    }
  }
  sh.appendRow([now, code, name, pin, device, label, 'активен', now]);
  return { ok: true, first: true, pin: pin, empCode: code, empName: name };
}

function ttCheck(p) {
  var data = ttRows(ttReg());
  var code = ttPick(p, ['empCode', 'code', 'employee']);
  var pin = ttPick(p, ['pin', 'pinCode']);
  for (var i = 0; i < data.length; i++) {
    var byCode = code && String(data[i][1]) === code;
    var byPin = pin && String(data[i][3]) === pin;
    if (byCode || byPin) {
      if (String(data[i][6]) === 'заблокирован') return { ok: false, error: 'blocked', empCode: data[i][1] };
      return { ok: true, status: 'active', empCode: data[i][1], empName: data[i][2] };
    }
  }
  return { ok: false, error: 'not_registered' };
}

function ttAppend(p) {
  var r = ttRecord(p);
  var code = ttPick(p, ['empCode', 'code']) || String(r.empCode || '');
  var name = ttPick(p, ['empName', 'name']) || String(r.empName || '');
  var type = ttPick(p, ['type']) || String(r.type || '');
  var pin = String(r.pin || '');
  var ts = r.ts ? new Date(r.ts) : new Date();
  var tz = Session.getScriptTimeZone();
  var date = Utilities.formatDate(ts, tz, 'dd.MM.yyyy');
  var time = Utilities.formatDate(ts, tz, 'HH:mm:ss');
  var lat = r.lat !== undefined && r.lat !== null ? r.lat : '';
  var lng = r.lng !== undefined && r.lng !== null ? r.lng : '';
  var acc = r.accuracy !== undefined && r.accuracy !== null ? r.accuracy : '';
  var dist = r.distance !== undefined && r.distance !== null ? r.distance : '';
  var inZone = r.inZone === true || r.inZone === 'true' || r.inZone === 1 ? 'да' : 'нет';
  var source = r.source === 'manual' ? 'ручной' : 'QR';
  var device = String(r.deviceLabel || r.device || '');

  ttAtt().appendRow([date, time, code, name, pin ? pin.slice(-3) : '', type === 'out' ? 'выход' : 'вход',
    lat, lng, acc, dist, inZone, source, device]);
  return { ok: true };
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
        sh.getRange(row, 5, 1, 3).setValues([['', '', 'активен']]);
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
      pin: String(data[i][3] || ''),
      deviceId: String(data[i][4] || ''),
      deviceLabel: String(data[i][5] || ''),
      boundAt: ttFmt(data[i][0]),
      status: String(data[i][6] || '')
    });
  }
  return { ok: true, rows: rows };
}

