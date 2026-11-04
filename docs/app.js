/*
 * 考勤码网页版。
 *
 * 设计约束：
 * 1. **不联网也能用**。所有资源（含二维码库）都在本目录，Service Worker 预缓存整个外壳；
 *    首次打开之后断网仍然能显示二维码——这是学生"手机欠费/没流量"时的真实场景。
 * 2. **二维码永远白底黑码**，即使系统是深色模式。反色二维码在不少扫码器上解不出来。
 * 3. **学号绑定有冷静期**（7 天），规则与安卓端 `BindRules` 完全同构；
 *    记录用 AES-GCM 加密后存 localStorage，并可导出成"恢复码"换设备使用。
 * 4. 不依赖任何框架/构建步骤，改完直接推到 GitHub Pages 就生效。
 */
(function () {
  'use strict';

  var el = function (id) { return document.getElementById(id); };

  var bindView = el('bindView');
  var qrView = el('qrView');
  var input = el('noInput');
  var errBox = el('bindErr');
  var canvas = el('qr');
  var netChip = el('netChip');
  var installBtn = el('installBtn');
  var installBtn2 = el('installBtn2');
  var lockNote = el('lockNote');
  var mask = el('mask');
  var sheetTitle = el('sheetTitle');
  var sheetBody = el('sheetBody');

  var deferredPrompt = null;
  var swReady = false;

  /** 当前绑定状态的镜像（true 的那一刻以 BindStore 为准，这里只是为了少写异步） */
  var state = { record: null, token: '', encrypted: true };

  // ---------------------------------------------------------------- 冷静期


  // ---------------------------------------------------------------- 二维码

  /**
   * 画二维码。
   *
   * 静默区（quiet zone）按规范留 4 个模块，并且**画进 canvas 内**而不是靠 CSS padding：
   * 截图/长按保存时 CSS 白边会丢，白边不够就可能扫不出来。
   */
  function renderQrOn(target, text, cssSize) {
    var qr = qrcode(0, 'M');
    qr.addData(text, 'Byte');
    qr.make();

    var count = qr.getModuleCount();
    var quiet = 4;
    var total = count + quiet * 2;

    var dpr = window.devicePixelRatio || 1;
    var px = Math.round(cssSize * dpr);

    target.width = px;
    target.height = px;
    target.style.width = cssSize + 'px';
    target.style.height = cssSize + 'px';

    var ctx = target.getContext('2d');
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

  function renderQr(text) {
    var cssSize = Math.min(Math.min(window.innerWidth, 520) - 72, 360);
    renderQrOn(canvas, text, cssSize);
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
    refreshLock();
    setChip();
  }

  function showBind(notice) {
    input.value = state.record ? state.record.no : '';
    qrView.classList.add('hide');
    bindView.classList.remove('hide');
    installBtn.classList.remove('hide');
    errBox.textContent = notice || '';
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

  // ---------------------------------------------------------------- 绑定 / 更换

  el('bindBtn').addEventListener('click', function () {
    var no = ScanCode.normalize(input.value);
    if (!no) { errBox.textContent = '请输入学号'; return; }
    if (no.length > ScanCode.MAX_NO_LENGTH) {
      errBox.textContent = '学号太长，请检查是否粘贴了多余内容';
      return;
    }
    errBox.textContent = '';
    BindStore.save(no).then(function (res) {
      state.record = res.record;
      state.token = res.token;
      state.encrypted = res.token.indexOf('P1.') !== 0 && BindStore.supported;
      if (!res.ok) {
        // 隐私模式下写不进去：本次仍可用，但要说明"关掉页面就没了"
        errBox.textContent = '';
      }
      showQr(no);
    });
  });

  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { el('bindBtn').click(); }
  });

  el('changeBtn').addEventListener('click', function () {
    openChange();
  });

  // ---------------------------------------------------------------- 改号流程

  var changeView = el('changeView');
  var changeTitle = el('changeTitle');
  var changeBody = el('changeBody');
  var changeToken = '';
  var changeMode = '';
  var scanStream = null;

  el('changeClose').addEventListener('click', function () {
    stopScan();
    changeView.classList.add('hide');
  });

  function openChange() {
    if (!window.ChangeFlow) {
      errBox.textContent = '页面脚本没有加载完整，请下拉刷新一次';
      return;
    }
    changeToken = ChangeFlow.generateToken();
    renderChangeMenu();
    changeView.classList.remove('hide');
  }

  function renderChangeMenu() {
    changeTitle.textContent = '更改学号';
    changeBody.innerHTML = [
      '<p class="sub" style="text-align:center">方式一：把申请码给老师扫，老师同意后再扫同意码。</p>',
      '<div class="change-qr" id="reqQr"></div>',
      '<button class="primary" id="scanApprovalBtn">扫老师的同意码</button>',
      '<button class="ghost" id="scanAuthorizeBtn">扫老师的授权码（一步改号）</button>',
      '<div class="change-err" id="changeErr"></div>'
    ].join('');
    renderChangeQr(ChangeFlow.request(state.record.no, changeToken), el('reqQr'));
    el('scanApprovalBtn').addEventListener('click', function () { startScan('approval'); });
    el('scanAuthorizeBtn').addEventListener('click', function () { startScan('authorize'); });
  }

  function renderChangeQr(text, host) {
    host.innerHTML = '';
    if (!text) {
      host.innerHTML = '<p style="text-align:center;color:#000">申请码生成失败</p>';
      return;
    }
    var c = document.createElement('canvas');
    host.appendChild(c);
    renderQrOn(c, text, 300);
  }

  function startScan(mode) {
    changeMode = mode;
    changeTitle.textContent = mode === 'approval' ? '扫描老师的同意码' : '扫描老师的授权码';
    changeBody.innerHTML = [
      '<div class="scan-box"><video id="scanVideo" playsinline muted></video><canvas id="scanCanvas"></canvas></div>',
      '<div class="change-err" id="changeErr"></div>',
      '<button class="ghost" id="scanBackBtn">返回</button>'
    ].join('');
    el('scanBackBtn').addEventListener('click', function () {
      stopScan();
      renderChangeMenu();
    });
    openCamera();
  }

  function openCamera() {
    var err = el('changeErr');
    if (!window.jsQR) { err.textContent = '扫码组件未加载，请下拉刷新'; return; }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      err.textContent = '当前浏览器不支持摄像头（请用 https 或 Chrome 打开）';
      return;
    }
    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
      .then(function (stream) {
        scanStream = stream;
        var video = el('scanVideo');
        video.srcObject = stream;
        video.play().catch(function () {});
        scanLoop();
      })
      .catch(function () {
        err.textContent = '无法打开摄像头，请检查权限';
      });
  }

  function scanLoop() {
    if (!scanStream) return;
    var video = el('scanVideo');
    var c = el('scanCanvas');
    if (video.readyState >= 2) {
      var w = video.videoWidth, h = video.videoHeight;
      if (w > 0 && h > 0) {
        c.width = w;
        c.height = h;
        var ctx = c.getContext('2d');
        ctx.drawImage(video, 0, 0, w, h);
        var img = ctx.getImageData(0, 0, w, h);
        var code = window.jsQR(img.data, w, h, { inversionAttempts: 'dontInvert' });
        if (code && code.data) {
          onDecode(code.data);
          return;
        }
      }
    }
    requestAnimationFrame(scanLoop);
  }

  function onDecode(raw) {
    stopScan();
    if (changeMode === 'approval') {
      var p = ChangeFlow.parseApproval(raw);
      if (!p.ok) { failScan(changeReason(p, 'approval')); return; }
      if (p.oldNo !== state.record.no) { failScan('这个同意码不是给你的（学号不匹配）'); return; }
      if (p.token !== changeToken) { failScan('这个同意码不是给这次申请的'); return; }
      applyNewNo(p.newNo);
    } else {
      var a = ChangeFlow.parseAuthorize(raw);
      if (!a.ok) { failScan(changeReason(a, 'authorize')); return; }
      applyNewNo(a.newNo);
    }
  }

  function changeReason(p, mode) {
    var kind = mode === 'approval' ? '同意码' : '授权码';
    if (p.reason === 'badChecksum') return kind + '校验不通过（可能截图不全或抄错）';
    if (p.reason === 'emptyNo') return kind + '里没有有效学号';
    return '不是改号' + kind;
  }

  function failScan(msg) {
    changeBody.innerHTML = [
      '<p class="change-err" style="text-align:center">' + msg + '</p>',
      '<button class="primary" id="scanRetryBtn">重新扫描</button>',
      '<button class="ghost" id="scanBackBtn2">返回</button>'
    ].join('');
    el('scanRetryBtn').addEventListener('click', function () { startScan(changeMode); });
    el('scanBackBtn2').addEventListener('click', function () { renderChangeMenu(); });
  }

  function applyNewNo(newNo) {
    BindStore.save(newNo).then(function (res) {
      state.record = res.record;
      state.token = res.token;
      state.encrypted = res.token.indexOf('P1.') !== 0 && BindStore.supported;
      changeView.classList.add('hide');
      showQr(newNo);
    });
  }

  function stopScan() {
    if (scanStream) {
      scanStream.getTracks().forEach(function (t) { t.stop(); });
      scanStream = null;
    }
  }

  // ---------------------------------------------------------------- 备份 / 恢复（加密恢复码）

  function openTokenSheet() {
    openSheet('备份 / 恢复学号', [
      '<p>下面这串是<b>加密后</b>的绑定记录，可以直接抄到备忘录里。',
      '换手机、换浏览器、或不小心清了网站数据时，用第二种方式粘回来即可。</p>',
      '<textarea id="tokenBox" rows="4" spellcheck="false" autocapitalize="off" placeholder="在这里粘贴恢复码"></textarea>',
      '<button class="primary" id="tokenCopy">复制本机绑定码</button>',
      '<button class="ghost" id="tokenApply">用上面的内容恢复</button>',
      '<div class="err" id="tokenErr"></div>'
    ].join(''));
    if (!state.encrypted) {
      el('tokenErr').textContent = '注意：当前环境不支持加密存储，这条记录是未加密的';
    }

    var box = el('tokenBox');
    box.value = state.token || '';

    el('tokenCopy').addEventListener('click', function () {
      var text = state.token || '';
      if (!text) { el('tokenErr').textContent = '还没有绑定记录，无法导出'; return; }
      copyText(text, box).then(function (ok) {
        el('tokenErr').textContent = ok ? '已复制，粘贴到备忘录保存即可' : '复制失败，请长按上面的文本框手动复制';
      });
    });

    el('tokenApply').addEventListener('click', function () {
      var text = (box.value || '').trim();
      if (!text) { el('tokenErr').textContent = '请先粘贴恢复码'; return; }
      BindStore.open(text).then(function (rec) {
        if (!rec) {
          el('tokenErr').textContent = '恢复码无效或已被修改，无法恢复';
          return;
        }
        BindStore.saveRecord(rec).then(function (res) {
          state.record = rec;
          state.token = res.token;
          state.encrypted = res.token.indexOf('P1.') !== 0 && BindStore.supported;
          mask.classList.remove('show');
          showQr(rec.no);
        });
      });
    });
  }

  function copyText(text, fallbackEl) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text)
        .then(function () { return true; })
        .catch(function () { return legacyCopy(fallbackEl); });
    }
    return Promise.resolve(legacyCopy(fallbackEl));
  }

  function legacyCopy(node) {
    try {
      node.focus();
      node.select();
      return document.execCommand('copy');
    } catch (e) {
      return false;
    }
  }

  el('tokenBtn').addEventListener('click', openTokenSheet);

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

  // 定时刷新锁定倒计时：不需要秒级，一分钟一次足够
  window.setInterval(function () {
    if (state.record) refreshLock();
  }, 60000);

  // 极少数情况下脚本可能没加载完整（例如 Service Worker 正处在换版的中途），
  // 那样 BindStore 就是 undefined——给一句能照做的话，而不是让整页白屏。
  if (!window.BindStore) {
    errBox.textContent = '页面脚本没有加载完整，请下拉刷新一次';
    showBind('');
    return;
  }

  BindStore.load().then(function (loaded) {
    state.record = loaded.record;
    state.token = loaded.token;
    state.encrypted = loaded.encrypted;

    if (loaded.record) {
      showQr(loaded.record.no);
      // 推进 seen：这是"把手机时间往回拨"绕不过冷静期的原因（与安卓端同一套规则）
      BindStore.touch(loaded.record, Date.now()).then(function (rec) { state.record = rec; });
    } else {
      showBind(loaded.damaged ? '上次的绑定记录已损坏（或被修改过），需要重新填写学号' : '');
    }
    setChip();
  }).catch(function () {
    // 存储整体不可用（极端隐私模式）：仍然允许本次出码，只是刷新后要重新填
    showBind('');
  });
})();
