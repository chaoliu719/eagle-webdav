/* 抓包用 WebDAV 服务：纯内存，不碰 Eagle 数据。
 * 目的：观察 Finder / Infuse / rclone 等客户端的真实请求序列，验证监听与保活（R1、R2、R7、R13）。
 * 兼容 Node 16，经典脚本，挂在 window.EW 上。 */
(function (root) {
  'use strict';
  var EW = root.EW = root.EW || {};
  var http = require('http');
  var fs = require('fs');
  var crypto = require('crypto');
  var os = require('os');

  var MAX_PUT = 64 * 1024 * 1024;
  var MAX_BODY = 1024 * 1024;
  var RING = 500;

  var MIME = {
    txt: 'text/plain; charset=utf-8', html: 'text/html; charset=utf-8', json: 'application/json',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
    svg: 'image/svg+xml', pdf: 'application/pdf', mp4: 'video/mp4', mov: 'video/quicktime',
    mkv: 'video/x-matroska', mp3: 'audio/mpeg', zip: 'application/zip'
  };

  function lanAddresses() {
    var out = [];
    try {
      var ifs = os.networkInterfaces();
      Object.keys(ifs).forEach(function (name) {
        (ifs[name] || []).forEach(function (a) {
          if (a.family === 'IPv4' || a.family === 4) out.push({ name: name, address: a.address, internal: !!a.internal });
        });
      });
    } catch (e) { /* ignore */ }
    return out;
  }

  function escXml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function parsePath(raw) {
    var p = String(raw || '');
    var q = p.indexOf('?'); if (q >= 0) p = p.slice(0, q);
    var h = p.indexOf('#'); if (h >= 0) p = p.slice(0, h);
    if (/^https?:\/\//i.test(p)) {
      var m = /^https?:\/\/[^\/]*(\/.*)?$/i.exec(p);
      p = (m && m[1]) || '/';
    }
    if (p.charAt(0) !== '/') return null;
    var segs = p.split('/');
    var out = [];
    var nfd = false;
    for (var i = 1; i < segs.length; i++) {
      var s = segs[i];
      if (s === '') continue;
      try { s = decodeURIComponent(s); } catch (e) { return null; }
      if (s === '.' || s === '..' || s.indexOf('/') >= 0 || s.indexOf('\0') >= 0) return null;
      var n = s.normalize('NFC');
      if (n !== s) nfd = true;
      out.push(n);
    }
    return { key: out.length ? '/' + out.join('/') : '/', segs: out, trailing: /\/$/.test(p), nfd: nfd };
  }

  function parentOf(key) {
    if (key === '/') return null;
    var i = key.lastIndexOf('/');
    return i <= 0 ? '/' : key.slice(0, i);
  }

  function hrefOf(key, isDir) {
    if (key === '/') return '/';
    var h = key.split('/').slice(1).map(encodeURIComponent).join('/');
    return '/' + h + (isDir ? '/' : '');
  }

  function rfc1123(d) { return new Date(d).toUTCString(); }
  function iso(d) { return new Date(d).toISOString().replace(/\.\d{3}Z$/, 'Z'); }

  function mimeOf(name) {
    var m = /\.([A-Za-z0-9]+)$/.exec(name);
    return (m && MIME[m[1].toLowerCase()]) || 'application/octet-stream';
  }

  // 从 XML 文本里取出 prop 里的元素，返回 [{ns, name, prefix}]
  function nsMap(xml) {
    var map = {};
    var re = /xmlns(?::([A-Za-z0-9_.-]+))?\s*=\s*"([^"]*)"/g;
    var m;
    while ((m = re.exec(xml))) map[m[1] || ''] = m[2];
    return map;
  }
  function propNames(fragment, map) {
    var res = [];
    var re = /<(?:([A-Za-z0-9_.-]+):)?([A-Za-z0-9_.-]+)(\s[^>]*)?\/?>/g;
    var m;
    while ((m = re.exec(fragment))) {
      var prefix = m[1] || '';
      var local = m[2];
      var attrs = m[3] || '';
      var own = nsMap(attrs);
      var ns = own.hasOwnProperty(prefix) ? own[prefix] : map[prefix];
      res.push({ ns: ns === undefined ? null : ns, name: local, prefix: prefix });
    }
    return res;
  }

  function createCaptureServer(opts) {
    opts = opts || {};
    var host = opts.host || '0.0.0.0';
    var port = opts.port || 41600;
    var user = opts.user || '';
    var pass = opts.pass || '';
    var onLog = opts.onLog || function () {};
    var logFile = opts.logFile || null;

    var nodes = new Map();
    var locks = new Map();
    var ring = [];
    var sockets = new Set();
    var counter = 0;
    var pending = 0;
    var server6 = null;
    var server = null;

    function now() { return Date.now(); }
    function mk(type, data) {
      var t = now();
      return { type: type, data: data || Buffer.alloc(0), ctime: t, mtime: t };
    }
    nodes.set('/', mk('dir'));
    if (opts.seed !== false) {
      nodes.set('/示例', mk('dir'));
      nodes.set('/readme.txt', mk('file', Buffer.from('Eagle WebDAV 抓包服务\n', 'utf8')));
    }

    function etagOf(n) { return '"' + n.mtime.toString(16) + '-' + n.data.length.toString(16) + '"'; }
    function childrenOf(key) {
      var prefix = key === '/' ? '/' : key + '/';
      var out = [];
      nodes.forEach(function (n, k) {
        if (k === key || k.indexOf(prefix) !== 0) return;
        if (k.indexOf('/', prefix.length) >= 0) return;
        out.push(k);
      });
      out.sort();
      return out;
    }
    function removeTree(key) {
      var prefix = key + '/';
      Array.from(nodes.keys()).forEach(function (k) {
        if (k === key || k.indexOf(prefix) === 0) nodes.delete(k);
      });
    }
    function copyTree(src, dst, deep) {
      var prefix = src + '/';
      var n = nodes.get(src);
      nodes.set(dst, { type: n.type, data: n.data, ctime: now(), mtime: now() });
      if (n.type === 'dir' && deep) {
        Array.from(nodes.keys()).forEach(function (k) {
          if (k.indexOf(prefix) === 0) {
            var m = nodes.get(k);
            nodes.set(dst + k.slice(src.length), { type: m.type, data: m.data, ctime: now(), mtime: now() });
          }
        });
      }
    }

    function send(res, status, headers, body) {
      var h = Object.assign({ 'Server': 'EagleWebdavProbe/0.1' }, headers || {});
      var b = body == null ? Buffer.alloc(0) : (Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8'));
      if (res.req && res.req.method === 'HEAD') {
        h['Content-Length'] = h['Content-Length'] != null ? h['Content-Length'] : b.length;
        res.writeHead(status, h); res.end();
      } else {
        h['Content-Length'] = b.length;
        res.writeHead(status, h); res.end(b);
      }
    }
    function xmlHead() { return '<?xml version="1.0" encoding="utf-8"?>\n'; }
    function sendXml(res, status, xml, extra) {
      send(res, status, Object.assign({ 'Content-Type': 'text/xml; charset=utf-8' }, extra || {}), xmlHead() + xml);
    }

    function checkAuth(req) {
      if (!user && !pass) return true;
      var a = req.headers['authorization'] || '';
      var m = /^Basic\s+(.+)$/i.exec(a);
      if (!m) return false;
      var s = Buffer.from(m[1], 'base64').toString('utf8');
      var i = s.indexOf(':');
      var u = i < 0 ? s : s.slice(0, i);
      var p = i < 0 ? '' : s.slice(i + 1);
      return u === user && p === pass;
    }

    function readBody(req, limit) {
      return new Promise(function (resolve, reject) {
        var chunks = []; var len = 0; var over = false;
        req.on('data', function (c) {
          len += c.length;
          if (len > limit) { over = true; return; }
          chunks.push(c);
        });
        req.on('end', function () { if (over) { var e = new Error('too large'); e.code = 'TOO_LARGE'; reject(e); } else resolve(Buffer.concat(chunks)); });
        req.on('error', reject);
      });
    }

    function statusOfLock(key) {
      var out = [];
      var t = now();
      locks.forEach(function (l, tok) {
        if (l.expires < t) { locks.delete(tok); return; }
        if (l.path === key) out.push([tok, l]);
      });
      return out;
    }
    function lockXml(tok, l) {
      return '<D:activelock><D:locktype><D:write/></D:locktype><D:lockscope><D:' + l.scope + '/></D:lockscope>' +
        '<D:depth>' + (l.depth || 'infinity') + '</D:depth>' +
        (l.owner ? '<D:owner>' + l.owner + '</D:owner>' : '') +
        '<D:timeout>Second-' + l.timeout + '</D:timeout>' +
        '<D:locktoken><D:href>opaquelocktoken:' + tok + '</D:href></D:locktoken>' +
        '<D:lockroot><D:href>' + escXml(hrefOf(l.path, false)) + '</D:href></D:lockroot></D:activelock>';
    }

    var KNOWN = ['resourcetype', 'getcontentlength', 'getcontenttype', 'getlastmodified', 'creationdate',
      'getetag', 'displayname', 'supportedlock', 'lockdiscovery', 'quota-available-bytes', 'quota-used-bytes'];

    function propValue(name, key, n) {
      var isDir = n.type === 'dir';
      switch (name) {
        case 'resourcetype': return isDir ? '<D:resourcetype><D:collection/></D:resourcetype>' : '<D:resourcetype/>';
        case 'getcontentlength': return isDir ? null : '<D:getcontentlength>' + n.data.length + '</D:getcontentlength>';
        case 'getcontenttype': return '<D:getcontenttype>' + (isDir ? 'httpd/unix-directory' : escXml(mimeOf(key))) + '</D:getcontenttype>';
        case 'getlastmodified': return '<D:getlastmodified>' + rfc1123(n.mtime) + '</D:getlastmodified>';
        case 'creationdate': return '<D:creationdate>' + iso(n.ctime) + '</D:creationdate>';
        case 'getetag': return isDir ? null : '<D:getetag>' + escXml(etagOf(n)) + '</D:getetag>';
        case 'displayname': return '<D:displayname>' + escXml(key === '/' ? '' : key.slice(key.lastIndexOf('/') + 1)) + '</D:displayname>';
        case 'supportedlock': return '<D:supportedlock><D:lockentry><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockentry>' +
          '<D:lockentry><D:lockscope><D:shared/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockentry></D:supportedlock>';
        case 'lockdiscovery': return '<D:lockdiscovery>' + statusOfLock(key).map(function (p) { return lockXml(p[0], p[1]); }).join('') + '</D:lockdiscovery>';
      }
      return null;
    }

    function responseXml(key, n, mode, wanted) {
      var isDir = n.type === 'dir';
      var ok = []; var missing = [];
      if (mode === 'propname') {
        KNOWN.forEach(function (k) { if (propValue(k, key, n) !== null) ok.push('<D:' + k + '/>'); });
      } else if (mode === 'allprop') {
        KNOWN.forEach(function (k) {
          if (k === 'quota-available-bytes' || k === 'quota-used-bytes') return;
          var v = propValue(k, key, n); if (v !== null) ok.push(v);
        });
      } else {
        wanted.forEach(function (w) {
          var v = w.ns === 'DAV:' ? propValue(w.name, key, n) : null;
          if (v !== null) ok.push(v);
          else if (w.ns && w.ns !== 'DAV:') missing.push('<ns0:' + w.name + ' xmlns:ns0="' + escXml(w.ns) + '"/>');
          else if (w.ns === 'DAV:') missing.push('<D:' + w.name + '/>');
          else missing.push('<' + (w.prefix ? w.prefix + ':' : '') + w.name + '/>');
        });
      }
      var x = '<D:response><D:href>' + escXml(hrefOf(key, isDir)) + '</D:href>';
      if (ok.length) x += '<D:propstat><D:prop>' + ok.join('') + '</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>';
      if (missing.length) x += '<D:propstat><D:prop>' + missing.join('') + '</D:prop><D:status>HTTP/1.1 404 Not Found</D:status></D:propstat>';
      if (!ok.length && !missing.length) x += '<D:propstat><D:prop/><D:status>HTTP/1.1 200 OK</D:status></D:propstat>';
      return x + '</D:response>';
    }

    var ALLOW = 'OPTIONS, GET, HEAD, PUT, DELETE, MKCOL, COPY, MOVE, PROPFIND, PROPPATCH, LOCK, UNLOCK';

    async function dispatch(req, res, p, info) {
      var method = req.method;
      var key = p.key;
      var node = nodes.get(key);
      var h = req.headers;

      if (method === 'OPTIONS') {
        var allow = !node ? 'OPTIONS, LOCK, PUT, MKCOL'
          : node.type === 'dir' ? 'OPTIONS, LOCK, DELETE, PROPPATCH, COPY, MOVE, UNLOCK, PROPFIND'
          : 'OPTIONS, LOCK, GET, HEAD, POST, DELETE, PROPPATCH, COPY, MOVE, UNLOCK, PROPFIND, PUT';
        return send(res, 200, { 'DAV': '1, 2', 'Allow': allow, 'MS-Author-Via': 'DAV' });
      }

      if (method === 'PROPFIND') {
        var body = (await readBody(req, MAX_BODY)).toString('utf8');
        info.bodyHead = body.slice(0, 600);
        if (/<!DOCTYPE/i.test(body) || /<!ENTITY/i.test(body)) return send(res, 400, {}, 'DOCTYPE not allowed');
        var depth = h['depth'];
        if (depth === undefined || depth === 'infinity') {
          return sendXml(res, 403, '<D:error xmlns:D="DAV:"><D:propfind-finite-depth/></D:error>');
        }
        if (!node) return send(res, 404);
        var mode = 'allprop'; var wanted = [];
        if (body.trim()) {
          if (/<(?:[A-Za-z0-9_.-]+:)?propname[\s\/>]/.test(body)) mode = 'propname';
          else if (/<(?:[A-Za-z0-9_.-]+:)?prop[\s>]/.test(body)) {
            mode = 'prop';
            var pm = /<(?:[A-Za-z0-9_.-]+:)?prop(?:\s[^>]*)?>([\s\S]*?)<\/(?:[A-Za-z0-9_.-]+:)?prop>/.exec(body);
            wanted = pm ? propNames(pm[1], nsMap(body)) : [];
          } else if (/<(?:[A-Za-z0-9_.-]+:)?prop\s*\/>/.test(body)) mode = 'prop';
        }
        var parts = [responseXml(key, node, mode, wanted)];
        if (depth === '1' && node.type === 'dir') {
          childrenOf(key).forEach(function (c) { parts.push(responseXml(c, nodes.get(c), mode, wanted)); });
        }
        return sendXml(res, 207, '<D:multistatus xmlns:D="DAV:">' + parts.join('') + '</D:multistatus>');
      }

      if (method === 'GET' || method === 'HEAD') {
        if (!node) return send(res, 404, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Not Found');
        if (node.type === 'dir') {
          var li = childrenOf(key).map(function (c) {
            var d = nodes.get(c).type === 'dir';
            var nm = c.slice(c.lastIndexOf('/') + 1) + (d ? '/' : '');
            return '<li><a href="' + escXml(hrefOf(c, d)) + '">' + escXml(nm) + '</a></li>';
          }).join('');
          return send(res, 200, { 'Content-Type': 'text/html; charset=utf-8' },
            '<!DOCTYPE html><meta charset="utf-8"><title>' + escXml(key) + '</title><h3>' + escXml(key) + '</h3><ul>' + li + '</ul>');
        }
        var data = node.data; var total = data.length;
        var base = { 'Content-Type': mimeOf(key), 'ETag': etagOf(node), 'Last-Modified': rfc1123(node.mtime), 'Accept-Ranges': 'bytes' };
        var rg = h['range'];
        if (rg) {
          var m = /^bytes=(\d*)-(\d*)$/.exec(rg.trim());
          if (m && (m[1] || m[2])) {
            var s, e;
            if (m[1] === '') { s = Math.max(0, total - parseInt(m[2], 10)); e = total - 1; }
            else { s = parseInt(m[1], 10); e = m[2] === '' ? total - 1 : Math.min(parseInt(m[2], 10), total - 1); }
            if (s >= total || s > e) return send(res, 416, { 'Content-Range': 'bytes */' + total });
            return send(res, 206, Object.assign(base, { 'Content-Range': 'bytes ' + s + '-' + e + '/' + total }), data.slice(s, e + 1));
          }
        }
        return send(res, 200, base, data);
      }

      if (method === 'PUT') {
        if (node && node.type === 'dir') { req.resume(); return send(res, 405); }
        var par = parentOf(key);
        if (!par || !nodes.has(par) || nodes.get(par).type !== 'dir') { req.resume(); return send(res, 409); }
        var buf;
        try { buf = await readBody(req, MAX_PUT); }
        catch (e) { if (e.code === 'TOO_LARGE') return send(res, 413, { 'Connection': 'close' }); throw e; }
        var existed = !!node;
        var nn = mk('file', buf);
        if (existed) nn.ctime = node.ctime;
        nodes.set(key, nn);
        info.bodyLen = buf.length;
        return send(res, existed ? 204 : 201, { 'ETag': etagOf(nn) });
      }

      if (method === 'MKCOL') {
        var mb = await readBody(req, MAX_BODY);
        if (mb.length) return send(res, 415);
        if (node) return send(res, 405);
        var mp = parentOf(key);
        if (!mp || !nodes.has(mp) || nodes.get(mp).type !== 'dir') return send(res, 409);
        nodes.set(key, mk('dir'));
        return send(res, 201);
      }

      if (method === 'DELETE') {
        await readBody(req, MAX_BODY);
        if (!node) return send(res, 404);
        if (key === '/') return send(res, 403);
        removeTree(key); nodes.delete(key);
        return send(res, 204);
      }

      if (method === 'MOVE' || method === 'COPY') {
        await readBody(req, MAX_BODY);
        if (!node) return send(res, 404);
        var dest = h['destination'];
        if (!dest) return send(res, 400, {}, 'Missing Destination');
        var dm = /^https?:\/\/([^\/]*)/i.exec(dest);
        if (dm && h['host'] && dm[1].toLowerCase() !== h['host'].toLowerCase()) return send(res, 502);
        var dp = parsePath(dest);
        if (!dp) return send(res, 400);
        var dk = dp.key;
        if (key === '/' || dk === '/' || dk === key) return send(res, 403);
        if (node.type === 'dir' && dk.indexOf(key + '/') === 0) return send(res, 403);
        var dpar = parentOf(dk);
        if (!nodes.has(dpar) || nodes.get(dpar).type !== 'dir') return send(res, 409);
        var ow = (h['overwrite'] || 'T').toUpperCase();
        var dex = nodes.has(dk);
        if (dex && ow === 'F') return send(res, 412);
        if (dex) { removeTree(dk); nodes.delete(dk); }
        if (method === 'COPY') {
          copyTree(key, dk, (h['depth'] || 'infinity') !== '0');
        } else {
          copyTree(key, dk, true);
          removeTree(key); nodes.delete(key);
        }
        return send(res, dex ? 204 : 201);
      }

      if (method === 'PROPPATCH') {
        var pb = (await readBody(req, MAX_BODY)).toString('utf8');
        info.bodyHead = pb.slice(0, 600);
        if (/<!DOCTYPE/i.test(pb)) return send(res, 400);
        if (!node) return send(res, 404);
        var map = nsMap(pb);
        var names = [];
        var re = /<(?:[A-Za-z0-9_.-]+:)?(?:set|remove)(?:\s[^>]*)?>([\s\S]*?)<\/(?:[A-Za-z0-9_.-]+:)?(?:set|remove)>/g;
        var mm;
        while ((mm = re.exec(pb))) {
          var pm2 = /<(?:[A-Za-z0-9_.-]+:)?prop(?:\s[^>]*)?>([\s\S]*?)<\/(?:[A-Za-z0-9_.-]+:)?prop>/.exec(mm[1]);
          if (pm2) names = names.concat(propNames(pm2[1].replace(/>[^<]*<\/[^>]+>/g, '/>'), map));
        }
        var px = names.map(function (w) {
          return w.ns && w.ns !== 'DAV:' ? '<ns0:' + w.name + ' xmlns:ns0="' + escXml(w.ns) + '"/>' : '<D:' + w.name + '/>';
        }).join('');
        return sendXml(res, 207, '<D:multistatus xmlns:D="DAV:"><D:response><D:href>' + escXml(hrefOf(key, node.type === 'dir')) + '</D:href>' +
          '<D:propstat><D:prop>' + px + '</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response></D:multistatus>');
      }

      if (method === 'LOCK') {
        var lb = (await readBody(req, MAX_BODY)).toString('utf8');
        info.bodyHead = lb.slice(0, 600);
        var to = 600;
        var tm = /Second-(\d+)/i.exec(h['timeout'] || '');
        if (tm) to = Math.min(parseInt(tm[1], 10), 3600);
        var ifh = h['if'] || '';
        var tokm = /opaquelocktoken:([0-9a-f-]+)/i.exec(ifh);
        if (!lb.trim()) {
          // 刷新
          var lk = tokm && locks.get(tokm[1]);
          if (!lk) return send(res, 412);
          lk.timeout = to; lk.expires = now() + to * 1000;
          return sendXml(res, 200, '<D:prop xmlns:D="DAV:"><D:lockdiscovery>' + lockXml(tokm[1], lk) + '</D:lockdiscovery></D:prop>');
        }
        if (/<!DOCTYPE/i.test(lb)) return send(res, 400);
        var created = false;
        if (!node) {
          var lpar = parentOf(key);
          if (!lpar || !nodes.has(lpar)) return send(res, 409);
          nodes.set(key, mk('file')); created = true;
        }
        var scope = /<(?:[A-Za-z0-9_.-]+:)?shared[\s\/>]/.test(lb) ? 'shared' : 'exclusive';
        var om = /<(?:[A-Za-z0-9_.-]+:)?owner(?:\s[^>]*)?>([\s\S]*?)<\/(?:[A-Za-z0-9_.-]+:)?owner>/.exec(lb);
        var tok = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
        var l = { path: key, scope: scope, owner: om ? om[1] : '', timeout: to, depth: h['depth'] === '0' ? '0' : 'infinity', expires: now() + to * 1000 };
        locks.set(tok, l);
        return sendXml(res, created ? 201 : 200,
          '<D:prop xmlns:D="DAV:"><D:lockdiscovery>' + lockXml(tok, l) + '</D:lockdiscovery></D:prop>',
          { 'Lock-Token': '<opaquelocktoken:' + tok + '>' });
      }

      if (method === 'UNLOCK') {
        await readBody(req, MAX_BODY);
        var um = /opaquelocktoken:([0-9a-f-]+)/i.exec(h['lock-token'] || '');
        if (um && locks.has(um[1])) { locks.delete(um[1]); return send(res, 204); }
        return send(res, 409);
      }

      req.resume();
      return send(res, 405, { 'Allow': ALLOW });
    }

    function handle(req, res, viaContinue) {
      var t0 = now();
      var id = ++counter;
      var info = { bodyHead: '', bodyLen: null };
      var p = parsePath(req.url);

      var finished = false;
      pending++;
      if (logFile) {
        fs.appendFile(logFile, JSON.stringify({ type: 'start', n: id, t: new Date(t0).toISOString(), ip: req.socket && req.socket.remoteAddress, method: req.method, url: req.url,
          h: { depth: req.headers['depth'], 'content-length': req.headers['content-length'], expect: req.headers['expect'], 'user-agent': req.headers['user-agent'] } }) + '\n', function () {});
      }
      function record(st) {
        var hd = req.headers;
        var entry = {
          n: id, t: new Date(t0).toISOString(), ms: now() - t0,
          ip: req.socket && req.socket.remoteAddress,
          method: req.method, url: req.url, status: st,
          nfdPath: !!(p && p.nfd),
          h: {
            depth: hd['depth'], destination: hd['destination'], overwrite: hd['overwrite'], 'if': hd['if'],
            'lock-token': hd['lock-token'], timeout: hd['timeout'], 'content-length': hd['content-length'],
            'transfer-encoding': hd['transfer-encoding'], expect: hd['expect'], range: hd['range'],
            'user-agent': hd['user-agent'], 'content-type': hd['content-type'],
            'x-expected-entity-length': hd['x-expected-entity-length'], 'if-match': hd['if-match'],
            'if-none-match': hd['if-none-match'], 'content-range': hd['content-range'],
            authorization: hd['authorization'] ? String(hd['authorization']).split(' ')[0] : undefined
          },
          bodyLen: info.bodyLen, bodyHead: info.bodyHead || undefined
        };
        Object.keys(entry.h).forEach(function (k) { if (entry.h[k] === undefined) delete entry.h[k]; });
        ring.push(entry); if (ring.length > RING) ring.shift();
        try { onLog(entry); } catch (e) { /* ignore */ }
        if (logFile) fs.appendFile(logFile, JSON.stringify(entry) + '\n', function () {});
      }
      res.on('finish', function () { finished = true; pending--; record(res.statusCode); });
      res.on('close', function () { if (!finished) { finished = true; pending--; record('aborted'); } });

      if (!checkAuth(req)) {
        return send(res, 401, { 'WWW-Authenticate': 'Basic realm="Eagle WebDAV Probe", charset="UTF-8"', 'Connection': 'close' }, 'Unauthorized');
      }
      if (viaContinue) res.writeContinue();
      if (!p) { req.resume(); return send(res, 400, {}, 'Bad path'); }

      dispatch(req, res, p, info).catch(function (err) {
        try {
          if (!res.headersSent) send(res, 500, { 'Content-Type': 'text/plain; charset=utf-8' }, String(err && err.message || err));
          else res.end();
        } catch (e) { /* ignore */ }
      });
    }

    function start() {
      return new Promise(function (resolve, reject) {
        if (server) return resolve(state());
        var s = http.createServer(function (req, res) { handle(req, res, false); });
        s.on('checkContinue', function (req, res) { handle(req, res, true); });
        s.on('connection', function (sock) { sockets.add(sock); sock.on('close', function () { sockets.delete(sock); }); });
        s.on('clientError', function (err, sock) { try { sock.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch (e) { /* ignore */ } });
        try { s.requestTimeout = 0; s.keepAliveTimeout = 0; } catch (e) { /* ignore */ }
        s.once('error', function (err) { server = null; reject(err); });
        s.listen(port, host, function () {
          server = s;
          if (host === '0.0.0.0' && opts.dualStack !== false) {
            try {
              var s6 = http.createServer(function (rq, rs) { handle(rq, rs, false); });
              s6.on('checkContinue', function (rq, rs) { handle(rq, rs, true); });
              s6.on('connection', function (sock) { sockets.add(sock); sock.on('close', function () { sockets.delete(sock); }); });
              s6.on('clientError', function (err, sock) { try { sock.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch (e) { /* ignore */ } });
              try { s6.requestTimeout = 0; s6.keepAliveTimeout = 0; } catch (e) { /* ignore */ }
              s6.on('error', function (err) { try { onLog({ t: new Date().toISOString(), serverError: 'ipv6: ' + (err && err.message) }); } catch (e) { /* ignore */ } server6 = null; });
              s6.listen({ port: port, host: '::', ipv6Only: true }, function () { server6 = s6; });
            } catch (e) { /* ignore */ }
          }
          s.removeAllListeners('error');
          s.on('error', function (err) { try { onLog({ t: new Date().toISOString(), serverError: String(err && err.message || err) }); } catch (e) { /* ignore */ } });
          resolve(state());
        });
      });
    }

    function stop() {
      return new Promise(function (resolve) {
        if (!server) return resolve();
        var s = server; server = null;
        if (server6) { try { server6.close(); } catch (e) { /* ignore */ } server6 = null; }
        s.close(function () { resolve(); });
        sockets.forEach(function (sk) { try { sk.destroy(); } catch (e) { /* ignore */ } });
      });
    }

    function state() {
      var addr = server && server.address && server.address();
      return {
        listening: !!(server && server.listening), host: host, port: port,
        boundAddress: addr && addr.address, boundPort: addr && addr.port,
        requests: counter, pending: pending, ipv6: !!server6, sockets: sockets.size, nodes: nodes.size, locks: locks.size
      };
    }

    return { start: start, stop: stop, state: state, ring: function () { return ring.slice(); } };
  }

  EW.createCaptureServer = createCaptureServer;
  EW.lanAddresses = lanAddresses;
  EW._dav = { parsePath: parsePath };
})(typeof window !== 'undefined' ? window : globalThis);
