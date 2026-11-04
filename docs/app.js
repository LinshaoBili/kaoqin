/*
 * 考勤码网页版。
 *
 * 设计约束：
 * 1. **不联网也能用**。所有资源（含二维码库）都在本目录，Service Worker 预缓存整个外壳；
 *    首次打开之后断网仍然能显示二维码——这是学生"手机欠费/没流量"时的真实场景。
 * 2. **二维码永远白底黑码**，即使系统是深色模式。反色二维码在不少扫码器上解不出来。
 * 3. 不依赖任何框架/构建步骤，改完直接推到 GitHub Pages 就生效。
 */
(function () {
  'use strict';

  var KEY_NO = 'kaoqin.student.no';
  var el = function (id) { return document.getElementById(id); };

  var bindView = el('bindView');
  var qrView = el('qrView');
  var input = el('noInput');
  var errBox = el('bindErr');
  var canvas = el('qr');
  var netChip = el('netChip');
  var installBtn = el('installBtn');
  var installBtn2 = el('installBtn2');
  var mask = el('mask');
  var sheetTitle = el('sheetTitle');
  var sheetBody = el('sheetBody');

  var deferredPrompt = null;
  var swReady = false;

  // ---------------------------------------------------------------- 存储

  function readNo() {
    try { return localStorage.getItem(KEY_NO) || ''; } catch (e) { return ''; }
  }

  function writeNo(no) {
    try { localStorage.setItem(KEY_NO, no); } catch (e) { /* 无痕模式写不进去，本次仍可用 */ }
  }

  // ---------------------------------------------------------------- 二维码

  /**
   * 画二维码。
   *
   * 静默区（quiet zone）按规范留 4 个模块，并且**画进 canvas 内**而不是靠 CSS padding：
   * 截图/长按保存时 CSS 白边会丢，白边不够就可能扫不出来。
   */
  function renderQr(text) {
    var qr = qrcode(0, 'M');
    qr.addData(text, 'Byte');
    qr.make();

    var count = qr.getModuleCount();
    var quiet = 4;
    var total = count + quiet * 2;

    var cssSize = Math.min(Math.min(window.innerWidth, 520) - 72, 360);
    var dpr = window.devicePixelRatio || 1;
    var px = Math.round(cssSize * dpr);

    canvas.width = px;
    canvas.height = px;
    canvas.style.width = cssSize + 'px';
    canvas.style.height = cssSize + 'px';

    var ctx = canvas.getContext('2d');
    var cell = px / total;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, px, px);
    ctx.fillStyle = '#000000';
    for (var r = 0; r < count; r++) {
      for (var c = 0; c < count; c++) {
        if (qr.isDark(r, c)) {
          // 用 ceil 让相邻模块不留缝（缩放取整时最常见的"白线"问题）
          ctx.fillRect(
            Math.floor((c + quiet) * cell),
            Math.floor((r + quiet) * cell),
            Math.ceil(cell),
            Math.ceil(cell)
          );
        }
      }
    }
  }

  function showQr(no) {
    var payload = ScanCode.encode(no);
    var check = ScanCode.parse(payload);
    if (!check.ok) {
      // 自检失败说明两端格式实现已经不一致，宁可报错也不显示一个扫不出来的码
      errBox.textContent = '二维码自检未通过（' + check.reason + '），请刷新页面重试';
      return;
    }
    renderQr(payload);
    el('noEcho').textContent = no;
    bindView.classList.add('hide');
    qrView.classList.remove('hide');
    installBtn.classList.add('hide');
    setChip();
  }

  function showBind() {
    input.value = readNo();
    qrView.classList.add('hide');
    bindView.classList.remove('hide');
    installBtn.classList.remove('hide');
    errBox.textContent = '';
    setChip();
  }

  // ---------------------------------------------------------------- 状态条

  function standalone() {
    return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
      window.navigator.standalone === true;
  }

  function setChip() {
    if (!navigator.onLine) {
      netChip.textContent = '离线使用中';
      netChip.className = 'chip';
    } else if (swReady) {
      netChip.textContent = '可离线使用';
      netChip.className = 'chip ok';
    } else {
      netChip.textContent = '在线';
      netChip.className = 'chip';
    }
    if (standalone()) {
      installBtn.classList.add('hide');
      installBtn2.classList.add('hide');
      el('offlineNote').textContent = '已添加到桌面：以后从这里打开，断网也能显示二维码。';
    }
  }

  // ---------------------------------------------------------------- 绑定

  el('bindBtn').addEventListener('click', function () {
    var no = ScanCode.normalize(input.value);
    if (!no) { errBox.textContent = '请输入学号'; return; }
    if (no.length > ScanCode.MAX_NO_LENGTH) {
      errBox.textContent = '学号太长，请检查是否粘贴了多余内容';
      return;
    }
    errBox.textContent = '';
    writeNo(no);
    showQr(no);
  });

  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { el('bindBtn').click(); }
  });

  el('changeBtn').addEventListener('click', showBind);

  // ---------------------------------------------------------------- 添加到桌面

  function isIOS() {
    var ua = navigator.userAgent || '';
    return /iPad|iPhone|iPod/.test(ua) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  }

  function isWeChat() { return /MicroMessenger/i.test(navigator.userAgent || ''); }

  function openSheet(title, html) {
    sheetTitle.textContent = title;
    sheetBody.innerHTML = html;
    mask.classList.add('show');
  }

  el('sheetClose').addEventListener('click', function () { mask.classList.remove('show'); });
  mask.addEventListener('click', function (e) { if (e.target === mask) { mask.classList.remove('show'); } });

  function askInstall() {
    if (deferredPrompt) {
      deferredPrompt.prompt();
      deferredPrompt.userChoice.then(function () { deferredPrompt = null; });
      return;
    }
    if (isWeChat()) {
      openSheet('请用浏览器打开', '<p>微信内置浏览器无法添加到桌面。点右上角 <b>⋯</b>，选择「在浏览器打开」，再按下面的步骤操作。</p>');
      return;
    }
    if (isIOS()) {
      openSheet('添加到主屏幕（iPhone / iPad）', [
        '<ol>',
        '<li>确认当前用的是 <b>Safari</b> 浏览器（本页底部有工具栏）</li>',
        '<li>点底部中间的 <b>分享</b> 图标（方框 + 向上箭头）</li>',
        '<li>在列表里选 <b>「添加到主屏幕」</b></li>',
        '<li>右上角点 <b>「添加」</b></li>',
        '</ol>',
        '<p>添加后桌面会多一个「考勤码」图标，点开就是全屏页面，不用再输网址。</p>'
      ].join(''));
      return;
    }
    openSheet('添加到桌面（安卓）', [
      '<ol>',
      '<li>点右上角 <b>⋮</b> 菜单</li>',
      '<li>选择 <b>「安装应用」</b> 或 <b>「添加到主屏幕」</b></li>',
      '<li>确认后会生成一个图标，点开即用</li>',
      '</ol>',
      '<p>若没有这个选项，说明当前浏览器不支持，换用 Chrome / Edge / 系统自带浏览器打开本页。</p>'
    ].join(''));
  }

  installBtn.addEventListener('click', askInstall);
  installBtn2.addEventListener('click', askInstall);

  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferredPrompt = e;
    // 有了原生安装提示就把它当主按钮，避免用户再去翻菜单
    installBtn.textContent = '一键添加到桌面';
    installBtn2.textContent = '一键添加到桌面';
  });

  window.addEventListener('appinstalled', function () {
    deferredPrompt = null;
    installBtn.classList.add('hide');
    installBtn2.classList.add('hide');
  });

  // ---------------------------------------------------------------- 离线

  window.addEventListener('online', setChip);
  window.addEventListener('offline', setChip);

  if ('serviceWorker' in navigator) {
    // 注册放在 load 之后：不跟首屏渲染抢带宽
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').then(function () {
        return navigator.serviceWorker.ready;
      }).then(function () {
        swReady = true;
        setChip();
      }).catch(function () {
        // Pages 上是 https，正常不会失败；file:// 打开时浏览器直接不支持，静默忽略
      });
    });
  }

  // ---------------------------------------------------------------- 启动

  var saved = readNo();
  if (saved) { showQr(saved); } else { showBind(); }
  setChip();
})();
