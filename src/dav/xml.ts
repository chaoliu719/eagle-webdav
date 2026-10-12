export interface PropName { ns: string | null; name: string; prefix: string }

export type PropfindRequest =
  | { mode: 'allprop' }
  | { mode: 'propname' }
  | { mode: 'prop'; props: PropName[] };

export function nsMap(xml: string): Record<string, string> {
  const map: Record<string, string> = {};
  const re = /xmlns(?::([A-Za-z0-9_.-]+))?\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) map[m[1] || ''] = m[2] ?? m[3] ?? '';
  return map;
}

function propNames(fragment: string, map: Record<string, string>): PropName[] {
  const res: PropName[] = [];
  const re = /<(?:([A-Za-z0-9_.-]+):)?([A-Za-z0-9_.-]+)(\s[^>]*)?\/?>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(fragment))) {
    const prefix = m[1] || '';
    const own = nsMap(m[3] || '');
    const ns = Object.prototype.hasOwnProperty.call(own, prefix) ? own[prefix] : map[prefix];
    res.push({ ns: ns || null, name: m[2], prefix });
  }
  return res;
}

/**
 * 轻量的格式良好性检查：标签配对、单一根元素、前缀已声明、不允许 `xmlns:p=""`。
 * 不校验实体与字符合法性，只用来对明显损坏的请求体返回 400。
 */
export function isWellFormed(body: string): boolean {
  const s = body.replace(/<\?[\s\S]*?\?>/g, '').replace(/<!--[\s\S]*?-->/g, '').replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '');
  const tagRe = /<(\/?)([A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?)((?:\s+[^\s=<>/]+\s*=\s*(?:"[^"<]*"|'[^'<]*'))*)\s*(\/?)>/y;
  const stack: Array<{ name: string; prefixes: Set<string> }> = [];
  let roots = 0;
  let pos = 0;
  for (;;) {
    const idx = s.indexOf('<', pos);
    const text = s.slice(pos, idx < 0 ? s.length : idx);
    if (!stack.length && text.trim()) return false;
    if (idx < 0) break;
    tagRe.lastIndex = idx;
    const m = tagRe.exec(s);
    if (!m) return false;
    pos = tagRe.lastIndex;
    const [, closing, name, attrs, selfClose] = m;
    if (closing) {
      if (selfClose || !stack.length || stack.pop()?.name !== name) return false;
      continue;
    }
    const declared = new Set<string>();
    const attrRe = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    let a: RegExpExecArray | null;
    while ((a = attrRe.exec(attrs))) {
      if (a[1].startsWith('xmlns:')) {
        if (!(a[2] ?? a[3])) return false;
        declared.add(a[1].slice(6));
      }
    }
    const colon = name.indexOf(':');
    if (colon > 0) {
      const prefix = name.slice(0, colon);
      if (prefix !== 'xml' && !declared.has(prefix) && !stack.some((e) => e.prefixes.has(prefix))) return false;
    }
    if (!stack.length && ++roots > 1) return false;
    if (!selfClose) stack.push({ name, prefixes: declared });
  }
  return roots === 1 && !stack.length;
}

/** 含 DOCTYPE 或 ENTITY 的请求体一律拒绝（杜绝 XXE）。 */
export function hasDoctype(body: string): boolean {
  return /<!DOCTYPE/i.test(body) || /<!ENTITY/i.test(body);
}

export function parsePropfind(body: string): PropfindRequest {
  if (!body.trim()) return { mode: 'allprop' };
  if (/<(?:[A-Za-z0-9_.-]+:)?propname[\s/>]/.test(body)) return { mode: 'propname' };
  const pm = /<(?:[A-Za-z0-9_.-]+:)?prop(?:\s[^>]*)?>([\s\S]*?)<\/(?:[A-Za-z0-9_.-]+:)?prop>/.exec(body);
  if (pm) return { mode: 'prop', props: propNames(pm[1], nsMap(body)) };
  if (/<(?:[A-Za-z0-9_.-]+:)?prop\s*\/>/.test(body)) return { mode: 'prop', props: [] };
  return { mode: 'allprop' };
}
