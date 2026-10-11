import type * as http from 'http';
import type { ItemPatch } from '../../eagle/adapter';
import { readBody, send, sendXml } from '../../http/respond';
import { isTagsView, pathKey } from '../../vfs/resolver';
import type { DavContext } from '../context';
import { escXml, hrefOf } from '../path';
import { hasDoctype, nsMap } from '../xml';

export const EAGLE_NS = 'urn:eagle-webdav:ns';
const MAX_XML_BODY = 1024 * 1024;

interface Instruction { op: 'set' | 'remove'; ns: string | null; name: string; prefix: string; value: string }

function parseInstructions(body: string): Instruction[] {
  const map = nsMap(body);
  const out: Instruction[] = [];
  for (const op of ['set', 'remove'] as const) {
    const blockRe = new RegExp(`<(?:[A-Za-z0-9_.-]+:)?${op}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[A-Za-z0-9_.-]+:)?${op}\\s*>`, 'g');
    let b: RegExpExecArray | null;
    while ((b = blockRe.exec(body))) {
      const pm = /<(?:[A-Za-z0-9_.-]+:)?prop(?:\s[^>]*)?>([\s\S]*?)<\/(?:[A-Za-z0-9_.-]+:)?prop\s*>/.exec(b[1]);
      if (!pm) continue;
      const elRe = /<(?:([A-Za-z0-9_.-]+):)?([A-Za-z0-9_.-]+)((?:\s[^>]*?)?)(?:\/>|>([\s\S]*?)<\/(?:[A-Za-z0-9_.-]+:)?\2\s*>)/g;
      let e: RegExpExecArray | null;
      while ((e = elRe.exec(pm[1]))) {
        const prefix = e[1] || '';
        const own = nsMap(e[3] || '');
        const ns = Object.prototype.hasOwnProperty.call(own, prefix) ? own[prefix] : map[prefix];
        out.push({ op, ns: ns === undefined ? null : ns, name: e[2], prefix, value: (e[4] ?? '').trim() });
      }
    }
  }
  return out;
}

function decodeText(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

function propEl(i: Instruction): string {
  if (i.ns === 'DAV:') return `<D:${i.name}/>`;
  if (i.ns) return `<ns0:${i.name} xmlns:ns0="${escXml(i.ns)}"/>`;
  return `<${i.prefix ? i.prefix + ':' : ''}${i.name}/>`;
}

type Verdict = { status: number } & ({ patch?: Partial<ItemPatch>; description?: string; dead?: boolean });

export async function handleProppatch(ctx: DavContext, req: http.IncomingMessage, res: http.ServerResponse, segs: string[]): Promise<void> {
  const body = (await readBody(req, MAX_XML_BODY)).toString('utf8');
  if (hasDoctype(body)) return send(res, 400, {}, 'DOCTYPE not allowed');
  const r = await ctx.resolver.resolve(segs);
  if (!r) return send(res, 404, {}, 'Not Found');
  if (isTagsView(r)) return send(res, 403, {}, '「@标签」视图只读');
  const instrs = parseInstructions(body);
  if (!instrs.length) return send(res, 400, {}, '没有有效的 set / remove 指令');

  const verdicts: Verdict[] = instrs.map((i) => {
    if (i.ns === 'DAV:') return { status: 403 };
    if (i.ns === EAGLE_NS) {
      if (r.kind === 'item') {
        const set = i.op === 'set';
        switch (i.name) {
          case 'tags': {
            if (!set) return { status: 200, patch: { tags: [] } };
            try {
              const v: unknown = JSON.parse(decodeText(i.value));
              if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return { status: 200, patch: { tags: v as string[] } };
            } catch { /* fallthrough */ }
            return { status: 409 };
          }
          case 'star': {
            const n = set ? Number(i.value) : 0;
            return Number.isInteger(n) && n >= 0 && n <= 5 ? { status: 200, patch: { star: n } } : { status: 409 };
          }
          case 'annotation': return { status: 200, patch: { annotation: set ? decodeText(i.value) : '' } };
          case 'url': return { status: 200, patch: { url: set ? decodeText(i.value) : '' } };
          default: return { status: 403 };
        }
      }
      if (r.kind === 'folder' && i.name === 'description') return { status: 200, description: i.op === 'set' ? decodeText(i.value) : '' };
      return { status: 403 };
    }
    // 其他命名空间：Finder 等写入的 dead 属性，只存内存
    return { status: 200, dead: true };
  });

  const failed = verdicts.some((v) => v.status !== 200);
  const final = verdicts.map((v) => (failed && v.status === 200 ? 424 : v.status));

  if (!failed) {
    const patch: ItemPatch = {};
    let description: string | undefined;
    for (const v of verdicts) {
      if (v.patch) Object.assign(patch, v.patch);
      if (v.description !== undefined) description = v.description;
    }
    if (r.kind === 'item' && Object.keys(patch).length) {
      const id = r.item.id;
      await ctx.mutex.run(id, () => ctx.adapter.updateItem(id, patch));
      ctx.index.invalidate();
    }
    if (r.kind === 'folder' && description !== undefined) {
      const id = r.folder.id;
      await ctx.mutex.run('folder:' + id, () => ctx.adapter.updateFolder(id, { description }));
      ctx.index.invalidate();
    }
    const key = pathKey(r.segs);
    instrs.forEach((i, n) => {
      if (!verdicts[n].dead || !i.ns) return;
      const m = ctx.deadProps.get(key) ?? new Map();
      if (i.op === 'set') m.set(`${i.ns}|${i.name}`, { ns: i.ns, name: i.name, value: i.value });
      else m.delete(`${i.ns}|${i.name}`);
      if (m.size) ctx.deadProps.set(key, m); else ctx.deadProps.delete(key);
    });
  }

  const groups = new Map<number, string[]>();
  instrs.forEach((i, n) => {
    const l = groups.get(final[n]) ?? [];
    l.push(propEl(i));
    groups.set(final[n], l);
  });
  const text: Record<number, string> = { 200: 'OK', 403: 'Forbidden', 409: 'Conflict', 424: 'Failed Dependency' };
  const stats = Array.from(groups.entries()).map(([st, els]) =>
    `<D:propstat><D:prop>${els.join('')}</D:prop><D:status>HTTP/1.1 ${st} ${text[st] ?? ''}</D:status></D:propstat>`).join('');
  sendXml(res, 207, `<D:multistatus xmlns:D="DAV:"><D:response><D:href>${escXml(hrefOf(r.segs, r.kind !== 'item'))}</D:href>${stats}</D:response></D:multistatus>`);
}
