/*
 * 考勤 · 老师版 纯逻辑（无 DOM / 无存储依赖）。
 *
 * 浏览器里挂到 window.KQLogic；Node 里 module.exports —— 这样
 * build-tools/verify_teacher_web.py 可以直接跑真实实现做断言，而不是另写一份同构。
 *
 * 与 Android 端一致的口径（改这里要同步原生端）：
 *  - 下半节默认跟随上半节；迟到不继承（视为已到）；早退→下半节不记录；
 *  - 出勤时长按半节额定窗口 clamp；空签到/空早退回退额定边界。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.KQLogic = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var STATUSES = [
    { key: 'PRESENT', label: '已到' },
    { key: 'LATE', label: '迟到' },
    { key: 'EARLY_LEAVE', label: '早退' },
    { key: 'ABSENT', label: '缺勤' },
    { key: 'SICK_LEAVE', label: '病假' },
    { key: 'PERSONAL_LEAVE', label: '事假' },
    { key: 'PUBLIC_LEAVE', label: '公假' }
  ];
  var LEAVE = ['SICK_LEAVE', 'PERSONAL_LEAVE', 'PUBLIC_LEAVE'];
  var MAIN = ['PRESENT', 'LATE', 'EARLY_LEAVE', 'ABSENT'];
  var PRI = { ABSENT: 0, EARLY_LEAVE: 1, LATE: 2, SICK_LEAVE: 3, PERSONAL_LEAVE: 3, PUBLIC_LEAVE: 3, PRESENT: 4 };
  var COLUMNS = ['学号', '姓名', '班级', '专业', '日期', '课程', '上课地点', '节次', '半节',
    '签到时间', '签退时间', '状态', '出勤时长(分钟)', '异常说明'];
  var EMPTY = '--';

  function label(k) {
    for (var i = 0; i < STATUSES.length; i++) if (STATUSES[i].key === k) return STATUSES[i].label;
    return k || '';
  }
  function isLeave(k) { return LEAVE.indexOf(k) >= 0; }
  function isAttended(k) { return k === 'PRESENT' || k === 'LATE' || k === 'EARLY_LEAVE'; }

  /** 下半节「跟随上半节」时的生效状态；null = 不记录 */
  function inheritedStatus(first) {
    if (first === 'EARLY_LEAVE') return null;
    if (first === 'LATE') return 'PRESENT';
    return first;
  }

  /** mark: 'INHERIT' | 'NOT_RECORDED' | 具体状态 → 下半节生效状态（null = 不记录） */
  function resolveSecond(first, mark) {
    if (mark === 'NOT_RECORDED') return null;
    if (mark && mark !== 'INHERIT') return mark;
    return inheritedStatus(first);
  }

  /** 导出块内状态优先级：缺勤 0 → 早退 1 → 迟到 2 → 请假 3 → 已到 4 */
  function statusPriority(st) { return PRI[st] == null ? 4 : PRI[st]; }

  function p2(n) { return n < 10 ? '0' + n : '' + n; }
  function minutesOf(h) {
    var m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(h || '').trim());
    return m ? (+m[1]) * 60 + (+m[2]) : null;
  }
  function hhmmOf(m) { m = Math.max(0, Math.min(24 * 60 - 1, m)); return p2(Math.floor(m / 60)) + ':' + p2(m % 60); }
  function halfWindows(s, e) {
    var a = minutesOf(s), b = minutesOf(e);
    if (a == null || b == null || b <= a) return null;
    var mid = a + Math.floor((b - a) / 2);
    return [{ start: hhmmOf(a), end: hhmmOf(mid), mins: mid - a },
      { start: hhmmOf(mid), end: hhmmOf(b), mins: b - mid }];
  }
  function recordMinutes(ci, lv, w) {
    var ws = minutesOf(w.start), we = minutesOf(w.end);
    if (ws == null || we == null) return 0;
    var st = minutesOf(ci); if (st == null) st = ws;
    var en = minutesOf(lv); if (en == null) en = we;
    return Math.max(0, Math.min(en - st, Math.max(0, we - ws)));
  }

  function csvEsc(v) {
    v = String(v == null ? '' : v);
    if (v === '' || /[,"\n\r]/.test(v)) return '"' + v.replace(/"/g, '""') + '"';
    return v;
  }

  /**
   * 按课时分块生成 CSV：每块「# ── 第 N 次课 · 日期 · 课程 · 班级 · 地点 · 节次 · K 条 ──」+
   * 独立列头 + 行 + 块间空行；块内顺序由调用方排好（缺勤→早退→迟到→请假→已到）。
   * 纯函数：rows 是已展开的导出行，meta 是筛选摘要。
   */
  function toCsv(rows, meta) {
    var blocks = [], cur = null;
    rows.forEach(function (r) {
      if (!cur || cur.sid !== r.sessionId) { cur = { sid: r.sessionId, rows: [] }; blocks.push(cur); }
      cur.rows.push(r);
    });
    var lines = [];
    lines.push('# 考勤明细导出');
    lines.push('# 日期范围,' + csvEsc(meta.rangeText));
    lines.push('# 班级,' + csvEsc(meta.classText));
    lines.push('# 课程,' + csvEsc(meta.courseText));
    lines.push('# 地点,' + csvEsc(meta.locationText));
    lines.push('# 记录条数,' + rows.length);
    lines.push('# 课次数,' + blocks.length);
    lines.push('# 导出时间,' + csvEsc(meta.exportedAt));
    lines.push('# 口径说明,签退时间即早退时刻（未早退为空）；出勤时长到课按实际到课时长、缺勤/请假为 0；空值以 -- 占位；按课时分块（块间空行分隔），块内按「缺勤 → 早退 → 迟到 → 请假 → 已到」排序');
    blocks.forEach(function (b, i) {
      var h = b.rows[0];
      lines.push('');
      lines.push('# ── 第 ' + (i + 1) + ' 次课 · ' + h.date + ' · ' + h.courseName + ' · ' + h.className + ' · ' + h.locationName + ' · ' + h.period + ' · ' + b.rows.length + ' 条 ──');
      lines.push(COLUMNS.join(','));
      b.rows.forEach(function (r) {
        lines.push([r.studentNo, r.name, r.className, r.major, r.date, r.courseName, r.locationName, r.period,
          r.halfLabel, r.checkIn, r.checkOut, r.statusLabel, r.duration, r.abnormal].map(csvEsc).join(','));
      });
    });
    return '\uFEFF' + lines.join('\r\n') + '\r\n';
  }

  return {
    STATUSES: STATUSES, LEAVE: LEAVE, MAIN: MAIN, PRI: PRI, COLUMNS: COLUMNS, EMPTY: EMPTY,
    label: label, isLeave: isLeave, isAttended: isAttended,
    inheritedStatus: inheritedStatus, resolveSecond: resolveSecond, statusPriority: statusPriority,
    minutesOf: minutesOf, hhmmOf: hhmmOf, halfWindows: halfWindows, recordMinutes: recordMinutes,
    csvEsc: csvEsc, toCsv: toCsv
  };
});
