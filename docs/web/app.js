/*
 * 考勤 · 网页版
 *
 * 定位：给**苹果用户 / 没有安装包的用户**一个可直接用、可「添加到主屏幕」的考勤端。
 * 数据只存在本机浏览器（localStorage），不依赖任何服务器；换机用「设置 → 备份/恢复」。
 *
 * 与考勤端（Android）的兼容：
 *  - 读：完整解析考勤端「数据导出」的 10 张表（tables: { 表名: { fields, rows } }），
 *        含请假条、课程名单规则、学生考勤状态、地点排序、复制格式 —— 导入后立即可用；
 *  - 写：可导出**考勤端可直接导入**的同格式备份，两端来回搬数据不丢字段；
 *  - 口径：状态、上下半节、出勤时长、假条生效、名单规则、分数规则全部与原生端同构（见 logic.js）。
 */
(function () {
  'use strict';

  // ============================================================ 常量与纯逻辑（logic.js，可被 Node 直跑验证）
  var KEY = 'kaoqin_web_v1';
  var LEGACY_KEY = 'kaoqin_teacher_v1';   // 旧名时期的键：读到就迁移，老用户数据不丢
  var KQ = window.KQLogic;
  var STATUSES = KQ.STATUSES, LEAVE = KQ.LEAVE, MAIN = KQ.MAIN, EMPTY = KQ.EMPTY;
  var RULE_TYPES = KQ.RULE_TYPES, ABSENCE_PRESETS = KQ.ABSENCE_PRESETS, LONG_TERM_END = KQ.LONG_TERM_END;
  var label = KQ.label, isLeave = KQ.isLeave, isAttended = KQ.isAttended;
  var resolveSecond = KQ.resolveSecond, statusPriority = KQ.statusPriority;
  var halfWindows = KQ.halfWindows, recordMinutes = KQ.recordMinutes;
  var toCsv = KQ.toCsv, scoreCsv = KQ.scoreCsv, formatNum = KQ.formatNum, p2 = KQ.p2;

  // ============================================================ 存储
  function load() {
    try {
      var raw = localStorage.getItem(KEY);
      if (!raw) raw = localStorage.getItem(LEGACY_KEY);
      if (raw) return KQ.migrateDb(JSON.parse(raw));
    } catch (e) { /* 解析失败按空库启动，避免整页白屏 */ }
    return KQ.blankDb();
  }
  var DB = load();
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(DB)); }
    catch (e) { toast('保存失败：本机存储可能已满，请到「设置」导出备份后清理'); }
  }
  function nid() { DB.seq = (DB.seq || 0) + 1; return DB.seq; }

  // ============================================================ 工具
  function $(s, r) { return (r || document).querySelector(s); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function today() { var d = new Date(); return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()); }
  function nowHHMM() { var d = new Date(); return p2(d.getHours()) + ':' + p2(d.getMinutes()); }
  function nowText() { return today() + ' ' + nowHHMM(); }
  function isoNow() { return today() + 'T' + nowHHMM() + ':' + p2(new Date().getSeconds()); }
  function fmtDate(s) {
    try {
      var d = new Date(s + 'T00:00:00');
      var w = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()];
      return (d.getMonth() + 1) + '月' + d.getDate() + '日 周' + w;
    } catch (e) { return s; }
  }
  function stamp() {
    var d = new Date();
    return d.getFullYear() + p2(d.getMonth() + 1) + p2(d.getDate()) + '-' + p2(d.getHours()) + p2(d.getMinutes()) + p2(d.getSeconds());
  }
  function toast(msg) {
    var t = document.createElement('div');
    t.className = 'toast'; t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 2200);
  }
  function byId(arr, id) { for (var i = 0; i < arr.length; i++) if (arr[i].id === id) return arr[i]; return null; }
  function findIdx(arr, id) { for (var i = 0; i < arr.length; i++) if (arr[i].id === id) return i; return -1; }
  function pct(v) { return v == null ? '—' : Math.round(v * 100) + '%'; }

  // ============================================================ 数据查询
  function studentsOf(classId) {
    return DB.students.filter(function (s) { return s.classId === classId; })
      .sort(function (a, b) {
        return (a.sortOrder || 0) - (b.sortOrder || 0) || String(a.studentNo).localeCompare(String(b.studentNo));
      });
  }
  /** 点名名单：剔除「不参加考勤」与「隐藏名单」，并带回黑/白名单标注 */
  function rollcallRoster(classId, courseId) {
    return KQ.roster(studentsOf(classId), DB.rules, courseId);
  }
  function sessionRecords(sessionId) {
    return DB.records.filter(function (r) { return r.sessionId === sessionId; });
  }

  // ============================================================ 路由
  var route = { name: 'rollcall', arg: '' };
  function parseHash() {
    var h = (location.hash || '').replace(/^#\/?/, '');
    var parts = h.split('/');
    return { name: parts[0] || 'rollcall', arg: parts[1] || '' };
  }
  function goto(h) {
    if (location.hash === h) { route = parseHash(); render(); }
    else location.hash = h;
  }
  window.addEventListener('hashchange', function () { route = parseHash(); render(); window.scrollTo(0, 0); });

  // ============================================================ 编辑器状态
  var editor = null;

  /** 每个「节」一份标记：marks[1] = 第一节，marks[2] = 第二节（连堂课才有第二份） */
  function periodMarks(p) {
    if (!editor.marks[p]) editor.marks[p] = {};
    return editor.marks[p];
  }
  /** 当前正在点的那个「节」的标记表 */
  function activeMarks() { return periodMarks(editor.period); }
  function periodCount() { return editor.doublePeriod ? 2 : 1; }

  function newEditor() {
    var def = DB.settings.defaultClassId || (DB.classes[0] ? DB.classes[0].id : 0);
    editor = {
      sessionId: null, sids: [], pairId: 0, date: today(), classId: def,
      courseId: (DB.courses[0] ? DB.courses[0].id : 0),
      locationId: 0, timeId: (DB.times[0] ? DB.times[0].id : 0),
      timeId2: (DB.times[1] ? DB.times[1].id : 0), doublePeriod: false,
      period: 1, half: 1, marks: { 1: {}, 2: {} },
      statusFilter: 'ABSENT'
    };
    ensureMarks();
  }

  /** 新建一名学生的默认标记：当天有生效假条 → 假条状态；否则**缺勤**（与考勤端一致，名单出现即全员缺勤） */
  function defaultMark(studentId) {
    var lv = KQ.activeLeave(DB.leaveNotes, studentId, editor.date);
    return { first: lv ? lv.status : 'ABSENT', second: 'INHERIT', checkIn: '', leaveTime: '', byLeave: !!lv };
  }

  /** 名单变化时补齐 marks（已标记的不动） */
  function ensureMarks() {
    var roster = rollcallRoster(editor.classId, editor.courseId).roster;
    for (var p = 1; p <= periodCount(); p++) {
      var M = periodMarks(p);
      roster.forEach(function (s) { if (!M[s.id]) M[s.id] = defaultMark(s.id); });
    }
  }

  /** 取某学生当前节的标记（不存在则按默认值创建） */
  function markOf(studentId) {
    var M = activeMarks();
    if (!M[studentId]) M[studentId] = defaultMark(studentId);
    return M[studentId];
  }

  /** 清空标记（换班级/课程/日期时调用）——重新按默认缺勤填充 */
  function resetMarks() {
    editor.marks = { 1: {}, 2: {} };
    ensureMarks();
  }

  function loadEditorFromSession(id) {
    var s = byId(DB.sessions, id);
    if (!s) return false;
    // 连堂课：同一 pairId 的两条会话按 id 升序即「第一节 / 第二节」
    var pair = s.pairId ? DB.sessions.filter(function (x) { return x.pairId === s.pairId; })
      .sort(function (a, b) { return a.id - b.id; }) : [];
    var list = pair.length ? pair : [s];
    editor = {
      sessionId: id, sids: list.map(function (x) { return x.id; }), pairId: s.pairId || 0,
      date: s.date, classId: s.classId, courseId: s.courseId,
      locationId: s.locationId, timeId: s.timeId,
      timeId2: list[1] ? list[1].timeId : 0, doublePeriod: list.length > 1,
      // 从「第二节」进入时直接落在第二节（两节按 id 升序即第 1/2 节）
      period: Math.max(1, list.findIndex(function (x) { return x.id === id; }) + 1), half: 1,
      marks: { 1: {}, 2: {} },
      // 编辑历史会话默认「全部」：已标记的缺勤才是多数，缺勤筛选会隐藏大多数学生
      statusFilter: 'ALL'
    };
    list.forEach(function (ses, i) {
      var byS = {};
      sessionRecords(ses.id).forEach(function (r) { (byS[r.studentId] = byS[r.studentId] || {})[r.half] = r; });
      Object.keys(byS).forEach(function (sid) {
        var f = byS[sid][1], sec = byS[sid][2];
        var first = f ? f.status : 'ABSENT';
        editor.marks[i + 1][sid] = {
          first: first,
          second: sec ? KQ.markOf(first, sec.status) : KQ.markOf(first, null),
          checkIn: f ? (f.checkInTime || '') : '',
          leaveTime: f ? (f.leaveTime || '') : '',
          byLeave: false
        };
      });
    });
    ensureMarks();
    return true;
  }

  // ============================================================ 保存会话
  /**
   * 保存点名：连堂课写**两条会话**（第一节 / 第二节），用 pairId 关联；
   * 每条会话内部再按半节拆记录 —— 合计四段：节1上/节1下/节2上/节2下。
   */
  function saveEditor() {
    if (!editor.classId) { toast('请先选择班级'); return; }
    if (!editor.courseId) { toast('请先在「管理 → 课程」添加并选择课程'); return; }
    var cls = byId(DB.classes, editor.classId), course = byId(DB.courses, editor.courseId);
    var loc = byId(DB.locations, editor.locationId);
    var periods = periodCount();
    if (periods === 2 && !editor.timeId2) { toast('连堂课请先选择第二节的节次'); return; }

    // 本次要写的会话 id：编辑时沿用旧 id（缺的补新），新点名逐节新建
    var sids = [];
    for (var p = 1; p <= periods; p++) sids[p] = editor.sids[p - 1] || nid();
    var pairId = periods === 2 ? (editor.pairId || sids[1]) : 0;
    var stale = editor.sids.slice();

    DB.sessions = DB.sessions.filter(function (s) { return stale.indexOf(s.id) < 0; });
    DB.records = DB.records.filter(function (r) { return stale.indexOf(r.sessionId) < 0; });

    var roster = rollcallRoster(editor.classId, editor.courseId).roster;
    var written = 0;
    for (var q = 1; q <= periods; q++) {
      var sid = sids[q];
      var timeId = q === 1 ? editor.timeId : editor.timeId2;
      var time = byId(DB.times, timeId);
      DB.sessions.push({
        id: sid, classId: editor.classId, courseId: editor.courseId, locationId: editor.locationId,
        timeId: timeId, date: editor.date, remark: '', createdAt: Date.now(), pairId: pairId,
        className: cls ? cls.name : '', courseName: course ? course.name : '',
        // 地点快照只存「上课地点」名，与考勤端一致（科室只是选择时的二级定位，不进快照）
        locationName: loc ? loc.name : '',
        timePeriod: time ? time.period : ''
      });
      var M = periodMarks(q);
      roster.forEach(function (s) {
        var m = M[s.id];
        if (!m) return;
        var first = m.first || 'ABSENT';   // 未标记 → 缺勤
        DB.records.push({
          id: nid(), sessionId: sid, studentId: s.id, status: first, remark: '',
          studentName: s.name, studentNo: s.studentNo, half: 1,
          checkInTime: m.checkIn || '', leaveTime: first === 'EARLY_LEAVE' ? (m.leaveTime || '') : ''
        });
        written++;
        var sec = KQ.resolveSecond(first, m.second);
        if (sec) {
          DB.records.push({
            id: nid(), sessionId: sid, studentId: s.id, status: sec, remark: '',
            studentName: s.name, studentNo: s.studentNo, half: 2, checkInTime: '', leaveTime: ''
          });
          written++;
        }
      });
    }
    save();
    toast('已保存 ' + roster.length + ' 人 × ' + periods + ' 节（' + written + ' 条记录）');
    goto('#/records');
  }

  function deleteSession(id) {
    confirmSheet('删除考勤', '确定删除这次考勤记录吗？此操作不可恢复。', function () {
      var s = byId(DB.sessions, id);
      var pairId = s ? s.pairId : 0;
      DB.sessions = DB.sessions.filter(function (x) { return x.id !== id; });
      DB.records = DB.records.filter(function (r) { return r.sessionId !== id; });
      // 连堂：删掉其中一节后，剩下那节退回「单节」，不留一个只剩一节的分组
      if (pairId) {
        DB.sessions.forEach(function (x) { if (x.pairId === pairId) x.pairId = 0; });
      }
      save(); closeSheet(); toast('已删除'); goto('#/records');
    });
  }

  // ============================================================ 筛选
  var rf = { range: 'all', classId: 0, courseId: 0, locationId: 0, keyword: '' };
  function rangeStart() {
    if (rf.range === 'today') return today();
    if (rf.range === '7') {
      var d = new Date(); d.setDate(d.getDate() - 6);
      return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());
    }
    return null;
  }
  function filteredSessions() {
    var start = rangeStart();
    return DB.sessions.filter(function (s) {
      if (start && s.date < start) return false;
      if (rf.classId && s.classId !== rf.classId) return false;
      if (rf.courseId && s.courseId !== rf.courseId) return false;
      if (rf.locationId && s.locationId !== rf.locationId) return false;
      return true;
    }).sort(function (a, b) { return a.date < b.date ? 1 : a.date > b.date ? -1 : b.id - a.id; });
  }
  function rangeText() { return rf.range === 'today' ? '今天' : rf.range === '7' ? '近7天' : '全部时间'; }
  function selectText(arr, id, all) { var o = id ? byId(arr, id) : null; return o ? o.name : all; }

  // ============================================================ 明细行（导出与界面同源）
  function exportRows(sessions, keyword) {
    var ids = {}; sessions.forEach(function (s) { ids[s.id] = 1; });
    var kw = String(keyword || '').trim().toLowerCase();
    var recs = DB.records.filter(function (r) { return ids[r.sessionId]; });
    var out = [];
    sessions.slice().sort(function (a, b) {
      return a.date < b.date ? -1 : a.date > b.date ? 1 : a.id - b.id;
    }).forEach(function (s) {
      var cls = byId(DB.classes, s.classId), course = byId(DB.courses, s.courseId);
      var loc = byId(DB.locations, s.locationId), time = byId(DB.times, s.timeId);
      var win = time ? halfWindows(time.startTime, time.endTime) : null;
      var rows = recs.filter(function (r) { return r.sessionId === s.id; })
        .filter(function (r) {
          if (!kw) return true;
          return String(r.studentName || '').toLowerCase().indexOf(kw) >= 0 ||
            String(r.studentNo || '').toLowerCase().indexOf(kw) >= 0;
        })
        .sort(function (a, b) {
          return statusPriority(a.status) - statusPriority(b.status) ||
            String(a.studentNo).localeCompare(String(b.studentNo)) || a.half - b.half;
        });
      rows.forEach(function (r) {
        var w = win ? (r.half === 2 ? win[1] : win[0]) : null;
        var dur;
        if (!w) dur = EMPTY;
        else if (!isAttended(r.status)) dur = '0';
        else dur = String(recordMinutes(r.checkInTime, r.leaveTime, w));
        out.push({
          sessionId: s.id, date: s.date,
          courseName: (course && course.name) || s.courseName || EMPTY,
          className: (cls && cls.name) || s.className || EMPTY,
          major: (cls && cls.major) || EMPTY,
          locationName: (loc && loc.name) || s.locationName || EMPTY,
          period: (time && time.period) || s.timePeriod || EMPTY,
          studentNo: r.studentNo || EMPTY, name: r.studentName || EMPTY,
          halfLabel: r.half === 2 ? '下半节' : '上半节',
          checkIn: r.checkInTime || EMPTY, checkOut: r.leaveTime || EMPTY,
          statusLabel: label(r.status), duration: dur, abnormal: r.remark || EMPTY,
          // 连堂：只在块标题标一个「连堂」，列结构保持 14 列不变（与考勤端导出一致）
          pairId: s.pairId || 0
        });
      });
    });
    return out;
  }

  // ============================================================ 导出
  function exportCsv() {
    var sessions = filteredSessions();
    if (!sessions.length) { toast('当前筛选下没有可导出的记录'); return; }
    var rows = exportRows(sessions, rf.keyword);
    if (!rows.length) { toast('筛选后没有明细行'); return; }
    var text = toCsv(rows, {
      rangeText: rangeText(),
      classText: selectText(DB.classes, rf.classId, '全部'),
      courseText: selectText(DB.courses, rf.courseId, '全部'),
      locationText: selectText(DB.locations, rf.locationId, '全部'),
      exportedAt: new Date().toLocaleString('zh-CN')
    });
    download('考勤明细_' + rangeText() + '_' + stamp() + '.csv', text, 'text/csv');
  }

  function exportOne(id) {
    var s = byId(DB.sessions, id); if (!s) return;
    var rows = exportRows([s]);
    if (!rows.length) { toast('本节没有明细行'); return; }
    var text = toCsv(rows, {
      rangeText: fmtDate(s.date), classText: s.className || '全部',
      courseText: s.courseName || '全部', locationText: s.locationName || '全部',
      exportedAt: new Date().toLocaleString('zh-CN')
    });
    download('考勤明细_' + s.date + '_' + stamp() + '.csv', text, 'text/csv');
  }

  /** 本应用备份（JSON）：只在网页版内部恢复用 */
  function doBackup() {
    var file = { app: 'kaoqin-web', kind: 'kaoqin-web-backup', v: 2, exportedAt: isoNow(), data: DB };
    download('考勤网页版备份-' + stamp() + '.json', JSON.stringify(file, null, 1), 'application/json');
  }

  /** 考勤端兼容备份：结构与考勤端「数据导出」完全一致，可直接被考勤端导入 */
  function doExportAndroid() {
    var env = KQ.toAndroid(DB, isoNow());
    var total = 0;
    Object.keys(env.tables).forEach(function (k) { total += env.tables[k].rows.length; });
    download('kaoqin-backup-' + stamp() + '.json', JSON.stringify(env), 'application/json');
    toast('已导出 ' + total + ' 行，可到考勤端「数据导入」使用');
  }

  /**
   * 导出文件。
   *
   * 手机/平板：走系统分享面板（iOS 上是唯一能把文件存进「文件」App 的路径）；
   * **电脑：一律直接下载**——桌面 Chrome/Edge 也实现了 Web Share，但弹出来的是系统共享弹窗，
   * 用户要的是「文件落到下载目录」，多一步纯属添乱（Windows 上还可能因为找不到可分享应用而失败）。
   * 判定写在 logic.js 的 sharePolicy 里（纯函数，Node 可直跑断言）。
   */
  function download(name, text, mime) {
    try {
      var blob = new Blob([text], { type: (mime || 'text/plain') + ';charset=utf-8' });
      var file = new File([blob], name, { type: mime || 'text/plain' });
      var canShare = !!(navigator.canShare && navigator.canShare({ files: [file] }));
      var policy = KQ.sharePolicy(navigator.userAgent, navigator.maxTouchPoints || 0, canShare);
      if (policy === 'share') {
        navigator.share({ files: [file], title: name }).catch(function () { fallbackDownload(blob, name); });
      } else {
        fallbackDownload(blob, name);
      }
    } catch (e) { toast('导出失败：' + e.message); }
  }
  function fallbackDownload(blob, name) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = name; a.rel = 'noopener';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  // ============================================================ 导入（本应用 / 考勤端，双端兼容）
  function doImport() {
    var input = document.createElement('input');
    input.type = 'file'; input.accept = '.json,application/json';
    input.onchange = function () {
      var f = input.files && input.files[0]; if (!f) return;
      var reader = new FileReader();
      reader.onload = function () {
        var doc;
        try { doc = JSON.parse(reader.result); }
        catch (e) { toast('文件解析失败：' + e.message); return; }
        var parsed = readImport(doc);
        if (!parsed.ok) { toast(parsed.error); return; }
        showImportPreview(parsed, f.name);
      };
      reader.readAsText(f);
    };
    input.click();
  }

  /** 识别文件类型：考勤端 tables 结构 / 网页版备份 / 旧版直接存 DB 的备份 */
  function readImport(doc) {
    if (doc && doc.tables && typeof doc.tables === 'object') {
      var r = KQ.fromAndroid(doc);
      if (!r.ok) return r;
      r.kind = 'android';
      r.title = '考勤端导出';
      return r;
    }
    if (doc && doc.data && doc.data.v) {
      return { ok: true, kind: 'web', title: '网页版备份', db: KQ.migrateDb(doc.data), stats: null, total: 0, unknown: [] };
    }
    if (doc && doc.v && Array.isArray(doc.classes)) {
      return { ok: true, kind: 'web', title: '网页版备份（旧格式）', db: KQ.migrateDb(doc), stats: null, total: 0, unknown: [] };
    }
    return { ok: false, error: '不是可识别的备份文件（支持考勤端导出 与 网页版备份）' };
  }

  function countOfDb(db) {
    return {
      classes: (db.classes || []).length, students: (db.students || []).length,
      courses: (db.courses || []).length, locations: (db.locations || []).length,
      times: (db.times || []).length, sessions: (db.sessions || []).length,
      records: (db.records || []).length, leaveNotes: (db.leaveNotes || []).length,
      rules: (db.rules || []).length, copies: (db.copies || []).length
    };
  }

  var pendingImport = null;
  function showImportPreview(parsed, fileName) {
    var c = countOfDb(parsed.db);
    var rows = [
      ['班级', c.classes], ['学生', c.students], ['课程', c.courses], ['上课地点', c.locations],
      ['节次', c.times], ['点名会话', c.sessions], ['考勤记录', c.records],
      ['请假条', c.leaveNotes], ['名单规则', c.rules], ['复制格式', c.copies]
    ];
    var html = '<h3>导入预览</h3>' +
      '<p class="small muted" style="margin:0 0 10px;line-height:1.7">文件：' + esc(fileName || '') +
      '<br>类型：' + esc(parsed.title) + '</p>' +
      '<div class="card" style="box-shadow:none;border:1px solid var(--line);margin:0 0 12px">';
    rows.forEach(function (r) {
      html += '<div class="statline"><span class="muted">' + r[0] + '</span><span class="k">' + r[1] + ' 行</span></div>';
    });
    html += '</div>';
    if (parsed.unknown && parsed.unknown.length) {
      html += '<p class="tiny muted" style="margin:0 0 10px">未识别的表（已忽略）：' + esc(parsed.unknown.join('、')) + '</p>';
    }
    html += '<div class="f"><label class="f">导入方式</label><select id="imp_mode">' +
      '<option value="replace">覆盖本机全部数据（先清空再导入）</option>' +
      '<option value="merge">合并（同 ID 覆盖，其余追加）</option>' +
      '</select></div>' +
      '<p class="tiny muted" style="margin:0 0 12px;line-height:1.7">合并按主键 id 判断同一条数据：' +
      '从考勤端反复导入同一份备份不会产生重复；网页已录入的数据不会被删。</p>' +
      '<div class="actions"><button class="btn ghost" data-act="closeSheet">取消</button>' +
      '<button class="btn" data-act="doImportOk">确认导入</button></div>';
    openSheet(html);
    pendingImport = parsed;
  }

  function runImport() {
    var p = pendingImport; if (!p) return;
    var mode = ($('#imp_mode') || {}).value || 'replace';
    if (mode === 'replace') {
      DB = p.db;
      save(); closeSheet(); toast('已导入：' + p.title); pendingImport = null; render(); return;
    }
    confirmSheet('合并导入', '将把文件中的数据按 ID 合并进本机（考勤记录 ' +
      countOfDb(p.db).records + ' 条）。继续？', function () {
      var r = KQ.mergeDb(DB, p.db, 'merge');
      DB = r.db; save(); toast('已合并导入'); pendingImport = null; render();
    });
  }

  // ============================================================ 视图：点名
  /** 地点分组：同名「上课地点」合并为一级，组内「所属科室」为二级（与考勤端一致） */
  function locGroups() {
    var order = [], map = {};
    DB.locations.slice().sort(function (a, b) {
      return (a.sortOrder || 0) - (b.sortOrder || 0) || (a.id - b.id);
    }).forEach(function (l) {
      if (!map[l.name]) { map[l.name] = []; order.push(l.name); }
      map[l.name].push(l);
    });
    return { order: order, map: map };
  }
  function deptsOf(name) {
    var g = locGroups().map[name] || [], out = [];
    g.forEach(function (l) { if (l.department && out.indexOf(l.department) < 0) out.push(l.department); });
    return out;
  }
  /** 当前正在点的半节的「归类状态」：下半节「不记录」按缺勤呈现（否则老师会找不到该学生） */
  function filterStatusOf(studentId) {
    var m = markOf(studentId);
    if (editor.half === 2) {
      var sec = KQ.resolveSecond(m.first, m.second);
      return sec || 'ABSENT';
    }
    return m.first || 'ABSENT';
  }

  function viewRollcall() {
    if (!editor) newEditor();
    ensureMarks();
    if (!DB.classes.length) {
      return topbar('点名', '网页版') + '<div class="card"><div class="empty">还没有班级数据<br>先到「管理 → 班级」添加一个班级和学生</div>' +
        '<button class="btn" data-act="go" data-v="manage">去添加</button></div>';
    }
    var picked = rollcallRoster(editor.classId, editor.courseId);
    var students = picked.roster;
    var hiddenCount = studentsOf(editor.classId).length - students.length;
    var showDept = !!editor.locationId && deptsOf((byId(DB.locations, editor.locationId) || {}).name || '').length >= 2;
    var curLoc = byId(DB.locations, editor.locationId);
    var curLocName = curLoc ? curLoc.name : '';

    var h = topbar((editor.sessionId ? '编辑考勤' : '点名') + (editor.doublePeriod ? ' · 连堂' : ''),
      (byId(DB.classes, editor.classId) || {}).name || '') +
      '<div class="card">' +
      '<div class="grid2">' +
      sel('班级', 'classId', DB.classes.map(function (c) { return [c.id, c.name]; }), editor.classId) +
      sel('课程', 'courseId', DB.courses.map(function (c) { return [c.id, c.name]; }), editor.courseId) +
      '</div><div class="grid2" style="margin-top:8px">' +
      sel('上课地点', 'locName', [[0, '未设置']].concat(locGroups().order.map(function (n) { return [n, n]; })), curLocName) +
      sel(editor.doublePeriod ? '第一节节次' : '节次', 'timeId',
        [[0, '未设置']].concat(DB.times.map(function (c) { return [c.id, c.period]; })), editor.timeId) +
      '</div>' +
      (showDept ? '<div style="margin-top:8px">' +
        sel('所属科室', 'locDept', deptsOf(curLocName).map(function (d) { return [d, d]; }), curLoc ? curLoc.department : '') +
        '</div>' : '') +
      '<div style="margin-top:8px"><label class="f">日期</label>' +
      '<input type="date" data-change="date" value="' + esc(editor.date) + '"></div>' +
      '<div class="row" style="margin-top:10px">' +
      '<div class="grow tiny muted">连堂课：同一班级/课程/地点，两节连上一起点名（如 1-2 节 + 3-4 节）</div>' +
      '<button class="btn sm ' + (editor.doublePeriod ? '' : 'ghost') + '" data-act="toggleDouble">' +
      (editor.doublePeriod ? '已开启' : '开启') + '</button>' +
      '</div>' +
      (editor.doublePeriod ? '<div style="margin-top:8px">' +
        sel('第二节节次', 'timeId2', [[0, '未设置']].concat(DB.times.map(function (c) { return [c.id, c.period]; })), editor.timeId2) +
        (editor.sessionId ? '<p class="tiny muted" style="margin:6px 0 0">关闭连堂后保存，会删除第二节已保存的考勤记录</p>' : '') +
        '</div>' : '') +
      '</div>';

    if (!students.length) {
      return h + '<div class="card"><div class="empty">这个班级还没有可点名的学生<br>先到「管理 → 学生」添加学生</div></div>';
    }

    // ---------- 分段切换：节（1/2）× 半节（上/下）
    var t1 = byId(DB.times, editor.timeId), t2 = byId(DB.times, editor.timeId2);
    h += '<div class="card">';
    if (editor.doublePeriod) {
      h += '<div class="seg">' +
        '<button class="' + (editor.period === 1 ? 'on' : '') + '" data-act="period" data-v="1">第1节' +
        (t1 ? '<br><span class="tiny">' + esc(t1.period) + '</span>' : '') + '</button>' +
        '<button class="' + (editor.period === 2 ? 'on' : '') + '" data-act="period" data-v="2">第2节' +
        (t2 ? '<br><span class="tiny">' + esc(t2.period) + '</span>' : '') + '</button>' +
        '</div>';
    }
    h += '<div class="seg" style="margin-top:6px">' +
      '<button class="' + (editor.half === 1 ? 'on' : '') + '" data-act="half" data-v="1">上半节</button>' +
      '<button class="' + (editor.half === 2 ? 'on' : '') + '" data-act="half" data-v="2">下半节</button>' +
      '</div>';

    var counts = {};
    KQ.STATUS_FILTERS.forEach(function (f) {
      counts[f.key] = students.filter(function (s) { return KQ.matchesStatusFilter(f.key, filterStatusOf(s.id)); }).length;
    });
    h += '<div class="chips" style="margin-top:10px">' +
      KQ.STATUS_FILTERS.map(function (f) {
        return '<span class="chip' + (editor.statusFilter === f.key ? ' on' : '') + '" data-s="' + f.key + '" ' +
          'data-act="filter" data-v="' + f.key + '">' + f.label + ' ' + counts[f.key] + '</span>';
      }).join('') + '</div>';

    h += '<div class="row" style="margin-top:10px"><div class="grow small muted">共 ' + students.length +
      ' 人' + (hiddenCount > 0 ? ' · 已隐藏 ' + hiddenCount + ' 人' : '') + ' · 默认缺勤，未标记即按缺勤保存</div>' +
      '<button class="btn sm ghost" data-act="allPresent">全部已到</button>' +
      '<button class="btn sm ghost" data-act="allAbsent">全部缺勤</button></div>' +
      '<p class="tiny muted" style="margin:8px 0 0">当天的请假条会自动带入；扫码可记「已到」并写入签到时刻。' +
      (editor.doublePeriod ? '两节的标记各自独立，会分别落库。' : '') + '</p>';
    h += '</div>';

    var shown = students.filter(function (s) { return KQ.matchesStatusFilter(editor.statusFilter, filterStatusOf(s.id)); });
    if (!shown.length) {
      h += '<div class="empty">当前筛选「' + esc(KQ.filterLabel(editor.statusFilter)) + '」没有学生<br>切到「全部」可查看完整名单</div>';
    }

    h += '<div class="list">';
    shown.forEach(function (s) {
      var m = markOf(s.id);
      var secEff = KQ.resolveSecond(m.first, m.second);
      var lv = KQ.activeLeave(DB.leaveNotes, s.id, editor.date);
      h += '<div class="item" style="cursor:default">' +
        '<div class="row"><div class="grow"><span class="t">' + esc(s.name) + '</span>' +
        '<span class="m" style="margin-left:8px">' + esc(s.studentNo) + '</span></div>' +
        (picked.blackIds[s.id] ? '<span class="badge LEAVE">黑</span>' : '') +
        (picked.whiteIds[s.id] ? '<span class="badge PRESENT">白</span>' : '') +
        '<span class="badge ' + (secEff ? esc(secEff) : 'ABSENT') + '">' + esc(label(m.first)) + ' / ' +
        (secEff ? esc(label(secEff)) : '不记录') + '</span></div>' +
        (lv ? '<div class="m" style="color:var(--blue)">假条：' + esc(label(lv.status)) + ' · ' + esc(KQ.leaveSpanText(lv)) + '</div>' : '') +
        (m.checkIn ? '<div class="m">签到 ' + esc(m.checkIn) + '</div>' : '') +
        '<div class="chips" style="margin-top:8px">';

      if (editor.half === 1) {
        MAIN.forEach(function (k) {
          h += '<span class="chip' + (m.first === k ? ' on' : '') + '" data-s="' + k + '" data-act="setFirst" data-id="' + s.id + '" data-v="' + k + '">' + label(k) + '</span>';
        });
        h += '<span class="chip' + (isLeave(m.first) ? ' on' : '') + '" data-s="SICK_LEAVE" data-act="pickLeave" data-id="' + s.id + '">' +
          (isLeave(m.first) ? label(m.first) : '请假') + '</span>';
      } else {
        h += '<span class="chip mute' + (m.second === 'INHERIT' ? ' on' : '') + '" data-act="setSecond" data-id="' + s.id + '" data-v="INHERIT">跟随上半节</span>' +
          '<span class="chip mute' + (m.second === 'NOT_RECORDED' ? ' on' : '') + '" data-act="setSecond" data-id="' + s.id + '" data-v="NOT_RECORDED">不记录</span>';
        MAIN.filter(function (k) { return k !== 'EARLY_LEAVE'; }).forEach(function (k) {
          var on = m.second !== 'INHERIT' && m.second !== 'NOT_RECORDED' && m.second === k;
          h += '<span class="chip' + (on ? ' on' : '') + '" data-s="' + k + '" data-act="setSecond" data-id="' + s.id + '" data-v="' + k + '">' + label(k) + '</span>';
        });
      }
      h += '</div>';
      if (editor.half === 2) {
        h += '<p class="tiny muted" style="margin:7px 0 0">' +
          (m.first === 'EARLY_LEAVE' ? '上半节早退 → 下半节默认不记录' :
            m.second === 'INHERIT' ? '继承上半节：迟到按已到、早退不记录' : '已单独设置下半节') + '</p>';
      }
      h += '</div>';
    });
    h += '</div>';

    h += '<div style="margin-top:12px"><button class="btn" data-act="saveEditor">' +
      (editor.sessionId ? '保存修改' : '保存本次考勤') + '</button></div>';
    return h;
  }

  function sel(labelText, change, options, value) {
    var h = '<div><label class="f">' + esc(labelText) + '</label><select data-change="' + change + '">';
    options.forEach(function (o) {
      h += '<option value="' + o[0] + '"' + (String(o[0]) === String(value) ? ' selected' : '') + '>' + esc(o[1]) + '</option>';
    });
    return h + '</select></div>';
  }
  function opt(v, t, cur) { return '<option value="' + v + '"' + (String(v) === String(cur) ? ' selected' : '') + '>' + esc(t) + '</option>'; }

  // ============================================================ 视图：记录
  function viewRecords() {
    var sessions = filteredSessions();
    var h = topbar('考勤记录', sessions.length + ' 次') +
      '<div class="card">' +
      '<div class="seg">' +
      ['today', '7', 'all'].map(function (r) {
        var t = r === 'today' ? '今天' : r === '7' ? '近7天' : '全部';
        return '<button class="' + (rf.range === r ? 'on' : '') + '" data-act="range" data-v="' + r + '">' + t + '</button>';
      }).join('') +
      '</div>' +
      '<div class="grid2" style="margin-top:10px">' +
      sel('班级', 'rfClass', [[0, '全部班级']].concat(DB.classes.map(function (c) { return [c.id, c.name]; })), rf.classId) +
      sel('课程', 'rfCourse', [[0, '全部课程']].concat(DB.courses.map(function (c) { return [c.id, c.name]; })), rf.courseId) +
      '</div>' +
      '<div class="grid2" style="margin-top:8px">' +
      sel('地点', 'rfLocation', [[0, '全部地点']].concat(DB.locations.map(function (c) { return [c.id, c.name]; })), rf.locationId) +
      '<div><label class="f">姓名 / 学号</label><input type="text" data-change="rfKeyword" value="' + esc(rf.keyword) + '" placeholder="可选"></div>' +
      '</div>' +
      '<div style="margin-top:12px"><button class="btn ghost" data-act="export">导出考勤明细 CSV</button></div>' +
      '</div>';

    if (!sessions.length) return h + '<div class="empty">没有符合条件的考勤记录</div>';

    h += '<div class="list">';
    sessions.forEach(function (s) {
      var recs = sessionRecords(s.id);
      var counts = {};
      recs.forEach(function (r) { counts[r.status] = (counts[r.status] || 0) + 1; });
      var attended = (counts.PRESENT || 0) + (counts.LATE || 0) + (counts.EARLY_LEAVE || 0);
      var rate = recs.length ? Math.round(attended / recs.length * 100) : null;
      h += '<div class="item" data-act="openRecord" data-id="' + s.id + '">' +
        '<div class="row"><div class="t grow">' + esc(fmtDate(s.date)) + '</div>' +
        '<div class="t" style="color:var(--blue)">' + (rate == null ? '无记录' : '到课 ' + rate + '%') + '</div></div>' +
        '<div class="m">' + esc(s.courseName || '未选课程') + ' · ' + esc(s.className || '未选班级') + '</div>' +
        '<div class="m">' + esc([s.pairId ? '连堂' : '', s.locationName || '', s.timePeriod || '']
          .filter(Boolean).join(' · ') || '未设置地点与节次') + '</div>' +
        '<div class="b chips">';
      ['PRESENT', 'LATE', 'EARLY_LEAVE', 'ABSENT'].forEach(function (k) {
        if (counts[k]) h += badge(k) + '<span class="tiny muted" style="margin-left:2px;margin-right:6px">' + counts[k] + '</span>';
      });
      var lc = (counts.SICK_LEAVE || 0) + (counts.PERSONAL_LEAVE || 0) + (counts.PUBLIC_LEAVE || 0);
      if (lc) h += badge('SICK_LEAVE') + '<span class="tiny muted" style="margin-left:2px">' + lc + '</span>';
      h += '</div></div>';
    });
    h += '</div>';
    return h;
  }

  function viewDetail(id) {
    var s = byId(DB.sessions, id);
    if (!s) return '<div class="empty">记录不存在</div>';
    var recs = sessionRecords(id).sort(function (a, b) {
      return statusPriority(a.status) - statusPriority(b.status) ||
        String(a.studentNo).localeCompare(String(b.studentNo)) || a.half - b.half;
    });
    var sum = KQ.summarize(recs);
    // 连堂：标出这是两节中的第几节（两节是两条会话，pairId 相同、id 升序即第 1/2 节）
    var pairNote = '';
    if (s.pairId) {
      var pair = DB.sessions.filter(function (x) { return x.pairId === s.pairId; })
        .sort(function (a, b) { return a.id - b.id; });
      pairNote = '连堂（第 ' + (pair.findIndex(function (x) { return x.id === s.id; }) + 1) + ' / ' + pair.length + ' 节）';
    }
    var h = topbar('考勤详情', fmtDate(s.date)) +
      '<div class="card">' +
      '<div class="statline"><span class="muted">课程</span><span class="k">' + esc(s.courseName || '未选') + '</span></div>' +
      '<div class="statline"><span class="muted">班级</span><span class="k">' + esc(s.className || '未选') + '</span></div>' +
      '<div class="statline"><span class="muted">地点 / 节次</span><span class="k">' + esc((s.locationName || '未设置') + ' · ' + (s.timePeriod || '未设置')) + '</span></div>' +
      (pairNote ? '<div class="statline"><span class="muted">连堂</span><span class="k">' + esc(pairNote) + '</span></div>' : '') +
      '<div class="statline"><span class="muted">人次 / 出勤率</span><span class="k">' + sum.total + ' · ' + pct(sum.rate) + '</span></div>' +
      '</div>' +
      '<div class="row" style="gap:8px;margin-bottom:12px">' +
      '<button class="btn ghost" data-act="editSession" data-id="' + id + '">编辑</button>' +
      '<button class="btn ghost" data-act="exportOne" data-id="' + id + '">导出本节</button>' +
      '<button class="btn ghost" style="color:var(--danger);border-color:#f0cccc" data-act="delSession" data-id="' + id + '">删除</button>' +
      '</div>';

    if (!recs.length) return h + '<div class="empty">暂无明细</div>';
    h += '<p class="tiny muted" style="margin:0 0 8px">点任意一行可单独修改该条记录（状态 / 签到 / 早退时刻 / 备注）。</p>';
    h += '<div class="list">';
    recs.forEach(function (r) {
      h += '<div class="item" data-act="editRecord" data-id="' + r.id + '"><div class="row">' +
        '<div class="grow"><span class="t">' + esc(r.studentName || '—') + '</span>' +
        '<span class="m" style="margin-left:8px">' + esc(r.studentNo || '') + '</span></div>' +
        badge(r.status) + '</div>' +
        '<div class="m">' + (r.half === 2 ? '下半节' : '上半节') +
        (r.checkInTime ? ' · 签到 ' + esc(r.checkInTime) : '') +
        (r.leaveTime ? ' · 早退 ' + esc(r.leaveTime) : '') +
        (r.remark ? ' · ' + esc(r.remark) : '') + '</div></div>';
    });
    h += '</div>';
    return h;
  }

  // ============================================================ 视图：统计
  var sf = { classId: 0, courseId: 0 };
  var statSort = { key: 'rate', asc: false };

  function statRows() {
    var start = rangeStart();
    var sessions = DB.sessions.filter(function (s) {
      if (start && s.date < start) return false;
      if (sf.classId && s.classId !== sf.classId) return false;
      if (sf.courseId && s.courseId !== sf.courseId) return false;
      return true;
    });
    var ids = {}; sessions.forEach(function (s) { ids[s.id] = 1; });
    var recs = DB.records.filter(function (r) { return ids[r.sessionId]; });
    return { sessions: sessions, recs: recs };
  }

  function viewStats() {
    var pack = statRows();
    var groups = {}, order = [];
    pack.recs.forEach(function (r) {
      if (!groups[r.studentId]) { groups[r.studentId] = []; order.push(r.studentId); }
      groups[r.studentId].push(r);
    });
    var list = order.map(function (id) {
      var g = groups[id];
      var live = byId(DB.students, id);
      var s = KQ.summarize(g);
      var cls = live ? byId(DB.classes, live.classId) : null;
      return {
        id: id,
        name: (live && live.name) || g[0].studentName || '未知学生',
        no: (live && live.studentNo) || g[0].studentNo || '',
        className: (cls && cls.name) || '',
        sum: s, rate: s.rate == null ? 0 : s.rate
      };
    });
    list.sort(function (a, b) {
      var d;
      if (statSort.key === 'rate') d = a.rate - b.rate;
      else if (statSort.key === 'absent') d = a.sum.absent - b.sum.absent;
      else if (statSort.key === 'late') d = a.sum.late - b.sum.late;
      else if (statSort.key === 'name') d = String(a.name).localeCompare(String(b.name));
      else d = a.sum.total - b.sum.total;
      return statSort.asc ? d : -d;
    });

    var total = KQ.summarize(pack.recs);
    var h = topbar('统计分析', pack.sessions.length + ' 次课 · ' + total.total + ' 人次') +
      '<div class="card"><div class="seg">' +
      ['today', '7', 'all'].map(function (r) {
        var t = r === 'today' ? '今天' : r === '7' ? '近7天' : '全部';
        return '<button class="' + (rf.range === r ? 'on' : '') + '" data-act="range" data-v="' + r + '">' + t + '</button>';
      }).join('') + '</div>' +
      '<div class="grid2" style="margin-top:10px">' +
      sel('班级', 'sfClass', [[0, '全部班级']].concat(DB.classes.map(function (c) { return [c.id, c.name]; })), sf.classId) +
      sel('课程', 'sfCourse', [[0, '全部课程']].concat(DB.courses.map(function (c) { return [c.id, c.name]; })), sf.courseId) +
      '</div></div>';

    h += '<div class="card"><h2>整体</h2>' +
      '<div class="statline"><span class="muted">人次 / 出勤率</span><span class="k">' + total.total + ' · ' + pct(total.rate) + '</span></div>' +
      '<div class="statline"><span class="muted">已到 / 迟到 / 早退</span><span class="k">' + total.present + ' / ' + total.late + ' / ' + total.earlyLeave + '</span></div>' +
      '<div class="statline"><span class="muted">缺勤 / 请假</span><span class="k">' + total.absent + ' / ' + total.leave + '</span></div>' +
      '</div>';

    if (!list.length) return h + '<div class="empty">范围内还没有考勤数据</div>';

    var sorts = [['rate', '出勤率'], ['absent', '缺勤'], ['late', '迟到'], ['total', '总人次'], ['name', '姓名']];
    h += '<div class="card"><h2>排序</h2><div class="chips">' +
      sorts.map(function (x) {
        var on = statSort.key === x[0];
        return '<span class="chip' + (on ? ' on' : '') + '" data-s="PRESENT" data-act="statSort" data-v="' + x[0] + '">' + x[1] +
          (on ? (statSort.asc ? ' ↑' : ' ↓') : '') + '</span>';
      }).join('') + '</div></div>';

    h += '<div class="card"><div class="statline small muted"><span>姓名 / 学号</span><span>到 · 迟 · 退 · 缺 · 假 · 出勤率</span></div>';
    list.forEach(function (o) {
      h += '<div class="statline"><span><span class="k">' + esc(o.name) + '</span> <span class="tiny muted">' + esc(o.no) + '</span></span>' +
        '<span class="small">' + o.sum.present + ' · ' + o.sum.late + ' · ' + o.sum.earlyLeave + ' · ' + o.sum.absent + ' · ' + o.sum.leave +
        ' · <b style="color:var(--blue)">' + pct(o.rate) + '</b></span></div>';
    });
    return h + '</div>';
  }

  // ============================================================ 视图：分数
  var scoreSort = { key: 'score', asc: false };
  function scoreResults() {
    var pack = statRows();
    var rows = pack.recs.map(function (r) {
      var live = byId(DB.students, r.studentId);
      var cls = live ? byId(DB.classes, live.classId) : null;
      return {
        studentId: r.studentId, studentNo: r.studentNo, studentName: r.studentName,
        className: (cls && cls.name) || '', status: r.status
      };
    });
    var cfg = DB.settings.score || KQ.defaultScoreConfig();
    var out = KQ.scoreRows(rows, cfg, function (id) { var s = byId(DB.students, id); return s ? s.name : ''; });
    if (scoreSort.key === 'name') {
      out.sort(function (a, b) { return scoreSort.asc ? String(a.name).localeCompare(b.name) : String(b.name).localeCompare(a.name); });
    } else if (scoreSort.key === 'no') {
      out.sort(function (a, b) { return scoreSort.asc ? String(a.studentNo).localeCompare(b.studentNo) : String(b.studentNo).localeCompare(a.studentNo); });
    } else {
      out.sort(function (a, b) { return scoreSort.asc ? a.score - b.score : b.score - a.score; });
    }
    return { results: out, cfg: cfg, pack: pack };
  }

  function viewScores() {
    var got = scoreResults();
    var cfg = got.cfg;
    var unit = cfg.mode === 'RATIO' ? '%' : '分';
    var active = KQ.activeWeights(cfg);
    var h = topbar('考勤分数', got.results.length + ' 人 · ' + (cfg.mode === 'RATIO' ? '按比例' : '固定分值')) +
      '<div class="card"><h2>计分方式</h2><div class="seg">' +
      [['FIXED', '固定分值'], ['RATIO', '按比例']].map(function (x) {
        return '<button class="' + (cfg.mode === x[0] ? 'on' : '') + '" data-act="scoreMode" data-v="' + x[0] + '">' + x[1] + '</button>';
      }).join('') + '</div>' +
      '<div class="grid3" style="margin-top:10px">' +
      KQ.SCORE_CATEGORIES.map(function (c) {
        return '<div><label class="f">' + c.label + (cfg.mode === 'RATIO' ? ' (%)' : '') + '</label>' +
          '<input type="number" step="0.01" data-change="weight" data-id="' + c.key + '" value="' + formatNum(active[c.key]) + '"></div>';
      }).join('') + '</div>' +
      '<div class="row" style="margin-top:10px;gap:8px">' +
      '<button class="btn sm ghost" data-act="scoreReset">恢复默认</button>' +
      '<button class="btn sm ghost" data-act="exportScores">导出分数 CSV</button></div>' +
      '<p class="tiny muted" style="margin:10px 0 0;line-height:1.7">固定分值：得分 = Σ(人次 × 分值)；按比例：得分 = Σ(人次 × 权重) ÷ 总人次（0~100）。' +
      '人次按记录行计（上下半节各算一次），请假合并病假/事假/公假。</p></div>';

    h += '<div class="card"><h2>范围</h2><div class="grid2">' +
      sel('班级', 'sfClass', [[0, '全部班级']].concat(DB.classes.map(function (c) { return [c.id, c.name]; })), sf.classId) +
      sel('课程', 'sfCourse', [[0, '全部课程']].concat(DB.courses.map(function (c) { return [c.id, c.name]; })), sf.courseId) +
      '</div><div class="seg" style="margin-top:10px">' +
      ['today', '7', 'all'].map(function (r) {
        var t = r === 'today' ? '今天' : r === '7' ? '近7天' : '全部';
        return '<button class="' + (rf.range === r ? 'on' : '') + '" data-act="range" data-v="' + r + '">' + t + '</button>';
      }).join('') + '</div></div>';

    if (!got.results.length) return h + '<div class="empty">范围内还没有可计分的数据</div>';

    h += '<div class="card"><div class="chips">' +
      [['score', '得分'], ['name', '姓名'], ['no', '学号']].map(function (x) {
        var on = scoreSort.key === x[0];
        return '<span class="chip' + (on ? ' on' : '') + '" data-s="PRESENT" data-act="scoreSort" data-v="' + x[0] + '">' + x[1] +
          (on ? (scoreSort.asc ? ' ↑' : ' ↓') : '') + '</span>';
      }).join('') + '</div></div>';

    h += '<div class="list">';
    got.results.forEach(function (r, i) {
      h += '<div class="item" style="cursor:default"><div class="row">' +
        '<div class="grow"><span class="m" style="font-size:13px">' + (i + 1) + '.</span> ' +
        '<span class="t">' + esc(r.name) + '</span>' +
        '<span class="m" style="margin-left:8px">' + esc(r.studentNo) + '</span></div>' +
        '<span class="k" style="color:var(--blue)">' + formatNum(r.score) + unit + '</span></div>' +
        '<div class="m">' + esc(r.className || '—') + ' · 总人次 ' + r.summary.total +
        ' · 到 ' + r.summary.present + ' 迟 ' + r.summary.late + ' 退 ' + r.summary.earlyLeave +
        ' 缺 ' + r.summary.absent + ' 假 ' + r.summary.leave + '</div></div>';
    });
    return h + '</div>';
  }

  // ============================================================ 视图：管理
  var mtab = 'classes';
  function viewManage() {
    var tabs = [['classes', '班级'], ['students', '学生'], ['courses', '课程'], ['locations', '地点'],
      ['times', '节次'], ['rules', '名单规则'], ['leaves', '请假条']];
    var h = topbar('数据管理', '') + '<div class="card"><div class="seg wrap">' +
      tabs.map(function (t) {
        return '<button class="' + (mtab === t[0] ? 'on' : '') + '" data-act="mtab" data-v="' + t[0] + '">' + t[1] + '</button>';
      }).join('') + '</div></div>';
    if (mtab === 'classes') h += manageClasses();
    else if (mtab === 'students') h += manageStudents();
    else if (mtab === 'courses') h += manageCourses();
    else if (mtab === 'locations') h += manageLocations();
    else if (mtab === 'times') h += manageTimes();
    else if (mtab === 'rules') h += manageRules();
    else h += manageLeaves();
    return h;
  }

  function addBtn(text, act) { return '<button class="btn sm" data-act="' + act + '">+ ' + text + '</button>'; }

  function manageClasses() {
    var h = '<div class="card"><div class="row"><div class="grow k">班级（' + DB.classes.length + '）</div>' + addBtn('新增', 'addClass') + '</div></div>';
    if (!DB.classes.length) return h + '<div class="empty">还没有班级</div>';
    h += '<div class="list">';
    DB.classes.forEach(function (c) {
      var n = studentsOf(c.id).length;
      h += '<div class="item" style="cursor:default"><div class="row"><div class="grow"><div class="t">' + esc(c.name) + '</div>' +
        '<div class="m">' + esc([c.major, c.majorShort, c.academicYear, c.counselor].filter(Boolean).join(' · ') || '—') + ' · ' + n + ' 人</div></div>' +
        '<button class="btn sm ghost" data-act="editClass" data-id="' + c.id + '">编辑</button>' +
        '<button class="btn sm ghost" style="color:var(--danger)" data-act="delClass" data-id="' + c.id + '">删</button></div></div>';
    });
    return h + '</div>';
  }

  function manageStudents() {
    if (!DB.classes.length) return '<div class="empty">先添加班级</div>';
    var classId = sf.classId || DB.classes[0].id;
    var list = studentsOf(classId);
    var h = '<div class="card">' + sel('按班级查看', 'sfClass', DB.classes.map(function (c) { return [c.id, c.name]; }), classId) +
      '<div style="margin-top:10px">' + addBtn('新增学生', 'addStudent') + '</div>' +
      '<p class="tiny muted" style="margin:8px 0 0">「不参加」的学生不进点名名单，历史记录保留（与考勤端一致）。</p></div>';
    if (!list.length) return h + '<div class="empty">这个班级还没有学生</div>';
    h += '<div class="list">';
    list.forEach(function (s) {
      var off = s.attendanceState === 'NOT_PARTICIPATE';
      h += '<div class="item" style="cursor:default"><div class="row"><div class="grow"><div class="t">' + esc(s.name) +
        (off ? ' <span class="badge ABSENT">不参加</span>' : '') + '</div>' +
        '<div class="m">' + esc(s.studentNo) + (off && s.absenceReason ? ' · ' + esc(s.absenceReason) : '') + '</div></div>' +
        '<button class="btn sm ghost" data-act="editStudent" data-id="' + s.id + '">编辑</button>' +
        '<button class="btn sm ghost" style="color:var(--danger)" data-act="delStudent" data-id="' + s.id + '">删</button></div></div>';
    });
    return h + '</div>';
  }

  function manageCourses() {
    var h = '<div class="card"><div class="row"><div class="grow k">课程（' + DB.courses.length + '）</div>' + addBtn('新增', 'addCourse') + '</div></div>';
    if (!DB.courses.length) return h + '<div class="empty">还没有课程</div>';
    h += '<div class="list">';
    DB.courses.forEach(function (c) {
      h += '<div class="item" style="cursor:default"><div class="row"><div class="grow"><div class="t">' + esc(c.name) + '</div>' +
        '<div class="m">' + esc(c.teacher || '—') + '</div></div>' +
        '<button class="btn sm ghost" data-act="editCourse" data-id="' + c.id + '">编辑</button>' +
        '<button class="btn sm ghost" style="color:var(--danger)" data-act="delCourse" data-id="' + c.id + '">删</button></div></div>';
    });
    return h + '</div>';
  }

  function manageLocations() {
    var h = '<div class="card"><div class="row"><div class="grow k">地点（' + DB.locations.length + '）</div>' + addBtn('新增', 'addLocation') + '</div></div>';
    if (!DB.locations.length) return h + '<div class="empty">还没有上课地点</div>';
    h += '<div class="list">';
    DB.locations.forEach(function (c) {
      h += '<div class="item" style="cursor:default"><div class="row"><div class="grow"><div class="t">' + esc(c.name) + '</div>' +
        '<div class="m">' + esc(c.department || '—') + '</div></div>' +
        '<button class="btn sm ghost" data-act="editLocation" data-id="' + c.id + '">编辑</button>' +
        '<button class="btn sm ghost" style="color:var(--danger)" data-act="delLocation" data-id="' + c.id + '">删</button></div></div>';
    });
    return h + '</div>';
  }

  function manageTimes() {
    var h = '<div class="card"><div class="row"><div class="grow k">节次（' + DB.times.length + '）</div>' + addBtn('新增', 'addTime') + '</div></div>';
    if (!DB.times.length) return h + '<div class="empty">还没有节次</div>';
    h += '<div class="list">';
    DB.times.forEach(function (c) {
      h += '<div class="item" style="cursor:default"><div class="row"><div class="grow"><div class="t">' + esc(c.period) + '</div>' +
        '<div class="m">' + esc((c.startTime || '') + ' – ' + (c.endTime || '')) + '</div></div>' +
        '<button class="btn sm ghost" data-act="editTime" data-id="' + c.id + '">编辑</button>' +
        '<button class="btn sm ghost" style="color:var(--danger)" data-act="delTime" data-id="' + c.id + '">删</button></div></div>';
    });
    return h + '</div>';
  }

  /** 名单规则：选课程 → 逐学生切换 黑名单 / 白名单 / 隐藏（对应考勤端 course_student_rule 表） */
  var ruleCourse = 0;
  function manageRules() {
    if (!DB.courses.length) return '<div class="empty">先添加课程</div>';
    if (!ruleCourse || !byId(DB.courses, ruleCourse)) ruleCourse = DB.courses[0].id;
    if (!DB.classes.length) return '<div class="empty">先添加班级与学生</div>';
    var classId = sf.classId || DB.classes[0].id;
    var list = studentsOf(classId);
    var ofCourse = DB.rules.filter(function (r) { return r.courseId === ruleCourse; });
    function typeOf(sid) {
      var hit = ofCourse.filter(function (x) { return x.studentId === sid; })[0];
      return hit ? hit.ruleType : '';
    }
    var h = '<div class="card">' + sel('课程', 'ruleCourse', DB.courses.map(function (c) { return [c.id, c.name]; }), ruleCourse) +
      '<div style="margin-top:8px">' + sel('班级', 'sfClass', DB.classes.map(function (c) { return [c.id, c.name]; }), classId) + '</div>' +
      '<p class="tiny muted" style="margin:10px 0 0;line-height:1.7">隐藏：不参与该课点名（历史记录保留）；黑/白名单：仅做标注，不改名单。</p></div>';
    if (!list.length) return h + '<div class="empty">这个班级还没有学生</div>';
    h += '<div class="list">';
    list.forEach(function (s) {
      var t = typeOf(s.id);
      h += '<div class="item" style="cursor:default"><div class="row"><div class="grow"><div class="t">' + esc(s.name) + '</div>' +
        '<div class="m">' + esc(s.studentNo) + '</div></div></div><div class="chips" style="margin-top:8px">' +
        '<span class="chip mute' + (!t ? ' on' : '') + '" data-act="setRule" data-id="' + s.id + '" data-v="">正常</span>' +
        RULE_TYPES.map(function (rt) {
          return '<span class="chip' + (t === rt.key ? ' on' : '') + '" data-s="ABSENT" data-act="setRule" data-id="' + s.id + '" data-v="' + rt.key + '">' + rt.label + '</span>';
        }).join('') + '</div></div>';
    });
    return h + '</div>';
  }

  /** 请假条：列表 + 新增 + 删除（写 leave_note 表，考勤端能直接读） */
  function manageLeaves() {
    var list = DB.leaveNotes.slice().sort(function (a, b) {
      return String(b.startDate).localeCompare(String(a.startDate)) || b.id - a.id;
    });
    var now = nowText();
    var h = '<div class="card"><div class="row"><div class="grow k">请假条（' + list.length + '）</div>' + addBtn('新增', 'addLeave') + '</div>' +
      '<p class="tiny muted" style="margin:8px 0 0">生效中的假条会在点名页自动带入对应状态。</p></div>';
    if (!list.length) return h + '<div class="empty">还没有请假条</div>';
    h += '<div class="list">';
    list.forEach(function (n) {
      var s = byId(DB.students, n.studentId);
      var cls = s ? byId(DB.classes, s.classId) : null;
      var expired = KQ.leaveNoteExpired(n, now);
      h += '<div class="item" style="cursor:default"><div class="row"><div class="grow">' +
        '<div class="t">' + esc((s && s.name) || '未知学生') + ' <span class="badge LEAVE">' + esc(label(n.status)) + '</span>' +
        (expired ? ' <span class="badge ABSENT">已过期</span>' : '') + '</div>' +
        '<div class="m">' + esc(KQ.leaveSpanText(n)) + (cls ? ' · ' + esc(cls.name) : '') +
        (n.remark ? ' · ' + esc(n.remark) : '') + '</div></div>' +
        '<button class="btn sm ghost" style="color:var(--danger)" data-act="delLeave" data-id="' + n.id + '">删</button></div></div>';
    });
    return h + '</div>';
  }

  // ============================================================ 视图：设置
  function viewSettings() {
    var s = DB.settings;
    var counts = DB.classes.length + ' 班 · ' + DB.students.length + ' 生 · ' + DB.sessions.length + ' 次考勤';
    var rows = countOfDb(DB);
    return topbar('设置', counts) +
      '<div class="card"><h2>教学</h2>' +
      '<div class="f"><label class="f">学期名称</label><input type="text" data-change="semesterLabel" value="' + esc(s.semesterLabel) + '" placeholder="如 2025-2026学年第一学期"></div>' +
      '<div class="f"><label class="f">当前周次</label><input type="number" min="1" max="60" data-change="currentWeek" value="' + (s.currentWeek || 1) + '"></div>' +
      '<div class="f"><label class="f">默认班级</label><select data-change="defaultClass">' +
      [[0, '不指定']].concat(DB.classes.map(function (c) { return [c.id, c.name]; })).map(function (o) {
        return '<option value="' + o[0] + '"' + (String(o[0]) === String(s.defaultClassId) ? ' selected' : '') + '>' + esc(o[1]) + '</option>';
      }).join('') + '</select></div>' +
      '</div>' +
      '<div class="card"><h2>当前数据</h2>' +
      '<div class="statline"><span class="muted">班级 / 学生 / 课程</span><span class="k">' + rows.classes + ' / ' + rows.students + ' / ' + rows.courses + '</span></div>' +
      '<div class="statline"><span class="muted">地点 / 节次 / 名单规则</span><span class="k">' + rows.locations + ' / ' + rows.times + ' / ' + rows.rules + '</span></div>' +
      '<div class="statline"><span class="muted">考勤次数 / 记录 / 假条</span><span class="k">' + rows.sessions + ' / ' + rows.records + ' / ' + rows.leaveNotes + '</span></div>' +
      '</div>' +
      '<div class="card"><h2>数据搬运</h2>' +
      '<button class="btn" data-act="exportAndroid">导出给考勤端（考勤端可直接导入）</button>' +
      '<div style="height:8px"></div>' +
      '<button class="btn ghost" data-act="import">导入数据（考勤端导出 / 网页版备份）</button>' +
      '<div style="height:8px"></div>' +
      '<button class="btn ghost" data-act="backup">备份本机数据（网页版专用 JSON）</button>' +
      '<p class="tiny muted" style="margin:10px 0 0;line-height:1.7">' +
      '两个方向都完整覆盖班级、学生、课程、名单规则、地点、节次、请假条、考勤会话与记录、复制格式，字段顺序与考勤端一致。</p>' +
      '</div>' +
      '<div class="card"><h2>危险操作</h2>' +
      '<button class="btn ghost" style="color:var(--danger);border-color:#f0cccc" data-act="clearAll">清空全部数据</button>' +
      '<p class="tiny muted" style="margin:10px 0 0">数据只保存在这台设备的浏览器里，换设备/清缓存前请先导出备份。</p>' +
      '</div>' +
      '<div class="card"><h2>安装到桌面</h2>' +
      '<button class="btn" data-act="install">添加到主屏幕（像 App 一样用）</button>' +
      '<p class="tiny muted" style="margin:10px 0 0">iPhone：用 Safari 打开 → 分享 → 添加到主屏幕。Android：浏览器菜单 → 安装应用。</p>' +
      '</div>' +
      '<div class="card"><h2>关于</h2><p class="small muted" style="margin:0;line-height:1.7">考勤 · 网页版<br>' +
      '与考勤端同一套口径：上下半节、请假/迟到/早退/缺勤、出勤时长、假条生效、名单规则、分数规则，数据可双向导入导出。<br>' +
      '数据全部本地保存，不上传服务器。</p></div>';
  }

  // ============================================================ 顶栏 / 弹层
  function topbar(title, sub) {
    return '<div class="topbar"><h1>' + esc(title) + '</h1>' +
      (sub ? '<span class="sub grow">' + esc(sub) + '</span>' : '<span class="grow"></span>') +
      '<button class="iconbtn" data-act="scan" title="扫码点名">⌗</button></div>';
  }
  function badge(k) {
    var cls = isLeave(k) ? 'LEAVE' : k;
    return '<span class="badge ' + cls + '">' + esc(label(k)) + '</span>';
  }

  function openSheet(html) { $('#sheet').innerHTML = html; $('#mask').classList.add('show'); }
  function closeSheet() { stopScan(); $('#mask').classList.remove('show'); $('#sheet').innerHTML = ''; }
  function confirmSheet(title, msg, onOk) {
    openSheet('<h3>' + esc(title) + '</h3><p class="small muted" style="margin:0 0 14px;line-height:1.7">' + esc(msg) + '</p>' +
      '<div class="actions"><button class="btn ghost" data-act="closeSheet">取消</button>' +
      '<button class="btn danger" data-act="confirmOk">确定</button></div>');
    pendingConfirm = onOk;
  }
  var pendingConfirm = null;

  function field(id, labelText, value, type) {
    return '<div class="f"><label class="f">' + esc(labelText) + '</label><input id="' + id + '" type="' + (type || 'text') + '" value="' + esc(value || '') + '"></div>';
  }

  // ============================================================ 事件分发
  document.addEventListener('click', function (e) {
    var el = e.target.closest('[data-act]');
    if (!el) return;
    handleAct(el.getAttribute('data-act'), el.getAttribute('data-id'), el.getAttribute('data-v'), el);
  });
  document.addEventListener('change', function (e) {
    var el = e.target.closest('[data-change]');
    if (!el) return;
    handleChange(el.getAttribute('data-change'), el.getAttribute('data-id'), el.value);
  });

  function handleChange(kind, id, val) {
    if (kind === 'classId') { editor.classId = +val; editor.period = 1; resetMarks(); render(); }
    else if (kind === 'courseId') { editor.courseId = +val; editor.period = 1; resetMarks(); render(); }
    else if (kind === 'locName') {
      // 一级「上课地点」选定后，默认取该地点名下第一条（组内多科室再用二级选择切换）
      var nm = String(val);
      var first = nm === '0' ? null : DB.locations.filter(function (l) { return l.name === nm; })[0];
      editor.locationId = first ? first.id : 0;
      render();
    } else if (kind === 'locDept') {
      var cur = byId(DB.locations, editor.locationId);
      var hit = cur ? DB.locations.filter(function (l) { return l.name === cur.name && l.department === val; })[0] : null;
      if (hit) editor.locationId = hit.id;
      render();
    }
    else if (kind === 'timeId') { editor.timeId = +val; render(); }
    else if (kind === 'timeId2') { editor.timeId2 = +val; render(); }
    else if (kind === 'date') { editor.date = val; resetMarks(); render(); }
    else if (kind === 'rfClass') { rf.classId = +val; render(); }
    else if (kind === 'rfCourse') { rf.courseId = +val; render(); }
    else if (kind === 'rfLocation') { rf.locationId = +val; render(); }
    else if (kind === 'rfKeyword') { rf.keyword = val; render(); }
    else if (kind === 'sfClass') { sf.classId = +val; render(); }
    else if (kind === 'sfCourse') { sf.courseId = +val; render(); }
    else if (kind === 'ruleCourse') { ruleCourse = +val; render(); }
    else if (kind === 'semesterLabel') { DB.settings.semesterLabel = val; save(); }
    else if (kind === 'currentWeek') { DB.settings.currentWeek = Math.max(1, +val || 1); save(); }
    else if (kind === 'defaultClass') { DB.settings.defaultClassId = +val; save(); }
    else if (kind === 'weight') { setWeight(id, val); }
    else if (kind === 'recStatus') { saveRecordEdit(id); }
  }

  function handleAct(act, id, v) {
    switch (act) {
      case 'go': goto('#/' + v); break;
      case 'closeSheet': closeSheet(); break;
      case 'confirmOk': { var cb = pendingConfirm; pendingConfirm = null; closeSheet(); if (cb) cb(); break; }
      case 'mtab': mtab = v; render(); break;
      case 'range': rf.range = v; render(); break;
      case 'export': exportCsv(); break;
      case 'exportOne': exportOne(+id); break;
      case 'exportAndroid': doExportAndroid(); break;
      case 'exportScores': doExportScores(); break;
      case 'allPresent': case 'allAbsent': {
        var st = act === 'allPresent' ? 'PRESENT' : 'ABSENT';
        var M = activeMarks();
        rollcallRoster(editor.classId, editor.courseId).roster.forEach(function (s) {
          var mm = M[s.id] || (M[s.id] = defaultMark(s.id));
          if (editor.half === 1) {
            mm.first = st; mm.byLeave = false;
            // 一键改上半节时清掉下半节的单独设置，避免「已到 / 早退」这种没人表达过的组合
            mm.second = st === 'EARLY_LEAVE' ? 'NOT_RECORDED' : 'INHERIT';
          } else {
            var rr = KQ.applyToSecond(mm.first, st);
            mm.first = rr.first; mm.second = rr.second;
          }
        });
        render(); break;
      }
      case 'setFirst': {
        var m = markOf(id); m.first = v; m.byLeave = false;
        if (v === 'EARLY_LEAVE') m.second = 'NOT_RECORDED';
        else if (m.second === 'NOT_RECORDED') m.second = 'INHERIT';
        render(); break;
      }
      case 'setSecond': {
        var ms = markOf(id);
        if (v === 'INHERIT' || v === 'NOT_RECORDED') ms.second = v;
        else {
          // 与考勤端同一条规则：早退上移到上半节、与继承结果相同则回存 INHERIT
          var ap = KQ.applyToSecond(ms.first, v);
          ms.first = ap.first; ms.second = ap.second;
        }
        render(); break;
      }
      case 'toggleDouble': {
        editor.doublePeriod = !editor.doublePeriod;
        if (!editor.doublePeriod) editor.period = 1;
        if (editor.doublePeriod && !editor.timeId2) {
          var idx = 0;
          DB.times.forEach(function (t, i) { if (t.id === editor.timeId) idx = i; });
          var nxt = DB.times[idx + 1] || DB.times[0];
          editor.timeId2 = nxt ? nxt.id : 0;
        }
        ensureMarks(); render(); break;
      }
      case 'period': editor.period = +v; render(); break;
      case 'half': editor.half = +v; render(); break;
      case 'filter': editor.statusFilter = v; render(); break;
      case 'pickLeave': openLeavePicker(id); break;
      case 'setLeave': {
        var m2 = markOf(id); m2.first = v; m2.byLeave = false;
        if (m2.second === 'NOT_RECORDED') m2.second = 'INHERIT';
        closeSheet(); render(); break;
      }
      case 'saveEditor': saveEditor(); break;
      case 'delSession': deleteSession(+id); break;
      case 'editSession': if (loadEditorFromSession(+id)) goto('#/rollcall'); break;
      case 'openRecord': goto('#/records/' + id); break;
      case 'editRecord': openRecordEdit(+id); break;
      case 'statSort': toggleSort(statSort, v); render(); break;
      case 'scoreSort': toggleSort(scoreSort, v); render(); break;
      case 'scoreMode': setScoreMode(v); break;
      case 'scoreReset': resetScore(); break;
      case 'scan': openScanner(); break;
      case 'install': showInstall(); break;
      case 'import': doImport(); break;
      case 'doImportOk': runImport(); break;
      case 'backup': doBackup(); break;
      case 'clearAll': confirmSheet('清空全部数据', '将删除本机所有班级、学生、考勤记录、假条，且不可恢复。确定继续？', function () {
        DB = KQ.blankDb(); save(); toast('已清空'); render();
      }); break;
      // ---- 管理 CRUD
      case 'addClass': editClassForm(null); break;
      case 'editClass': editClassForm(byId(DB.classes, +id)); break;
      case 'delClass': confirmSheet('删除班级', '将同时删除该班级的学生；历史考勤记录保留。确定删除？', function () { delClassCascade(+id); }); break;
      case 'saveClass': saveClass(id); break;
      case 'addStudent': editStudentForm(null); break;
      case 'editStudent': editStudentForm(byId(DB.students, +id)); break;
      case 'delStudent': confirmSheet('删除学生', '历史考勤记录会保留该学生的姓名快照。确定删除？', function () {
        DB.students = DB.students.filter(function (s) { return s.id !== +id; });
        DB.rules = DB.rules.filter(function (r) { return r.studentId !== +id; });
        save(); closeSheet(); render();
      }); break;
      case 'saveStudent': saveStudent(id); break;
      case 'addCourse': editCourseForm(null); break;
      case 'editCourse': editCourseForm(byId(DB.courses, +id)); break;
      case 'delCourse': confirmSheet('删除课程', '历史考勤记录保留课程名快照。确定删除？', function () {
        DB.courses = DB.courses.filter(function (c) { return c.id !== +id; });
        DB.rules = DB.rules.filter(function (r) { return r.courseId !== +id; });
        save(); closeSheet(); render();
      }); break;
      case 'saveCourse': saveCourse(id); break;
      case 'addLocation': editLocationForm(null); break;
      case 'editLocation': editLocationForm(byId(DB.locations, +id)); break;
      case 'delLocation': confirmSheet('删除地点', '历史考勤记录保留地点名快照。确定删除？', function () {
        DB.locations = DB.locations.filter(function (c) { return c.id !== +id; }); save(); closeSheet(); render();
      }); break;
      case 'saveLocation': saveLocation(id); break;
      case 'addTime': editTimeForm(null); break;
      case 'editTime': editTimeForm(byId(DB.times, +id)); break;
      case 'delTime': confirmSheet('删除节次', '确定删除该节次？', function () {
        DB.times = DB.times.filter(function (c) { return c.id !== +id; }); save(); closeSheet(); render();
      }); break;
      case 'saveTime': saveTime(id); break;
      case 'setRule': setRule(+id, v); break;
      case 'addLeave': editLeaveForm(); break;
      case 'delLeave': confirmSheet('删除请假条', '确定删除这条请假条？已记录的考勤不会改变。', function () {
        DB.leaveNotes = DB.leaveNotes.filter(function (n) { return n.id !== +id; }); save(); closeSheet(); render();
      }); break;
      case 'saveLeave': saveLeave(); break;
      case 'saveRecord': saveRecordEdit(v); break;
      case 'delRecord': deleteRecord(+id); break;
    }
  }

  function toggleSort(state, key) {
    if (state.key === key) state.asc = !state.asc;
    else { state.key = key; state.asc = (key === 'name' || key === 'no'); }
  }

  // ============================================================ 分数交互
  function setWeight(key, raw) {
    var cfg = DB.settings.score || KQ.defaultScoreConfig();
    var mode = cfg.mode;
    var v = KQ.parseNum(raw, mode === 'RATIO' ? KQ.MIN_RATIO : KQ.MIN_SCORE, mode === 'RATIO' ? KQ.MAX_RATIO : KQ.MAX_SCORE);
    if (v == null) { toast('请输入 ' + (mode === 'RATIO' ? '0~100' : '±999 之间') + '的数字'); return; }
    var bucket = mode === 'RATIO' ? 'ratio' : 'fixed';
    var w = {};
    KQ.SCORE_CATEGORIES.forEach(function (c) { w[c.key] = cfg[bucket][c.key]; });
    w[key] = v;
    cfg[bucket] = KQ.clampWeights(w, mode);
    DB.settings.score = cfg;
    save(); render();
  }
  function setScoreMode(mode) {
    var cfg = DB.settings.score || KQ.defaultScoreConfig();
    cfg.mode = mode === 'RATIO' ? 'RATIO' : 'FIXED';
    DB.settings.score = cfg;
    save(); render();
  }
  function resetScore() {
    confirmSheet('恢复默认规则', '将把「固定分值」与「按比例」两套权重都恢复默认值。确定？', function () {
      DB.settings.score = KQ.defaultScoreConfig(); save(); render();
    });
  }
  function doExportScores() {
    var got = scoreResults();
    if (!got.results.length) { toast('没有可导出的分数'); return; }
    var text = scoreCsv(got.results, {
      semesterLabel: DB.settings.semesterLabel,
      rangeText: rangeText(),
      weekLabel: DB.settings.currentWeek,
      classText: selectText(DB.classes, sf.classId, '全部'),
      courseText: selectText(DB.courses, sf.courseId, '全部'),
      studentText: '全部',
      keywordLabel: '无',
      orderLabel: scoreSort.key === 'score' ? (scoreSort.asc ? '得分从低到高' : '得分从高到低') :
        scoreSort.key === 'name' ? '姓名' : '学号',
      exportedAt: new Date().toLocaleString('zh-CN')
    }, got.cfg);
    download('考勤分数_' + rangeText() + '_' + stamp() + '.csv', text, 'text/csv');
  }

  // ============================================================ 管理表单
  function editClassForm(c) {
    openSheet('<h3>' + (c ? '编辑班级' : '新增班级') + '</h3>' +
      field('c_name', '班级名称', c && c.name, 'text') +
      field('c_major', '专业', c && c.major, 'text') +
      field('c_short', '专业简称', c && c.majorShort, 'text') +
      field('c_year', '学年', c && c.academicYear, 'text') +
      field('c_counselor', '导员', c && c.counselor, 'text') +
      '<div class="actions"><button class="btn ghost" data-act="closeSheet">取消</button>' +
      '<button class="btn" data-act="saveClass" data-id="' + (c ? c.id : 0) + '">保存</button></div>');
  }
  function saveClass(id) {
    var name = $('#c_name').value.trim();
    if (!name) { toast('班级名称不能为空'); return; }
    var obj = {
      id: +id || nid(), name: name, major: $('#c_major').value.trim(),
      majorShort: $('#c_short').value.trim(), academicYear: $('#c_year').value.trim(),
      counselor: $('#c_counselor').value.trim()
    };
    if (+id) DB.classes[findIdx(DB.classes, +id)] = obj; else DB.classes.push(obj);
    save(); closeSheet(); toast('已保存'); render();
  }
  function delClassCascade(id) {
    var ids = {};
    DB.students.forEach(function (s) { if (s.classId === id) ids[s.id] = 1; });
    DB.classes = DB.classes.filter(function (c) { return c.id !== id; });
    DB.students = DB.students.filter(function (s) { return s.classId !== id; });
    DB.rules = DB.rules.filter(function (r) { return !ids[r.studentId]; });
    if (DB.settings.defaultClassId === id) DB.settings.defaultClassId = 0;
    save(); closeSheet(); toast('已删除'); render();
  }

  function editStudentForm(s) {
    if (!DB.classes.length) { toast('请先添加班级'); return; }
    var curClass = s ? s.classId : (sf.classId || DB.classes[0].id);
    var curState = (s && s.attendanceState) || 'PARTICIPATE';
    var curReason = (s && s.absenceReason) || '';
    var preset = ABSENCE_PRESETS.indexOf(curReason) >= 0 ? curReason : (curReason ? '' : '');
    openSheet('<h3>' + (s ? '编辑学生' : '新增学生') + '</h3>' +
      '<div class="f"><label class="f">班级</label><select id="s_class">' +
      DB.classes.map(function (c) { return '<option value="' + c.id + '"' + (c.id === curClass ? ' selected' : '') + '>' + esc(c.name) + '</option>'; }).join('') + '</select></div>' +
      field('s_name', '姓名', s && s.name, 'text') +
      field('s_no', '学号', s && s.studentNo, 'text') +
      '<div class="f"><label class="f">是否参与考勤</label><select id="s_state">' +
      opt('PARTICIPATE', '参加', curState) + opt('NOT_PARTICIPATE', '不参加（入伍/退学等）', curState) +
      '</select></div>' +
      '<div class="f"><label class="f">不参加原因（选「不参加」时必填）</label><select id="s_reason">' +
      ['（无）'].concat(ABSENCE_PRESETS.slice(1)).map(function (t) {
        var val = t === '（无）' ? '' : t;
        return '<option value="' + esc(val) + '"' + (val === preset ? ' selected' : '') + '>' + esc(t) + '</option>';
      }).join('') + '</select></div>' +
      field('s_reason_text', '或手动填写原因', ABSENCE_PRESETS.indexOf(curReason) >= 0 ? '' : curReason, 'text') +
      '<div class="actions"><button class="btn ghost" data-act="closeSheet">取消</button>' +
      '<button class="btn" data-act="saveStudent" data-id="' + (s ? s.id : 0) + '">保存</button></div>');
  }
  function saveStudent(id) {
    var name = $('#s_name').value.trim();
    if (!name) { toast('姓名不能为空'); return; }
    var state = $('#s_state').value;
    var reason = $('#s_reason').value || $('#s_reason_text').value.trim();
    if (state === 'NOT_PARTICIPATE' && !reason) { toast('选择「不参加」时必须填写原因'); return; }
    var old = +id ? byId(DB.students, +id) : null;
    var obj = {
      id: +id || nid(), classId: +$('#s_class').value, name: name,
      studentNo: $('#s_no').value.trim(),
      sortOrder: (old && old.sortOrder) || 0,
      attendanceState: state,
      absenceReason: state === 'NOT_PARTICIPATE' ? reason : ''
    };
    if (+id) DB.students[findIdx(DB.students, +id)] = obj; else DB.students.push(obj);
    save(); closeSheet(); toast('已保存'); render();
  }

  function editCourseForm(c) {
    openSheet('<h3>' + (c ? '编辑课程' : '新增课程') + '</h3>' +
      field('k_name', '课程名称', c && c.name, 'text') +
      field('k_teacher', '授课老师', c && c.teacher, 'text') +
      '<div class="actions"><button class="btn ghost" data-act="closeSheet">取消</button>' +
      '<button class="btn" data-act="saveCourse" data-id="' + (c ? c.id : 0) + '">保存</button></div>');
  }
  function saveCourse(id) {
    var name = $('#k_name').value.trim();
    if (!name) { toast('课程名称不能为空'); return; }
    var obj = { id: +id || nid(), name: name, teacher: $('#k_teacher').value.trim() };
    if (+id) DB.courses[findIdx(DB.courses, +id)] = obj; else DB.courses.push(obj);
    save(); closeSheet(); toast('已保存'); render();
  }

  function editLocationForm(c) {
    openSheet('<h3>' + (c ? '编辑地点' : '新增地点') + '</h3>' +
      field('l_name', '上课地点', c && c.name, 'text') +
      field('l_dept', '所属科室', c && c.department, 'text') +
      '<div class="actions"><button class="btn ghost" data-act="closeSheet">取消</button>' +
      '<button class="btn" data-act="saveLocation" data-id="' + (c ? c.id : 0) + '">保存</button></div>');
  }
  function saveLocation(id) {
    var name = $('#l_name').value.trim();
    if (!name) { toast('地点不能为空'); return; }
    var old = +id ? byId(DB.locations, +id) : null;
    var obj = {
      id: +id || nid(), name: name, department: $('#l_dept').value.trim(),
      sortOrder: (old && old.sortOrder) || 0, deptOrder: (old && old.deptOrder) || 0
    };
    if (+id) DB.locations[findIdx(DB.locations, +id)] = obj; else DB.locations.push(obj);
    save(); closeSheet(); toast('已保存'); render();
  }

  function editTimeForm(c) {
    openSheet('<h3>' + (c ? '编辑节次' : '新增节次') + '</h3>' +
      field('t_period', '节次名称', c && c.period, 'text') +
      '<div class="grid2"><div class="f"><label class="f">开始时间</label><input id="t_start" type="time" value="' + esc((c && c.startTime) || '') + '"></div>' +
      '<div class="f"><label class="f">结束时间</label><input id="t_end" type="time" value="' + esc((c && c.endTime) || '') + '"></div></div>' +
      '<div class="actions"><button class="btn ghost" data-act="closeSheet">取消</button>' +
      '<button class="btn" data-act="saveTime" data-id="' + (c ? c.id : 0) + '">保存</button></div>');
  }
  function saveTime(id) {
    var period = $('#t_period').value.trim();
    if (!period) { toast('节次名称不能为空'); return; }
    var obj = { id: +id || nid(), period: period, startTime: $('#t_start').value, endTime: $('#t_end').value };
    if (+id) DB.times[findIdx(DB.times, +id)] = obj; else DB.times.push(obj);
    save(); closeSheet(); toast('已保存'); render();
  }

  function setRule(studentId, type) {
    DB.rules = DB.rules.filter(function (r) { return !(r.courseId === ruleCourse && r.studentId === studentId); });
    if (type) DB.rules.push({ id: nid(), courseId: ruleCourse, studentId: studentId, ruleType: type });
    save(); render();
  }

  function editLeaveForm() {
    if (!DB.students.length) { toast('请先添加学生'); return; }
    var cls = sf.classId || (DB.classes[0] ? DB.classes[0].id : 0);
    var pool = cls ? studentsOf(cls) : DB.students;
    if (!pool.length) pool = DB.students;
    var opts = pool.map(function (s) {
      return '<option value="' + s.id + '">' + esc(s.name + ' ' + (s.studentNo || '')) + '</option>';
    }).join('');
    openSheet('<h3>新增请假条</h3>' +
      '<div class="f"><label class="f">学生</label><select id="n_student">' + opts + '</select></div>' +
      '<div class="f"><label class="f">请假类型</label><select id="n_status">' +
      LEAVE.map(function (k) { return '<option value="' + k + '">' + label(k) + '</option>'; }).join('') + '</select></div>' +
      '<div class="grid2"><div class="f"><label class="f">起始日期</label><input id="n_start" type="date" value="' + esc(today()) + '"></div>' +
      '<div class="f"><label class="f">结束日期</label><input id="n_end" type="date" value="' + esc(today()) + '"></div></div>' +
      '<div class="f"><label class="f"><input type="checkbox" id="n_long" style="width:auto;margin-right:6px">长期假条（直到学期结束）</label></div>' +
      '<div class="f"><label class="f">备注</label><input id="n_remark" type="text" value=""></div>' +
      '<div class="actions"><button class="btn ghost" data-act="closeSheet">取消</button>' +
      '<button class="btn" data-act="saveLeave">保存</button></div>');
  }
  function saveLeave() {
    var studentId = +$('#n_student').value;
    var status = $('#n_status').value;
    var start = $('#n_start').value;
    var longTerm = $('#n_long').checked;
    var end = longTerm ? LONG_TERM_END : $('#n_end').value;
    if (!studentId) { toast('请选择学生'); return; }
    if (!KQ.isLeaveNoteStatus(status)) { toast('请假类型不合法'); return; }
    if (!start) { toast('请选择起始日期'); return; }
    if (!longTerm && (!end || end < start)) { toast('结束日期不能早于起始日期'); return; }
    DB.leaveNotes.push({
      id: nid(), studentId: studentId, status: status,
      startDate: start + ' 00:00',
      endDate: longTerm ? LONG_TERM_END : end + ' 23:59',
      remark: $('#n_remark').value.trim(), createdAt: Date.now()
    });
    save(); closeSheet(); toast('已保存'); render();
  }

  // ============================================================ 单条记录编辑
  function openRecordEdit(recId) {
    var r = byId(DB.records, recId);
    if (!r) { toast('记录不存在'); return; }
    openSheet('<h3>修改记录</h3>' +
      '<p class="small muted" style="margin:0 0 12px">' + esc(r.studentName || '') + ' · ' + esc(r.studentNo || '') +
      ' · ' + (r.half === 2 ? '下半节' : '上半节') + '</p>' +
      '<div class="f"><label class="f">状态</label><select id="r_status">' +
      STATUSES.map(function (st) { return opt(st.key, st.label, r.status); }).join('') + '</select></div>' +
      '<div class="grid2"><div class="f"><label class="f">签到时刻</label><input id="r_in" type="time" value="' + esc(r.checkInTime || '') + '"></div>' +
      '<div class="f"><label class="f">早退时刻</label><input id="r_out" type="time" value="' + esc(r.leaveTime || '') + '"></div></div>' +
      '<div class="f"><label class="f">备注（异常说明）</label><input id="r_remark" type="text" value="' + esc(r.remark || '') + '"></div>' +
      '<div class="actions"><button class="btn ghost" data-act="closeSheet">取消</button>' +
      '<button class="btn" data-act="saveRecord" data-v="' + recId + '">保存</button></div>' +
      '<div style="margin-top:10px"><button class="btn ghost" style="color:var(--danger)" data-act="delRecord" data-id="' + recId + '">删除这条记录</button></div>');
  }
  function saveRecordEdit(recId) {
    recId = +recId;
    var r = byId(DB.records, recId);
    if (!r) { toast('记录不存在'); return; }
    r.status = $('#r_status').value;
    r.checkInTime = $('#r_in').value;
    r.leaveTime = $('#r_out').value;
    r.remark = $('#r_remark').value.trim();
    save(); closeSheet(); toast('已保存'); render();
  }
  function deleteRecord(recId) {
    confirmSheet('删除记录', '只删除这一条（不清空整节课）。确定删除？', function () {
      DB.records = DB.records.filter(function (r) { return r.id !== recId; });
      save(); closeSheet(); toast('已删除'); render();
    });
  }

  // ============================================================ 请假类型选择
  function openLeavePicker(studentId) {
    openSheet('<h3>请假类型</h3><div class="list">' +
      LEAVE.map(function (k) {
        return '<div class="item" data-act="setLeave" data-id="' + studentId + '" data-v="' + k + '"><div class="t">' + label(k) + '</div></div>';
      }).join('') +
      '</div><div class="actions"><button class="btn ghost" data-act="closeSheet">取消</button></div>');
  }

  // ============================================================ 扫码点名
  var scan = null;
  function openScanner() {
    if (!editor) newEditor();
    openSheet('<h3>扫码点名</h3>' +
      '<div class="scanbox"><video id="scanVideo" playsinline muted></video><canvas id="scanCanvas" class="hide"></canvas><div class="frame"></div></div>' +
      '<p class="small muted" id="scanMsg" style="text-align:center;margin:4px 0 10px">把学生二维码对准取景框</p>' +
      '<div class="actions"><button class="btn ghost" data-act="closeSheet">关闭</button></div>');
    var video = $('#scanVideo');
    var msg = $('#scanMsg');
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { msg.textContent = '当前浏览器不支持摄像头（需 https 打开）'; return; }
    navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false })
      .then(function (stream) {
        scan = { stream: stream, raf: 0, last: 0 };
        video.srcObject = stream;
        video.play().catch(function () {});
        var canvas = $('#scanCanvas'), ctx = canvas.getContext('2d');
        function tick(ts) {
          if (!scan) return;
          if (ts - scan.last > 220) {
            scan.last = ts;
            if (video.readyState === video.HAVE_ENOUGH_DATA && video.videoWidth) {
              canvas.width = video.videoWidth; canvas.height = video.videoHeight;
              ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
              try {
                var img = ctx.getImageData(0, 0, canvas.width, canvas.height);
                var code = window.jsQR ? window.jsQR(img.data, img.width, img.height) : null;
                if (code && code.data) onScanResult(code.data, msg);
              } catch (e) { /* 单帧解码失败继续 */ }
            }
          }
          scan.raf = requestAnimationFrame(tick);
        }
        scan.raf = requestAnimationFrame(tick);
      })
      .catch(function (err) {
        msg.textContent = '无法打开摄像头：' + (err && err.message ? err.message : '请检查权限') + '（需 https 打开）';
      });
  }
  function onScanResult(text, msg) {
    var parsed = window.ScanCode ? window.ScanCode.parse(text) : { ok: false };
    if (!parsed.ok) { msg.textContent = '不是本应用的考勤码，继续对准…'; return; }
    var roster = rollcallRoster(editor.classId, editor.courseId).roster;
    var s = roster.filter(function (x) { return String(x.studentNo).toUpperCase() === parsed.studentNo; })[0];
    if (!s) { msg.textContent = '本班名单里没有学号 ' + parsed.studentNo; return; }
    var m = markOf(s.id);
    m.first = 'PRESENT'; m.checkIn = nowHHMM(); m.byLeave = false;
    if (m.second === 'NOT_RECORDED') m.second = 'INHERIT';
    stopScan(); closeSheet(); render();
    toast('已记 ' + s.name + ' 已到 ' + m.checkIn + (editor.doublePeriod ? '（第' + editor.period + '节）' : ''));
  }
  function stopScan() {
    if (!scan) return;
    cancelAnimationFrame(scan.raf);
    try { scan.stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) { /* 已停止 */ }
    scan = null;
  }

  // ============================================================ 安装引导
  var installEvent = null;
  window.addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); installEvent = e; });
  function showInstall() {
    if (installEvent) { installEvent.prompt(); installEvent = null; return; }
    var ua = navigator.userAgent || '';
    var ios = /iPad|iPhone|iPod/.test(ua);
    openSheet('<h3>添加到主屏幕</h3>' +
      (ios
        ? '<ol class="small" style="line-height:1.9;padding-left:20px;margin:0 0 12px"><li>用 <b>Safari</b> 打开本页</li><li>点底部的「分享」按钮</li><li>选择「添加到主屏幕」</li><li>点「添加」</li></ol>'
        : '<p class="small" style="line-height:1.9;margin:0 0 12px">点浏览器右上角菜单 →「安装应用 / 添加到主屏幕」。</p>') +
      '<p class="tiny muted">添加后从桌面图标打开，全屏无地址栏，并支持离线使用。</p>' +
      '<div class="actions"><button class="btn ghost" data-act="closeSheet">知道了</button></div>');
  }

  // ============================================================ 渲染
  function render() {
    var html;
    if (route.name === 'records') html = route.arg ? viewDetail(+route.arg) : viewRecords();
    else if (route.name === 'stats') html = viewStats();
    else if (route.name === 'scores') html = viewScores();
    else if (route.name === 'manage') html = viewManage();
    else if (route.name === 'settings') html = viewSettings();
    else html = viewRollcall();
    $('#app').innerHTML = html;
    var btns = document.querySelectorAll('#tabs button');
    for (var i = 0; i < btns.length; i++) btns[i].classList.toggle('on', btns[i].getAttribute('data-tab') === route.name);
  }

  // ============================================================ PWA
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('./sw.js').catch(function () {});
    });
  }

  // ============================================================ 启动
  document.getElementById('tabs').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-tab]');
    if (b) goto('#/' + b.getAttribute('data-tab'));
  });
  $('#mask').addEventListener('click', function (e) { if (e.target === $('#mask')) closeSheet(); });
  route = parseHash();
  render();
})();
