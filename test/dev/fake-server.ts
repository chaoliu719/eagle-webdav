// 不依赖 Eagle 的联调服务：假数据 + 真实 DavServer，用于 rclone / mount_webdav 验证。
// 运行：npx tsx test/dev/fake-server.ts [端口]
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ConfigStore } from '../../src/config/config';
import { DavRouter } from '../../src/dav/router';
import { FakeEagleAdapter } from '../../src/eagle/fakeAdapter';
import { DavServer } from '../../src/http/server';
import { LibraryIndex } from '../../src/index/libraryIndex';
import { RingLogger } from '../../src/util/log';

const port = Number(process.argv[2] || 41650);
const store = new ConfigStore(fs.mkdtempSync(path.join(os.tmpdir(), 'ewdav-dev-')));
store.load();
store.update({ host: '0.0.0.0', port, username: 'eagle' });
store.setPassword('test');

const fake = new FakeEagleAdapter();
const trip = fake.addFolder('旅行');
const tokyo = fake.addFolder('东京', trip.id);
fake.addItem('海报', 'jpg', Buffer.alloc(3 * 1024 * 1024, 7), [trip.id]);
fake.addItem('海报', 'jpg', 'second', [trip.id]);
fake.addItem('note', 'txt', 'hello eagle\n', [tokyo.id, trip.id]);
fake.addItem('loose', 'png', 'PNGDATA', []);
fake.addItem('无扩展名', '', 'noext', []);

const logger = new RingLogger();
logger.onChange(() => {});
const origRequest = logger.request.bind(logger);
logger.request = (e) => { origRequest(e); console.log(`${e.method} ${decodeURIComponent(e.url)} -> ${e.status} ${e.ms}ms`); };
const router = new DavRouter(fake, new LibraryIndex(fake), logger);
const server = new DavServer({ getConfig: () => store.get(), logger, handler: (a, b, r) => router.handle(a, b, r) });
server.start().then(() => console.log('ready on', port));
