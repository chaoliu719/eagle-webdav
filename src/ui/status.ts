import * as os from 'os';
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

export interface StatusHandlers {
  onStart(form: { host: string; port: number; username: string; password: string; cidrs: string[] }): void;
  onStop(): void;
}

export class StatusView {
  private lastRender = 0;

  constructor(private logger: RingLogger) {
    logger.onChange(() => this.renderLog(false));
  }

  bind(handlers: StatusHandlers, initial: { host: string; port: number; username: string; hasPassword: boolean; cidrs: string[] }): void {
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
    $<HTMLInputElement>('cidrs').value = initial.cidrs.join(', ');
    $<HTMLInputElement>('pass').placeholder = initial.hasPassword ? '已设置，留空保持不变' : '未设置';
    this.updateHostWarning();

    $('btnStart').addEventListener('click', () => handlers.onStart({
      host: sel.value,
      port: parseInt($<HTMLInputElement>('port').value, 10) || 41600,
      username: $<HTMLInputElement>('user').value.trim(),
      password: $<HTMLInputElement>('pass').value,
      cidrs: $<HTMLInputElement>('cidrs').value.split(/[,\s]+/).map((c) => c.trim()).filter(Boolean)
    }));
    $('btnStop').addEventListener('click', () => handlers.onStop());
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
    $<HTMLButtonElement>('btnStart').disabled = running;
    $<HTMLButtonElement>('btnStop').disabled = !running;
    $('urls').textContent = urls.length ? '可用地址：' + urls.join('　') : '';
    $<HTMLInputElement>('pass').value = '';
  }

  renderLog(force: boolean): void {
    const now = Date.now();
    if (!force && now - this.lastRender < 400) return;
    this.lastRender = now;
    const lines = this.logger.recent(60).map((e) =>
      `#${e.n} ${e.ip} ${e.method} ${decodeSafe(e.url)} → ${e.status} ${e.ms}ms${e.depth !== undefined ? ' Depth:' + e.depth : ''}`);
    $('reqlog').textContent = lines.length ? lines.join('\n') : '（尚无请求）';
    $('msglog').textContent = this.logger.messages().slice(-30).join('\n');
  }
}

function decodeSafe(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}
