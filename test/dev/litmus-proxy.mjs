// litmus 专用代理：给没有扩展名的末段补 .dat（本服务对无扩展名文件返回 415），响应里再抹掉
import http from 'node:http';
const [,, listen, target] = process.argv;
const EXT = '.dat';
const fwd = (p) => p.replace(/(\/)([^/?]*)$/, (m, s, last) => (last === '' || last.includes('.') ? m : s + last + EXT)).replace(/([^/.]+)(\/)$/, (m, a, s) => (m.includes('.') ? m : a + EXT + s));
const fixPath = (p) => {
  const q = p.indexOf('?'); const path = q < 0 ? p : p.slice(0, q); const rest = q < 0 ? '' : p.slice(q);
  return path.split('/').map((seg, i, a) => (seg === '' || seg.includes('.') || seg.includes('%2e') ? seg : seg + EXT)).join('/') + rest;
};
const fixUrls = (s) => s.replace(/(https?:\/\/)([^\/\s>]+)(\/[^\s>]*)/g, (m, sch, host, p) => sch + target + fixPath(p));
const strip = (s) => s.split(EXT).join('');
http.createServer((req, res) => {
  const headers = { ...req.headers, host: target };
  if (headers.destination) headers.destination = headers.destination.startsWith('/') ? fixPath(headers.destination) : fixUrls(headers.destination);
  if (headers.if) headers.if = fixUrls(headers.if);
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    let body = Buffer.concat(chunks);
    if (body.length) headers['content-length'] = String(body.length);
    const p = http.request({ host: target.split(':')[0], port: Number(target.split(':')[1]), method: req.method, path: fixPath(req.url), headers }, (r) => {
      const out = [];
      r.on('data', (c) => out.push(c));
      r.on('end', () => {
        let b = Buffer.concat(out);
        const h = { ...r.headers }; delete h['transfer-encoding']; h['content-length'] = String(b.length);
        if (/xml|text|html/.test(h['content-type'] || '')) { b = Buffer.from(strip(b.toString('utf8'))); h['content-length'] = String(b.length); }
        if (h.location) h.location = strip(h.location);
        res.writeHead(r.statusCode, h); res.end(b);
      });
    });
    p.end(body);
  });
}).listen(Number(listen), () => console.log('proxy', listen));
