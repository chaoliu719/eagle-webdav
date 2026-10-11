/* 界面逻辑：把抓包服务与探针接到页面上。 */
(function (root) {
  'use strict';
  var EW = root.EW = root.EW || {};
  var fs = require('fs');
  var os = require('os');
  var path = require('path');
  var http = require('http');

  var LOG_DIR = path.join(os.homedir(), 'EagleWebdavProbe');
  try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch (e) { /* ignore */ }

  var $ = function (id) { return document.getElementById(id); };
  var report = { tool: 'eagle-webdav-probe', version: '0.1.0', createdAt: new Date().toISOString() };
  var server = null;
  var heartbeat = null;
  var lastRender = 0;
  var startedAt = Date.now();

  function stamp() { return new Date().toISOString(); }
  function append(file, line) { fs.appendFile(path.join(LOG_DIR, file), line + '\n', function () {}); }
  function log(msg) {
    var line = '[' + stamp().slice(11, 19) + '] ' + msg;
    var box = $('log');
    if (box) { box.value += line + '\n'; box.scrollTop = box.scrollHeight; }
    append('probe.log', '[' + stamp() + '] ' + msg);
  }
  function status(t) { var s = $('status'); if (s) s.textContent = t; }
  function save(k, v) { try { localStorage.setItem('ewprobe.' + k, v); } catch (e) { /* ignore */ } }
  function load(k, d) { try { var v = localStorage.getItem('ewprobe.' + k); return v === null ? d : v; } catch (e) { return d; } }

  function eagleObj() { return typeof eagle !== 'undefined' ? eagle : null; }

  // ---------- 抓包服务 ----------
  function renderReq(force) {
    var t = Date.now();
    if (!force && t - lastRender < 400) return;
    lastRender = t;
    if (!server) return;
    var ring = server.ring().slice(-40);
    var lines = ring.map(function (e) {
      var extra = [];
      if (e.h.depth !== undefined) extra.push('Depth:' + e.h.depth);
      if (e.h.destination) extra.push('→ ' + e.h.destination);
      if (e.h.overwrite) extra.push('Overwrite:' + e.h.overwrite);
      if (e.h['content-length']) extra.push('len:' + e.h['content-length']);
      return '#' + e.n + ' ' + e.method + ' ' + e.url + ' → ' + e.status + (extra.length ? '  ' + extra.join(' ') : '');
    });
    $('reqlog').textContent = lines.length ? lines.join('\n') : '（尚无请求）';
  }

  function selfRequest(host, port, auth) {
    return new Promise(function (resolve) {
      var h = { Depth: '0' };
      if (auth) h.Authorization = 'Basic ' + Buffer.from(auth).toString('base64');
      var req = http.request({ host: host, port: port, method: 'PROPFIND', path: '/', headers: h, timeout: 3000 }, function (res) {
        res.resume(); res.on('end', function () { resolve(host + ' → ' + res.statusCode); });
      });
      req.on('timeout', function () { req.destroy(); resolve(host + ' → 超时'); });
      req.on('error', function (e) { resolve(host + ' → 失败 ' + e.code); });
      req.end();
    });
  }

  async function startServer() {
    var host = $('host').value.trim() || '0.0.0.0';
    var port = parseInt($('port').value, 10) || 41600;
    var user = $('user').value; var pass = $('pass').value;
    save('host', host); save('port', port); save('user', user);
    server = EW.createCaptureServer({
      host: host, port: port, user: user, pass: pass,
      logFile: path.join(LOG_DIR, 'requests.jsonl'),
      onLog: function (e) { if (e.serverError) log('服务错误 ' + e.serverError); renderReq(false); }
    });
    try {
      var st = await server.start();
      $('btnStart').disabled = true; $('btnStop').disabled = false;
      var lan = EW.lanAddresses().filter(function (a) { return !a.internal; });
      var urls = ['http://127.0.0.1:' + port + '/'].concat(lan.map(function (a) { return 'http://' + a.address + ':' + port + '/'; }));
      $('urls').textContent = '已监听 ' + st.boundAddress + ':' + st.boundPort + '。可用地址：' + urls.join('  ');
      log('抓包服务已启动 ' + JSON.stringify(st));
      var auth = user || pass ? user + ':' + pass : '';
      var targets = ['127.0.0.1'].concat(lan.map(function (a) { return a.address; }));
      var res = [];
      for (var i = 0; i < targets.length; i++) res.push(await selfRequest(targets[i], port, auth));
      report.selfCheck = res;
      log('自检（本机访问自己）：' + res.join('；') + '。注意：这不能证明别的设备能连上，需要从另一台设备实际访问来验证 R1。');
    } catch (e) {
      server = null;
      log('启动失败：' + (e && e.code ? e.code + ' ' : '') + (e && e.message || e));
      $('urls').textContent = '启动失败：' + (e && e.message || e);
    }
  }

  async function stopServer() {
    if (!server) return;
    report.captureSummary = captureSummary();
    await server.stop();
    server = null;
    $('btnStart').disabled = false; $('btnStop').disabled = true;
    log('抓包服务已停止');
  }

  function captureSummary() {
    if (!server) return report.captureSummary || null;
    var ring = server.ring();
    var byMethod = {}; var agents = {};
    ring.forEach(function (e) {
      byMethod[e.method + ' ' + e.status] = (byMethod[e.method + ' ' + e.status] || 0) + 1;
      var ua = e.h['user-agent'] || '(无)'; agents[ua] = (agents[ua] || 0) + 1;
    });
    return { state: server.state(), byMethod: byMethod, userAgents: agents, lastRequests: ring.slice(-300) };
  }

  // ---------- 心跳（R2） ----------
  function startHeartbeat() {
    if (heartbeat) return;
    heartbeat = setInterval(function () {
      var st = server ? server.state() : null;
      var vis = ''; try { vis = document.visibilityState; } catch (e) { /* ignore */ }
      append('heartbeat.log', JSON.stringify({ t: stamp(), upSec: Math.round((Date.now() - startedAt) / 1000), visible: vis, server: st, rssMB: Math.round(process.memoryUsage().rss / 1048576) }));
    }, 30000);
    append('heartbeat.log', JSON.stringify({ t: stamp(), event: 'plugin loaded' }));
  }

  // ---------- 报告 ----------
  function buildReport() {
    report.exportedAt = stamp();
    report.captureSummary = captureSummary();
    return JSON.stringify(report, null, 2);
  }
  function exportReport() {
    var text = buildReport();
    var file = path.join(LOG_DIR, 'report-' + stamp().replace(/[:.]/g, '-') + '.json');
    try { fs.writeFileSync(file, text); $('reportPath').textContent = '已保存到 ' + file; log('报告已保存 ' + file); }
    catch (e) { $('reportPath').textContent = '保存失败：' + e.message; }
    $('reportBox').value = text;
    return text;
  }
  function copyReport() {
    var text = $('reportBox').value || exportReport();
    var ok = false;
    try { navigator.clipboard.writeText(text).then(function () { log('已复制到剪贴板'); }, fallbackCopy); ok = true; } catch (e) { /* ignore */ }
    if (!ok) fallbackCopy();
    function fallbackCopy() { var b = $('reportBox'); b.select(); try { document.execCommand('copy'); log('已复制到剪贴板'); } catch (e) { log('复制失败，请手动选中文本框内容'); } }
  }

  // ---------- 按钮 ----------
  async function busy(btn, fn) {
    btn.disabled = true;
    try { await fn(); } catch (e) { log('出错：' + (e && e.stack || e)); }
    btn.disabled = false;
  }

  function wire() {
    $('host').value = load('host', '0.0.0.0');
    $('port').value = load('port', '41600');
    $('user').value = load('user', '');

    $('btnEnv').onclick = function () {
      busy($('btnEnv'), async function () {
        var e = eagleObj(); if (!e) return log('找不到 eagle 对象');
        report.env = await EW.collectEnv(e);
        log('环境信息：Node ' + report.env.node + '，Eagle ' + JSON.stringify({ v: report.env.app.version, build: report.env.app.build }) + '，条目 ' + report.env.itemCountAll);
      });
    };
    $('btnStart').onclick = startServer;
    $('btnStop').onclick = stopServer;
    $('ack').onchange = function () { $('btnWrite').disabled = !$('ack').checked; };
    $('btnWrite').onclick = function () {
      busy($('btnWrite'), async function () {
        var e = eagleObj(); if (!e) return log('找不到 eagle 对象');
        log('开始写入探针，库：' + (e.library && e.library.path));
        report.write = await EW.runWriteProbes(e, {
          log: log, bigMB: parseInt($('bigmb').value, 10) || 0, bookmark: $('bookmark').checked, dupTest: $('dup').checked
        });
        log('写入探针完成。结论：' + JSON.stringify(report.write.verdicts));
        exportReport();
      });
      $('btnWrite').disabled = !$('ack').checked;
    };
    $('btnPerf').onclick = function () {
      busy($('btnPerf'), async function () {
        var e = eagleObj(); if (!e) return log('找不到 eagle 对象');
        report.perf = await EW.runPerfProbe(e, { log: log });
        log('性能探针完成');
      });
    };
    $('btnExport').onclick = exportReport;
    $('btnCopy').onclick = copyReport;
  }

  // ---------- Eagle 钩子 ----------
  function hooks() {
    var e = eagleObj(); if (!e) return;
    try {
      e.onPluginCreate && e.onPluginCreate(function (plugin) {
        log('onPluginCreate');
        report.pluginCreate = { manifestVersion: plugin && plugin.manifest && plugin.manifest.version, path: plugin && plugin.path };
        try { e.window && e.window.show && e.window.show(); } catch (x) { /* ignore */ }
      });
    } catch (x) { /* ignore */ }
    try { e.onPluginRun && e.onPluginRun(function () { log('onPluginRun'); }); } catch (x) { /* ignore */ }
    try { e.onPluginShow && e.onPluginShow(function () { append('heartbeat.log', JSON.stringify({ t: stamp(), event: 'show' })); }); } catch (x) { /* ignore */ }
    try { e.onPluginHide && e.onPluginHide(function () { append('heartbeat.log', JSON.stringify({ t: stamp(), event: 'hide' })); }); } catch (x) { /* ignore */ }
    try {
      e.onPluginBeforeExit && e.onPluginBeforeExit(function () {
        append('heartbeat.log', JSON.stringify({ t: stamp(), event: 'beforeExit' }));
        if (server) server.stop();
      });
    } catch (x) { /* ignore */ }
    try { e.onLibraryChanged && e.onLibraryChanged(function (p) { log('onLibraryChanged ' + p); report.libraryChanged = (report.libraryChanged || []).concat([{ t: stamp(), path: p }]); }); } catch (x) { /* ignore */ }
  }

  function init() {
    wire();
    hooks();
    startHeartbeat();
    status('就绪。日志目录：' + LOG_DIR);
    log('探针已加载，日志目录 ' + LOG_DIR);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
  EW._plugin = { buildReport: buildReport, startServer: startServer, stopServer: stopServer, report: report };
})(typeof window !== 'undefined' ? window : globalThis);
