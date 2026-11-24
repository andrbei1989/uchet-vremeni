/* Тесты QR-кодов. Запуск: node --test (или node --test tests/qr.test.js)
   Декодирование настоящим сканером (OpenCV) выполняется, если установлен python3 с opencv-contrib;
   иначе этот тест пропускается. */
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const { spawnSync } = require("child_process");
const QR = require("../qr.js");

const ROOT = path.join(__dirname, "..");
const ORIGIN = "https://andrbei1989.github.io";
const DIR = "/uchet-vremeni/";

/* загружаем из app.js раздел QR и строим ссылки так же, как панель администратора */
function appLinks(server) {
  const src = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");
  const def = /var DEFAULT_SERVER = "([^"]+)"/.exec(src)[1];
  const part = src.slice(src.indexOf("/* ================= QR"), src.indexOf("/* ================= модальные"));
  const ctx = { location: { origin: ORIGIN, pathname: DIR + "index.html" }, window: { TTQR: QR },
    DEFAULT_SERVER: def, AUTH: { server: server || def } };
  vm.runInNewContext(part + ";this.L={linkIn,linkOut,linkReg};", ctx);
  return ctx.L;
}
const EMP = { code: "EMP-001", key: "ABCD2345" };

test("короткие ссылки входа, выхода и привязки", () => {
  const L = appLinks();
  assert.strictEqual(L.linkIn(), "https://ANDRBEI1989.GITHUB.IO/uchet-vremeni/i/");
  assert.strictEqual(L.linkOut(), "https://ANDRBEI1989.GITHUB.IO/uchet-vremeni/o/");
  assert.strictEqual(L.linkReg(EMP), "https://ANDRBEI1989.GITHUB.IO/uchet-vremeni/r/?001ABCD2345");
  /* схема строчными: старые Android-сканеры не открывают «HTTPS://» */
  [L.linkIn(), L.linkOut(), L.linkReg(EMP)].forEach((u) => assert.ok(u.startsWith("https://")));
});

test("коды стали меньше прежних, коррекция не ниже, чем позволяет размер", () => {
  const L = appLinks();
  const oldIn = QR.encode(ORIGIN + DIR + "emp.html?t=in", { minEcl: "M" });
  const oldReg = QR.encode(ORIGIN + DIR + "emp.html?r=EMP-001&k=ABCD2345", { minEcl: "M" });
  const inQ = QR.encode(L.linkIn()), outQ = QR.encode(L.linkOut()), regQ = QR.encode(L.linkReg(EMP));
  assert.strictEqual(inQ.size, 29); assert.strictEqual(outQ.size, 29); assert.strictEqual(regQ.size, 29);
  assert.ok(inQ.size < oldIn.size, "вход: " + inQ.size + " < " + oldIn.size);
  assert.ok(regQ.size < oldReg.size, "привязка: " + regQ.size + " < " + oldReg.size);
  assert.strictEqual(inQ.ecl, "M");
  assert.strictEqual(outQ.ecl, "M");
  /* сотрудник с четырёхзначным номером тоже получает компактный код */
  assert.ok(QR.encode(L.linkReg({ code: "EMP-1234", key: "ZZZZ9999" })).size <= 33);
});

test("уровень коррекции поднимается, только если размер не растёт", () => {
  for (const t of ["A", "HELLO WORLD", "https://example.com/abc", "x".repeat(200)]) {
    const low = QR.encode(t, { minEcl: "L" });
    const order = "LMQH";
    for (const e of order.slice(order.indexOf(low.ecl) + 1)) {
      assert.ok(QR.encode(t, { minEcl: e }).version > low.version, t + ": " + e + " влез бы в ту же версию");
    }
  }
});

test("рисуется только #000 на #fff с белым полем 4 модуля", () => {
  const fills = [];
  const ctx = { set fillStyle(v) { this._f = v; }, get fillStyle() { return this._f; },
    fillRect(x, y, w, h) { fills.push([this._f, x, y, w, h]); } };
  const cv = { getContext: () => ctx };
  const doc = { createElement: () => cv };
  const q = QR.encode("https://ANDRBEI1989.GITHUB.IO/uchet-vremeni/i/");
  QR.toCanvas(q, 10, 1, doc);
  assert.strictEqual(cv.width, (q.size + 8) * 10, "белое поле меньше 4 модулей не бывает");
  assert.deepStrictEqual([...new Set(fills.map((f) => f[0]))].sort(), ["#000000", "#ffffff"]);
  const dark = fills.filter((f) => f[0] === "#000000");
  assert.ok(dark.every((f) => f[1] >= 40 && f[2] >= 40 && f[3] === 10 && f[4] === 10));
});

test("прежние ссылки по-прежнему ведут на emp.html", () => {
  const L = appLinks("https://script.google.com/macros/s/OTHER_server-1/exec");
  assert.match(L.linkIn(), /\/emp\.html\?t=in&s=/);
  assert.match(L.linkReg(EMP), /\/emp\.html\?r=EMP-001&k=ABCD2345&s=/);
  const emp = fs.readFileSync(path.join(ROOT, "emp.html"), "utf8");
  assert.match(emp, /qs\("r"\)/); assert.match(emp, /qs\("k"\)/); assert.match(emp, /qs\("t"\)/); assert.match(emp, /qs\("s"\)/);
});

function redirect(dir, search) {
  const html = fs.readFileSync(path.join(ROOT, dir, "index.html"), "utf8");
  const code = /<script>([\s\S]*?)<\/script>/.exec(html)[1];
  let to = null;
  vm.runInNewContext(code, { location: { search, replace: (u) => { to = u; } } });
  return to;
}
test("короткие страницы переводят на emp.html с нужными параметрами", () => {
  assert.strictEqual(redirect("i", ""), "../emp.html?t=in");
  assert.strictEqual(redirect("o", ""), "../emp.html?t=out");
  assert.strictEqual(redirect("i", "?s=X"), "../emp.html?t=in&s=X");
  assert.strictEqual(redirect("r", "?001ABCD2345"), "../emp.html?r=EMP-001&k=ABCD2345");
  assert.strictEqual(redirect("r", "?1234ZZZZ9999&s=X"), "../emp.html?r=EMP-1234&k=ZZZZ9999&s=X");
  assert.strictEqual(redirect("r", "?r=EMP-001&k=ABCD2345"), "../emp.html?r=EMP-001&k=ABCD2345");
});

test("коды читаются сканером (OpenCV)", (t) => {
  const probe = spawnSync("python3", ["-c", "import cv2; cv2.wechat_qrcode_WeChatQRCode"]);
  if (probe.status !== 0) return t.skip("нет python3 + opencv-contrib");
  const L = appLinks();
  const texts = [L.linkIn(), L.linkOut(), L.linkReg(EMP), L.linkReg({ code: "EMP-1234", key: "ZZZZ9999" }),
    "Привет 123", "0123456789", "x".repeat(300), "MIXED abc 123 ÄÖ " + "Z9".repeat(150)];
  for (const e of "LMQH") texts.push(e + ":" + "https://example.com/?q=".repeat(10));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "qr-"));
  const items = texts.map((text, i) => {
    const q = QR.encode(text), px = 6, quiet = 4, full = (q.size + quiet * 2) * px;
    const buf = Buffer.alloc(full * full, 255);
    for (let y = 0; y < q.size; y++) for (let x = 0; x < q.size; x++) if (q.modules[y][x])
      for (let a = 0; a < px; a++) buf.fill(0, ((y + quiet) * px + a) * full + (x + quiet) * px, ((y + quiet) * px + a) * full + (x + quiet + 1) * px);
    const file = path.join(tmp, i + ".pgm");
    fs.writeFileSync(file, Buffer.concat([Buffer.from(`P5 ${full} ${full} 255\n`), buf]));
    return { file, text };
  });
  const py = "import sys,json,cv2\nw=cv2.wechat_qrcode_WeChatQRCode()\nprint(json.dumps([list(w.detectAndDecode(cv2.imread(f,0))[0]) for f in json.load(sys.stdin)]))";
  const r = spawnSync("python3", ["-c", py], { input: JSON.stringify(items.map((i) => i.file)) });
  assert.strictEqual(r.status, 0, String(r.stderr));
  JSON.parse(r.stdout).forEach((got, i) => assert.deepStrictEqual(got, [items[i].text], "не прочитался: " + items[i].text.slice(0, 40)));
});
