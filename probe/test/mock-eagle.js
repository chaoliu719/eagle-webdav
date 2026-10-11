// 内存版 Eagle 模拟，仅用于自测探针代码路径，不代表真实行为。
const fs = require('fs');
const path = require('path');
const os = require('os');

function createMock() {
  const items = new Map(); const folders = new Map(); let seq = 0; let libMod = Date.now();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mockeagle-'));
  const nid = (p) => p + (++seq).toString().padStart(6, '0');
  function wrapItem(rec) {
    const it = Object.assign({}, rec);
    Object.defineProperty(it, 'moveToTrash', { enumerable: false, value: async () => { items.get(it.id).isDeleted = true; libMod = Date.now(); return true; } });
    Object.defineProperty(it, 'replaceFile', { enumerable: false, value: async (p) => { const r = items.get(it.id); fs.copyFileSync(p, r.filePath); r.ext = path.extname(p).slice(1); return true; } });
    Object.defineProperty(it, 'save', { enumerable: false, value: async () => { Object.assign(items.get(it.id), JSON.parse(JSON.stringify(it))); items.get(it.id).modifiedAt = Date.now(); libMod = Date.now(); return true; } });
    return it;
  }
  function wrapFolder(rec) {
    const f = Object.assign({}, rec);
    Object.defineProperty(f, 'save', { enumerable: false, value: async () => { Object.assign(folders.get(f.id), JSON.parse(JSON.stringify(f))); return true; } });
    return f;
  }
  const eagle = {
    app: { version: '4.0.0', build: 23, name: 'MockEagle' },
    library: { get path() { return root; }, async info() { return { name: 'mock' }; } },
    item: {
      async countAll() { return Array.from(items.values()).filter((i) => !i.isDeleted).length; },
      async getIdsWithModifiedAt() { return Array.from(items.values()).map((i) => ({ id: i.id, modifiedAt: i.modifiedAt })); },
      async getById(id) { const r = items.get(id); return r ? wrapItem(r) : null; },
      async get(q = {}) {
        let a = Array.from(items.values()).filter((i) => !i.isDeleted);
        if (q.ids) a = a.filter((i) => q.ids.includes(i.id));
        if (q.folders) a = a.filter((i) => i.folders.some((f) => q.folders.includes(f)));
        return a.map(wrapItem);
      },
      async addFromPath(p, o = {}) {
        const id = nid('ITEM'); const ext = path.extname(p).slice(1);
        const dir = path.join(root, 'images', id + '.info'); fs.mkdirSync(dir, { recursive: true });
        const name = o.name || path.basename(p, path.extname(p));
        const fp = path.join(dir, name + (ext ? '.' + ext : '')); fs.copyFileSync(p, fp);
        items.set(id, { id, name, ext, filePath: fp, size: fs.statSync(fp).size, tags: o.tags || [], folders: o.folders || [], modifiedAt: Date.now(), isDeleted: false });
        libMod = Date.now(); return id;
      },
      async addBookmark(url, o = {}) { const id = nid('BMK'); items.set(id, { id, name: o.name, ext: 'url', tags: [], folders: o.folders || [], modifiedAt: Date.now(), isDeleted: false }); return id; },
    },
    folder: {
      async create(o) { const id = nid('FLD'); folders.set(id, { id, name: o.name, parent: null, children: [] }); return wrapFolder(folders.get(id)); },
      async createSubfolder(pid, o) { const id = nid('FLD'); folders.set(id, { id, name: o.name, parent: pid, children: [] }); return wrapFolder(folders.get(id)); },
      async getById(id) { return wrapFolder(folders.get(id)); },
      async getAll() { return Array.from(folders.values()).map(wrapFolder); }
    }
  };
  return { eagle, root };
}
module.exports = { createMock };
