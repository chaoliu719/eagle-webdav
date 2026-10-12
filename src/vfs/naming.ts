import type { FolderInfo, ItemInfo } from '../eagle/adapter';
import type { ShadowEntry } from './shadow';

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
  kind: 'folder' | 'item' | 'uncat' | 'all' | 'tags' | 'tag' | 'shadow';
  id: string;
  shadow?: ShadowEntry;
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

// 实测 Eagle 4.0.0 Build 23 会在条目名里直接删除这些字符（文件夹名不会）：
// " % * : < > ? \ |、控制字符、格式字符（软连字符、零宽、方向标记、BOM）、emoji 与符号（©®™★❤ 等）、
// 所有辅助平面字符（含 𠮷 与旗帜）。保留 # & ; = , [ ] ' ~ ( ) 以及 CJK、重音字母、不间断空格。
// eslint-disable-next-line no-control-regex
const EAGLE_STRIP = /["%*:<>?\\|\u0000-\u001f\u007f\u00ad\u200b-\u200f\u202a-\u202e\u2060\ufeff\u2605]|\p{Extended_Pictographic}|[\u{10000}-\u{10FFFF}]/gu;

/** 模拟 Eagle 对条目名的处理，用来把客户端请求的名字映射到实际存储的名字。 */
export function eagleSanitizeName(name: string): string {
  const s = name.normalize('NFC').replace(EAGLE_STRIP, '');
  const i = s.lastIndexOf('.');
  const base = i > 0 ? s.slice(0, i) : s;
  const ext = i > 0 ? s.slice(i) : '';
  return base.replace(/^\s+|[\s.]+$/g, '') + ext;
}

/** 目录子项的查找索引：避免大目录每次线性扫描并反复小写化。 */
export class EntryIndex {
  private byName = new Map<string, Entry>();
  private byKey = new Map<string, Entry>();

  constructor(readonly entries: Entry[]) {
    for (const e of entries) {
      this.byName.set(e.name, e);
      const k = collisionKey(e.name);
      if (!this.byKey.has(k)) this.byKey.set(k, e);
    }
  }

  /** 精确 → 冲突键 → ID 后缀。 */
  match(rawName: string): Entry | null {
    const name = rawName.normalize('NFC');
    const exact = this.byName.get(name);
    if (exact) return exact;
    const byKey = this.byKey.get(collisionKey(name));
    if (byKey) return byKey;
    // Eagle 会改写条目名（去 emoji、: ? 等）、我们会修剪尾部空格与点：用同样的规则再找一次
    for (const alt of [eagleSanitizeName(name), name.replace(/[\s.]+$/, '')]) {
      if (alt && alt !== name) {
        const hit = this.byName.get(alt) ?? this.byKey.get(collisionKey(alt));
        if (hit) return hit;
      }
    }
    const m = SUFFIX_RE.exec(name);
    if (m) {
      const suffix = m[1];
      return this.entries.find((e) => e.id !== '' && e.id.endsWith(suffix)) ?? null;
    }
    return null;
  }
}

/** 在目录子项中解析一段名字：精确 → 冲突键 → ID 后缀。 */
export function matchEntry(entries: Entry[], rawName: string): Entry | null {
  return new EntryIndex(entries).match(rawName);
}
