import test from 'node:test';
import assert from 'node:assert/strict';
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

test('前后端 codec 模块保持完全一致', () => {
  assert.deepEqual(Object.keys(WebCodec), Object.keys(PluginCodec));
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
  return {
    store,
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async put(key, val) {
      store.set(key, String(val));
    },
  };
}

test('Cloudflare Pages Functions /api/binds 完整读写与校验流程', async () => {
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

  // 2. 正常写入短码并返回 201
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

  // 3. 查询存在的短码返回 200
  const getOk = await bindsCodeMod.onRequestGet({
    params: { code: created.code.toUpperCase() },
    env: { BOX_BINDS: kv },
  });
  assert.equal(getOk.status, 200);
  const loaded = await getOk.json();
  assert.equal(loaded.box, 'My0wLTQ=');
  assert.equal(loaded.cidol, cEnc);

  // 4. 查询不存在返回 404，非法码返回 400
  const get404 = await bindsCodeMod.onRequestGet({
    params: { code: 'g00000000' },
    env: { BOX_BINDS: kv },
  });
  assert.equal(get404.status, 404);

  const get400 = await bindsCodeMod.onRequestGet({
    params: { code: 'badcode' },
    env: { BOX_BINDS: kv },
  });
  assert.equal(get400.status, 400);

  // 5. 空载荷与非法载荷拒绝 400
  const badPayload = await bindsIndexMod.onRequestPost({
    request: new Request('https://box.example.com/api/binds', {
      method: 'POST',
      body: JSON.stringify({ box: 'not-base64!!!', cidol: '' }),
    }),
    env: { BOX_BINDS: kv },
  });
  assert.equal(badPayload.status, 400);
});
