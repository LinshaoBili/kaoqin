/*
 * 学号绑定记录的存储层（网页端）。
 *
 * 与安卓端 `shared/src/BindCodec.kt` **使用同一套字节格式**：
 * ```
 * 0..3    magic "KQB1"
 * 4..19   salt 16 字节
 * 20..31  iv   12 字节
 * 32..    AES-256-GCM 密文（含 16 字节认证标签）
 * ```
 * PBKDF2-HMAC-SHA256 / 20000 轮 / 256 位，AAD = magic。
 * 参数必须一字不差，否则「手机按代码恢复」和「网页导出的恢复码」互相打不开。
 * 两边都有用例：`_device/gen_bind_vectors.js` 生成的包由 `BindJvmCheck` 解，
 * 反过来 Kotlin 生成的包也由 Node 解（见 build-tools/verify_binding.py）。
 *
 * 网页端做不到「写到公共文件夹」——浏览器没有这种能力。
 * 折中方案是两条：localStorage（清站点数据前一直在）+ **导出恢复码**（可抄到任何地方，
 * 换设备/换浏览器都能导回来）。导出的就是上面那个加密容器的 base64，不泄露明文。
 */
(function (global) {
  'use strict';

  var MAGIC = new Uint8Array([0x4B, 0x51, 0x42, 0x31]); // "KQB1"
  var PASSPHRASE = 'KaoQin.StudentCode.v1|bind-record';
  var ITERATIONS = 20000;
  var KEY_BITS = 256;
  var SALT_LEN = 16;
  var IV_LEN = 12;

  var STORE_KEY = 'kaoqin.bind.v2';
  // 明文形态只用于「当前环境没有 WebCrypto」（例如 file:// 打开），带前缀便于识别
  var PLAIN_PREFIX = 'P1.';

  var subtle = (global.crypto && global.crypto.subtle) ? global.crypto.subtle : null;

  // ---------------------------------------------------------------- base64

  function b64encode(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return global.btoa(s);
  }

  function b64decode(str) {
    var bin = global.atob(str);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  // ---------------------------------------------------------------- 加密容器

  function concat(a, b, c, d) {
    var out = new Uint8Array(a.length + b.length + c.length + d.length);
    var at = 0;
    out.set(a, at); at += a.length;
    out.set(b, at); at += b.length;
    out.set(c, at); at += c.length;
    out.set(d, at);
    return out;
  }

  function deriveKey(salt) {
    var enc = new TextEncoder();
    return subtle.importKey('raw', enc.encode(PASSPHRASE), 'PBKDF2', false, ['deriveKey'])
      .then(function (base) {
        return subtle.deriveKey(
          { name: 'PBKDF2', salt: salt, iterations: ITERATIONS, hash: 'SHA-256' },
          base,
          { name: 'AES-GCM', length: KEY_BITS },
          false,
          ['encrypt', 'decrypt']
        );
      });
  }

  function sealRecord(rec) {
    var body = JSON.stringify({ no: rec.no });

    if (!subtle) {
      return Promise.resolve(PLAIN_PREFIX + b64encode(new TextEncoder().encode(body)));
    }

    var salt = global.crypto.getRandomValues(new Uint8Array(SALT_LEN));
    var iv = global.crypto.getRandomValues(new Uint8Array(IV_LEN));
    return deriveKey(salt).then(function (key) {
      return subtle.encrypt(
        { name: 'AES-GCM', iv: iv, additionalData: MAGIC, tagLength: 128 },
        key,
        new TextEncoder().encode(body)
      );
    }).then(function (ct) {
      return b64encode(concat(MAGIC, salt, iv, new Uint8Array(ct)));
    });
  }

  function openToken(token) {
    if (!token) return Promise.resolve(null);

    if (token.indexOf(PLAIN_PREFIX) === 0) {
      try {
        var raw = new TextDecoder().decode(b64decode(token.slice(PLAIN_PREFIX.length)));
        return Promise.resolve(normalize(JSON.parse(raw)));
      } catch (e) {
        return Promise.resolve(null);
      }
    }

    var bytes;
    try {
      bytes = b64decode(token);
    } catch (e) {
      return Promise.resolve(null);
    }
    if (bytes.length < 4 + SALT_LEN + IV_LEN + 16) return Promise.resolve(null);
    for (var i = 0; i < 4; i++) {
      if (bytes[i] !== MAGIC[i]) return Promise.resolve(null);
    }
    if (!subtle) return Promise.resolve(null);

    var salt = bytes.slice(4, 4 + SALT_LEN);
    var iv = bytes.slice(4 + SALT_LEN, 4 + SALT_LEN + IV_LEN);
    var body = bytes.slice(4 + SALT_LEN + IV_LEN);

    return deriveKey(salt).then(function (key) {
      return subtle.decrypt(
        { name: 'AES-GCM', iv: iv, additionalData: MAGIC, tagLength: 128 },
        key,
        body
      );
    }).then(function (pt) {
      return normalize(JSON.parse(new TextDecoder().decode(pt)));
    }).catch(function () {
      // 被改过 / 密钥不对：一律当成「没有可用记录」，绝不放行
      return null;
    });
  }

  function normalize(o) {
    if (!o || typeof o.no !== 'string' || !o.no) return null;
    return { no: o.no };
  }

  // ---------------------------------------------------------------- 存储

  function readRaw() {
    try { return global.localStorage.getItem(STORE_KEY) || ''; } catch (e) { return ''; }
  }

  function writeRaw(v) {
    try { global.localStorage.setItem(STORE_KEY, v); return true; } catch (e) { return false; }
  }

  function load() {
    var token = readRaw();
    if (!token) return Promise.resolve({ record: null, damaged: false, token: '', encrypted: !!subtle });
    return openToken(token).then(function (rec) {
      return {
        record: rec,
        damaged: !rec,          // 有内容但解不开 = 被改过或损坏
        token: token,
        encrypted: token.indexOf(PLAIN_PREFIX) !== 0 && !!subtle
      };
    });
  }

  function save(no) {
    return saveRecord({ no: no });
  }

  /**
   * 直接落盘一条已有记录（"用恢复码恢复"走这里）。
   *
   * 注意它**不会**重置 `at`：恢复出来的是当初绑定的那一刻，
   * 否则"恢复一次"就能把冷静期刷新，等于给了个绕过口子。
   */
  function saveRecord(rec) {
    var clean = { no: rec.no };
    return sealRecord(clean).then(function (token) {
      var ok = writeRaw(token);
      return { ok: ok, record: clean, token: token };
    });
  }

    function clear() {
    try { global.localStorage.removeItem(STORE_KEY); } catch (e) { /* 无痕模式 */ }
  }


  global.BindStore = {
    supported: !!subtle,
    load: load,
    save: save,
    saveRecord: saveRecord,
    clear: clear,
    seal: sealRecord,
    open: openToken
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
