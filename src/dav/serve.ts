import * as fs from 'fs';
import type * as http from 'http';
import { send } from '../http/respond';
import type { Logger } from '../util/log';
import { evaluate, ifRangeAllows, parseRange } from './conditional';

export interface ServableFile {
  realPath: string;
  size: number;
  mime: string;
  etag: string;
  lastModified: number;
}

/** 发送文件：条件请求、单区间 Range、HEAD。GET 与影子文件共用。 */
export function serveFile(req: http.IncomingMessage, res: http.ServerResponse, f: ServableFile, logger: Logger): void {
  const headers: http.OutgoingHttpHeaders = {
    Server: 'EagleWebdav/0.1',
    'Content-Type': f.mime,
    ETag: f.etag,
    'Last-Modified': new Date(f.lastModified).toUTCString(),
    'Accept-Ranges': 'bytes'
  };
  const v = { etag: f.etag, lastModified: f.lastModified };
  const pre = evaluate(req.headers, v);
  if (pre === 'precondition-failed') return send(res, 412, headers);
  if (pre === 'not-modified') return send(res, 304, headers);

  let start = 0;
  let end = f.size - 1;
  let status = 200;
  const range = ifRangeAllows(req.headers, v) ? parseRange(req.headers['range'], f.size) : { kind: 'none' as const };
  if (range.kind === 'unsatisfiable') return send(res, 416, { ...headers, 'Content-Range': `bytes */${f.size}` });
  if (range.kind === 'range') {
    status = 206;
    start = range.start;
    end = range.end;
    headers['Content-Range'] = `bytes ${start}-${end}/${f.size}`;
  }
  headers['Content-Length'] = f.size === 0 ? 0 : end - start + 1;
  res.writeHead(status, headers);
  if (req.method === 'HEAD' || f.size === 0) return void res.end();

  const stream = fs.createReadStream(f.realPath, { start, end });
  res.on('close', () => stream.destroy());
  stream.on('error', (e) => {
    logger.error(`读取文件失败：${e.message}`);
    res.destroy();
  });
  stream.pipe(res);
}
