import qrcode from 'qrcode-generator';
import * as os from 'os';
import { summarizeClients } from '../util/clients';
import type { RingLogger } from '../util/log';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

export interface LanAddress { name: string; address: string }

export function lanAddresses(): LanAddress[] {
  const out: LanAddress[] = [];
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const a of ifs[name] ?? []) {
      if (a.family === 'IPv4' && !a.internal) out.push({ name, address: a.address });
    }
  }
  return out;
}

export interface StartForm {
  host: string;
  port: number;
  username: string;
  password: string;
  readonlyUsername: string;
  readonlyPassword: string;
  cidrs: string[];
  bonjour: boolean;
  preventSleep: boolean;
}

export interface StatusHandlers {
  onStart(form: StartForm): void;
  onStop(): void;
}

export interface InitialSettings {
  host: string;
  port: number;
  username: string;
  hasPassword: boolean;
  readonlyUsername: string;
  hasReadonlyPassword: boolean;
  cidrs: string[];
  bonjour: boolean;
  preventSleep: boolean;
}

function copyText(text: string): void {
  const fallback = () => {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch { /* ignore */ }
    ta.remove();
  };
  try {
    void navigator.clipboard.writeText(text).catch(fallback);
  } catch {
    fallback();
  }
}

function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 5) return '刚刚';
  if (s < 60) return `${s} 秒前`;
  return `${Math.round(s / 60)} 分钟前`;
}

/** 二维码：白底黑块（暗色模式下也要保证可扫），返回 SVG 字符串。 */
export function qrSvg(text: string): string {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
}

export class StatusView {
  private lastRender = 0;
  private urls: string[] = [];
  private running = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private logger: RingLogger) {
    logger.onChange(() => this.renderLog(false));
    this.timer = setInterval(() => this.renderLog(true), 2000);
  }

  bind(handlers: StatusHandlers, initial: InitialSettings): void {
    const sel = $<HTMLSelectElement>('host');
    const options: Array<[string, string]> = [['仅本机（127.0.0.1）', '127.0.0.1']];
    for (const a of lanAddresses()) options.push([`${a.address}（${a.name}）`, a.address]);
    options.push(['所有网卡（0.0.0.0）', '0.0.0.0']);
    if (!options.some((o) => o[1] === initial.host)) options.push([initial.host, initial.host]);
    for (const [label, value] of options) sel.add(new Option(label, value));
    sel.value = initial.host;
    sel.addEventListener('change', () => this.updateHostWarning());

    $<HTMLInputElement>('port').value = String(initial.port);
    $<HTMLInputElement>('user').value = initial.username;
    $<HTMLInputElement>('pass').placeholder = initial.hasPassword ? '已设置，留空保持不变' : '未设置';
    $<HTMLInputElement>('rouser').value = initial.readonlyUsername;
    $<HTMLInputElement>('ropass').placeholder = initial.hasReadonlyPassword ? '已设置，留空保持不变' : '未启用';
    $<HTMLInputElement>('cidrs').value = initial.cidrs.join(', ');
    $<HTMLInputElement>('bonjour').checked = initial.bonjour;
    $<HTMLInputElement>('nosleep').checked = initial.preventSleep;
    this.updateHostWarning();

    $('btnStart').addEventListener('click', () => handlers.onStart({
      host: sel.value,
      port: parseInt($<HTMLInputElement>('port').value, 10) || 41600,
      username: $<HTMLInputElement>('user').value.trim(),
      password: $<HTMLInputElement>('pass').value,
      readonlyUsername: $<HTMLInputElement>('rouser').value.trim(),
      readonlyPassword: $<HTMLInputElement>('ropass').value,
      cidrs: $<HTMLInputElement>('cidrs').value.split(/[,\s]+/).map((c) => c.trim()).filter(Boolean),
      bonjour: $<HTMLInputElement>('bonjour').checked,
      preventSleep: $<HTMLInputElement>('nosleep').checked
    }));
    $('btnStop').addEventListener('click', () => handlers.onStop());
    $('qrsel').addEventListener('change', () => this.renderQr());
  }

  private updateHostWarning(): void {
    const v = $<HTMLSelectElement>('host').value;
    $('hostWarn').textContent = v === '0.0.0.0' ? '将监听所有网卡，请确认密码足够强，且仅在可信局域网中使用。' : '';
  }

  setStatus(text: string, bad = false): void {
    const el = $('status');
    el.textContent = text;
    el.classList.toggle('warn', bad);
  }

  setRunning(running: boolean, urls: string[] = []): void {
    this.running = running;
    this.urls = urls;
    $<HTMLButtonElement>('btnStart').disabled = running;
    $<HTMLButtonElement>('btnStop').disabled = !running;
    $('state').textContent = running ? '运行中' : '未启动';
    $('state').classList.toggle('on', running);
    for (const id of ['pass', 'ropass']) $<HTMLInputElement>(id).value = '';
    this.renderAddresses();
  }

  setDiscovery(name: string | null): void {
    $('discover').textContent = name
      ? `自动发现已开启：Finder 的「网络」、Infuse 等里会出现「${name}」。`
      : '自动发现未开启。';
  }

  setSleepState(active: boolean, enabled: boolean): void {
    $('sleep').textContent = !enabled ? '' : active ? '正在阻止 Mac 休眠（有客户端连接中）。' : '有客户端连接时会阻止 Mac 休眠。';
  }

  private renderAddresses(): void {
    const box = $('addrs');
    box.textContent = '';
    if (!this.urls.length) {
      box.innerHTML = '<span class="mut">服务未启动</span>';
      $('qrwrap').hidden = true;
      return;
    }
    for (const u of this.urls) {
      const row = document.createElement('div');
      row.className = 'addr';
      const code = document.createElement('code');
      code.textContent = u;
      const btn = document.createElement('button');
      btn.className = 'sec';
      btn.textContent = '复制';
      btn.addEventListener('click', () => {
        copyText(u);
        btn.textContent = '已复制';
        setTimeout(() => { btn.textContent = '复制'; }, 1200);
      });
      row.append(code, btn);
      box.append(row);
    }
    // 二维码只给非回环地址（手机扫的必须是局域网地址）
    const lan = this.urls.filter((u) => !/\/\/(127\.0\.0\.1|localhost)[:/]/.test(u));
    const sel = $<HTMLSelectElement>('qrsel');
    sel.textContent = '';
    for (const u of lan) sel.add(new Option(u, u));
    $('qrwrap').hidden = lan.length === 0;
    this.renderQr();
  }

  private renderQr(): void {
    const sel = $<HTMLSelectElement>('qrsel');
    if (!sel.value) { $('qr').innerHTML = ''; return; }
    $('qr').innerHTML = qrSvg(sel.value);
  }

  renderLog(force: boolean): void {
    const now = Date.now();
    if (!force && now - this.lastRender < 400) return;
    this.lastRender = now;

    const notices = $('notices');
    notices.textContent = '';
    for (const n of this.logger.activeNotices()) {
      const d = document.createElement('div');
      d.className = 'notice';
      d.textContent = n.message;
      notices.append(d);
    }

    const body = $('clients').querySelector('tbody') as HTMLElement;
    body.textContent = '';
    const list = summarizeClients(this.logger.recent(), now);
    if (!list.length) {
      body.innerHTML = '<tr><td class="mut">（尚无连接）</td></tr>';
    } else {
      body.innerHTML = '<tr><th>客户端</th><th>地址</th><th>账号</th><th>请求数</th><th>最近</th></tr>';
      for (const c of list.slice(0, 8)) {
        const tr = document.createElement('tr');
        for (const t of [c.client, c.ip, c.role === 'readonly' ? '只读' : '管理', String(c.requests), ago(now - c.lastSeen)]) {
          const td = document.createElement('td');
          td.textContent = t;
          tr.append(td);
        }
        body.append(tr);
      }
    }

    const lines = this.logger.recent(60).map((e) =>
      `#${e.n} ${e.ip} ${e.method} ${decodeSafe(e.url)} → ${e.status} ${e.ms}ms${e.depth !== undefined ? ' Depth:' + e.depth : ''}`);
    $('reqlog').textContent = lines.length ? lines.join('\n') : '（尚无请求）';
    $('msglog').textContent = this.logger.messages().slice(-30).join('\n');
  }
}

function decodeSafe(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}
