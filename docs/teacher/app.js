/*
 * 考勤 · 老师版（浏览器端）
 *
 * 定位：给**苹果用户 / 没有安装包的用户**一个可直接用、可「添加到主屏幕」的考勤端。
 * 数据只存在本机浏览器（localStorage），不依赖任何服务器；换机用「设置 → 备份/恢复」。
 *
 * 与 Android 端同口径的关键点（改这里要同步原生端）：
 *  - 状态：已到 / 迟到 / 早退 / 缺勤 / 病假 / 事假 / 公假；
 *  - 上下半节：下半节默认跟随上半节，但迟到不继承（视为已到）、早退→下半节不记录；
 *  - 导出：按课时分块，块内「缺勤 → 早退 → 迟到 → 请假 → 已到」，空值 --。
 */
(function () {
  'use strict';

  // ============================================================ 常量与纯逻辑（来自 logic.js，可被 Node 直跑验证）
  var KEY = 'kaoqin_teacher_v1';
  var KQ = window.KQLogic;
  var STATUSES = KQ.STATUSES;
  var LEAVE = KQ.LEAVE;
  var MAIN = KQ.MAIN;
  var PRI = KQ.PRI;
  var COLUMNS = KQ.COLUMNS;
  var EMPTY = KQ.EMPTY;
  var label = KQ.label;
  var isLeave = KQ.isLeave;
  var isAttended = KQ.isAttended;
  var inheritedStatus = KQ.inheritedStatus;
  var resolveSecond = KQ.resolveSecond;
  var statusPriority = KQ.statusPriority;
  var minutesOf = KQ.minutesOf;
  var hhmmOf = KQ.hhmmOf;
  var halfWindows = KQ.halfWindows;
  var recordMinutes = KQ.recordMinutes;
  var csvEsc = KQ.csvEsc;
  var toCsv = KQ.toCsv;

  // ============================================================ 存储
  function blank() {
    return {
      v: 1, seq: 0,
      settings: { semesterLabel: '', currentWeek: 1, defaultClassId: 0 },
      classes: [], students: [], courses: [], locations: [], times: [],
      sessions: [], records: []
    };
  }
  function load() {
    try {
      var raw = localStorage.getItem(KEY);
      if (raw) { var d = JSON.parse(raw); if (d && d.v === 1) return d; }
    } catch (e) { /* ignore */ }
    return blank();
  }
  var DB = load();
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(DB)); }
    catch (e) { toast('保存失败：本机存储可能已满，请到「设置 → 备份」导出后清理'); }
  }
  function nid() { DB.seq = (DB.seq || 0) + 1; return DB.seq; }

  // ============================================================ 工具
  function $(s, r) { return (r || document).querySelector(s); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function p2(n) { return n < 10 ? '0' + n : '' + n; }
  function today() { var d = new Date(); return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()); }
  function nowHHMM() { var d = new Date(); return p2(d.getHours()) + ':' + p2(d.getMinutes()); }
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
    setTimeout(function () { t.remove(); }, 1900);
  }
  function byId(arr, id) { for (var i = 0; i < arr.length; i++) if (arr[i].id === id) return arr[i]; return null; }

  // ============================================================ 状态模型（实现在 logic.js）
  function badge(k) {
    var cls = isLeave(k) ? 'LEAVE' : k;
    return '<span class="badge ' + cls + '">' + esc(label(k)) + '</span>';
  }

  // ============================================================ 数据查询
  function classStudents(classId) {
    return DB.students.filter(function (s) { return s.classId === classId; })
      .sort(function (a, b) { return (a.sortOrder || 0) - (b.sortOrder || 0) || String(a.studentNo).localeCompare(String(b.studentNo)); });
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
  function newEditor() {
    var def = DB.settings.defaultClassId || (DB.classes[0] ? DB.classes[0].id : 0);
    editor = { sessionId: null, date: today(), classId: def, courseId: (DB.courses[0] ? DB.courses[0].id : 0), locationId: 0, timeId: (DB.times[0] ? DB.times[0].id : 0), marks: {} };
    ensureMarks();
  }
  function ensureMarks() {
    classStudents(editor.classId).forEach(function (s) {
      if (!editor.marks[s.id]) editor.marks[s.id] = { first: 'PRESENT', second: 'INHERIT', checkIn: '' };
    });
  }
  function loadEditorFromSession(id) {
    var s = byId(DB.sessions, id);
    if (!s) return false;
    editor = { sessionId: id, date: s.date, classId: s.classId, courseId: s.courseId, locationId: s.locationId, timeId: s.timeId, marks: {} };
    var recs = DB.records.filter(function (r) { return r.sessionId === id; });
    var byS = {};
    recs.forEach(function (r) { (byS[r.studentId] = byS[r.studentId] || {})[r.half] = r; });
    Object.keys(byS).forEach(function (sid) {
      var f = byS[sid][1], sec = byS[sid][2];
      var first = f ? f.status : 'PRESENT';
      var mark = 'INHERIT';
      if (sec) mark = sec.status;
      else if (first === 'EARLY_LEAVE') mark = 'NOT_RECORDED';
      editor.marks[sid] = { first: first, second: mark, checkIn: f ? (f.checkInTime || '') : '' };
    });
    ensureMarks();
    return true;
  }

  // ============================================================ 保存会话
  function saveEditor() {
    if (!editor.classId) { toast('请先选择班级'); return; }
    var cls = byId(DB.classes, editor.classId), course = byId(DB.courses, editor.courseId);
    var loc = byId(DB.locations, editor.locationId), time = byId(DB.times, editor.timeId);
    var sid = editor.sessionId || nid();
    var sess = {
      id: sid, classId: editor.classId, courseId: editor.courseId, locationId: editor.locationId,
      timeId: editor.timeId, date: editor.date, remark: '', createdAt: Date.now(),
      className: cls ? cls.name : '', courseName: course ? course.name : '',
      locationName: loc ? loc.name : '', timePeriod: time ? time.period : ''
    };
    DB.sessions = DB.sessions.filter(function (s) { return s.id !== sid; });
    DB.records = DB.records.filter(function (r) { return r.sessionId !== sid; });
    DB.sessions.push(sess);
    var students = classStudents(editor.classId);
    students.forEach(function (s) {
      var m = editor.marks[s.id];
      if (!m || !m.first) return;
      DB.records.push({
        id: nid(), sessionId: sid, studentId: s.id, status: m.first, remark: '',
        studentName: s.name, studentNo: s.studentNo, half: 1, checkInTime: m.checkIn || '', leaveTime: ''
      });
      var sec = resolveSecond(m.first, m.second);
      if (sec) {
        DB.records.push({
          id: nid(), sessionId: sid, studentId: s.id, status: sec, remark: '',
          studentName: s.name, studentNo: s.studentNo, half: 2, checkInTime: '', leaveTime: ''
        });
      }
    });
    save();
    var marking = students.filter(function (s) { return editor.marks[s.id] && editor.marks[s.id].first; }).length;
    toast('已保存 ' + marking + ' 名学生的考勤');
    goto('#/records');
  }

  function deleteSession(id) {
    confirmSheet('删除考勤', '确定删除这次考勤记录吗？此操作不可恢复。', function () {
      DB.sessions = DB.sessions.filter(function (s) { return s.id !== id; });
      DB.records = DB.records.filter(function (r) { return r.sessionId !== id; });
      save(); closeSheet(); toast('已删除'); goto('#/records');
    });
  }

  // ============================================================ 筛选
  var rf = { range: 'all', classId: 0, courseId: 0, locationId: 0 };
  function rangeStart() {
    if (rf.range === 'today') return today();
    if (rf.range === '7') { var d = new Date(); d.setDate(d.getDate() - 6); return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()); }
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

  // ============================================================ CSV 导出（按课时分块，与原生端同口径）
  function exportRows(sessions) {
    var ids = {}; sessions.forEach(function (s) { ids[s.id] = 1; });
    var recs = DB.records.filter(function (r) { return ids[r.sessionId]; });
    var out = [];
    sessions.slice().sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : a.id - b.id; }).forEach(function (s) {
      var cls = byId(DB.classes, s.classId), course = byId(DB.courses, s.courseId);
      var loc = byId(DB.locations, s.locationId), time = byId(DB.times, s.timeId);
      var win = time ? halfWindows(time.startTime, time.endTime) : null;
      var rows = recs.filter(function (r) { return r.sessionId === s.id; }).sort(function (a, b) {
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
          statusLabel: label(r.status), duration: dur, abnormal: r.remark || EMPTY
        });
      });
    });
    return out;
  }

  function exportCsv() {
    var sessions = filteredSessions();
    if (!sessions.length) { toast('当前筛选下没有可导出的记录'); return; }
    var rows = exportRows(sessions);
    var cls = rf.classId ? byId(DB.classes, rf.classId) : null;
    var course = rf.courseId ? byId(DB.courses, rf.courseId) : null;
    var loc = rf.locationId ? byId(DB.locations, rf.locationId) : null;
    var rangeText = rf.range === 'today' ? '今天' : rf.range === '7' ? '近7天' : '全部时间';
    var text = toCsv(rows, {
      rangeText: rangeText,
      classText: cls ? cls.name : '全部',
      courseText: course ? course.name : '全部',
      locationText: loc ? loc.name : '全部',
      exportedAt: new Date().toLocaleString('zh-CN')
    });
    var name = '考勤明细_' + rangeText + '_' + stamp() + '.csv';
    download(name, text, 'text/csv');
  }

  function download(name, text, mime) {
    try {
      var blob = new Blob([text], { type: (mime || 'text/plain') + ';charset=utf-8' });
      var file = new File([blob], name, { type: mime || 'text/plain' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
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

  // ============================================================ 视图：点名
  function viewRollcall() {
    if (!editor) newEditor();
    ensureMarks();
    var classes = DB.classes, courses = DB.courses, locs = DB.locations, times = DB.times;
    if (!classes.length) {
      return topbar('点名', '老师版') + '<div class="card"><div class="empty">还没有班级数据<br>先到「管理 → 班级」添加一个班级和学生</div>' +
        '<button class="btn" data-act="go" data-v="manage">去添加</button></div>';
    }
    var students = classStudents(editor.classId);
    var marked = students.filter(function (s) { return editor.marks[s.id] && editor.marks[s.id].first; }).length;

    var h = topbar(editor.sessionId ? '编辑考勤' : '点名', (byId(DB.classes, editor.classId) || {}).name || '') +
      '<div class="card">' +
      '<div class="grid2">' +
      sel('班级', 'classId', classes.map(function (c) { return [c.id, c.name]; }), editor.classId) +
      sel('课程', 'courseId', courses.map(function (c) { return [c.id, c.name]; }), editor.courseId) +
      '</div><div class="grid2" style="margin-top:8px">' +
      sel('地点', 'locationId', [[0, '未设置']].concat(locs.map(function (c) { return [c.id, c.name]; })), editor.locationId) +
      sel('节次', 'timeId', [[0, '未设置']].concat(times.map(function (c) { return [c.id, c.period]; })), editor.timeId) +
      '</div><div style="margin-top:8px"><label class="f">日期</label>' +
      '<input type="date" data-change="date" value="' + esc(editor.date) + '"></div>' +
      '</div>';

    if (!students.length) {
      return h + '<div class="card"><div class="empty">这个班级还没有学生<br>先到「管理 → 学生」添加学生</div></div>';
    }

    h += '<div class="card"><div class="row"><div class="grow small muted">已标记 ' + marked + ' / ' + students.length + ' 人 · 未指定状态按缺勤</div>' +
      '<button class="btn sm ghost" data-act="allPresent">全部已到</button>' +
      '<button class="btn sm ghost" data-act="allAbsent">全部缺勤</button></div></div>';

    h += '<div class="list">';
    students.forEach(function (s) {
      var m = editor.marks[s.id] || { first: 'PRESENT', second: 'INHERIT', checkIn: '' };
      var secEff = resolveSecond(m.first, m.second);
      h += '<div class="item" style="cursor:default">' +
        '<div class="row"><div class="grow"><span class="t">' + esc(s.name) + '</span>' +
        '<span class="m" style="margin-left:8px">' + esc(s.studentNo) + '</span></div>' +
        (m.checkIn ? '<span class="tiny muted">签到 ' + esc(m.checkIn) + '</span>' : '') + '</div>' +
        '<div class="chips" style="margin-top:8px">';
      MAIN.forEach(function (k) {
        h += '<span class="chip' + (m.first === k ? ' on' : '') + '" data-s="' + k + '" data-act="setFirst" data-id="' + s.id + '" data-v="' + k + '">' + label(k) + '</span>';
      });
      h += '<span class="chip' + (isLeave(m.first) ? ' on' : '') + '" data-s="SICK_LEAVE" data-act="pickLeave" data-id="' + s.id + '">' +
        (isLeave(m.first) ? label(m.first) : '请假') + '</span>';
      h += '</div>';
      h += '<div class="row" style="margin-top:7px">' +
        '<span class="tiny muted" style="width:64px">下半节</span>' +
        '<select style="flex:1;padding:7px 10px;font-size:13px" data-change="second" data-id="' + s.id + '"' +
        (m.first === 'EARLY_LEAVE' ? ' disabled' : '') + '>' +
        opt('INHERIT', '跟随上半节', m.second) +
        opt('NOT_RECORDED', '不记录', m.second) +
        STATUSES.map(function (st) { return opt(st.key, st.label, m.second); }).join('') +
        '</select>' +
        '<span class="tiny muted" style="width:76px;text-align:right">' + (secEff ? esc(label(secEff)) : '不记录') + '</span>' +
        '</div>';
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
      '<div style="margin-top:10px">' + sel('地点', 'rfLocation', [[0, '全部地点']].concat(DB.locations.map(function (c) { return [c.id, c.name]; })), rf.locationId) + '</div>' +
      '<div style="margin-top:12px"><button class="btn ghost" data-act="export">导出考勤明细 CSV</button></div>' +
      '</div>';

    if (!sessions.length) return h + '<div class="empty">没有符合条件的考勤记录</div>';

    h += '<div class="list">';
    sessions.forEach(function (s) {
      var recs = DB.records.filter(function (r) { return r.sessionId === s.id; });
      var counts = {};
      recs.forEach(function (r) { counts[r.status] = (counts[r.status] || 0) + 1; });
      var total = recs.length;
      var attended = (counts.PRESENT || 0) + (counts.LATE || 0) + (counts.EARLY_LEAVE || 0);
      var rate = total ? Math.round(attended / total * 100) : null;
      h += '<div class="item" data-act="openRecord" data-id="' + s.id + '">' +
        '<div class="row"><div class="t grow">' + esc(fmtDate(s.date)) + '</div>' +
        '<div class="t" style="color:var(--blue)">' + (rate == null ? '无记录' : '到课 ' + rate + '%') + '</div></div>' +
        '<div class="m">' + esc(s.courseName || '未选课程') + ' · ' + esc(s.className || '未选班级') + '</div>' +
        '<div class="m">' + esc((s.locationName || '') + (s.timePeriod ? (s.locationName ? ' · ' : '') + s.timePeriod : '') || '未设置地点与节次') + '</div>' +
        '<div class="b chips">';
      ['PRESENT', 'LATE', 'EARLY_LEAVE', 'ABSENT'].forEach(function (k) {
        if (counts[k]) h += badge(k) + '<span class="tiny muted" style="margin-left:2px;margin-right:6px">' + counts[k] + '</span>';
      });
      if (counts.SICK_LEAVE || counts.PERSONAL_LEAVE || counts.PUBLIC_LEAVE) {
        var lc = (counts.SICK_LEAVE || 0) + (counts.PERSONAL_LEAVE || 0) + (counts.PUBLIC_LEAVE || 0);
        h += badge('SICK_LEAVE') + '<span class="tiny muted" style="margin-left:2px">' + lc + '</span>';
      }
      h += '</div></div>';
    });
    h += '</div>';
    return h;
  }

  function viewDetail(id) {
    var s = byId(DB.sessions, id);
    if (!s) return '<div class="empty">记录不存在</div>';
    var recs = DB.records.filter(function (r) { return r.sessionId === id; })
      .sort(function (a, b) { return statusPriority(a.status) - statusPriority(b.status) || String(a.studentNo).localeCompare(String(b.studentNo)) || a.half - b.half; });
    var h = topbar('考勤详情', fmtDate(s.date)) +
      '<div class="card">' +
      '<div class="statline"><span class="muted">课程</span><span class="k">' + esc(s.courseName || '未选') + '</span></div>' +
      '<div class="statline"><span class="muted">班级</span><span class="k">' + esc(s.className || '未选') + '</span></div>' +
      '<div class="statline"><span class="muted">地点 / 节次</span><span class="k">' + esc((s.locationName || '未设置') + ' · ' + (s.timePeriod || '未设置')) + '</span></div>' +
      '<div class="statline"><span class="muted">记录条数</span><span class="k">' + recs.length + '</span></div>' +
      '</div>' +
      '<div class="row" style="gap:8px;margin-bottom:12px">' +
      '<button class="btn ghost" data-act="editSession" data-id="' + id + '">编辑</button>' +
      '<button class="btn ghost" data-act="exportOne" data-id="' + id + '">导出本节</button>' +
      '<button class="btn ghost" style="color:var(--danger);border-color:#f0cccc" data-act="delSession" data-id="' + id + '">删除</button>' +
      '</div>';

    if (!recs.length) return h + '<div class="empty">暂无明细</div>';
    h += '<div class="list">';
    recs.forEach(function (r) {
      h += '<div class="item" style="cursor:default"><div class="row">' +
        '<div class="grow"><span class="t">' + esc(r.studentName || '—') + '</span>' +
        '<span class="m" style="margin-left:8px">' + esc(r.studentNo || '') + '</span></div>' +
        badge(r.status) + '</div>' +
        '<div class="m">' + (r.half === 2 ? '下半节' : '上半节') +
        (r.checkInTime ? ' · 签到 ' + esc(r.checkInTime) : '') +
        (r.leaveTime ? ' · 早退 ' + esc(r.leaveTime) : '') + '</div></div>';
    });
    h += '</div>';
    return h;
  }

  // ============================================================ 视图：统计
  var sf = { classId: 0 };
  function viewStats() {
    var start = rangeStart();
    var sessions = DB.sessions.filter(function (s) {
      if (start && s.date < start) return false;
      if (sf.classId && s.classId !== sf.classId) return false;
      return true;
    });
    var ids = {}; sessions.forEach(function (s) { ids[s.id] = 1; });
    var recs = DB.records.filter(function (r) { return ids[r.sessionId]; });
    var byS = {};
    recs.forEach(function (r) {
      var o = byS[r.studentId] || (byS[r.studentId] = { no: r.studentNo, name: r.studentName, PRESENT: 0, LATE: 0, EARLY_LEAVE: 0, ABSENT: 0, LEAVE: 0, total: 0 });
      o.total++;
      if (isLeave(r.status)) o.LEAVE++; else o[r.status] = (o[r.status] || 0) + 1;
    });
    var list = Object.keys(byS).map(function (k) { return byS[k]; }).map(function (o) {
      var attended = o.PRESENT + o.LATE + o.EARLY_LEAVE;
      o.rate = o.total ? Math.round(attended / o.total * 100) : 0;
      return o;
    }).sort(function (a, b) { return b.rate - a.rate || String(a.no).localeCompare(String(b.no)); });

    var h = topbar('统计分析', list.length + ' 人') +
      '<div class="card"><div class="seg">' +
      ['today', '7', 'all'].map(function (r) {
        var t = r === 'today' ? '今天' : r === '7' ? '近7天' : '全部';
        return '<button class="' + (rf.range === r ? 'on' : '') + '" data-act="range" data-v="' + r + '">' + t + '</button>';
      }).join('') + '</div>' +
      '<div style="margin-top:10px">' + sel('班级', 'sfClass', [[0, '全部班级']].concat(DB.classes.map(function (c) { return [c.id, c.name]; })), sf.classId) + '</div></div>';

    if (!list.length) return h + '<div class="empty">范围内还没有考勤数据</div>';
    h += '<div class="card"><div class="statline small muted"><span>姓名 / 学号</span><span>已到 · 迟到 · 早退 · 缺勤 · 请假 · 出勤率</span></div>';
    list.forEach(function (o) {
      h += '<div class="statline"><span><span class="k">' + esc(o.name) + '</span> <span class="tiny muted">' + esc(o.no) + '</span></span>' +
        '<span class="small">' + o.PRESENT + ' · ' + o.LATE + ' · ' + o.EARLY_LEAVE + ' · ' + o.ABSENT + ' · ' + o.LEAVE +
        ' · <b style="color:var(--blue)">' + o.rate + '%</b></span></div>';
    });
    return h + '</div>';
  }

  // ============================================================ 视图：管理
  var mtab = 'classes';
  function viewManage() {
    var tabs = [['classes', '班级'], ['students', '学生'], ['courses', '课程'], ['locations', '地点'], ['times', '节次']];
    var h = topbar('数据管理', '') + '<div class="card"><div class="seg">' +
      tabs.map(function (t) { return '<button class="' + (mtab === t[0] ? 'on' : '') + '" data-act="mtab" data-v="' + t[0] + '">' + t[1] + '</button>'; }).join('') +
      '</div></div>';
    if (mtab === 'classes') h += manageClasses();
    else if (mtab === 'students') h += manageStudents();
    else if (mtab === 'courses') h += manageCourses();
    else if (mtab === 'locations') h += manageLocations();
    else h += manageTimes();
    return h;
  }

  function addBtn(text, act) { return '<button class="btn sm" data-act="' + act + '">+ ' + text + '</button>'; }

  function manageClasses() {
    var h = '<div class="card"><div class="row"><div class="grow k">班级（' + DB.classes.length + '）</div>' + addBtn('新增', 'addClass') + '</div></div>';
    if (!DB.classes.length) return h + '<div class="empty">还没有班级</div>';
    h += '<div class="list">';
    DB.classes.forEach(function (c) {
      var n = classStudents(c.id).length;
      h += '<div class="item" style="cursor:default"><div class="row"><div class="grow"><div class="t">' + esc(c.name) + '</div>' +
        '<div class="m">' + esc([c.major, c.majorShort, c.academicYear, c.counselor].filter(Boolean).join(' · ') || '—') + ' · ' + n + ' 人</div></div>' +
        '<button class="btn sm ghost" data-act="editClass" data-id="' + c.id + '">编辑</button>' +
        '<button class="btn sm ghost" style="color:var(--danger)" data-act="delClass" data-id="' + c.id + '">删</button></div></div>';
    });
    return h + '</div>';
  }

  function manageStudents() {
    var classId = sf.classId || (DB.classes[0] ? DB.classes[0].id : 0);
    var list = classStudents(classId);
    var h = '<div class="card">' + sel('按班级查看', 'sfClass', DB.classes.map(function (c) { return [c.id, c.name]; }), classId) +
      '<div style="margin-top:10px">' + addBtn('新增学生', 'addStudent') + '</div></div>';
    if (!DB.classes.length) return '<div class="empty">先添加班级</div>';
    if (!list.length) return h + '<div class="empty">这个班级还没有学生</div>';
    h += '<div class="list">';
    list.forEach(function (s) {
      h += '<div class="item" style="cursor:default"><div class="row"><div class="grow"><div class="t">' + esc(s.name) + '</div>' +
        '<div class="m">' + esc(s.studentNo) + '</div></div>' +
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

  // ============================================================ 视图：设置
  function viewSettings() {
    var s = DB.settings;
    var counts = DB.classes.length + ' 班 · ' + DB.students.length + ' 生 · ' + DB.sessions.length + ' 次考勤';
    return topbar('设置', counts) +
      '<div class="card"><h2>教学</h2>' +
      '<div class="f"><label class="f">学期名称</label><input type="text" data-change="semesterLabel" value="' + esc(s.semesterLabel) + '" placeholder="如 2025-2026学年第一学期"></div>' +
      '<div class="f"><label class="f">当前周次</label><input type="number" min="1" max="60" data-change="currentWeek" value="' + (s.currentWeek || 1) + '"></div>' +
      '<div class="f"><label class="f">默认班级</label><select data-change="defaultClass">' +
      [[0, '不指定']].concat(DB.classes.map(function (c) { return [c.id, c.name]; })).map(function (o) {
        return '<option value="' + o[0] + '"' + (String(o[0]) === String(s.defaultClassId) ? ' selected' : '') + '>' + esc(o[1]) + '</option>';
      }).join('') + '</select></div>' +
      '</div>' +
      '<div class="card"><h2>数据</h2>' +
      '<button class="btn ghost" data-act="backup">备份数据（导出 JSON）</button>' +
      '<div style="height:8px"></div>' +
      '<button class="btn ghost" data-act="restore">从备份恢复（本应用 / Android 导出）</button>' +
      '<div style="height:8px"></div>' +
      '<button class="btn ghost" style="color:var(--danger);border-color:#f0cccc" data-act="clearAll">清空全部数据</button>' +
      '<p class="tiny muted" style="margin:10px 0 0">数据只保存在这台设备的浏览器里，换设备/清缓存前请先备份。</p>' +
      '</div>' +
      '<div class="card"><h2>安装</h2>' +
      '<button class="btn" data-act="install">添加到主屏幕（像 App 一样用）</button>' +
      '<p class="tiny muted" style="margin:10px 0 0">iPhone：用 Safari 打开 → 分享 → 添加到主屏幕。Android：浏览器菜单 → 安装应用。</p>' +
      '</div>' +
      '<div class="card"><h2>关于</h2><p class="small muted" style="margin:0;line-height:1.7">考勤 · 老师版（网页版）<br>' +
      '与 Android 端同一套考勤口径：上下半节、请假/迟到/早退/缺勤、按课时分块导出。<br>' +
      '数据全部本地保存，不上传服务器；建议定期到「备份数据」导出。</p></div>';
  }

  // ============================================================ 顶栏
  function topbar(title, sub) {
    return '<div class="topbar"><h1>' + esc(title) + '</h1>' +
      (sub ? '<span class="sub grow">' + esc(sub) + '</span>' : '<span class="grow"></span>') +
      '<button class="iconbtn" data-act="scan" title="扫码点名">⌗</button></div>';
  }

  // ============================================================ 弹层（表单 / 确认 / 选择）
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

  // ============================================================ 动作分发
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
    if (kind === 'classId') { editor.classId = +val; ensureMarks(); render(); }
    else if (kind === 'courseId') { editor.courseId = +val; render(); }
    else if (kind === 'locationId') { editor.locationId = +val; render(); }
    else if (kind === 'timeId') { editor.timeId = +val; render(); }
    else if (kind === 'date') { editor.date = val; render(); }
    else if (kind === 'second') { editor.marks[id].second = val; render(); }
    else if (kind === 'rfClass') { rf.classId = +val; render(); }
    else if (kind === 'rfCourse') { rf.courseId = +val; render(); }
    else if (kind === 'rfLocation') { rf.locationId = +val; render(); }
    else if (kind === 'sfClass') { sf.classId = +val; render(); }
    else if (kind === 'semesterLabel') { DB.settings.semesterLabel = val; save(); }
    else if (kind === 'currentWeek') { DB.settings.currentWeek = Math.max(1, +val || 1); save(); }
    else if (kind === 'defaultClass') { DB.settings.defaultClassId = +val; save(); }
  }

  function handleAct(act, id, v, el) {
    switch (act) {
      case 'go': goto('#/' + v); break;
      case 'closeSheet': closeSheet(); break;
      case 'confirmOk': { var cb = pendingConfirm; pendingConfirm = null; closeSheet(); if (cb) cb(); break; }
      case 'mtab': mtab = v; render(); break;
      case 'range': rf.range = v; render(); break;
      case 'export': exportCsv(); break;
      case 'exportOne': exportOne(+id); break;
      case 'allPresent': case 'allAbsent': {
        var st = act === 'allPresent' ? 'PRESENT' : 'ABSENT';
        classStudents(editor.classId).forEach(function (s) {
          if (!editor.marks[s.id]) editor.marks[s.id] = { first: st, second: 'INHERIT', checkIn: '' };
          else editor.marks[s.id].first = st;
        });
        render(); break;
      }
      case 'setFirst': {
        var m = editor.marks[id]; m.first = v;
        if (v === 'EARLY_LEAVE') m.second = 'NOT_RECORDED';
        else if (m.second === 'NOT_RECORDED') m.second = 'INHERIT';
        render(); break;
      }
      case 'pickLeave': openLeavePicker(id); break;
      case 'setLeave': { var mm = editor.marks[id]; mm.first = v; if (mm.second === 'NOT_RECORDED') mm.second = 'INHERIT'; closeSheet(); render(); break; }
      case 'saveEditor': saveEditor(); break;
      case 'delSession': deleteSession(+id); break;
      case 'editSession': if (loadEditorFromSession(+id)) goto('#/rollcall'); break;
      case 'openRecord': goto('#/records/' + id); break;
      case 'scan': openScanner(); break;
      case 'install': showInstall(); break;
      case 'backup': doBackup(); break;
      case 'restore': doRestore(); break;
      case 'clearAll': confirmSheet('清空全部数据', '将删除本机所有班级、学生、考勤记录，且不可恢复。确定继续？', function () { DB = blank(); save(); toast('已清空'); render(); }); break;
      // ---- 管理 CRUD
      case 'addClass': editClassForm(null); break;
      case 'editClass': editClassForm(+id); break;
      case 'delClass': confirmSheet('删除班级', '将同时删除该班级的学生；历史考勤记录保留。确定删除？', function () { delClassCascade(+id); }); break;
      case 'saveClass': saveClass(id); break;
      case 'addStudent': editStudentForm(null); break;
      case 'editStudent': editStudentForm(+id); break;
      case 'delStudent': confirmSheet('删除学生', '历史考勤记录会保留该学生的姓名快照。确定删除？', function () { DB.students = DB.students.filter(function (s) { return s.id !== +id; }); save(); closeSheet(); render(); }); break;
      case 'saveStudent': saveStudent(id); break;
      case 'addCourse': editCourseForm(null); break;
      case 'editCourse': editCourseForm(+id); break;
      case 'delCourse': confirmSheet('删除课程', '历史考勤记录保留课程名快照。确定删除？', function () { DB.courses = DB.courses.filter(function (c) { return c.id !== +id; }); save(); closeSheet(); render(); }); break;
      case 'saveCourse': saveCourse(id); break;
      case 'addLocation': editLocationForm(null); break;
      case 'editLocation': editLocationForm(+id); break;
      case 'delLocation': confirmSheet('删除地点', '历史考勤记录保留地点名快照。确定删除？', function () { DB.locations = DB.locations.filter(function (c) { return c.id !== +id; }); save(); closeSheet(); render(); }); break;
      case 'saveLocation': saveLocation(id); break;
      case 'addTime': editTimeForm(null); break;
      case 'editTime': editTimeForm(+id); break;
      case 'delTime': confirmSheet('删除节次', '确定删除该节次？', function () { DB.times = DB.times.filter(function (c) { return c.id !== +id; }); save(); closeSheet(); render(); }); break;
      case 'saveTime': saveTime(id); break;
    }
  }

  function exportOne(id) {
    var s = byId(DB.sessions, id); if (!s) return;
    var rows = exportRows([s]);
    var text = toCsv(rows, { rangeText: fmtDate(s.date), classText: s.className || '全部', courseText: s.courseName || '全部', locationText: s.locationName || '全部', exportedAt: new Date().toLocaleString('zh-CN') });
    download('考勤明细_' + s.date + '_' + stamp() + '.csv', text, 'text/csv');
  }

  // ============================================================ 请假类型选择
  function openLeavePicker(studentId) {
    openSheet('<h3>请假类型</h3><div class="list">' +
      LEAVE.map(function (k) { return '<div class="item" data-act="setLeave" data-id="' + studentId + '" data-v="' + k + '"><div class="t">' + label(k) + '</div></div>'; }).join('') +
      '</div><div class="actions"><button class="btn ghost" data-act="closeSheet">取消</button></div>');
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
    var obj = { id: +id || nid(), name: name, major: $('#c_major').value.trim(), majorShort: $('#c_short').value.trim(), academicYear: $('#c_year').value.trim(), counselor: $('#c_counselor').value.trim() };
    if (+id) { var i = DB.classes.findIndex(function (c) { return c.id === +id; }); DB.classes[i] = obj; }
    else DB.classes.push(obj);
    save(); closeSheet(); toast('已保存'); render();
  }
  function delClassCascade(id) {
    DB.classes = DB.classes.filter(function (c) { return c.id !== id; });
    DB.students = DB.students.filter(function (s) { return s.classId !== id; });
    save(); closeSheet(); toast('已删除'); render();
  }

  function editStudentForm(s) {
    if (!DB.classes.length) { toast('请先添加班级'); return; }
    var curClass = s ? s.classId : (sf.classId || DB.classes[0].id);
    openSheet('<h3>' + (s ? '编辑学生' : '新增学生') + '</h3>' +
      '<div class="f"><label class="f">班级</label><select id="s_class">' +
      DB.classes.map(function (c) { return '<option value="' + c.id + '"' + (c.id === curClass ? ' selected' : '') + '>' + esc(c.name) + '</option>'; }).join('') + '</select></div>' +
      field('s_name', '姓名', s && s.name, 'text') +
      field('s_no', '学号', s && s.studentNo, 'text') +
      '<div class="actions"><button class="btn ghost" data-act="closeSheet">取消</button>' +
      '<button class="btn" data-act="saveStudent" data-id="' + (s ? s.id : 0) + '">保存</button></div>');
  }
  function saveStudent(id) {
    var name = $('#s_name').value.trim(), no = $('#s_no').value.trim();
    if (!name) { toast('姓名不能为空'); return; }
    var obj = { id: +id || nid(), classId: +$('#s_class').value, name: name, studentNo: no, sortOrder: 0 };
    if (+id) { var i = DB.students.findIndex(function (s) { return s.id === +id; }); DB.students[i] = obj; }
    else DB.students.push(obj);
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
    if (+id) { var i = DB.courses.findIndex(function (c) { return c.id === +id; }); DB.courses[i] = obj; }
    else DB.courses.push(obj);
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
    var obj = { id: +id || nid(), name: name, department: $('#l_dept').value.trim() };
    if (+id) { var i = DB.locations.findIndex(function (c) { return c.id === +id; }); DB.locations[i] = obj; }
    else DB.locations.push(obj);
    save(); closeSheet(); toast('已保存'); render();
  }

  function editTimeForm(c) {
    openSheet('<h3>' + (c ? '编辑节次' : '新增节次') + '</h3>' +
      field('t_period', '节次名称', c && c.period, 'text') +
      '<div class="grid2"><div class="f"><label class="f">开始时间</label><input id="t_start" type="time" value="' + esc(c && c.startTime || '') + '"></div>' +
      '<div class="f"><label class="f">结束时间</label><input id="t_end" type="time" value="' + esc(c && c.endTime || '') + '"></div></div>' +
      '<div class="actions"><button class="btn ghost" data-act="closeSheet">取消</button>' +
      '<button class="btn" data-act="saveTime" data-id="' + (c ? c.id : 0) + '">保存</button></div>');
  }
  function saveTime(id) {
    var period = $('#t_period').value.trim();
    if (!period) { toast('节次名称不能为空'); return; }
    var obj = { id: +id || nid(), period: period, startTime: $('#t_start').value, endTime: $('#t_end').value };
    if (+id) { var i = DB.times.findIndex(function (c) { return c.id === +id; }); DB.times[i] = obj; }
    else DB.times.push(obj);
    save(); closeSheet(); toast('已保存'); render();
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
              } catch (e) { /* ignore */ }
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
    var s = DB.students.filter(function (x) { return x.classId === editor.classId && String(x.studentNo).toUpperCase() === parsed.studentNo; })[0];
    if (!s) { msg.textContent = '本班没有学号 ' + parsed.studentNo; return; }
    var m = editor.marks[s.id] || (editor.marks[s.id] = { first: 'PRESENT', second: 'INHERIT', checkIn: '' });
    m.first = 'PRESENT'; m.checkIn = nowHHMM();
    stopScan(); closeSheet(); render(); toast('已记 ' + s.name + ' 已到 ' + m.checkIn);
  }
  function stopScan() {
    if (!scan) return;
    cancelAnimationFrame(scan.raf);
    try { scan.stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
    scan = null;
  }

  // ============================================================ 备份 / 恢复 / 安装
  function doBackup() {
    download('kaoqin-teacher-backup-' + stamp() + '.json', JSON.stringify(DB), 'application/json');
  }
  function doRestore() {
    var input = document.createElement('input');
    input.type = 'file'; input.accept = '.json,application/json';
    input.onchange = function () {
      var f = input.files && input.files[0]; if (!f) return;
      var reader = new FileReader();
      reader.onload = function () {
        try {
          var d = JSON.parse(reader.result);
          var next = null, fromAndroid = false;
          if (d && d.v === 1 && Array.isArray(d.classes)) next = d;
          else if (d && d.tables && (d.tables.class_info || d.tables.student)) { next = importAndroid(d); fromAndroid = true; }
          if (!next) { toast('不是有效的备份文件（本应用或 Android 导出均可）'); return; }
          confirmSheet('恢复备份',
            (fromAndroid ? '识别为 Android 端导出文件。' : '') +
            '将用备份覆盖本机现有数据（班级 ' + next.classes.length + ' 个，考勤 ' + next.sessions.length + ' 次）。确定？',
            function () { DB = next; save(); toast(fromAndroid ? '已从 Android 备份导入' : '已恢复'); render(); });
        } catch (e) { toast('文件解析失败：' + e.message); }
      };
      reader.readAsText(f);
    };
    input.click();
  }

  /** 把 Android 端导出的 BackupEnvelope（tables: {表名:{fields,rows}}）映射成本地数据 */
  function importAndroid(d) {
    function rows(name) {
      var tab = d.tables[name];
      if (!tab || !tab.fields || !tab.rows) return [];
      var idx = {};
      tab.fields.forEach(function (f, i) { idx[f] = i; });
      return tab.rows.map(function (r) {
        var o = {};
        Object.keys(idx).forEach(function (f) { o[f] = r[idx[f]]; });
        return o;
      });
    }
    var db = blank();
    db.classes = rows('class_info').map(function (o) {
      return { id: +o.id, name: o.name || '', major: o.major || '', majorShort: o.majorShort || '', academicYear: o.academicYear || '', counselor: o.counselor || '' };
    });
    db.students = rows('student').map(function (o) {
      return { id: +o.id, classId: +o.classId, studentNo: o.studentNo || '', name: o.name || '', sortOrder: +o.sortOrder || 0 };
    });
    db.courses = rows('course').map(function (o) { return { id: +o.id, name: o.name || '', teacher: o.teacher || '' }; });
    db.locations = rows('location').map(function (o) { return { id: +o.id, name: o.name || '', department: o.department || '' }; });
    db.times = rows('class_time').map(function (o) { return { id: +o.id, period: o.period || '', startTime: o.startTime || '', endTime: o.endTime || '' }; });
    db.sessions = rows('session').map(function (o) {
      return { id: +o.id, classId: +o.classId, courseId: +o.courseId, locationId: +o.locationId || 0, timeId: +o.timeId || 0, date: o.date || '', remark: o.remark || '', createdAt: +o.createdAt || 0, className: o.className || '', courseName: o.courseName || '', locationName: o.locationName || '', timePeriod: o.timePeriod || '' };
    });
    db.records = rows('record').map(function (o) {
      return { id: +o.id, sessionId: +o.sessionId, studentId: +o.studentId, status: o.status || 'PRESENT', remark: o.remark || '', studentName: o.studentName || '', studentNo: o.studentNo || '', half: +o.half || 1, checkInTime: o.checkInTime || '', leaveTime: o.leaveTime || '' };
    });
    var maxId = 0;
    ['classes', 'students', 'courses', 'locations', 'times', 'sessions', 'records'].forEach(function (k) {
      db[k].forEach(function (x) { if (x.id > maxId) maxId = x.id; });
    });
    db.seq = maxId;
    return db;
  }

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
    else if (route.name === 'manage') html = viewManage();
    else if (route.name === 'settings') html = viewSettings();
    else html = viewRollcall();
    $('#app').innerHTML = html;
    var active = route.name === 'records' ? 'records' : route.name;
    var btns = document.querySelectorAll('#tabs button');
    for (var i = 0; i < btns.length; i++) btns[i].classList.toggle('on', btns[i].getAttribute('data-tab') === active);
    if (route.name === 'records' && route.arg) {
      // 详情页时高亮「记录」tab
      var recBtn = document.querySelector('#tabs button[data-tab="records"]');
      if (recBtn) recBtn.classList.add('on');
    }
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
