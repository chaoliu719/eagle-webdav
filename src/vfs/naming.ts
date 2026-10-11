import type { FolderInfo, ItemInfo } from '../eagle/adapter';

const MAX_NAME_BYTES = 255;

/** 冲突检测键：NFC 后小写，适配 macOS 默认的大小写不敏感文件系统。 */
export function collisionKey(s: string): string {
  return s.normalize('NFC').toLowerCase();
}

function truncateBytes(s: string, max: number): string {
  if (Buffer.byteLength(s) <= max) return s;
  let out = '';
  let bytes = 0;
  for (const ch of s) {
    const b = Buffer.byteLength(ch);
    if (bytes + b > max) break;
    out += ch;
    bytes += b;
  }
  return out;
}

/** 4.2 节规范化步骤 1–3：NFC、替换非法字符、去尾部空格与点。 */
export function cleanBase(raw: string): string {
  return raw
    .normalize('NFC')
    .replace(/\//g, '／')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f]/g, '_')
    .replace(/[ .]+$/, '');
}

/** 拼出完整名字，并保证 UTF-8 字节数不超过 255（截断 base，不动后缀与扩展名）。 */
export function buildName(base: string, ext: string, suffix = ''): string {
  const tail = suffix + (ext ? '.' + ext : '');
  const room = MAX_NAME_BYTES - Buffer.byteLength(tail);
  return truncateBytes(base, Math.max(room, 1)) + tail;
}

export function idSuffix(id: string, length = 6): string {
  return ' ~' + id.slice(-length);
}

export interface Entry {
  name: string;
  kind: 'folder' | 'item';
  id: string;
  folder?: FolderInfo;
  item?: ItemInfo;
}

/**
 * 生成一个目录的子项名字（含重名消歧）。
 * 文件夹优先保留原名，其次是素材；同一冲突键内按 创建/导入时间、id 升序，第一个保留原名。
 * reserved：该目录下被虚拟目录占用的名字（根目录的 @未分类）。
 */
export function buildEntries(folders: FolderInfo[], items: ItemInfo[], reserved: string[] = []): Entry[] {
  const used = new Set(reserved.map(collisionKey));
  const out: Entry[] = [];

  const place = (id: string, base: string, ext: string): string => {
    let name = buildName(base || id, ext);
    if (used.has(collisionKey(name))) {
      name = buildName(base || id, ext, idSuffix(id));
      // 末 6 位仍冲突时使用完整 ID
      if (used.has(collisionKey(name))) name = buildName(base || id, ext, ' ~' + id);
    }
    used.add(collisionKey(name));
    return name;
  };

  const sortedFolders = [...folders].sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
  for (const f of sortedFolders) {
    out.push({ name: place(f.id, cleanBase(f.name), ''), kind: 'folder', id: f.id, folder: f });
  }
  const sortedItems = [...items].sort((a, b) => a.importedAt - b.importedAt || (a.id < b.id ? -1 : 1));
  for (const it of sortedItems) {
    out.push({ name: place(it.id, cleanBase(it.name), it.ext), kind: 'item', id: it.id, item: it });
  }
  return out;
}

const SUFFIX_RE = / ~([A-Z0-9]{6,13})(\.[^.]+)?$/;

/** 在目录子项中解析一段名字：精确 → 冲突键 → ID 后缀。 */
export function matchEntry(entries: Entry[], rawName: string): Entry | null {
  const name = rawName.normalize('NFC');
  const exact = entries.find((e) => e.name === name);
  if (exact) return exact;
  const key = collisionKey(name);
  const byKey = entries.find((e) => collisionKey(e.name) === key);
  if (byKey) return byKey;
  const m = SUFFIX_RE.exec(name);
  if (m) {
    const suffix = m[1];
    return entries.find((e) => e.id.endsWith(suffix)) ?? null;
  }
  return null;
}
