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
      // 198.18.0.0/15 是基准测试保留网段，Surge 等代理软件的虚拟网卡会用到，手机连不上
      if (a.family === 'IPv4' && !a.internal && !/^198\.1[89]\./.test(a.address)) out.push({ name, address: a.address });
    }
  }
  return out;
}

export interface SettingsForm {
  host: string;
  port: number;
  username: string;
  /** 密码：null = 不修改；'' = 清除；其他 = 设置为该值。 */
  password: string | null;
  readonlyUsername: string;
  readonlyPassword: string | null;
  cidrs: string[];
  bonjour: boolean;
  preventSleep: boolean;
}

export interface StatusHandlers {
  /** 用已保存的配置启动。 */
  onStart(): void;
  onStop(): void;
  /** 保存表单并自动启动（运行中则重启）。 */
  onSave(form: SettingsForm): void;
  /** 读取已保存的配置，供「放弃」恢复表单。 */
  getSettings(): InitialSettings;
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

/**
 * 已设置的密码用一串黑点表示（真实密码不会回显，这里只是占位值）。
 * 黑点 = 不修改；清空 = 清除密码；输入新内容 = 设置新密码。点进去会全选，直接输入即替换。
 */
const MASK = '•'.repeat(10);

function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 5) return '刚刚';
  if (s < 60) return `${s} 秒前`;
  return `${Math.round(s / 60)} 分钟前`;
}

export class StatusView {
  private lastRender = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private logger: RingLogger) {
    logger.onChange(() => this.renderLog(false));
    this.timer = setInterval(() => this.renderLog(true), 2000);
  }

  private baseline = '';

  bind(handlers: StatusHandlers): void {
    const initial = handlers.getSettings();
    const sel = $<HTMLSelectElement>('host');
    const options: Array<[string, string]> = [['仅本机（127.0.0.1）', '127.0.0.1']];
    for (const a of lanAddresses()) options.push([`${a.address}（${a.name}）`, a.address]);
    options.push(['所有网卡（0.0.0.0）', '0.0.0.0']);
    if (!options.some((o) => o[1] === initial.host)) options.push([initial.host, initial.host]);
    for (const [label, value] of options) sel.add(new Option(label, value));

    this.applySettings(initial);
    for (const id of ['host', 'port', 'user', 'pass', 'rouser', 'ropass', 'cidrs', 'bonjour', 'nosleep']) {
      const el = $(id);
      el.addEventListener('input', () => this.updateDirty());
      el.addEventListener('change', () => this.updateDirty());
    }

    for (const id of ['pass', 'ropass']) {
      const el = $<HTMLInputElement>(id);
      // 点进去全选黑点，直接输入就是替换；清空则表示清除密码（点「放弃」可恢复）
      el.addEventListener('focus', () => { if (el.value === MASK) el.select(); });
    }
    $('btnStart').addEventListener('click', () => handlers.onStart());
    $('btnStop').addEventListener('click', () => handlers.onStop());
    $('btnSave').addEventListener('click', () => handlers.onSave(this.readForm()));
    $('btnDiscard').addEventListener('click', () => this.applySettings(handlers.getSettings()));
  }

  /** 用已保存的配置填充表单（保存成功后、或点「放弃」时），并清空密码框。 */
  applySettings(s: InitialSettings): void {
    $<HTMLSelectElement>('host').value = s.host;
    $<HTMLInputElement>('port').value = String(s.port);
    $<HTMLInputElement>('user').value = s.username;
    this.setPassword('pass', s.hasPassword, '未设置');
    $<HTMLInputElement>('rouser').value = s.readonlyUsername;
    this.setPassword('ropass', s.hasReadonlyPassword, '未启用');
    $<HTMLInputElement>('cidrs').value = s.cidrs.join(', ');
    $<HTMLInputElement>('bonjour').checked = s.bonjour;
    $<HTMLInputElement>('nosleep').checked = s.preventSleep;
    this.baseline = JSON.stringify(this.readForm());
    this.updateDirty();
  }

  private setPassword(id: string, isSet: boolean, emptyHint: string): void {
    const el = $<HTMLInputElement>(id);
    el.value = isSet ? MASK : '';
    el.placeholder = isSet ? '' : emptyHint;
    el.dataset.isSet = isSet ? '1' : '';
  }

  /** 密码框的意图：null = 不修改（黑点，或本来就没设置且仍为空）；'' = 清除；其他 = 新密码。 */
  private passwordValue(id: string): string | null {
    const el = $<HTMLInputElement>(id);
    if (el.value === MASK) return null;
    if (el.value === '' && !el.dataset.isSet) return null;
    return el.value;
  }

  private readForm(): SettingsForm {
    return {
      host: $<HTMLSelectElement>('host').value,
      port: parseInt($<HTMLInputElement>('port').value, 10) || 0,
      username: $<HTMLInputElement>('user').value.trim(),
      password: this.passwordValue('pass'),
      readonlyUsername: $<HTMLInputElement>('rouser').value.trim(),
      readonlyPassword: this.passwordValue('ropass'),
      cidrs: $<HTMLInputElement>('cidrs').value.split(/[,\s]+/).map((c) => c.trim()).filter(Boolean),
      bonjour: $<HTMLInputElement>('bonjour').checked,
      preventSleep: $<HTMLInputElement>('nosleep').checked
    };
  }

  /** 有未保存的修改时才启用「保存」「放弃」。 */
  private updateDirty(): void {
    const dirty = JSON.stringify(this.readForm()) !== this.baseline;
    $<HTMLButtonElement>('btnSave').disabled = !dirty;
    $<HTMLButtonElement>('btnDiscard').disabled = !dirty;
    $('dirty').textContent = dirty ? '有未保存的修改' : '';
  }

  setSaving(saving: boolean): void {
    if (saving) {
      $<HTMLButtonElement>('btnSave').disabled = true;
      $<HTMLButtonElement>('btnDiscard').disabled = true;
    } else {
      this.updateDirty();
    }
  }

  setStatus(text: string, bad = false): void {
    const el = $('status');
    el.textContent = text;
    el.classList.toggle('warn', bad);
  }

  setRunning(running: boolean): void {
    $<HTMLButtonElement>('btnStart').disabled = running;
    $<HTMLButtonElement>('btnStop').disabled = !running;
    $('state').textContent = running ? '运行中' : '未启动';
    $('state').classList.toggle('on', running);
  }

  setSleepState(active: boolean, enabled: boolean): void {
    $('sleep').textContent = enabled && active ? '正在阻止 Mac 休眠（有客户端连接中）。' : '';
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
      const msg = document.createElement('span');
      msg.textContent = n.message;
      const btn = document.createElement('button');
      btn.className = 'sec';
      btn.textContent = '忽略';
      btn.style.marginLeft = '10px';
      btn.addEventListener('click', () => { this.logger.clearNotice(n.key); this.renderLog(true); });
      d.append(msg, btn);
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
      `#${e.n} ${e.ip} ${e.method} ${decodeSafe(e.url)} → ${e.status} ${e.ms}ms${e.depth !== undefined ? ' Depth:' + e.depth : ''}${e.range ? ' Range:' + e.range : ''}${e.contentRange ? ' → ' + e.contentRange : ''}${e.length && !e.contentRange ? ' len:' + e.length : ''}${e.ua ? ' [' + e.ua.slice(0, 40) + ']' : ' [无UA]'}`);
    $('reqlog').textContent = lines.length ? lines.join('\n') : '（尚无请求）';
    $('msglog').textContent = this.logger.messages().slice(-30).join('\n');
  }
}

function decodeSafe(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}
