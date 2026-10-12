import assert from 'assert';
import { test } from 'node:test';
import { isAllowedAddress } from '../../src/http/access';
import { Authenticator } from '../../src/http/auth';
import { hashPassword, verifyPassword } from '../../src/config/config';

test('源地址过滤', () => {
  for (const ok of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.5', '169.254.1.1', '::1', 'fe80::1%en0', 'fd12::1', '::ffff:192.168.1.5'])
    assert.ok(isAllowedAddress(ok), ok);
  for (const bad of ['8.8.8.8', '172.32.0.1', '100.64.0.1', '2001:db8::1', '', undefined])
    assert.ok(!isAllowedAddress(bad as string | undefined), String(bad));
  assert.ok(isAllowedAddress('100.64.1.1', ['100.64.0.0/10']));
});

test('密码哈希', () => {
  const h = hashPassword('secret');
  assert.ok(verifyPassword('secret', h));
  assert.ok(!verifyPassword('Secret', h));
  assert.ok(!verifyPassword('x', null));
  assert.ok(!verifyPassword('x', 'garbage'));
});

test('认证与封禁', () => {
  let t = 0;
  const a = new Authenticator(() => t);
  const cfg = { username: 'u', passwordHash: hashPassword('p') };
  const hdr = (s: string) => 'Basic ' + Buffer.from(s).toString('base64');
  assert.strictEqual(a.check(undefined, '1.1.1.1', cfg), 'denied');
  assert.strictEqual(a.check(hdr('u:p'), '1.1.1.1', cfg), 'ok');
  for (let i = 0; i < 10; i++) assert.strictEqual(a.check(hdr('u:bad'), '2.2.2.2', cfg), 'denied');
  assert.strictEqual(a.check(hdr('u:p'), '2.2.2.2', cfg), 'banned');
  t += 10 * 60 * 1000 + 1;
  assert.strictEqual(a.check(hdr('u:p'), '2.2.2.2', cfg), 'ok');
  // 没设管理密码：不要求认证
  assert.strictEqual(a.check(hdr('u:p'), '3.3.3.3', { username: 'u', passwordHash: null }), 'ok');
});
