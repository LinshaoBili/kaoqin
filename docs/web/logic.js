/*
 * 考勤 · 网页版 纯逻辑（无 DOM / 无存储依赖）。
 *
 * 浏览器里挂到 window.KQLogic；Node 里 module.exports —— 这样
 * build-tools/verify_web_attendance.py 可以直接跑真实实现做断言，而不是另写一份同构。
 *
 * 与 Android 端一致的口径（改这里要同步原生端 app/src/main/java/com/kaoqin/app/data/）：
 *  - 状态：已到 / 迟到 / 早退 / 缺勤 / 病假 / 事假 / 公假（HalfStatus.kt）
 *  - 下半节：跟随上半节，迟到不继承（视为已到），早退 → 下半节不记录
 *  - 出勤时长：按半节额定窗口 clamp（AttendanceDuration.kt）
 *  - 分数：固定分值 Σ(人次×分值) / 按比例 Σ(人次×权重)÷总人次（ScoreConfig.kt、ScoreCalculator.kt）
 *  - 假条：按天比较 substr(startDate,1,10) ≤ date ≤ substr(endDate,1,10)（LeaveNoteDao.activeOn）
 *  - 名单：不参加考勤的学生不进点名；隐藏名单不参与点名；黑/白名单只做标注（HomeViewModel）
 *  - 数据交换：Android BackupEnvelope 的 10 张表，字段顺序与 TransferModels.kt 逐一对应
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.KQLogic = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ============================================================ 状态与文案
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
  var SCORE_COLUMNS = ['排名', '学号', '姓名', '班级', '总人次', '已到', '迟到', '缺勤', '早退', '请假', '得分'];
  var EMPTY = '--';

  var RULE_TYPES = [
    { key: 'BLACKLIST', label: '黑名单' },
    { key: 'WHITELIST', label: '白名单' },
    { key: 'HIDDEN', label: '隐藏名单' }
  ];
  var ABSENCE_PRESETS = ['自定义…', '入伍', '退学', '休学', '转学/转专业', '毕业/结业'];
  /** 长期假条的结束时间占位（与 LeaveNote.LONG_TERM_END 一致） */
  var LONG_TERM_END = '9999-12-31 23:59';

  function label(k) {
    for (var i = 0; i < STATUSES.length; i++) if (STATUSES[i].key === k) return STATUSES[i].label;
    return k || '';
  }
  function ruleLabel(k) {
    for (var i = 0; i < RULE_TYPES.length; i++) if (RULE_TYPES[i].key === k) return RULE_TYPES[i].label;
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

  /**
   * 在下半节设置某个状态后的结果：{ first, second }（与 HalfStatus.applyToSecond 同构）
   * - 早退 → 上移到上半节，下半节「不记录」；
   * - 与「继承结果」相同 → 存回 INHERIT，不制造「已单独设置」的假象；
   * - 其余 → 显式写进下半节。
   */
  function applyToSecond(first, status) {
    if (status === 'EARLY_LEAVE') return { first: 'EARLY_LEAVE', second: 'NOT_RECORDED' };
    if (status === inheritedStatus(first)) return { first: first, second: 'INHERIT' };
    return { first: first, second: status };
  }

  /** 由「上半节 + 下半节实际记录」反推下半节标记（与 HalfStatus.markOf 同构） */
  function markOf(first, secondRecorded) {
    var inh = inheritedStatus(first);
    if (secondRecorded == null) return inh == null ? 'NOT_RECORDED' : 'INHERIT';
    return secondRecorded === inh ? 'INHERIT' : secondRecorded;
  }

  /**
   * 半节签到时刻的自动填充（与 HalfTimeRules 同构）：
   * - 只有「到场了」的状态才需要签到时刻（已到/迟到/早退）；
   * - 空着才补 now，老师手填过的保留；
   * - 缺勤/请假/不记录（null）一律清空，避免导出「缺勤 · 签到 08:12」。
   */
  function needsCheckIn(status) {
    return !!status && status !== 'ABSENT' && !isLeave(status);
  }

  function autoCheckIn(status, current, now) {
    if (!needsCheckIn(status)) return '';
    if (current) return current;
    return now || '';
  }

  /** 点名页状态筛选（与 Android StatusFilter 一致：请假 = 病/事/公假合并） */
  var STATUS_FILTERS = [
    { key: 'ALL', label: '全部' },
    { key: 'PRESENT', label: '已到' },
    { key: 'ABSENT', label: '缺勤' },
    { key: 'LATE', label: '迟到' },
    { key: 'EARLY_LEAVE', label: '早退' },
    { key: 'LEAVE', label: '请假' }
  ];
  function matchesStatusFilter(filter, status) {
    if (filter === 'ALL' || !filter) return true;
    if (filter === 'LEAVE') return isLeave(status);
    return status === filter;
  }
  function filterLabel(k) {
    for (var i = 0; i < STATUS_FILTERS.length; i++) if (STATUS_FILTERS[i].key === k) return STATUS_FILTERS[i].label;
    return k || '';
  }

  /** 导出块内状态优先级：缺勤 0 → 早退 1 → 迟到 2 → 请假 3 → 已到 4 */
  function statusPriority(st) { return PRI[st] == null ? 4 : PRI[st]; }

  // ============================================================ 时间与时长
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

  // ============================================================ CSV
  function csvEsc(v) {
    v = String(v == null ? '' : v);
    if (v === '' || /[,"\n\r]/.test(v)) return '"' + v.replace(/"/g, '""') + '"';
    return v;
  }
  function csvLine(cells) { return cells.map(csvEsc).join(','); }

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
      lines.push('# ── 第 ' + (i + 1) + ' 次课 · ' + h.date + ' · ' + h.courseName + ' · ' + h.className + ' · ' + h.locationName + ' · ' + h.period +
        (h.pairId ? ' · 连堂' : '') + ' · ' + b.rows.length + ' 条 ──');
      lines.push(csvLine(COLUMNS));
      b.rows.forEach(function (r) {
        lines.push(csvLine([r.studentNo, r.name, r.className, r.major, r.date, r.courseName, r.locationName, r.period,
          r.halfLabel, r.checkIn, r.checkOut, r.statusLabel, r.duration, r.abnormal]));
      });
    });
    return '\uFEFF' + lines.join('\r\n') + '\r\n';
  }

  // ============================================================ 数值与分数
  function round2(v) {
    if (typeof v !== 'number' || !isFinite(v)) return 0;
    return Math.round(v * 100) / 100;
  }
  /** 数值 → 文案：整数不带小数点，小数最多 2 位且去掉尾部 0（与 ScoreWeights.format 一致） */
  function formatNum(v) {
    var r = round2(v);
    if (r === Math.floor(r)) return String(Math.trunc(r));
    return String(r.toFixed(2)).replace(/0+$/, '').replace(/\.$/, '');
  }
  function parseNum(raw, min, max) {
    var s = String(raw == null ? '' : raw).trim();
    if (s === '' || !/^-?\d+(\.\d+)?$/.test(s)) return null;
    var v = Number(s);
    if (!isFinite(v) || v < min || v > max) return null;
    return round2(v);
  }
  var MIN_SCORE = -999, MAX_SCORE = 999, MIN_RATIO = 0, MAX_RATIO = 100;

  function defaultFixed() { return { present: 1, late: 0, absent: -1, earlyLeave: 0, leave: 0 }; }
  function defaultRatio() { return { present: 100, late: 80, absent: 0, earlyLeave: 60, leave: 90 }; }
  function defaultScoreConfig() { return { mode: 'FIXED', fixed: defaultFixed(), ratio: defaultRatio() }; }

  function clampWeights(w, mode) {
    var min = mode === 'RATIO' ? MIN_RATIO : MIN_SCORE;
    var max = mode === 'RATIO' ? MAX_RATIO : MAX_SCORE;
    function fix(v) {
      var n = Number(v);
      if (!isFinite(n)) n = 0;
      return round2(Math.max(min, Math.min(max, n)));
    }
    w = w || {};
    return { present: fix(w.present), late: fix(w.late), absent: fix(w.absent), earlyLeave: fix(w.earlyLeave), leave: fix(w.leave) };
  }
  function activeWeights(cfg) {
    var c = cfg || defaultScoreConfig();
    return c.mode === 'RATIO' ? (c.ratio || defaultRatio()) : (c.fixed || defaultFixed());
  }
  var SCORE_CATEGORIES = [
    { key: 'present', status: 'PRESENT', label: '已到' },
    { key: 'late', status: 'LATE', label: '迟到' },
    { key: 'absent', status: 'ABSENT', label: '缺勤' },
    { key: 'earlyLeave', status: 'EARLY_LEAVE', label: '早退' },
    { key: 'leave', status: 'SICK_LEAVE', label: '请假' }
  ];
  function describeWeights(cfg) {
    var c = cfg || defaultScoreConfig();
    var w = activeWeights(c);
    var unit = c.mode === 'RATIO' ? '%' : '';
    return (c.mode === 'RATIO' ? '按比例（0~100 加权出勤率）：' : '固定分值：') +
      SCORE_CATEGORIES.map(function (x) { return x.label + formatNum(w[x.key]) + unit; }).join(' ');
  }

  /** 人次汇总（与 StatsCalculator.AttendanceSummary 同构） */
  function summarize(records) {
    var s = { total: 0, present: 0, late: 0, earlyLeave: 0, absent: 0, sickLeave: 0, personalLeave: 0, publicLeave: 0 };
    records.forEach(function (r) {
      s.total++;
      if (r.status === 'PRESENT') s.present++;
      else if (r.status === 'LATE') s.late++;
      else if (r.status === 'EARLY_LEAVE') s.earlyLeave++;
      else if (r.status === 'ABSENT') s.absent++;
      else if (r.status === 'SICK_LEAVE') s.sickLeave++;
      else if (r.status === 'PERSONAL_LEAVE') s.personalLeave++;
      else if (r.status === 'PUBLIC_LEAVE') s.publicLeave++;
    });
    s.leave = s.sickLeave + s.personalLeave + s.publicLeave;
    s.attended = s.present + s.late + s.earlyLeave;
    s.rate = s.total ? s.attended / s.total : null;
    return s;
  }

  /** 单人得分：固定分值 = Σ(人次×分值)；按比例 = Σ(人次×权重)÷总人次 */
  function scoreOf(summary, cfg) {
    var c = cfg || defaultScoreConfig();
    var w = activeWeights(c);
    var weighted = summary.present * w.present + summary.late * w.late + summary.absent * w.absent +
      summary.earlyLeave * w.earlyLeave + summary.leave * w.leave;
    if (c.mode === 'RATIO') return summary.total ? round2(weighted / summary.total) : 0;
    return round2(weighted);
  }

  /**
   * 分数行：按学生聚合 → 计算得分 → 稳定排序（得分降序 → 总人次降序 → 姓名升序）。
   * rows: [{studentId, studentNo, studentName, className, status}]
   */
  function scoreRows(rows, cfg, nameOf) {
    var groups = {}, order = [];
    rows.forEach(function (r) {
      if (!groups[r.studentId]) { groups[r.studentId] = []; order.push(r.studentId); }
      groups[r.studentId].push(r);
    });
    var out = order.map(function (id) {
      var g = groups[id];
      var live = nameOf ? nameOf(id) : '';
      var first = g[0] || {};
      var name = (live || '').trim();
      if (!name) {
        for (var i = 0; i < g.length; i++) if (g[i].studentName) { name = g[i].studentName; break; }
      }
      var studentNo = '';
      for (var j = 0; j < g.length; j++) if (g[j].studentNo) { studentNo = g[j].studentNo; break; }
      var summary = summarize(g);
      return {
        studentId: id, name: name || '未知学生', studentNo: studentNo,
        className: first.className || '未知班级',
        summary: summary, score: scoreOf(summary, cfg)
      };
    });
    out.sort(function (a, b) {
      return b.score - a.score || b.summary.total - a.summary.total ||
        String(a.name).localeCompare(String(b.name));
    });
    return out;
  }

  function scoreCsv(results, meta, cfg) {
    var c = cfg || defaultScoreConfig();
    var lines = [];
    lines.push('# 考勤分数导出');
    lines.push('# 学期,' + csvEsc(meta.semesterLabel || '全部学期'));
    lines.push('# 时间范围,' + csvEsc(meta.rangeText));
    lines.push('# 当前周次,' + csvEsc(String(meta.weekLabel == null ? '' : meta.weekLabel)));
    lines.push('# 班级,' + csvEsc(meta.classText));
    lines.push('# 课程,' + csvEsc(meta.courseText));
    lines.push('# 学生,' + csvEsc(meta.studentText || '全部'));
    lines.push('# 搜索关键词,' + csvEsc(meta.keywordLabel || '无'));
    lines.push('# 排序方式,' + csvEsc(meta.orderLabel || '得分从高到低'));
    lines.push('# 分值规则,' + csvEsc(describeWeights(c)));
    lines.push('# 导出时间,' + csvEsc(meta.exportedAt));
    lines.push('# 口径说明,人次按记录行计（上下半节各算一次并累加）；请假合并病假/事假/公假');
    lines.push(csvLine(SCORE_COLUMNS));
    results.forEach(function (r, i) {
      var s = r.summary;
      lines.push(csvLine([String(i + 1), r.studentNo, r.name, r.className, String(s.total),
        String(s.present), String(s.late), String(s.absent), String(s.earlyLeave), String(s.leave),
        formatNum(r.score)]));
    });
    return '\uFEFF' + lines.join('\r\n') + '\r\n';
  }

  // ============================================================ 假条
  /**
   * 某学生某天生效的假条（结束时间最晚优先、同结束时间取 id 大者）。
   * 比较口径与 LeaveNoteDao.activeOn 一致：只取日期部分，含起止两端。
   */
  function activeLeave(notes, studentId, date) {
    var hit = null;
    (notes || []).forEach(function (n) {
      if (n.studentId !== studentId) return;
      var s = String(n.startDate || '').slice(0, 10);
      var e = String(n.endDate || '').slice(0, 10);
      if (!s || !e) return;
      if (s <= date && date <= e) {
        if (!hit || String(n.endDate) > String(hit.endDate) ||
          (String(n.endDate) === String(hit.endDate) && n.id > hit.id)) hit = n;
      }
    });
    return hit;
  }
  function isLeaveNoteStatus(k) { return LEAVE.indexOf(k) >= 0; }
  function leaveNoteExpired(n, nowText) { return String(n.endDate) < nowText; }
  function leaveNoteLongTerm(n) { return String(n.endDate) === LONG_TERM_END; }
  function leaveSpanText(n) {
    function d(v) { return String(v || '').slice(0, 10); }
    if (leaveNoteLongTerm(n)) return d(n.startDate) + ' 起（长期）';
    return d(n.startDate) + ' ~ ' + d(n.endDate);
  }

  // ============================================================ 点名名单
  /**
   * 点名名单：剔除「不参加考勤」与「隐藏名单」；黑/白名单只做标注（与 HomeViewModel 一致）。
   * 返回 { roster, hiddenIds, blackIds, whiteIds }
   */
  function roster(students, rules, courseId) {
    var hidden = {}, black = {}, white = {};
    (rules || []).forEach(function (r) {
      if (courseId && r.courseId !== courseId) return;
      if (r.ruleType === 'HIDDEN') hidden[r.studentId] = 1;
      else if (r.ruleType === 'BLACKLIST') black[r.studentId] = 1;
      else if (r.ruleType === 'WHITELIST') white[r.studentId] = 1;
    });
    var list = (students || []).filter(function (s) {
      if (s.attendanceState === 'NOT_PARTICIPATE') return false;
      return !hidden[s.id];
    });
    return { roster: list, hiddenIds: hidden, blackIds: black, whiteIds: white };
  }

  // ============================================================ 双端数据交换
  /**
   * 10 张表规格：table = Android 表名，coll = 本地集合名，fields 顺序与 TransferModels.TableSpec 完全一致，
   * order 为导入依赖顺序（父表先）。defaults 用于旧备份缺列时兜底。
   */
  var SPECS = [
    {
      table: 'class_info', coll: 'classes', label: '班级', order: 1,
      fields: ['id', 'name', 'major', 'majorShort', 'academicYear', 'counselor'],
      numeric: ['id'], defaults: { major: '', majorShort: '', academicYear: '', counselor: '' }
    },
    {
      table: 'student', coll: 'students', label: '学生', order: 2,
      fields: ['id', 'classId', 'studentNo', 'name', 'sortOrder', 'attendanceState', 'absenceReason'],
      numeric: ['id', 'classId', 'sortOrder'],
      defaults: { studentNo: '', sortOrder: 0, attendanceState: 'PARTICIPATE', absenceReason: '' }
    },
    {
      table: 'course', coll: 'courses', label: '课程', order: 3,
      fields: ['id', 'name', 'teacher'], numeric: ['id'], defaults: { teacher: '' }
    },
    {
      table: 'course_student_rule', coll: 'rules', label: '课程名单规则', order: 4,
      fields: ['id', 'courseId', 'studentId', 'ruleType'], numeric: ['id', 'courseId', 'studentId'], defaults: {}
    },
    {
      table: 'location', coll: 'locations', label: '上课地点', order: 5,
      fields: ['id', 'name', 'department', 'sortOrder', 'deptOrder'],
      numeric: ['id', 'sortOrder', 'deptOrder'], defaults: { department: '', sortOrder: 0, deptOrder: 0 }
    },
    {
      table: 'class_time', coll: 'times', label: '上课时间', order: 6,
      fields: ['id', 'period', 'startTime', 'endTime'], numeric: ['id'], defaults: {}
    },
    {
      table: 'copy_format', coll: 'copies', label: '复制格式', order: 7,
      fields: ['id', 'name', 'template', 'listStyle', 'listLetter', 'listSeparator', 'listEmptyText'],
      numeric: ['id'],
      defaults: { listStyle: 'BOTH', listLetter: '1', listSeparator: '、', listEmptyText: '无' }
    },
    {
      table: 'leave_note', coll: 'leaveNotes', label: '请假条', order: 8,
      fields: ['id', 'studentId', 'status', 'startDate', 'endDate', 'remark', 'createdAt'],
      numeric: ['id', 'studentId', 'createdAt'], defaults: { remark: '', createdAt: 0 }
    },
    {
      table: 'session', coll: 'sessions', label: '点名会话', order: 9,
      fields: ['id', 'classId', 'courseId', 'locationId', 'timeId', 'date', 'remark', 'createdAt',
        'className', 'courseName', 'locationName', 'timePeriod', 'pairId'],
      numeric: ['id', 'classId', 'courseId', 'locationId', 'timeId', 'createdAt', 'pairId'],
      defaults: {
        locationId: 0, timeId: 0, remark: '', createdAt: 0,
        className: '', courseName: '', locationName: '', timePeriod: '', pairId: 0
      }
    },
    {
      table: 'record', coll: 'records', label: '考勤记录', order: 10,
      fields: ['id', 'sessionId', 'studentId', 'status', 'remark', 'studentName', 'studentNo', 'half',
        'checkInTime', 'leaveTime'],
      numeric: ['id', 'sessionId', 'studentId', 'half'],
      defaults: { remark: '', studentName: '', studentNo: '', checkInTime: '', leaveTime: '' }
    }
  ];
  var SPEC_OF = {};
  SPECS.forEach(function (s) { SPEC_OF[s.table] = s; });
  var TABLE_OF_COLL = {};
  SPECS.forEach(function (s) { TABLE_OF_COLL[s.coll] = s.table; });

  /** 空库（v2：含分数配置、假条、名单规则、复制格式） */
  function blankDb() {
    return {
      v: 2, seq: 0,
      settings: {
        semesterLabel: '', currentWeek: 1, defaultClassId: 0, score: defaultScoreConfig(),
        // 周次锚点：weekAnchorValue = 设定当周的周次，weekAnchorMonday = 那一周的周一
        // （空串 = 老数据，首次启动就地补一个，用户看到的数字不变）
        weekAnchorValue: 1, weekAnchorMonday: ''
      },
      classes: [], students: [], courses: [], rules: [], locations: [], times: [],
      copies: [], leaveNotes: [], sessions: [], records: []
    };
  }

  /** v1（旧版）→ v2：补集合与字段，老用户已存数据不丢 */
  function migrateDb(d) {
    var out = blankDb();
    if (!d || typeof d !== 'object') return out;
    out.seq = +d.seq || 0;
    var st = d.settings || {};
    out.settings.semesterLabel = st.semesterLabel || '';
    out.settings.currentWeek = +st.currentWeek || 1;
    out.settings.weekAnchorValue = +st.weekAnchorValue || 0;
    out.settings.weekAnchorMonday = st.weekAnchorMonday || '';
    out.settings.defaultClassId = +st.defaultClassId || 0;
    out.settings.score = (st.score && st.score.mode) ? st.score : defaultScoreConfig();
    ['classes', 'students', 'courses', 'rules', 'locations', 'times', 'copies', 'leaveNotes', 'sessions', 'records']
      .forEach(function (k) { if (Array.isArray(d[k])) out[k] = d[k]; });
    out.students = out.students.map(function (s) {
      return {
        id: +s.id || 0, classId: +s.classId || 0, studentNo: s.studentNo || '', name: s.name || '',
        sortOrder: +s.sortOrder || 0,
        attendanceState: s.attendanceState === 'NOT_PARTICIPATE' ? 'NOT_PARTICIPATE' : 'PARTICIPATE',
        absenceReason: s.absenceReason || ''
      };
    });
    out.locations = out.locations.map(function (l) {
      return {
        id: +l.id || 0, name: l.name || '', department: l.department || '',
        sortOrder: +l.sortOrder || 0, deptOrder: +l.deptOrder || 0
      };
    });
    // 连堂课（v0.3.7）：旧数据的会话没有 pairId —— 一律按「单节」处理（0 = 未配对）
    out.sessions = out.sessions.map(function (s) {
      return {
        id: +s.id || 0, classId: +s.classId || 0, courseId: +s.courseId || 0,
        locationId: +s.locationId || 0, timeId: +s.timeId || 0, date: s.date || '',
        remark: s.remark || '', createdAt: +s.createdAt || 0,
        className: s.className || '', courseName: s.courseName || '',
        locationName: s.locationName || '', timePeriod: s.timePeriod || '',
        pairId: +s.pairId || 0
      };
    });
    return out;
  }

  /** 一行原始值 → 本地对象（数值字段转 number、缺列取默认值） */
  function normalizeRow(spec, raw) {
    var o = {};
    spec.fields.forEach(function (f) {
      var v = raw[f];
      if (spec.numeric.indexOf(f) >= 0) o[f] = +v || 0;
      else o[f] = v == null ? '' : String(v);
    });
    Object.keys(spec.defaults).forEach(function (f) {
      if (raw[f] == null || raw[f] === '') {
        if (typeof spec.defaults[f] === 'number') o[f] = spec.defaults[f];
        else if (!o[f]) o[f] = spec.defaults[f];
      }
    });
    return o;
  }

  /** 表数据（Android 结构 {fields, rows}，行值为字符串）→ 对象数组；fields 缺失时按规格顺序兜底 */
  function tableToObjects(spec, tab) {
    if (!tab || !Array.isArray(tab.rows)) return [];
    var fields = (Array.isArray(tab.fields) && tab.fields.length) ? tab.fields : spec.fields;
    return tab.rows.map(function (r) {
      var o = {};
      fields.forEach(function (f, i) { o[f] = Array.isArray(r) ? r[i] : r[f]; });
      return normalizeRow(spec, o);
    });
  }

  /**
   * 解析 Android 端导出的 BackupEnvelope：
   * { app, kind, version, exportedAt, tables: { 表名: { fields:[], rows:[[]] } } }
   * 返回 { ok, error, db, stats:[{table,label,rows}], unknown:[表名], total, source }
   */
  function fromAndroid(doc) {
    if (!doc || typeof doc !== 'object') return { ok: false, error: '不是有效的 JSON 文件' };
    var tables = doc.tables;
    if (!tables || typeof tables !== 'object' || Array.isArray(tables)) {
      return { ok: false, error: '缺少 tables 节点，不是考勤端导出的备份' };
    }
    var db = blankDb();
    var stats = [], unknown = [], maxId = 0;
    SPECS.slice().sort(function (a, b) { return a.order - b.order; }).forEach(function (spec) {
      var list = tableToObjects(spec, tables[spec.table]);
      db[spec.coll] = list;
      list.forEach(function (x) { if (x.id > maxId) maxId = x.id; });
      stats.push({ table: spec.table, label: spec.label, rows: list.length });
    });
    Object.keys(tables).forEach(function (n) { if (!SPEC_OF[n]) unknown.push(n); });
    db.seq = maxId;
    // 老备份没有 half 列、状态可能是脏值：这里兜底，避免后续统计整片错位
    db.records = db.records.map(function (r) {
      if (r.half !== 1 && r.half !== 2) r.half = 1;
      if (!label(r.status)) r.status = 'PRESENT';
      return r;
    });
    return {
      ok: true, error: '', db: db, stats: stats, unknown: unknown,
      total: stats.reduce(function (a, b) { return a + b.rows; }, 0),
      source: { app: doc.app || '', kind: doc.kind || '', version: doc.version, exportedAt: doc.exportedAt || '' }
    };
  }

  /**
   * 本地数据 → Android 端可导入的 BackupEnvelope（10 张表，字段顺序与原生一致）。
   * 数值一律写字符串，与 DataExporter 的行输出形态一致。
   */
  function toAndroid(db, exportedAt) {
    var tables = {};
    SPECS.slice().sort(function (a, b) { return a.order - b.order; }).forEach(function (spec) {
      var list = db[spec.coll] || [];
      tables[spec.table] = {
        fields: spec.fields.slice(),
        rows: list.map(function (o) {
          return spec.fields.map(function (f) {
            var v = o[f];
            return v == null ? '' : String(v);
          });
        })
      };
    });
    return {
      app: 'com.kaoqin.app', kind: 'kaoqin-backup', version: 1,
      exportedAt: exportedAt || '', tables: tables
    };
  }

  /** 把一份 db 并入另一份（mode: 'replace' | 'merge'），返回 { db, added, updated } */
  function mergeDb(base, incoming, mode) {
    if (mode === 'replace') return { db: incoming, added: null, updated: null };
    var out = migrateDb(JSON.parse(JSON.stringify(base)));
    var added = {}, updated = {};
    SPECS.forEach(function (spec) {
      var target = out[spec.coll];
      var indexOf = {};
      target.forEach(function (x, i) { indexOf[x.id] = i; });
      (incoming[spec.coll] || []).forEach(function (x) {
        if (indexOf[x.id] != null) { target[indexOf[x.id]] = x; updated[spec.coll] = (updated[spec.coll] || 0) + 1; }
        else { indexOf[x.id] = target.length; target.push(x); added[spec.coll] = (added[spec.coll] || 0) + 1; }
      });
      out[spec.coll] = target;
    });
    var maxId = 0;
    SPECS.forEach(function (spec) {
      (out[spec.coll] || []).forEach(function (x) { if (x.id > maxId) maxId = x.id; });
    });
    out.seq = Math.max(maxId, +out.seq || 0);
    return { db: out, added: added, updated: updated };
  }

  // ============================================================ 分享策略（导出文件时走分享面板还是直接下载）
  /**
   * 是否手机/平板。iPadOS 13+ 的 UA 伪装成 Macintosh，靠触点数量区分（桌面 Mac 触点恒为 0~1）。
   */
  function isMobileUA(ua, maxTouchPoints) {
    ua = String(ua || '');
    if (/Android|iPhone|iPod|iPad|Windows Phone|HarmonyOS|HarmonyOSNext|Mobile/i.test(ua)) return true;
    if (/Macintosh/i.test(ua) && (maxTouchPoints || 0) > 1) return true;   // iPad 桌面模式
    return false;
  }

  /**
   * 'share' = 走 navigator.share 系统分享面板；'download' = 直接存成文件。
   *
   * 电脑一律 'download'：桌面 Chrome/Edge 也有 canShare，但弹出的是系统共享弹窗，
   * 与「导出到本机」的预期不符（Windows 上还可能因为没有可分享的应用而直接失败）。
   */
  function sharePolicy(ua, maxTouchPoints, canShare) {
    if (!canShare) return 'download';
    return isMobileUA(ua, maxTouchPoints) ? 'share' : 'download';
  }

  // ------------------------------------------------------------ 教学周次（自动递增）
  // 与考勤端 WeekCalendar 同口径：设置里填过「这周第几周」后，记下当时的周一当锚点，
  // 之后每到周一自动 +1。存锚点而不是「开学日期」，填错一次只错一次。

  /** 周次上限，与考勤端 WeekCalendar.MAX_WEEK 一致 */
  var MAX_WEEK = 30;

  /** 'yyyy-MM-dd' → 该周的周一（同格式）；非法输入返回 '' */
  function mondayOfDate(str) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(str == null ? '' : str));
    if (!m) return '';
    var d = new Date(+m[1], +m[2] - 1, +m[3]);
    if (isNaN(d.getTime())) return '';
    var wd = (d.getDay() + 6) % 7;          // 周一 = 0
    d.setDate(d.getDate() - wd);
    return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());
  }

  /** 两个日期相差几周（各自先对齐到所在周的周一）；任一侧非法按 0 处理 */
  function weeksBetween(fromMonday, toDate) {
    var a = mondayOfDate(fromMonday), b = mondayOfDate(toDate);
    if (!a || !b) return 0;
    var da = new Date(a + 'T00:00:00'), db = new Date(b + 'T00:00:00');
    // round 而不是 floor：跨夏令时会出现 ±1 小时的偏差，整除后不能直接取整
    return Math.round((db - da) / 604800000);
  }

  /** 今天第几周：锚点周次 + 周差，收敛到 1..MAX_WEEK（缺锚点按锚点周次原样返回） */
  function resolveWeek(anchorValue, anchorMonday, todayStr) {
    var base = +anchorValue || 1;
    if (!anchorMonday) return Math.min(MAX_WEEK, Math.max(1, base));
    return Math.min(MAX_WEEK, Math.max(1, base + weeksBetween(anchorMonday, todayStr)));
  }

  return {
    // 分享策略
    isMobileUA: isMobileUA, sharePolicy: sharePolicy,
    // 周次（自动递增）
    MAX_WEEK: MAX_WEEK, mondayOfDate: mondayOfDate, weeksBetween: weeksBetween, resolveWeek: resolveWeek,
    // 状态
    STATUSES: STATUSES, LEAVE: LEAVE, MAIN: MAIN, PRI: PRI, EMPTY: EMPTY,
    COLUMNS: COLUMNS, SCORE_COLUMNS: SCORE_COLUMNS,
    RULE_TYPES: RULE_TYPES, ABSENCE_PRESETS: ABSENCE_PRESETS, LONG_TERM_END: LONG_TERM_END,
    label: label, ruleLabel: ruleLabel, isLeave: isLeave, isAttended: isAttended,
    inheritedStatus: inheritedStatus, resolveSecond: resolveSecond, statusPriority: statusPriority,
    applyToSecond: applyToSecond, markOf: markOf,
    needsCheckIn: needsCheckIn, autoCheckIn: autoCheckIn,
    STATUS_FILTERS: STATUS_FILTERS, matchesStatusFilter: matchesStatusFilter, filterLabel: filterLabel,
    // 时间与时长
    p2: p2, minutesOf: minutesOf, hhmmOf: hhmmOf, halfWindows: halfWindows, recordMinutes: recordMinutes,
    // CSV
    csvEsc: csvEsc, csvLine: csvLine, toCsv: toCsv, scoreCsv: scoreCsv,
    // 分数
    round2: round2, formatNum: formatNum, parseNum: parseNum,
    MIN_SCORE: MIN_SCORE, MAX_SCORE: MAX_SCORE, MIN_RATIO: MIN_RATIO, MAX_RATIO: MAX_RATIO,
    defaultFixed: defaultFixed, defaultRatio: defaultRatio, defaultScoreConfig: defaultScoreConfig,
    clampWeights: clampWeights, activeWeights: activeWeights, describeWeights: describeWeights,
    SCORE_CATEGORIES: SCORE_CATEGORIES,
    summarize: summarize, scoreOf: scoreOf, scoreRows: scoreRows,
    // 假条
    activeLeave: activeLeave, isLeaveNoteStatus: isLeaveNoteStatus,
    leaveNoteExpired: leaveNoteExpired, leaveNoteLongTerm: leaveNoteLongTerm, leaveSpanText: leaveSpanText,
    // 名单
    roster: roster,
    // 双端数据交换
    SPECS: SPECS, SPEC_OF: SPEC_OF, TABLE_OF_COLL: TABLE_OF_COLL,
    blankDb: blankDb, migrateDb: migrateDb, normalizeRow: normalizeRow, tableToObjects: tableToObjects,
    fromAndroid: fromAndroid, toAndroid: toAndroid, mergeDb: mergeDb
  };
});
