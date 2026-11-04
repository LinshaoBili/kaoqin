/*
 * 考勤二维码载荷（网页端实现）。
 *
 * 与 Android 端 shared/src/ScanCode.kt **逐字对应**：
 * 前缀、规范化规则、校验算法三处任何一处不一致，学生网页生成的码老师就扫不出来。
 * 因此这里的每个函数都在 build-tools/verify_web.py 里被 Node 执行，
 * 再用 Kotlin 的同一份实现反解一遍做交叉验证——不是"看着一样"，是跑出来一样。
 *
 * 校验用 FNV-1a 32 位取高 16 位：
 * 不用 crypto.subtle，因为它要求 https/localhost 安全上下文，
 * 而学生可能把页面保存到本地用 file:// 打开，那时 crypto.subtle 直接是 undefined。
 */
(function (global) {
  'use strict';

  var PREFIX = 'KQ1';
  var MAX_NO_LENGTH = 32;
  var FNV_OFFSET = 0x811C9DC5 | 0;   // 与 Kotlin 的 Int 字面量同值（有符号 32 位）
  var FNV_PRIME = 16777619;

  /** 去掉常见空白（含全角空格、不间断空格）并转大写 */
  function normalize(studentNo) {
    return String(studentNo == null ? '' : studentNo)
      .replace(/[ \t\r\n\u3000\u00A0]/g, '')
      .toUpperCase();
  }

  /** FNV-1a 32 位，取高 16 位，4 位大写十六进制 */
  function checksum(studentNo) {
    var s = normalize(studentNo);
    var h = FNV_OFFSET;
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      // Math.imul 保证是 32 位整数乘法（直接 * 会丢精度，与 Kotlin 的 Int 溢出行为对不上）
      h = Math.imul(h, FNV_PRIME);
    }
    return (h >>> 16 & 0xFFFF).toString(16).toUpperCase().padStart(4, '0');
  }

  /** 生成二维码内容；学号为空返回空串 */
  function encode(studentNo) {
    var no = normalize(studentNo);
    // 必须与 Kotlin 侧同规则：超长一律不生成
    if (!no || no.length > MAX_NO_LENGTH) return '';
    return PREFIX + '|' + no + '|' + checksum(no);
  }

  /**
   * 解析（网页端自己不用，但必须有：它让「两端一致」可被自动验证，
   * 也让页面可以自检——绑定后立刻把自己的码解一遍，不一致就当场报错）。
   */
  function parse(raw) {
    var text = String(raw == null ? '' : raw).trim();
    if (!text) return { ok: false, reason: 'notOurs' };
    var parts = text.split('|');
    if (parts.length !== 3) return { ok: false, reason: 'notOurs' };
    if (parts[0].toUpperCase() !== PREFIX) return { ok: false, reason: 'notOurs' };
    var no = normalize(parts[1]);
    if (!no || no.length > MAX_NO_LENGTH) return { ok: false, reason: 'emptyNo' };
    if (parts[2].trim().toUpperCase() !== checksum(no)) return { ok: false, reason: 'badChecksum' };
    return { ok: true, studentNo: no };
  }

  global.ScanCode = {
    PREFIX: PREFIX,
    MAX_NO_LENGTH: MAX_NO_LENGTH,
    normalize: normalize,
    checksum: checksum,
    encode: encode,
    parse: parse
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
