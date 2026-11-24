/* Генератор QR-кодов без внешних библиотек.
   Зачем свой: чтобы код был как можно менее плотным —
   • текст режется на сегменты: цифры, «буквенно-цифровой» режим (A–Z 0–9 пробел $%*+-./:)
     и байты; так ссылка занимает меньше бит, чем целиком в байтовом режиме;
   • выбирается самая маленькая версия (меньше модулей = крупнее точки) при уровне коррекции L,
     а потом коррекция поднимается до максимума, который помещается в ту же версию
     (M/Q/H, если влезает: размер тот же, а читается надёжнее);
   • рисуется только чистым чёрным по белому, с белым полем не меньше 4 модулей.
   Алгоритм — по стандарту ISO/IEC 18004 (по мотивам библиотеки Project Nayuki, MIT). */
(function (root) {
  "use strict";

  var ECL = { L: 0, M: 1, Q: 2, H: 3 };
  var ECL_FORMAT = [1, 0, 3, 2];
  var ECC_PER_BLOCK = [
    [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
    [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30]
  ];
  var NUM_BLOCKS = [
    [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
    [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
    [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
    [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81]
  ];

  /* режимы: биты режима и длины счётчика символов для версий 1–9, 10–26, 27–40 */
  var BYTE = { name: "byte", bits: 4, cc: [8, 16, 16] };
  var ALNUM = { name: "alnum", bits: 2, cc: [9, 11, 13] };
  var NUMERIC = { name: "numeric", bits: 1, cc: [10, 12, 14] };
  var MODES = [BYTE, ALNUM, NUMERIC];
  var ALNUM_SET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:";

  function ccIndex(ver) { return ver <= 9 ? 0 : ver <= 26 ? 1 : 2; }
  function utf8(cp) {
    if (cp < 0x80) return [cp];
    if (cp < 0x800) return [0xC0 | cp >> 6, 0x80 | cp & 63];
    if (cp < 0x10000) return [0xE0 | cp >> 12, 0x80 | cp >> 6 & 63, 0x80 | cp & 63];
    return [0xF0 | cp >> 18, 0x80 | cp >> 12 & 63, 0x80 | cp >> 6 & 63, 0x80 | cp & 63];
  }
  function codePoints(s) {
    var out = [];
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c >= 0xD800 && c < 0xDC00 && i + 1 < s.length) {
        var d = s.charCodeAt(i + 1);
        if (d >= 0xDC00 && d < 0xE000) { out.push(0x10000 + (c - 0xD800) * 0x400 + (d - 0xDC00)); i++; continue; }
      }
      out.push(c);
    }
    return out;
  }
  function canEncode(mode, cp) {
    if (mode === BYTE) return true;
    if (mode === NUMERIC) return cp >= 48 && cp <= 57;
    return cp < 128 && ALNUM_SET.indexOf(String.fromCharCode(cp)) >= 0;
  }

  /* оптимальное разбиение на сегменты (динамика по стоимости в 1/6 бита) */
  function optimalModes(cps, ver) {
    var ci = ccIndex(ver);
    var head = MODES.map(function (m) { return (4 + m.cc[ci]) * 6; });
    var prev = head.slice();
    var choice = [];
    for (var i = 0; i < cps.length; i++) {
      var cp = cps[i], cur = [Infinity, Infinity, Infinity], from = [-1, -1, -1];
      cur[0] = prev[0] + utf8(cp).length * 48; from[0] = 0;
      if (canEncode(ALNUM, cp)) { cur[1] = prev[1] + 33; from[1] = 1; }
      if (canEncode(NUMERIC, cp)) { cur[2] = prev[2] + 20; from[2] = 2; }
      /* после символа можно закончить сегмент и начать новый в другом режиме */
      var fixed = cur.slice(), fixedFrom = from.slice();
      for (var j = 0; j < 3; j++) {
        for (var k = 0; k < 3; k++) {
          if (fixedFrom[k] < 0) continue;
          var c2 = Math.ceil(fixed[k] / 6) * 6 + head[j];
          if (from[j] < 0 || c2 < cur[j]) { cur[j] = c2; from[j] = k; }
        }
      }
      choice.push(from);
      prev = cur;
    }
    var best = 0;
    for (var m = 1; m < 3; m++) if (prev[m] < prev[best]) best = m;
    var modes = new Array(cps.length);
    for (var t = cps.length - 1; t >= 0; t--) { best = choice[t][best]; modes[t] = best; }
    return modes;
  }

  function BitBuf() { this.bits = []; }
  BitBuf.prototype.put = function (val, len) {
    for (var i = len - 1; i >= 0; i--) this.bits.push((val >>> i) & 1);
  };

  function makeSegments(text, ver) {
    var cps = codePoints(text);
    if (!cps.length) return [];
    var modes = optimalModes(cps, ver), segs = [], start = 0;
    for (var i = 1; i <= cps.length; i++) {
      if (i === cps.length || modes[i] !== modes[start]) {
        segs.push(encodeSeg(MODES[modes[start]], cps.slice(start, i)));
        start = i;
      }
    }
    return segs;
  }
  function encodeSeg(mode, cps) {
    var bb = new BitBuf(), count = cps.length, i;
    if (mode === BYTE) {
      count = 0;
      cps.forEach(function (cp) { utf8(cp).forEach(function (b) { bb.put(b, 8); count++; }); });
    } else if (mode === ALNUM) {
      for (i = 0; i + 1 < cps.length; i += 2)
        bb.put(ALNUM_SET.indexOf(String.fromCharCode(cps[i])) * 45 + ALNUM_SET.indexOf(String.fromCharCode(cps[i + 1])), 11);
      if (i < cps.length) bb.put(ALNUM_SET.indexOf(String.fromCharCode(cps[i])), 6);
    } else {
      for (i = 0; i < cps.length; i += 3) {
        var n = Math.min(3, cps.length - i), v = 0;
        for (var j = 0; j < n; j++) v = v * 10 + (cps[i + j] - 48);
        bb.put(v, n * 3 + 1);
      }
    }
    return { mode: mode, count: count, bits: bb.bits };
  }
  function segsBits(segs, ver) {
    var ci = ccIndex(ver), total = 0;
    for (var i = 0; i < segs.length; i++) {
      if (segs[i].count >= (1 << segs[i].mode.cc[ci])) return Infinity;
      total += 4 + segs[i].mode.cc[ci] + segs[i].bits.length;
    }
    return total;
  }

  function rawModules(ver) {
    var r = (16 * ver + 128) * ver + 64;
    if (ver >= 2) {
      var na = Math.floor(ver / 7) + 2;
      r -= (25 * na - 10) * na - 55;
      if (ver >= 7) r -= 36;
    }
    return r;
  }
  function dataCodewords(ver, ecl) {
    return Math.floor(rawModules(ver) / 8) - ECC_PER_BLOCK[ecl][ver] * NUM_BLOCKS[ecl][ver];
  }

  /* Рид — Соломон над GF(256), многочлен 0x11D */
  function gfMul(x, y) {
    var z = 0;
    for (var i = 7; i >= 0; i--) {
      z = (z << 1) ^ ((z >>> 7) * 0x11D);
      z ^= ((y >>> i) & 1) * x;
    }
    return z & 0xFF;
  }
  function rsDivisor(degree) {
    var res = [];
    for (var i = 0; i < degree - 1; i++) res.push(0);
    res.push(1);
    var root = 1;
    for (i = 0; i < degree; i++) {
      for (var j = 0; j < res.length; j++) {
        res[j] = gfMul(res[j], root);
        if (j + 1 < res.length) res[j] ^= res[j + 1];
      }
      root = gfMul(root, 0x02);
    }
    return res;
  }
  function rsRemainder(data, div) {
    var res = div.map(function () { return 0; });
    data.forEach(function (b) {
      var f = b ^ res.shift();
      res.push(0);
      div.forEach(function (coef, i) { res[i] ^= gfMul(coef, f); });
    });
    return res;
  }
  function addEcc(data, ver, ecl) {
    var nb = NUM_BLOCKS[ecl][ver], eccLen = ECC_PER_BLOCK[ecl][ver];
    var raw = Math.floor(rawModules(ver) / 8);
    var numShort = nb - raw % nb, shortLen = Math.floor(raw / nb);
    var blocks = [], div = rsDivisor(eccLen), k = 0;
    for (var i = 0; i < nb; i++) {
      var dat = data.slice(k, k + shortLen - eccLen + (i < numShort ? 0 : 1));
      k += dat.length;
      var ecc = rsRemainder(dat, div);
      if (i < numShort) dat.push(0);
      blocks.push(dat.concat(ecc));
    }
    var out = [];
    for (i = 0; i < blocks[0].length; i++) {
      for (var j = 0; j < blocks.length; j++) {
        if (i !== shortLen - eccLen || j >= numShort) out.push(blocks[j][i]);
      }
    }
    return out;
  }

  function alignPositions(ver) {
    if (ver === 1) return [];
    var size = ver * 4 + 17, na = Math.floor(ver / 7) + 2;
    var step = ver === 32 ? 26 : Math.ceil((ver * 4 + 4) / (na * 2 - 2)) * 2;
    var res = [6];
    for (var pos = size - 7; res.length < na; pos -= step) res.splice(1, 0, pos);
    return res;
  }

  function Matrix(ver, ecl) {
    this.ver = ver; this.ecl = ecl; this.size = ver * 4 + 17;
    this.m = []; this.fn = [];
    for (var y = 0; y < this.size; y++) {
      this.m.push(new Array(this.size).fill(false));
      this.fn.push(new Array(this.size).fill(false));
    }
  }
  Matrix.prototype.setFn = function (x, y, dark) { this.m[y][x] = dark; this.fn[y][x] = true; };
  Matrix.prototype.drawFunctions = function () {
    var s = this.size, i, j;
    for (i = 0; i < s; i++) { this.setFn(6, i, i % 2 === 0); this.setFn(i, 6, i % 2 === 0); }
    this.finder(3, 3); this.finder(s - 4, 3); this.finder(3, s - 4);
    var ap = alignPositions(this.ver), n = ap.length;
    for (i = 0; i < n; i++) {
      for (j = 0; j < n; j++) {
        if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) continue;
        for (var dy = -2; dy <= 2; dy++)
          for (var dx = -2; dx <= 2; dx++)
            this.setFn(ap[i] + dx, ap[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
    this.formatBits(0);
    this.versionBits();
  };
  Matrix.prototype.finder = function (x, y) {
    for (var dy = -4; dy <= 4; dy++) {
      for (var dx = -4; dx <= 4; dx++) {
        var d = Math.max(Math.abs(dx), Math.abs(dy)), xx = x + dx, yy = y + dy;
        if (xx >= 0 && xx < this.size && yy >= 0 && yy < this.size) this.setFn(xx, yy, d !== 2 && d !== 4);
      }
    }
  };
  Matrix.prototype.formatBits = function (mask) {
    var data = ECL_FORMAT[this.ecl] << 3 | mask, rem = data, i;
    for (i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    var bits = (data << 10 | rem) ^ 0x5412, s = this.size;
    var b = function (k) { return ((bits >>> k) & 1) !== 0; };
    for (i = 0; i <= 5; i++) this.setFn(8, i, b(i));
    this.setFn(8, 7, b(6)); this.setFn(8, 8, b(7)); this.setFn(7, 8, b(8));
    for (i = 9; i < 15; i++) this.setFn(14 - i, 8, b(i));
    for (i = 0; i < 8; i++) this.setFn(s - 1 - i, 8, b(i));
    for (i = 8; i < 15; i++) this.setFn(8, s - 15 + i, b(i));
    this.setFn(8, s - 8, true);
  };
  Matrix.prototype.versionBits = function () {
    if (this.ver < 7) return;
    var rem = this.ver, i;
    for (i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
    var bits = this.ver << 12 | rem;
    for (i = 0; i < 18; i++) {
      var bit = ((bits >>> i) & 1) !== 0, a = this.size - 11 + i % 3, c = Math.floor(i / 3);
      this.setFn(a, c, bit); this.setFn(c, a, bit);
    }
  };
  Matrix.prototype.drawCodewords = function (data) {
    var i = 0, s = this.size;
    for (var right = s - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (var v = 0; v < s; v++) {
        for (var j = 0; j < 2; j++) {
          var x = right - j, up = ((right + 1) & 2) === 0, y = up ? s - 1 - v : v;
          if (!this.fn[y][x] && i < data.length * 8) {
            this.m[y][x] = ((data[i >>> 3] >>> (7 - (i & 7))) & 1) !== 0;
            i++;
          }
        }
      }
    }
  };
  var MASKS = [
    function (x, y) { return (x + y) % 2 === 0; },
    function (x, y) { return y % 2 === 0; },
    function (x) { return x % 3 === 0; },
    function (x, y) { return (x + y) % 3 === 0; },
    function (x, y) { return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; },
    function (x, y) { return x * y % 2 + x * y % 3 === 0; },
    function (x, y) { return (x * y % 2 + x * y % 3) % 2 === 0; },
    function (x, y) { return ((x + y) % 2 + x * y % 3) % 2 === 0; }
  ];
  Matrix.prototype.applyMask = function (mask) {
    var f = MASKS[mask];
    for (var y = 0; y < this.size; y++)
      for (var x = 0; x < this.size; x++)
        if (!this.fn[y][x] && f(x, y)) this.m[y][x] = !this.m[y][x];
  };
  Matrix.prototype.penalty = function () {
    var s = this.size, m = this.m, score = 0, x, y, dark = 0;
    function line(get) {
      var p = 0, run = 1;
      for (var i = 1; i <= s; i++) {
        if (i < s && get(i) === get(i - 1)) { run++; continue; }
        if (run >= 5) p += run - 2;
        run = 1;
      }
      /* похожие на искатель последовательности 1011101 с четырьмя светлыми с одной стороны */
      var at = function (i) { return i >= 0 && i < s ? get(i) : false; };
      for (i = -4; i < s; i++) {
        if (at(i) && !at(i + 1) && at(i + 2) && at(i + 3) && at(i + 4) && !at(i + 5) && at(i + 6)) {
          var before = !at(i - 1) && !at(i - 2) && !at(i - 3) && !at(i - 4);
          var after = !at(i + 7) && !at(i + 8) && !at(i + 9) && !at(i + 10);
          if (before || after) p += 40;
        }
      }
      return p;
    }
    for (y = 0; y < s; y++) score += line(function (i) { return m[y][i]; });
    for (x = 0; x < s; x++) score += line(function (i) { return m[i][x]; });
    for (y = 0; y < s - 1; y++)
      for (x = 0; x < s - 1; x++)
        if (m[y][x] === m[y][x + 1] && m[y][x] === m[y + 1][x] && m[y][x] === m[y + 1][x + 1]) score += 3;
    for (y = 0; y < s; y++) for (x = 0; x < s; x++) if (m[y][x]) dark++;
    var total = s * s;
    score += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
    return score;
  };

  /* text → { version, ecl: "L"|"M"|"Q"|"H", size, modules: [[bool]], segments } */
  function encode(text, opts) {
    opts = opts || {};
    var minEcl = ECL[opts.minEcl || "L"], ver, segs, used;
    for (ver = opts.minVersion || 1; ver <= 40; ver++) {
      segs = makeSegments(String(text), ver);
      used = segsBits(segs, ver);
      if (used <= dataCodewords(ver, minEcl) * 8) break;
    }
    if (ver > 40) throw new Error("Слишком длинный текст для QR-кода");
    /* размер выбран — поднимаем коррекцию, пока данные помещаются в ту же версию */
    var ecl = minEcl;
    for (var e = minEcl + 1; e <= 3; e++) if (used <= dataCodewords(ver, e) * 8) ecl = e;

    var cap = dataCodewords(ver, ecl) * 8, bb = new BitBuf();
    segs.forEach(function (sg) {
      bb.put(sg.mode.bits, 4);
      bb.put(sg.count, sg.mode.cc[ccIndex(ver)]);
      bb.bits = bb.bits.concat(sg.bits);
    });
    bb.put(0, Math.min(4, cap - bb.bits.length));
    bb.put(0, (8 - bb.bits.length % 8) % 8);
    for (var pad = 0xEC; bb.bits.length < cap; pad ^= 0xEC ^ 0x11) bb.put(pad, 8);
    var bytes = [];
    for (var i = 0; i < bb.bits.length; i += 8) {
      var v = 0;
      for (var j = 0; j < 8; j++) v = v << 1 | bb.bits[i + j];
      bytes.push(v);
    }

    var mx = new Matrix(ver, ecl);
    mx.drawFunctions();
    mx.drawCodewords(addEcc(bytes, ver, ecl));
    var best = -1, bestScore = Infinity;
    for (var mk = 0; mk < 8; mk++) {
      mx.applyMask(mk); mx.formatBits(mk);
      var sc = mx.penalty();
      if (sc < bestScore) { best = mk; bestScore = sc; }
      mx.applyMask(mk);
    }
    mx.applyMask(best); mx.formatBits(best);
    return {
      version: ver,
      ecl: "LMQH"[ecl],
      mask: best,
      size: mx.size,
      modules: mx.m,
      segments: segs.map(function (sg) { return { mode: sg.mode.name, count: sg.count }; })
    };
  }

  /* Рисует код на canvas: целое число пикселей на модуль, белое поле quiet модулей (не меньше 4),
     только #000 и #fff — без сглаживания и полутонов. */
  function toCanvas(qr, modulePx, quiet, doc) {
    quiet = Math.max(4, quiet || 4);
    modulePx = Math.max(1, Math.round(modulePx || 8));
    var full = (qr.size + quiet * 2) * modulePx;
    var cv = (doc || document).createElement("canvas");
    cv.width = cv.height = full;
    var ctx = cv.getContext("2d");
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, full, full);
    ctx.fillStyle = "#000000";
    for (var y = 0; y < qr.size; y++)
      for (var x = 0; x < qr.size; x++)
        if (qr.modules[y][x]) ctx.fillRect((x + quiet) * modulePx, (y + quiet) * modulePx, modulePx, modulePx);
    return cv;
  }

  var api = { encode: encode, toCanvas: toCanvas, ALNUM_SET: ALNUM_SET };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.TTQR = api;
})(typeof self !== "undefined" ? self : this);
