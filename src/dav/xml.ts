export interface PropName { ns: string | null; name: string; prefix: string }

export type PropfindRequest =
  | { mode: 'allprop' }
  | { mode: 'propname' }
  | { mode: 'prop'; props: PropName[] };

export function nsMap(xml: string): Record<string, string> {
  const map: Record<string, string> = {};
  const re = /xmlns(?::([A-Za-z0-9_.-]+))?\s*=\s*"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) map[m[1] || ''] = m[2];
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
    res.push({ ns: ns === undefined ? null : ns, name: m[2], prefix });
  }
  return res;
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
