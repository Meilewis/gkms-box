import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

const require = createRequire(import.meta.url);
const WebCodec = require(path.join(ROOT, 'web/public/codec.js'));
const PluginCodec = require(path.join(ROOT, 'koishi-plugin/codec.js'));

const bindsIndexUrl = pathToFileURL(path.join(ROOT, 'web/functions/api/binds/index.js')).href;
const bindsCodeUrl = pathToFileURL(path.join(ROOT, 'web/functions/api/binds/[code].js')).href;
const bindsIndexMod = await import(bindsIndexUrl);
const bindsCodeMod = await import(bindsCodeUrl);

const characters = JSON.parse(fs.readFileSync(path.join(ROOT, 'web/public/data/characters.json'), 'utf8'));
const supportCatalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'web/public/data/support.json'), 'utf8'));
const cidolCatalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'web/public/data/cidol.json'), 'utf8'));

const supportByKey = Object.fromEntries(supportCatalog.map((c) => [c.key, c]));
const cidolByKey = Object.fromEntries(cidolCatalog.map((c) => [c.key, c]));

test('前后端 codec 模块保持字节级完全一致', () => {
  assert.deepEqual(Object.keys(WebCodec), Object.keys(PluginCodec));
  const webHash = crypto
    .createHash('sha256')
    .update(fs.readFileSync(path.join(ROOT, 'web/public/codec.js')))
    .digest('hex');
  const pluginHash = crypto
    .createHash('sha256')
    .update(fs.readFileSync(path.join(ROOT, 'koishi-plugin/codec.js')))
    .digest('hex');
  assert.equal(webHash, pluginHash);
});

test('兼容旧版 Base64 向量 My0wLTQ= 解码与回环重编码', () => {
  const res = WebCodec.decodeSupportBox('My0wLTQ=', supportByKey);
  assert.equal(res.ok, true);
  assert.equal(res.items.length, 1);
  assert.deepEqual(res.items[0], {
    key: '3-0000',
    rarity: '3',
    number: '0000',
    breakLevel: 4,
  });
  assert.equal(res.b64, 'My0wLTQ=');
});

test('支援卡与P卡编码解码、去重排序及非法值拦截', () => {
  const sEnc = WebCodec.encodeSupportBox([
    { rarity: '2', number: '0005', breakLevel: 3 },
    { rarity: '3', number: '0012', breakLevel: 4 },
  ]);
  const sDec = PluginCodec.decodeSupportBox(sEnc, supportByKey);
  assert.equal(sDec.ok, true);
  assert.deepEqual(sDec.map, { '3-0012': 4, '2-0005': 3 });

  const badBreak = WebCodec.decodeSupportBox(Buffer.from('3-0-5').toString('base64'), supportByKey);
  assert.equal(badBreak.ok, false);

  const missingId = WebCodec.decodeSupportBox(Buffer.from('3-9999-4').toString('base64'), supportByKey);
  assert.equal(missingId.ok, false);

  const cEnc = WebCodec.encodeCidolBox(['shro-3-000', 'amao-3-001', 'shro-3-000']);
  const cDec = PluginCodec.decodeCidolBox(cEnc, cidolByKey);
  assert.equal(cDec.ok, true);
  assert.equal(cDec.items.length, 2);
  assert.deepEqual(cDec.set, { 'shro-3-000': true, 'amao-3-001': true });

  const badCidol = WebCodec.decodeCidolBox(Buffer.from('xxxx-3-999').toString('base64'), cidolByKey);
  assert.equal(badCidol.ok, false);
});

test('detectCodePayload 能准确区分短码、S卡、P卡与非法字符串', () => {
  assert.deepEqual(WebCodec.detectCodePayload('G52396342'), { kind: 'short', code: 'g52396342' });

  const supDetect = WebCodec.detectCodePayload('My0wLTQ=', supportByKey, cidolByKey);
  assert.equal(supDetect.kind, 'support');

  const cEnc = WebCodec.encodeCidolBox(['shro-3-000']);
  const cidDetect = WebCodec.detectCodePayload(cEnc, supportByKey, cidolByKey);
  assert.equal(cidDetect.kind, 'cidol');

  const inv = WebCodec.detectCodePayload('not_valid_$$$', supportByKey, cidolByKey);
  assert.equal(inv.kind, 'invalid');

  // P卡非法目录与非法条目形态均应给出 P卡相关错误提示
  const missingCidol = WebCodec.detectCodePayload(
    Buffer.from('xxxx-3-999').toString('base64'),
    supportByKey,
    cidolByKey
  );
  assert.equal(missingCidol.kind, 'invalid');
  assert.match(missingCidol.error, /P卡/);

  const badCidolItem = WebCodec.detectCodePayload(
    Buffer.from('shro-9-000').toString('base64'),
    supportByKey,
    cidolByKey
  );
  assert.equal(badCidolItem.kind, 'invalid');
  assert.match(badCidolItem.error, /P卡/);

  // 原型属性名不应被误判为有效目录卡
  const protoCidol = WebCodec.decodeCidolBox(
    Buffer.from('constructor-3-000').toString('base64'),
    cidolByKey
  );
  assert.equal(protoCidol.ok, false);

  // summarizeBox 遇到原型属性名时不崩溃且忽略未命中 key
  const summaryProto = WebCodec.summarizeBox({
    supportMap: Object.assign(Object.create(null), { '3-0000': 4 }),
    cidolSet: { toString: true, constructor: true },
    supportCatalog,
    cidolCatalog,
    characters,
  });
  assert.equal(summaryProto.support.owned, 1);
  assert.equal(summaryProto.cidol.owned, 0);
});

test('summarizeBox 准确统计持有率与各属性/角色进度', () => {
  const summary = PluginCodec.summarizeBox({
    supportMap: { '3-0000': 4, '2-0000': 1 },
    cidolSet: { 'shro-3-000': true },
    supportCatalog,
    cidolCatalog,
    characters,
  });
  assert.equal(summary.support.owned, 2);
  assert.equal(summary.support.maxBreakTotal, 1);
  assert.equal(summary.support.maxBreakSsr, 1);
  assert.equal(summary.cidol.owned, 1);
  const shroStat = summary.cidol.byCharacter.find((c) => c.code === 'shro');
  assert.ok(shroStat && shroStat.owned === 1);
});

function createMockKv(initial = {}) {
  const store = new Map(Object.entries(initial));
  const putCalls = [];
  return {
    store,
    putCalls,
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async put(key, val, options) {
      putCalls.push({ key, val: String(val), options });
      store.set(key, String(val));
    },
  };
}

function createMockCacheStorage() {
  const cacheMap = new Map();
  return {
    default: {
      async match(req) {
        const key = typeof req === 'string' ? req : req.url;
        const val = cacheMap.get(key);
        return val ? new Response(val) : undefined;
      },
      async put(req, res) {
        const key = typeof req === 'string' ? req : req.url;
        cacheMap.set(key, await res.text());
      },
    },
  };
}

test('Cloudflare Pages Functions /api/binds 完整读写、TTL、幂等去重、大小限制与限流', async () => {
  // 1. 未配置 KV 时返回 503
  const noKvRes = await bindsIndexMod.onRequestPost({
    request: new Request('https://box.example.com/api/binds', {
      method: 'POST',
      body: JSON.stringify({ box: 'My0wLTQ=' }),
    }),
    env: {},
  });
  assert.equal(noKvRes.status, 503);

  const kv = createMockKv();
  const cEnc = WebCodec.encodeCidolBox(['shro-3-000', 'ttmr-3-000']);

  // 2. 正常写入短码并返回 201，且携带 180 天 expirationTtl
  const postRes = await bindsIndexMod.onRequestPost({
    request: new Request('https://box.example.com/api/binds', {
      method: 'POST',
      body: JSON.stringify({ box: 'My0wLTQ=', cidol: cEnc }),
    }),
    env: { BOX_BINDS: kv },
  });
  assert.equal(postRes.status, 201);
  const created = await postRes.json();
  assert.match(created.code, /^g\d{8}$/);
  assert.equal(created.box_count, 1);
  assert.equal(created.cidol_count, 2);
  assert.equal(kv.putCalls.length, 2); // 短码记录 + hash 映射
  assert.equal(kv.putCalls[0].options?.expirationTtl, 180 * 24 * 3600);
  assert.equal(kv.putCalls[1].options?.expirationTtl, 180 * 24 * 3600);

  // 3. 幂等去重：相同 payload 第二次 POST 返回 200 + 相同 code + reused: true，不增加 KV 写入
  const dupRes = await bindsIndexMod.onRequestPost({
    request: new Request('https://box.example.com/api/binds', {
      method: 'POST',
      body: JSON.stringify({ box: ` ${'My0wLTQ='} `, cidol: cEnc }),
    }),
    env: { BOX_BINDS: kv },
  });
  assert.equal(dupRes.status, 200);
  const reused = await dupRes.json();
  assert.equal(reused.code, created.code);
  assert.equal(reused.reused, true);
  assert.equal(kv.putCalls.length, 2);

  // 4. 查询存在的短码返回 200
  const getOk = await bindsCodeMod.onRequestGet({
    request: new Request(`https://box.example.com/api/binds/${created.code}`),
    params: { code: created.code.toUpperCase() },
    env: { BOX_BINDS: kv },
  });
  assert.equal(getOk.status, 200);
  const loaded = await getOk.json();
  assert.equal(loaded.box, 'My0wLTQ=');
  assert.equal(loaded.cidol, cEnc);

  // 5. 查询不存在返回 404（带缓存头），非法码返回 400
  const get404 = await bindsCodeMod.onRequestGet({
    request: new Request('https://box.example.com/api/binds/g00000000'),
    params: { code: 'g00000000' },
    env: { BOX_BINDS: kv },
  });
  assert.equal(get404.status, 404);
  assert.equal(get404.headers.get('cache-control'), 'public, max-age=60');

  const get400 = await bindsCodeMod.onRequestGet({
    params: { code: 'badcode' },
    env: { BOX_BINDS: kv },
  });
  assert.equal(get400.status, 400);

  // 6. null / 数组 / 非字符串字段 / 非法条目截断 -> 400
  for (const invalidBody of ['null', '[]', JSON.stringify({ box: 123, cidol: '' })]) {
    const r = await bindsIndexMod.onRequestPost({
      request: new Request('https://box.example.com/api/binds', { method: 'POST', body: invalidBody }),
      env: { BOX_BINDS: kv },
    });
    assert.equal(r.status, 400, `body=${invalidBody} 应返回 400`);
  }

  const longBadItem = 'bad_' + 'x'.repeat(60);
  const longBadRes = await bindsIndexMod.onRequestPost({
    request: new Request('https://box.example.com/api/binds', {
      method: 'POST',
      body: JSON.stringify({ box: Buffer.from(longBadItem).toString('base64') }),
    }),
    env: { BOX_BINDS: kv },
  });
  assert.equal(longBadRes.status, 400);
  const longBadJson = await longBadRes.json();
  assert.ok(longBadJson.message.includes('…'), '超 40 字非法条目回显应截断');
  assert.ok(longBadJson.message.length < 60);

  // 7. Content-Length > 65536 前置返回 413，且不会调用 request.text()
  let readCalled = false;
  const header413 = await bindsIndexMod.onRequestPost({
    request: {
      headers: new Headers({ 'content-length': '70000', 'cf-connecting-ip': '203.0.113.10' }),
      async text() {
        readCalled = true;
        return '{}';
      },
    },
    env: { BOX_BINDS: kv },
  });
  assert.equal(header413.status, 413);
  assert.equal(readCalled, false);

  // 8. 实际请求体 > 65536 返回 413
  const bigBodyRes = await bindsIndexMod.onRequestPost({
    request: new Request('https://box.example.com/api/binds', {
      method: 'POST',
      body: JSON.stringify({ box: 'A'.repeat(66000) }),
    }),
    env: { BOX_BINDS: kv },
  });
  assert.equal(bigBodyRes.status, 413);

  // 9. 注入 mock caches 测试 POST (5次/min) 与 GET (30次/min) 429 限流
  const hasCachesDesc = Object.getOwnPropertyDescriptor(globalThis, 'caches');
  Object.defineProperty(globalThis, 'caches', {
    configurable: true,
    writable: true,
    value: createMockCacheStorage(),
  });
  try {
    for (let i = 0; i < 5; i += 1) {
      const okPost = await bindsIndexMod.onRequestPost({
        request: new Request('https://box.example.com/api/binds', {
          method: 'POST',
          headers: { 'cf-connecting-ip': '198.51.100.5' },
          body: JSON.stringify({ box: 'My0wLTQ=', cidol: cEnc }),
        }),
        env: { BOX_BINDS: kv },
      });
      assert.equal(okPost.status, 200);
    }
    const post429 = await bindsIndexMod.onRequestPost({
      request: new Request('https://box.example.com/api/binds', {
        method: 'POST',
        headers: { 'cf-connecting-ip': '198.51.100.5' },
        body: JSON.stringify({ box: 'My0wLTQ=', cidol: cEnc }),
      }),
      env: { BOX_BINDS: kv },
    });
    assert.equal(post429.status, 429);
    assert.ok(Number(post429.headers.get('retry-after')) >= 1);

    for (let i = 0; i < 30; i += 1) {
      const okGet = await bindsCodeMod.onRequestGet({
        request: new Request(`https://box.example.com/api/binds/${created.code}`, {
          headers: { 'cf-connecting-ip': '198.51.100.6' },
        }),
        params: { code: created.code },
        env: { BOX_BINDS: kv },
      });
      assert.equal(okGet.status, 200);
    }
    const get429 = await bindsCodeMod.onRequestGet({
      request: new Request(`https://box.example.com/api/binds/${created.code}`, {
        headers: { 'cf-connecting-ip': '198.51.100.6' },
      }),
      params: { code: created.code },
      env: { BOX_BINDS: kv },
    });
    assert.equal(get429.status, 429);
    assert.ok(Number(get429.headers.get('retry-after')) >= 1);
  } finally {
    if (hasCachesDesc) {
      Object.defineProperty(globalThis, 'caches', hasCachesDesc);
    } else {
      delete globalThis.caches;
    }
  }
});
