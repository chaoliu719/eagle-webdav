import type * as http from 'http';

export const SERVER_NAME = 'EagleWebdav/0.1';

export function send(res: http.ServerResponse, status: number, headers: http.OutgoingHttpHeaders = {}, body = ''): void {
  const buf = Buffer.from(body, 'utf8');
  const h: http.OutgoingHttpHeaders = { Server: SERVER_NAME, ...headers, 'Content-Length': buf.length };
  if (body && !h['Content-Type']) h['Content-Type'] = 'text/plain; charset=utf-8';
  res.writeHead(status, h);
  res.end(res.req.method === 'HEAD' ? undefined : buf);
}

/** 与 Go net/http webdav 一致：text/xml; charset=utf-8。 */
export function sendXml(res: http.ServerResponse, status: number, xml: string, extra: http.OutgoingHttpHeaders = {}): void {
  send(res, status, { 'Content-Type': 'text/xml; charset=utf-8', ...extra }, '<?xml version="1.0" encoding="utf-8"?>\n' + xml);
}

export function readBody(req: http.IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let len = 0;
    let over = false;
    req.on('data', (c: Buffer) => {
      len += c.length;
      if (len > limit) { over = true; return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (over) reject(Object.assign(new Error('请求体过大'), { code: 'TOO_LARGE' }));
      else resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}
