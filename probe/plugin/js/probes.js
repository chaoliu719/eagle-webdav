/* 环境、写入、性能探针。针对 Eagle Plugin API，所有不确定的调用都包在 try/catch 里。 */
(function (root) {
  'use strict';
  var EW = root.EW = root.EW || {};
  var fs = require('fs');
  var path = require('path');
  var os = require('os');
  var zlib = require('zlib');

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function nowMs() { return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now(); }
  function errStr(e) { return String(e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e); }

  // ---------- 测试素材生成 ----------
  var CRC_TABLE = (function () {
    var t = []; for (var n = 0; n < 256; n++) { var c = n; for (var k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
  })();
  function crc32(buf) { var c = 0xffffffff; for (var i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
  function chunk(type, data) {
    var len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    var td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    var crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td), 0);
    return Buffer.concat([len, td, crc]);
  }
  function makePng(w, h, r, g, b) {
    var ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
    var row = Buffer.alloc(1 + w * 3);
    for (var x = 0; x < w; x++) { row[1 + x * 3] = r; row[2 + x * 3] = g; row[3 + x * 3] = (b + x) & 255; }
    var raw = Buffer.concat(Array.from({ length: h }, function () { return row; }));
    return Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))
    ]);
  }
  var GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

  // ---------- 通用 ----------
  var SKIP_KEYS = { thumbnail: 1, palettes: 1 };
  function plain(o, depth) {
    depth = depth || 0;
    if (o === null || o === undefined) return o;
    var t = typeof o;
    if (t === 'string' || t === 'number' || t === 'boolean') return o;
    if (t === 'function') return undefined;
    if (Array.isArray(o)) return depth > 2 ? '[array ' + o.length + ']' : o.slice(0, 80).map(function (x) { return plain(x, depth + 1); });
    if (t === 'object') {
      if (depth > 2) return '[object]';
      var out = {};
      var keys = Object.keys(o);
      keys.forEach(function (k) {
        if (SKIP_KEYS[k]) return;
        if (k.charAt(0) === '_') return;
        var v = plain(o[k], depth + 1);
        if (v !== undefined) out[k] = v;
      });
      return out;
    }
    return String(o);
  }
  function protoMethods(o) {
    var out = [];
    try {
      var p = Object.getPrototypeOf(o);
      while (p && p !== Object.prototype) {
        Object.getOwnPropertyNames(p).forEach(function (k) { if (k !== 'constructor' && out.indexOf(k) < 0) out.push(k); });
        p = Object.getPrototypeOf(p);
      }
    } catch (e) { /* ignore */ }
    return out;
  }
  function apiList(obj) {
    var out = [];
    try { for (var k in obj) out.push(k + ':' + typeof obj[k]); } catch (e) { /* ignore */ }
    try { Object.getOwnPropertyNames(obj).forEach(function (k) { var s = k + ':' + typeof obj[k]; if (out.indexOf(s) < 0) out.push(s); }); } catch (e) { /* ignore */ }
    return out.sort();
  }

  // ---------- 环境 ----------
  function collectEnv(eagle) {
    var env = { at: new Date().toISOString() };
    try { env.processVersions = plain(process.versions); env.platform = process.platform; env.arch = process.arch; env.node = process.version; } catch (e) { env.processError = errStr(e); }
    try { env.userAgent = navigator.userAgent; } catch (e) { /* ignore */ }
    try { env.hostname = os.hostname(); env.homedir = os.homedir(); env.tmpdir = os.tmpdir(); } catch (e) { /* ignore */ }
    env.app = {};
    try {
      ['version', 'build', 'name', 'locale', 'arch', 'platform', 'isDarkColors', 'execPath', 'userDataPath', 'runningUnderARM64Translation']
        .forEach(function (k) { try { var v = eagle.app[k]; if (typeof v !== 'function') env.app[k] = plain(v); } catch (e) { /* ignore */ } });
      env.app.apis = apiList(eagle.app);
    } catch (e) { env.app.error = errStr(e); }
    env.library = {};
    try {
      ['path', 'name', 'modificationTime'].forEach(function (k) { try { env.library[k] = plain(eagle.library[k]); } catch (e) { /* ignore */ } });
      env.library.apis = apiList(eagle.library);
    } catch (e) { env.library.error = errStr(e); }
    env.eagleApis = {};
    ['item', 'folder', 'tag', 'tagGroup', 'window', 'event', 'log', 'os', 'clipboard', 'dialog', 'notification'].forEach(function (ns) {
      try { if (eagle[ns]) env.eagleApis[ns] = apiList(eagle[ns]); } catch (e) { /* ignore */ }
    });
    try { env.eagleTopKeys = Object.keys(eagle).sort(); } catch (e) { /* ignore */ }
    try { env.lan = EW.lanAddresses(); } catch (e) { /* ignore */ }
    try { env.memory = plain(process.memoryUsage()); } catch (e) { /* ignore */ }
    return Promise.resolve().then(function () { return eagle.library.info(); })
      .then(function (v) { env.library.info = plain(v); }).catch(function (e) { env.library.infoError = errStr(e); })
      .then(function () { return eagle.item.countAll(); })
      .then(function (n) { env.itemCountAll = n; }).catch(function (e) { env.itemCountError = errStr(e); })
      .then(function () { return env; });
  }

  // ---------- 写入探针 ----------
  async function runWriteProbes(eagle, ctx) {
    ctx = ctx || {};
    var log = ctx.log || function () {};
    var R = { startedAt: new Date().toISOString(), steps: [], notes: {}, verdicts: {}, timeline: [] };
    var created = [];      // 创建的 item id
    var folderIds = [];
    var stamp = String(Date.now());
    var dir = path.join(os.tmpdir(), 'ewprobe-' + stamp);
    fs.mkdirSync(dir, { recursive: true });
    R.tmpDir = dir;

    function rec(name, ok, data) {
      var s = { name: name, ok: ok, data: data };
      R.steps.push(s);
      log((ok ? '✓ ' : '✗ ') + name + (data !== undefined ? ' ' + JSON.stringify(data).slice(0, 300) : ''));
      return s;
    }
    async function step(name, fn) {
      var t0 = nowMs();
      try {
        var limit = (name.indexOf('I9') === 0 ? 600000 : (ctx.stepTimeoutMs || 20000));
        var timer;
        var v = await Promise.race([
          Promise.resolve().then(fn),
          new Promise(function (_, rej) { timer = setTimeout(function () { rej(new Error('TIMEOUT ' + limit + 'ms，调用没有返回')); }, limit); })
        ]);
        clearTimeout(timer);
        var s = rec(name, true, plain(v));
        s.ms = Math.round(nowMs() - t0);
        return v;
      } catch (e) {
        var s2 = rec(name, false, { error: errStr(e) });
        s2.ms = Math.round(nowMs() - t0);
        return undefined;
      }
    }
    var IPROPS = ['id', 'name', 'ext', 'width', 'height', 'url', 'isDeleted', 'annotation', 'tags', 'folders', 'size', 'star', 'importedAt', 'modifiedAt', 'lastModified', 'filePath', 'fileURL', 'thumbnailPath', 'noThumbnail', 'noPreview', 'duration'];
    function itemSummary(it) {
      if (!it) return it;
      var o = {};
      IPROPS.forEach(function (k) { try { var v = it[k]; if (v !== undefined && typeof v !== 'function') o[k] = plain(v); } catch (e) { /* ignore */ } });
      return o;
    }
    async function trash(id) {
      var it = await eagle.item.getById(id);
      if (!it) throw new Error('getById 返回空：' + id);
      return it.moveToTrash();
    }
    async function libInfo() { try { return plain(await eagle.library.info()); } catch (e) { return 'err:' + errStr(e); } }
    async function reload(id) { return eagle.item.getById(id); }
    async function mod(id) {
      try {
        var r = await eagle.item.getIdsWithModifiedAt();
        var hit = Array.isArray(r) ? r.filter(function (x) { return (x.id || x) === id; })[0] : (r && r[id]);
        return hit;
      } catch (e) { return 'err:' + errStr(e); }
    }
    function libMod() { try { return eagle.library.modificationTime; } catch (e) { return undefined; } }
    function mark(label) { R.timeline.push({ label: label, libraryModificationTime: libMod(), at: Date.now() }); }
    function fileInfo(p) {
      try { var st = fs.statSync(p); return { exists: true, size: st.size, isDir: st.isDirectory() }; } catch (e) { return { exists: false }; }
    }
    function listDir(p) { try { return fs.readdirSync(p); } catch (e) { return 'err:' + e.code; } }

    // 素材
    var files = {};
    var rnd = function () { return Math.floor(Math.random() * 200) + 20; };
    files.png = path.join(dir, 'probe-a.png'); fs.writeFileSync(files.png, makePng(48, 32, rnd(), rnd(), rnd()));
    files.png2 = path.join(dir, 'probe-b.png'); fs.writeFileSync(files.png2, makePng(40, 40, rnd(), rnd(), rnd()));
    files.png3 = path.join(dir, 'probe-b2.png'); fs.writeFileSync(files.png3, makePng(41, 41, rnd(), rnd(), rnd()));
    var gifBuf = Buffer.from(GIF); gifBuf[13] = rnd(); gifBuf[14] = rnd(); gifBuf[15] = rnd();
    files.gif = path.join(dir, 'probe-c.gif'); fs.writeFileSync(files.gif, gifBuf);
    files.txt = path.join(dir, 'probe-d.txt'); fs.writeFileSync(files.txt, 'webdav probe text ' + stamp + '\n');
    files.noext = path.join(dir, 'probe-noext'); fs.writeFileSync(files.noext, 'no extension ' + stamp + '\n');
    var nfcName = '探针é文件.png';
    var nfdName = 'é-nfd.png';
    files.uni = path.join(dir, 'uni-src.png'); fs.writeFileSync(files.uni, makePng(24, 24, rnd(), rnd(), rnd()));
    files.uni2 = path.join(dir, 'uni-src2.png'); fs.writeFileSync(files.uni2, makePng(25, 25, rnd(), rnd(), rnd()));
    if (ctx.bigMB > 0) {
      files.big = path.join(dir, 'probe-big.bin');
      var fd = fs.openSync(files.big, 'w');
      var blk = Buffer.alloc(1024 * 1024, 7);
      for (var i = 0; i < ctx.bigMB; i++) fs.writeSync(fd, blk);
      fs.closeSync(fd);
    }

    var libPath = ''; try { libPath = eagle.library.path; } catch (e) { /* ignore */ }
    R.library = libPath;
    mark('start');

    // F0 文件夹
    var A = await step('F0a folder.create A', function () { return eagle.folder.create({ name: '__webdav_probe_A_' + stamp }); });
    var B = await step('F0b folder.create B', function () { return eagle.folder.create({ name: '__webdav_probe_B_' + stamp }); });
    if (A) folderIds.push(A.id); if (B) folderIds.push(B.id);
    if (!A || !B) {
      R.verdicts.abort = '无法创建文件夹，后续步骤终止';
      return R;
    }
    var SUB = await step('F0c folder.createSubfolder', async function () {
      if (typeof eagle.folder.createSubfolder === 'function') return eagle.folder.createSubfolder(A.id, { name: 'sub' });
      return A.createSubfolder({ name: 'sub' });
    });
    if (SUB) folderIds.push(SUB.id);
    await step('F0d folder 对象成员', function () { return { keys: Object.keys(A), proto: protoMethods(A) }; });
    mark('after folders');

    // 导入
    async function imp(label, p, opts) {
      var t0 = nowMs();
      var id = await step(label, function () { return eagle.item.addFromPath(p, opts); });
      var ms = Math.round(nowMs() - t0);
      var realId = id && typeof id === 'object' ? (id.id || id.itemId) : id;
      if (realId) {
        created.push(realId);
        var it = await step(label + ' → getById', function () { return reload(realId); });
        var sum = itemSummary(it);
        var fp = it && it.filePath;
        var d = { returned: plain(id), ms: ms, item: sum };
        if (fp) { d.file = fileInfo(fp); d.dirList = listDir(path.dirname(fp)); d.copiedFromSource = fp !== p; }
        R.notes[label] = d;
        return realId;
      }
      return undefined;
    }

    var I1 = await imp('I1 png 带扩展名的 name', files.png, { name: 'probe-name-with-ext.png', folders: [A.id], tags: ['webdav-probe'] });
    var I2 = await imp('I2 png 不带扩展名的 name', files.png2, { name: 'probe-name-noext', folders: [A.id] });
    var I3 = await imp('I3 同名同文件夹再次导入（内容不同）', files.png3, { name: 'probe-name-noext', folders: [A.id] });
    var I4 = await imp('I4 gif 无 name 选项', files.gif, { folders: [A.id] });
    var I5 = await imp('I5 txt', files.txt, { name: 'probe-d', folders: [B.id] });
    var I6 = await imp('I6 无扩展名文件', files.noext, { name: 'probe-noext', folders: [B.id] });
    var I7 = await imp('I7 Unicode NFC 名称', files.uni, { name: nfcName, folders: [A.id] });
    var I8 = await imp('I8 NFD 名称', files.uni2, { name: nfdName, folders: [A.id] });
    if (R.notes['I7 Unicode NFC 名称'] && R.notes['I7 Unicode NFC 名称'].item) {
      var n7 = R.notes['I7 Unicode NFC 名称'].item.name;
      R.notes.I7_nameCompare = { stored: n7, equalsNFC: n7 === nfcName, equalsNFD: n7 === nfcName.normalize('NFD') };
    }
    if (R.notes['I8 NFD 名称'] && R.notes['I8 NFD 名称'].item) {
      var n8 = R.notes['I8 NFD 名称'].item.name;
      R.notes.I8_nameCompare = { stored: n8, equalsAsGiven: n8 === nfdName, equalsNFC: n8 === nfdName.normalize('NFC') };
    }
    if (ctx.dupTest) {
      log('即将导入与 I2 内容完全相同的文件，Eagle 会弹出「重复添加提示」，请在 Eagle 里点「保留两者」或「使用已存在文件导入」，本步骤最多等 90 秒');
      var td = nowMs();
      var did = await (async function () {
        try {
          return await Promise.race([eagle.item.addFromPath(files.png2, { name: 'probe-dup', folders: [A.id] }), new Promise(function (_, rej) { setTimeout(function () { rej(new Error('TIMEOUT 90s')); }, 90000); })]);
        } catch (e) { return 'err:' + errStr(e); }
      })();
      R.notes.DUP = { returned: plain(did), waitedMs: Math.round(nowMs() - td), note: '重复内容导入会弹出 Eagle 对话框并阻塞调用，需要决定服务端如何处理' };
      rec('DUP 重复内容导入', typeof did !== 'string' || did.indexOf('err:') !== 0, R.notes.DUP);
      if (typeof did === 'string' && did.indexOf('err:') !== 0) created.push(did);
    }
    if (files.big) {
      await imp('I9 大文件 ' + ctx.bigMB + 'MB', files.big, { name: 'probe-big.bin', folders: [B.id] });
    }
    mark('after imports');

    // 实例成员清单
    if (I1) {
      var it1 = await reload(I1);
      await step('X1 Item 实例成员', function () { return { own: Object.keys(it1), proto: protoMethods(it1) }; });
    }

    // R4 重命名
    if (I1) {
      var before = await reload(I1);
      var fp0 = before && before.filePath;
      var dl0 = fp0 ? listDir(path.dirname(fp0)) : null;
      await sleep(50);
      await step('R4a item.name 赋值并 save', async function () {
        before.name = 'renamed-by-probe';
        var r = await before.save();
        return { saveReturned: plain(r) };
      });
      var after = await reload(I1);
      var fp1 = after && after.filePath;
      var dl1 = fp1 ? listDir(path.dirname(fp1)) : null;
      R.notes.R4 = { nameAfter: after && after.name, extAfter: after && after.ext, filePathBefore: fp0, filePathAfter: fp1, dirBefore: dl0, dirAfter: dl1, fileRenamedOnDisk: JSON.stringify(dl0) !== JSON.stringify(dl1) };
      rec('R4b 重命名后磁盘对比', true, R.notes.R4);
      mark('after rename');
      await step('R4c 重命名为含点号的名字', async function () {
        var x = await reload(I1); x.name = 'a.b.c v2'; await x.save();
        var y = await reload(I1); return { name: y.name, ext: y.ext };
      });
    }

    // R3 归属
    if (I2) {
      var seq = [['[A,B]', [A.id, B.id]], ['[B]', [B.id]], ['[]', []], ['[A]', [A.id]]];
      R.notes.R3 = [];
      for (var q = 0; q < seq.length; q++) {
        var lab = seq[q][0]; var val = seq[q][1];
        await step('R3 folders=' + lab, async function () {
          var x = await reload(I2); x.folders = val; await x.save();
          var y = await reload(I2);
          var inA = [], inB = [];
          try { inA = (await eagle.item.get({ folders: [A.id] })).map(function (z) { return z.id; }); } catch (e) { inA = 'err:' + errStr(e); }
          try { inB = (await eagle.item.get({ folders: [B.id] })).map(function (z) { return z.id; }); } catch (e) { inB = 'err:' + errStr(e); }
          var rr = { wanted: val, got: y.folders, inA: Array.isArray(inA) ? inA.indexOf(I2) >= 0 : inA, inB: Array.isArray(inB) ? inB.indexOf(I2) >= 0 : inB };
          R.notes.R3.push({ label: lab, result: rr });
          return rr;
        });
      }
      mark('after R3');
    }

    // F1 文件夹移动与重命名
    if (SUB && B) {
      await step('F1a folder.parent 移动 sub 到 B', async function () {
        var s = await eagle.folder.getById(SUB.id);
        var oldParent = s.parent;
        s.parent = B.id;
        await s.save();
        var s2 = await eagle.folder.getById(SUB.id);
        return { oldParent: oldParent, newParent: s2.parent, expected: B.id };
      });
      await step('F1b folder.name 重命名 A', async function () {
        var a = await eagle.folder.getById(A.id);
        a.name = '__webdav_probe_A_renamed_' + stamp;
        await a.save();
        var a2 = await eagle.folder.getById(A.id);
        return { name: a2.name };
      });
    }

    // R9 修改时间
    if (I4) {
      var m0 = libMod(); var i0 = await mod(I4); var li0 = await libInfo();
      await sleep(1100);
      await step('R9 改标签并 save', async function () {
        var x = await reload(I4); x.tags = ['webdav-probe', 'edited']; await x.save();
        return true;
      });
      await sleep(300);
      var m1 = libMod(); var i1 = await mod(I4); var li1 = await libInfo();
      var xi = await reload(I4);
      R.notes.R9 = {
        libModBefore: m0, libModAfter: m1, libModChanged: m0 !== m1, libInfoBefore: li0, libInfoAfter: li1, libInfoChanged: JSON.stringify(li0) !== JSON.stringify(li1),
        idsWithModifiedAtBefore: plain(i0), idsWithModifiedAtAfter: plain(i1),
        itemModifiedAt: xi && xi.modifiedAt, itemLastModified: xi && xi.lastModified
      };
      rec('R9 修改时间对比', true, R.notes.R9);
      mark('after R9');
    }

    // R12 replaceFile
    if (I4) {
      await step('R12 replaceFile 把 gif 条目换成 png', async function () {
        var b = await reload(I4);
        var r = await b.replaceFile(files.png);
        var a = await reload(I4);
        return { returned: plain(r), before: { ext: b.ext, name: b.name, size: b.size, filePath: b.filePath }, after: { ext: a.ext, name: a.name, size: a.size, filePath: a.filePath, fileExists: a.filePath ? fileInfo(a.filePath) : null } };
      });
    } else rec('R12 replaceFile', false, { error: 'replaceFile 不存在或没有可用条目' });

    // R8 书签
    if (ctx.bookmark && typeof eagle.item.addBookmark === 'function') {
      var bid = await step('R8 addBookmark', function () { return eagle.item.addBookmark('https://example.com/', { name: 'probe-bookmark', folders: [B.id] }); });
      var brealId = bid && typeof bid === 'object' ? bid.id : bid;
      if (brealId) { created.push(brealId); var bi = await reload(brealId); R.notes.R8 = { item: itemSummary(bi), file: bi && bi.filePath ? fileInfo(bi.filePath) : null }; rec('R8 书签条目', true, R.notes.R8); }
    }

    // R6 回收站
    if (I3) {
      var trashedId = I3;
      var tm0 = libMod();
      await step('R6a item.moveToTrash()', function () { return trash(trashedId); });
      await sleep(300);
      var gb = null, ga = null, gi = null, gm = null;
      try { gb = await eagle.item.getById(trashedId); } catch (e) { gb = 'err:' + errStr(e); }
      try { ga = (await eagle.item.get({ folders: [A.id] })).map(function (z) { return z.id; }).indexOf(trashedId) >= 0; } catch (e) { ga = 'err:' + errStr(e); }
      try { gi = (await eagle.item.get({ ids: [trashedId] })).length; } catch (e) { gi = 'err:' + errStr(e); }
      gm = await mod(trashedId);
      var cnt = null; try { cnt = await eagle.item.countAll(); } catch (e) { /* ignore */ }
      R.notes.R6 = {
        getByIdAfterTrash: gb && typeof gb === 'object' ? { id: gb.id, isDeleted: gb.isDeleted, folders: gb.folders } : gb,
        stillListedInFolderGet: ga, getByIdsGet: gi, inIdsWithModifiedAt: plain(gm), countAllAfter: cnt,
        libModBefore: tm0, libModAfter: libMod()
      };
      rec('R6 回收站可见性', true, R.notes.R6);
      mark('after trash');
    }

    // 清理
    R.cleanup = [];
    for (var c = 0; c < created.length; c++) {
      try { await trash(created[c]); R.cleanup.push({ id: created[c], ok: true }); }
      catch (e) { R.cleanup.push({ id: created[c], ok: false, error: errStr(e) }); }
    }
    R.leftoverFolders = folderIds;
    R.cleanupNote = '探针素材已尝试移入回收站，请在 Eagle 里手动删除以 __webdav_probe_ 开头的文件夹，并清空回收站中的探针素材。';
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* ignore */ }

    // 结论
    function note(k) { return R.notes[k]; }
    var V = R.verdicts;
    var r3 = R.notes.R3 || [];
    V.R3_folders可写 = r3.length ? r3.every(function (x) { return JSON.stringify((x.result.got || []).slice().sort()) === JSON.stringify(x.result.wanted.slice().sort()); }) : '未运行';
    V.R4_重命名同步磁盘文件名 = R.notes.R4 ? R.notes.R4.fileRenamedOnDisk : '未运行';
    V.R4_重命名后name = R.notes.R4 ? R.notes.R4.nameAfter : '未运行';
    V.R5_addFromPath返回ID = !!I1;
    V.R5_是否复制源文件 = R.notes['I1 png 带扩展名的 name'] ? R.notes['I1 png 带扩展名的 name'].copiedFromSource : '未知';
    V.R9_库修改时间随元数据变化 = R.notes.R9 ? R.notes.R9.libModChanged : '未运行';
    V.R6_回收站后仍在列表 = R.notes.R6 ? R.notes.R6.stillListedInFolderGet : '未运行';
    V.F1_folder_parent可写 = (R.steps.filter(function (s) { return s.name.indexOf('F1a') === 0; })[0] || {}).ok;
    R.finishedAt = new Date().toISOString();
    return R;
  }

  // ---------- 性能探针 ----------
  async function runPerfProbe(eagle, ctx) {
    ctx = ctx || {};
    var log = ctx.log || function () {};
    var P = { startedAt: new Date().toISOString(), timings: [] };
    async function timed(name, fn) {
      var t0 = nowMs();
      try {
        var v = await fn();
        var ms = Math.round(nowMs() - t0);
        var size = Array.isArray(v) ? v.length : (typeof v === 'number' ? v : undefined);
        P.timings.push({ name: name, ms: ms, size: size, rssMB: Math.round(process.memoryUsage().rss / 1048576) });
        log(name + ' ' + ms + 'ms' + (size !== undefined ? ' (' + size + ')' : ''));
        return v;
      } catch (e) {
        P.timings.push({ name: name, error: errStr(e) }); log(name + ' ✗ ' + errStr(e));
        return undefined;
      }
    }
    var total = await timed('item.countAll', function () { return eagle.item.countAll(); });
    P.total = total;
    for (var i = 0; i < 3; i++) await timed('item.getIdsWithModifiedAt #' + (i + 1), function () { return eagle.item.getIdsWithModifiedAt(); });
    var folders = await timed('folder.getAll', function () { return eagle.folder.getAll(); });
    var fields = ['id', 'name', 'ext', 'size', 'modifiedAt', 'folders', 'tags'];
    if (typeof total === 'number' && total <= 30000) {
      await timed('item.get 全库 (fields)', function () { return eagle.item.get({ fields: fields }); });
    } else {
      P.timings.push({ name: 'item.get 全库', skipped: '条目数过大，跳过' });
    }
    if (Array.isArray(folders) && folders.length) {
      var sample = folders.slice(0, 20);
      var t0 = nowMs(); var sum = 0;
      for (var f = 0; f < sample.length; f++) {
        try { var r = await eagle.item.get({ folders: [sample[f].id], fields: fields }); sum += r.length; } catch (e) { /* ignore */ }
      }
      P.timings.push({ name: '前 ' + sample.length + ' 个文件夹逐个 item.get (fields)', ms: Math.round(nowMs() - t0), size: sum });
      var one = null;
      for (var g = 0; g < folders.length; g++) { if ((folders[g].children || []).length === 0) { one = folders[g]; break; } }
      if (one) await timed('单文件夹 item.get 不限字段', function () { return eagle.item.get({ folders: [one.id] }); });
    }
    try { P.memory = plain(process.memoryUsage()); } catch (e) { /* ignore */ }
    try { if (performance.memory) P.jsHeap = plain(performance.memory); } catch (e) { /* ignore */ }
    P.finishedAt = new Date().toISOString();
    return P;
  }

  EW.collectEnv = collectEnv;
  EW.runWriteProbes = runWriteProbes;
  EW.runPerfProbe = runPerfProbe;
  EW._makePng = makePng;
})(typeof window !== 'undefined' ? window : globalThis);
