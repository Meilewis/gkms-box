import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module, { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'web', 'public');

// ---------------------------------------------------------------------------
// 极简 koishi 桩
// ---------------------------------------------------------------------------
const KOISHI_STUB_ID = '\u0000koishi-stub-gkms-box';

function createChainableSchema() {
  const target = function schema() {};
  const proxy = new Proxy(target, {
    get(_t, prop) {
      if (prop === Symbol.toPrimitive) return () => '[Schema]';
      return proxy;
    },
    apply() {
      return proxy;
    },
  });
  return proxy;
}

function unescapeXml(s) {
  return String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

const hStub = {
  text(s) {
    return { type: 'text', attrs: { content: String(s) }, children: [] };
  },
  escape(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  },
  image(data, mime, attrs = {}) {
    return {
      type: 'image',
      attrs: typeof data === 'string' ? { src: data, ...attrs } : { data, mime, ...attrs },
      children: [],
    };
  },
  parse(src) {
    const out = [];
    const re = /<at\s+id="([^"]*)"(?:\s+name="([^"]*)")?\s*\/>/g;
    let last = 0;
    let m;
    while ((m = re.exec(src))) {
      if (m.index > last) out.push(hStub.text(unescapeXml(src.slice(last, m.index))));
      out.push({ type: 'at', attrs: { id: m[1], ...(m[2] ? { name: m[2] } : {}) }, children: [] });
      last = re.lastIndex;
    }
    if (last < src.length) out.push(hStub.text(unescapeXml(src.slice(last))));
    return out;
  },
};

const koishiStub = { Schema: createChainableSchema(), h: hStub };
const origResolve = Module._resolveFilename;
const origLoad = Module._load;
Module._resolveFilename = function (req, ...rest) {
  if (req === 'koishi') return KOISHI_STUB_ID;
  return origResolve.call(this, req, ...rest);
};
Module._load = function (req, ...rest) {
  if (req === 'koishi' || req === KOISHI_STUB_ID) return koishiStub;
  return origLoad.call(this, req, ...rest);
};

const Plugin = require(path.join(ROOT, 'koishi-plugin', 'index.js'));
const Renderer = require(path.join(ROOT, 'koishi-plugin', 'renderer.js'));

const characters = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'data', 'characters.json'), 'utf8'));

// ---------------------------------------------------------------------------
// 测试辅助：内存 Mock 数据库、Ctx、Page
// ---------------------------------------------------------------------------

function matchQuery(row, query) {
  for (const [k, v] of Object.entries(query || {})) {
    if (row[k] !== v) return false;
  }
  return true;
}

function createMockDb() {
  const tables = new Map();
  const primaries = new Map();
  const ensure = (t) => {
    if (!tables.has(t)) tables.set(t, []);
    return tables.get(t);
  };
  return {
    tables,
    setPrimary(t, key) {
      primaries.set(t, key);
    },
    async get(t, query) {
      return ensure(t).filter((r) => matchQuery(r, query)).map((r) => ({ ...r }));
    },
    async upsert(t, rows) {
      const pk = primaries.get(t) || 'userKey';
      const arr = ensure(t);
      for (const doc of rows) {
        const idx = arr.findIndex((r) => r[pk] === doc[pk]);
        if (idx >= 0) arr[idx] = { ...doc };
        else arr.push({ ...doc });
      }
    },
    async remove(t, query) {
      const arr = ensure(t);
      tables.set(
        t,
        arr.filter((r) => !matchQuery(r, query))
      );
    },
  };
}

function createFakePage(options = {}) {
  let requestHandler = null;
  const handlers = {
    continueCalls: [],
    abortCalls: [],
    closed: false,
    setViewportCalls: [],
  };
  const page = {
    handlers,
    async setRequestInterception(enabled) {
      handlers.interception = enabled;
    },
    on(evt, fn) {
      if (evt === 'request') requestHandler = fn;
    },
    async setViewport(vp) {
      handlers.setViewportCalls.push(vp);
    },
    async setContent(html) {
      handlers.html = html;
      if (typeof options.onSetContent === 'function') {
        await options.onSetContent(html, page);
      }
    },
    async evaluate() {
      if (typeof options.onEvaluate === 'function') {
        return options.onEvaluate();
      }
    },
    async $(selector) {
      if (selector !== '#canvas-root') return null;
      return {
        async boundingBox() {
          return options.boundingBox || { x: 0, y: 0, width: 1400, height: 800 };
        },
      };
    },
    async screenshot({ quality }) {
      if (typeof options.onScreenshot === 'function') {
        return options.onScreenshot(quality);
      }
      return Buffer.alloc(1024, 1);
    },
    async close() {
      handlers.closed = true;
    },
    emitRequest(url) {
      if (!requestHandler) return;
      requestHandler({
        url: () => url,
        isInterceptResolutionHandled: () => false,
        continue() {
          handlers.continueCalls.push(url);
        },
        abort() {
          handlers.abortCalls.push(url);
        },
      });
    },
  };
  return page;
}

function createMockCtx(db, configOverrides = {}, pageFactory = () => createFakePage()) {
  const middlewares = [];
  const logs = { info: [], warn: [], error: [] };
  const fmt = (args) => args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');

  const ctx = {
    baseDir: ROOT,
    database: db,
    puppeteer: {
      page: () => pageFactory(),
    },
    model: {
      extend(table, _fields, opts = {}) {
        if (opts.primary) db.setPrimary(table, opts.primary);
      },
    },
    logger() {
      return {
        info: (...a) => logs.info.push(fmt(a)),
        warn: (...a) => logs.warn.push(fmt(a)),
        error: (...a) => logs.error.push(fmt(a)),
      };
    },
    middleware(fn) {
      middlewares.push(fn);
    },
    setInterval() {
      return {};
    },
    setTimeout() {
      return {};
    },
    async dispatch(session) {
      let nextCalled = false;
      const ret = await middlewares[0](session, async () => {
        nextCalled = true;
        return 'NEXT';
      });
      return { ret, nextCalled };
    },
    logs,
  };

  Plugin.apply(ctx, {
    webUrl: 'https://gkms.134491.xyz',
    apiBaseUrl: 'https://gkms.134491.xyz',
    dataDir: DATA_DIR,
    requireAt: true,
    allowDirectWithoutAt: true,
    cooldownSeconds: 20,
    bindSuccessRecallSeconds: 30,
    boxQueryRecallSeconds: 30,
    botDisplayName: 'Hiro',
    ...configOverrides,
  });

  return ctx;
}

function createSession(text, overrides = {}) {
  const sent = [];
  return {
    platform: 'qq',
    selfId: 'bot001',
    userId: 'u100',
    channelId: 'ch1',
    username: '制作人',
    author: { nick: '制作人' },
    isDirect: false,
    content: `<at id="bot001"/> ${text}`,
    elements: [
      { type: 'at', attrs: { id: 'bot001' }, children: [] },
      { type: 'text', attrs: { content: ` ${text}` }, children: [] },
    ],
    stripped: { appel: true, content: text },
    sent,
    async send(payload) {
      sent.push(payload);
      return [`msg-${sent.length}`];
    },
    bot: {
      async deleteMessage() {},
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// G-H1：恶意 Base64 与恶意昵称一律以 h.text 输出并做截断
// ---------------------------------------------------------------------------
test('G-H1: 恶意 Base64 解码报错与恶意昵称一律输出为 text 元素且截断', async () => {
  const db = createMockDb();
  const ctx = createMockCtx(db);

  // 1. 恶意 Base64 解码为 <at type="all"/> + 超长内容
  const evilRaw = '<at type="all"/>' + 'A'.repeat(120);
  const evilB64 = Buffer.from(evilRaw).toString('base64');
  const { ret: bindRet, nextCalled } = await ctx.dispatch(createSession(`绑定 ${evilB64}`));
  assert.equal(nextCalled, false);
  assert.equal(bindRet.type, 'text', '绑定失败提示必须是 h.text 元素而非原始字符串');
  assert.ok(bindRet.attrs.content.includes('绑定失败：'));
  assert.ok(bindRet.attrs.content.includes('…'), '超 80 字的错误内容应截断');
  assert.ok(bindRet.attrs.content.length < 140);

  // 2. 先绑定成功，再构造超长恶意昵称查box（无图文字统计/失败兜底路径也均经 textReply）
  await db.upsert('gkms_box_binding', [
    {
      userKey: 'qq:u100',
      shortCode: '',
      supportCode: 'My0wLTQ=',
      cidolCode: '',
      supportCount: 1,
      cidolCount: 0,
      updatedAt: new Date(),
    },
  ]);

  // 制造一个返回 oversized 的 ctx 来检查纯文本响应里的 ownerLabel 截断与 h.text 包装
  const oversizedCtx = createMockCtx(db, {}, () =>
    createFakePage({ onScreenshot: () => Buffer.alloc(Renderer.MAX_JPEG_BYTES + 100) })
  );
  const evilNick = '<img src="file:///etc/passwd"/>'.repeat(3);
  const qSession = createSession('查box', {
    author: { nick: evilNick },
    username: evilNick,
  });
  const { ret: qRet } = await oversizedCtx.dispatch(qSession);
  assert.equal(qRet.type, 'text', 'oversized 统计回退必须返回 h.text 元素');
  assert.ok(!qRet.attrs.content.includes(evilNick), '恶意超长昵称应截断为 <=32 字');
  assert.ok(qRet.attrs.content.includes('…'));
});

// ---------------------------------------------------------------------------
// G-M1：绑定正则收紧与 help 触发词收紧
// ---------------------------------------------------------------------------
test('G-M1: 闲聊「绑定 原神 1234」与单独「box」放行 next()；有效绑定语法正常触发', async (t) => {
  const db = createMockDb();
  const ctx = createMockCtx(db);

  // 非法/普通聊天绑定应放行
  assert.equal((await ctx.dispatch(createSession('绑定 原神 1234'))).nextCalled, true);
  assert.equal((await ctx.dispatch(createSession('绑定身份证后无法解绑怎么办'))).nextCalled, true);
  // 单独 box 应放行；绑定 / box帮助 触发帮助
  assert.equal((await ctx.dispatch(createSession('box'))).nextCalled, true);
  assert.equal((await ctx.dispatch(createSession('box 怎么用'))).nextCalled, true);

  const helpRes = await ctx.dispatch(createSession('box帮助'));
  assert.equal(helpRes.nextCalled, false);
  assert.equal(helpRes.ret.type, 'text');
  assert.match(helpRes.ret.attrs.content, /学园偶像大师 BOX 助手/);

  // 绑定My0wLTQ=（无空格）成功
  const sDirect = createSession('绑定My0wLTQ=');
  const res1 = await ctx.dispatch(sDirect);
  assert.equal(res1.nextCalled, false);
  assert.equal(sDirect.sent.length, 1);
  assert.equal(sDirect.sent[0].type, 'text');
  assert.match(sDirect.sent[0].attrs.content, /BOX 绑定成功/);

  // Mock fetch 测试 绑定+g12345678 与 绑定box g12345678
  t.mock.method(globalThis, 'fetch', async () =>
    new Response(JSON.stringify({ code: 'g12345678', box: 'My0wLTQ=', cidol: '' }), { status: 200 })
  );
  const sPlus = createSession('绑定+g12345678');
  await ctx.dispatch(sPlus);
  assert.match(sPlus.sent[0].attrs.content, /BOX 绑定成功/);

  const sBox = createSession('绑定box g12345678');
  await ctx.dispatch(sBox);
  assert.match(sBox.sent[0].attrs.content, /BOX 绑定成功/);
});

// ---------------------------------------------------------------------------
// G-M2 & L3 & L4 & L8 & L13
// ---------------------------------------------------------------------------
test('G-M2 / L3 / L4 / L8 / L13 边界安全与异常兜底检查', async (t) => {
  // G-M2: sendAndAutoRecall 异常兜底与 oversized 分支
  const logger = { info() {}, warn() {}, error() {} };
  const dummyCtx = { setTimeout() {} };
  const sErrWithFallback = createSession('', {
    async send(payload) {
      sErrWithFallback.sent.push(payload);
      if (sErrWithFallback.sent.length === 1) throw new Error('send image failed');
      return ['fallback-1'];
    },
  });
  const r1 = await Plugin.sendAndAutoRecall(
    dummyCtx,
    sErrWithFallback,
    ['img'],
    30,
    logger,
    '拼图',
    '文字兜底内容'
  );
  assert.equal(r1, undefined, '绝不返回原 payload 导致框架重发');
  assert.equal(sErrWithFallback.sent.length, 2);
  assert.equal(sErrWithFallback.sent[1].type, 'text');
  assert.equal(sErrWithFallback.sent[1].attrs.content, '文字兜底内容');

  const sErrNoFallback = createSession('', {
    async send() {
      throw new Error('send bind failed');
    },
  });
  const r2 = await Plugin.sendAndAutoRecall(dummyCtx, sErrNoFallback, 'hi', 30, logger, '绑定');
  assert.equal(r2, undefined);

  // L3: fetchShortBindRecord 限制响应体积与字段类型
  t.mock.method(globalThis, 'fetch', async () =>
    new Response('ok', { status: 200, headers: { 'content-length': String(300000) } })
  );
  await assert.rejects(Plugin.fetchShortBindRecord('https://box.example.com', 'g12345678'), /体积异常/);

  t.mock.restoreAll();
  t.mock.method(globalThis, 'fetch', async () =>
    new Response('{' + '"a":"' + 'x'.repeat(270000) + '"}', { status: 200 })
  );
  await assert.rejects(Plugin.fetchShortBindRecord('https://box.example.com', 'g12345678'), /体积异常/);

  t.mock.restoreAll();
  t.mock.method(globalThis, 'fetch', async () =>
    new Response(JSON.stringify([]), { status: 200 })
  );
  await assert.rejects(Plugin.fetchShortBindRecord('https://box.example.com', 'g12345678'), /格式无效/);

  t.mock.restoreAll();
  t.mock.method(globalThis, 'fetch', async () =>
    new Response(JSON.stringify({ box: 123 }), { status: 200 })
  );
  await assert.rejects(Plugin.fetchShortBindRecord('https://box.example.com', 'g12345678'), /box 格式无效/);

  // 中间件测试 L8 + L4
  const db = createMockDb();
  const ctx = createMockCtx(db);

  // L8: 无 session.userId 拒绝
  const noUserRes = await ctx.dispatch(createSession('查box', { userId: '' }));
  assert.equal(noUserRes.ret.type, 'text');
  assert.match(noUserRes.ret.attrs.content, /无法识别你的账号/);

  // L4: 全角 ＠某人 与 @他人元素均拦截
  const fullWidthAt = await ctx.dispatch(createSession('查box ＠小明'));
  assert.match(fullWidthAt.ret.attrs.content, /不支持 @群友/);

  const halfWidthAt = await ctx.dispatch(createSession('查box @小明'));
  assert.match(halfWidthAt.ret.attrs.content, /不支持 @群友/);

  const otherAtEl = await ctx.dispatch(
    createSession('查box', {
      elements: [
        { type: 'at', attrs: { id: 'bot001' }, children: [] },
        { type: 'text', attrs: { content: ' 查box' }, children: [] },
        { type: 'at', attrs: { id: 'other999' }, children: [] },
      ],
    })
  );
  assert.match(otherAtEl.ret.attrs.content, /不支持 @群友/);

  // L13: 单字别名精确匹配（「广」命中，「广州」不命中）
  assert.equal(Plugin.resolveCharacterFilter('广州', characters), null);
  assert.equal(Plugin.resolveCharacterFilter('广', characters)?.code, 'shro');
  assert.equal(Plugin.resolveCharacterFilter('筱泽广', characters)?.code, 'shro');
});

// ---------------------------------------------------------------------------
// G-M5 & L5: 排队上限与失败清除冷却
// ---------------------------------------------------------------------------
test('G-M5 & L5: 渲染排队 >=4 直接拦截不扣冷却；普通失败退还冷却，「拼图过长」保留冷却', async () => {
  const db = createMockDb();
  for (let i = 1; i <= 5; i += 1) {
    await db.upsert('gkms_box_binding', [
      {
        userKey: `qq:u${i}`,
        shortCode: '',
        supportCode: 'My0wLTQ=',
        cidolCode: '',
        supportCount: 1,
        cidolCount: 0,
        updatedAt: new Date(),
      },
    ]);
  }

  let releaseFirst;
  const firstGate = new Promise((r) => {
    releaseFirst = r;
  });
  let notifyFirstEntered;
  const firstEntered = new Promise((r) => {
    notifyFirstEntered = r;
  });
  let firstCall = true;
  const ctx = createMockCtx(db, { cooldownSeconds: 60 }, async () => {
    if (firstCall) {
      firstCall = false;
      notifyFirstEntered();
      await firstGate;
    }
    return createFakePage();
  });

  const p1 = ctx.dispatch(createSession('查box', { userId: 'u1' }));
  const p2 = ctx.dispatch(createSession('查box', { userId: 'u2' }));
  const p3 = ctx.dispatch(createSession('查box', { userId: 'u3' }));
  const p4 = ctx.dispatch(createSession('查box', { userId: 'u4' }));
  try {
    await firstEntered;
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(Renderer.getPendingRenderCount(), 4);

    // 第 5 个用户直接提示排队过多，且不写入冷却
    const p5 = await ctx.dispatch(createSession('查box', { userId: 'u5' }));
    assert.match(p5.ret.attrs.content, /排队较多/);
  } finally {
    releaseFirst();
    await Promise.allSettled([p1, p2, p3, p4]);
  }
  assert.equal(Renderer.getPendingRenderCount(), 0);

  // 第 5 个用户此前未扣冷却，现在应当能立即成功发起拼图（不再提示排队或冷却）
  const s5Again = createSession('查box', { userId: 'u5' });
  await ctx.dispatch(s5Again);
  assert.equal(s5Again.sent.length, 1);

  // L5: 普通渲染异常退还冷却 -> 马上再查不报冷却；「拼图过长」保留冷却 -> 马上再查提示冷却
  let mode = 'fail';
  const ctxFail = createMockCtx(db, { cooldownSeconds: 60 }, async () => {
    if (mode === 'fail') throw new Error('chrome crashed');
    if (mode === 'toolong') return createFakePage({ boundingBox: { x: 0, y: 0, width: 1400, height: 32000 } });
    return createFakePage();
  });

  const f1 = await ctxFail.dispatch(createSession('查box', { userId: 'u1' }));
  assert.match(f1.ret.attrs.content, /拼图生成暂时失败/);

  mode = 'toolong';
  // 此前普通失败已删冷却，本次应真正执行并命中「拼图过长」
  const f2 = await ctxFail.dispatch(createSession('查box', { userId: 'u1' }));
  assert.match(f2.ret.attrs.content, /拼图过长/);

  // 「拼图过长」保留了冷却，紧接着再查应提示冷却中
  mode = 'ok';
  const f3 = await ctxFail.dispatch(createSession('查box', { userId: 'u1' }));
  assert.match(f3.ret.attrs.content, /拼图正在冷却中/);
});

// ---------------------------------------------------------------------------
// renderer.js: escapeHtml、请求拦截、超时关闭 page、过长拒绝、dataURL 缓存
// ---------------------------------------------------------------------------
test('renderer.js: HTML 转义、请求拦截、超时关 page、过长拦截与缓存机制', async () => {
  // 1. escapeHtml 包含单引号等特殊字符
  assert.equal(
    Renderer.escapeHtml(`<script>'a'&"b"</script>`),
    '&lt;script&gt;&#39;a&#39;&amp;&quot;b&quot;&lt;/script&gt;'
  );

  // 2. 请求拦截：只放行 data: 和 about:，拦截 http://
  const pageReq = createFakePage({
    async onSetContent(_html, p) {
      p.emitRequest('about:blank');
      p.emitRequest('data:image/webp;base64,AAA');
      p.emitRequest('http://127.0.0.1:5140/secret');
      p.emitRequest('https://evil.example.com/track.png');
    },
  });
  const basePayload = {
    mode: 'support',
    ownerLabel: 'Test',
    summary: {
      support: { owned: 0, total: 201, maxBreakTotal: 0 },
      cidol: { owned: 0, total: 100, ssrOwned: 0, percent: 0 },
    },
    supportItems: [],
    cidolItems: [],
    characters: {},
  };
  await Renderer.renderBoxImage({
    getPage: async () => pageReq,
    dataDir: DATA_DIR,
    htmlPayload: basePayload,
  });
  assert.deepEqual(pageReq.handlers.continueCalls, ['about:blank', 'data:image/webp;base64,AAA']);
  assert.deepEqual(pageReq.handlers.abortCalls, [
    'http://127.0.0.1:5140/secret',
    'https://evil.example.com/track.png',
  ]);
  assert.equal(pageReq.handlers.closed, true);

  // 3. 渲染超时主动 page.close() 并释放锁（pending 归零）
  const slowPage = createFakePage({
    onEvaluate: () => new Promise(() => {}), // 永不 resolve，强制超时
  });
  await assert.rejects(
    Renderer.renderBoxImage({
      getPage: async () => slowPage,
      dataDir: DATA_DIR,
      htmlPayload: basePayload,
      timeoutMs: 40,
    }),
    /超时/
  );
  assert.equal(slowPage.handlers.closed, true, '超时后必须主动关闭泄漏中的 page');
  assert.equal(Renderer.getPendingRenderCount(), 0, '超时后必须归零渲染队列计数');

  // 4. 画布高度 >= 32000px（scale < 0.5）抛「拼图过长」
  const tallPage = createFakePage({
    boundingBox: { x: 0, y: 0, width: 1400, height: 32000 },
  });
  await assert.rejects(
    Renderer.renderBoxImage({
      getPage: async () => tallPage,
      dataDir: DATA_DIR,
      htmlPayload: basePayload,
    }),
    /拼图过长/
  );
  assert.equal(tallPage.handlers.closed, true);

  // 5. fileToDataUrl 缓存命中与 clearDataUrlCache
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gkms-r-cache-'));
  try {
    const imgPath = path.join(tmpDir, 'card.webp');
    fs.writeFileSync(imgPath, Buffer.from('WEBP_TEST'));
    Renderer.clearDataUrlCache();
    assert.equal(Renderer.getDataUrlCacheSize(), 0);
    const u1 = Renderer.fileToDataUrl(imgPath);
    assert.ok(u1.startsWith('data:image/webp;base64,'));
    assert.equal(Renderer.getDataUrlCacheSize(), 1);
    const u2 = Renderer.fileToDataUrl(imgPath);
    assert.equal(u2, u1);
    Renderer.clearDataUrlCache();
    assert.equal(Renderer.getDataUrlCacheSize(), 0);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// hif配卡 指令端到端校验（纯图片回复、6卡渲染、XSS转义、冷却与排队）
// ---------------------------------------------------------------------------
test('hif配卡: 未绑定提示、绑定后严格只返回单张 6 配卡拼图、XSS 转义及冷却排队限制', async () => {
  assert.deepEqual(Plugin.parseHifDeckCommand('hif配卡 姬崎莉波 ガラクタロード'), {
    rawArg: '姬崎莉波 ガラクタロード',
  });
  assert.deepEqual(Plugin.parseHifDeckCommand('HIF 配卡 莉波 感性'), {
    rawArg: '莉波 感性',
  });
  assert.deepEqual(Plugin.parseHifDeckCommand('hif配卡'), { rawArg: '' });

  const db = createMockDb();
  const capturedPages = [];
  const ctx = createMockCtx(db, { cooldownSeconds: 60, boxQueryRecallSeconds: 30 }, () => {
    const p = createFakePage({ boundingBox: { x: 0, y: 0, width: 1200, height: 960 } });
    capturedPages.push(p);
    return p;
  });

  // 1. 未绑定用户先提示绑定
  const unbindRes = await ctx.dispatch(createSession('hif配卡 姬崎莉波 ガラクタロード'));
  assert.equal(unbindRes.nextCalled, false);
  assert.equal(unbindRes.ret.type, 'text');
  assert.match(unbindRes.ret.attrs.content, /还没有绑定支援卡 BOX/);

  // 2. 绑定真实 Base64 BOX（使用含 XSS 的昵称）
  const realB64 =
    'My0xMjItNCwzLTExNC0xLDMtMTEwLTQsMy0xMDctNCwzLTk2LTEsMy05NC0xLDMtOTItMCwzLTkwLTAsMy04OS0xLDMtODMtMSwzLTgyLTEsMy04MS0xLDMtNzktMSwzLTc4LTEsMy03Ni0wLDMtNzAtMCwzLTY5LTQsMy02Ni00LDMtNjQtNCwzLTYyLTAsMy01OC0zLDMtNTctMCwzLTU1LTAsMy00Ni0wLDMtNDQtMCwzLTQyLTAsMy0zNy0wLDMtMzUtMCwzLTM0LTMsMy0zMS0wLDMtMjgtMSwzLTI3LTMsMy0yNS00LDMtMjQtMCwzLTIyLTEsMy0xOC0wLDMtMTctMCwzLTE2LTAsMy0xMy0wLDMtMTItMSwzLTExLTIsMy05LTQsMy03LTQsMy02LTAsMy01LTQsMy00LTAsMy0zLTAsMy0yLTQsMy0wLTAsMi04Mi0wLDItODEtMCwyLTcyLTQsMi02OC0wLDItNjEtNCwyLTQzLTQsMi03LTQsMi0zLTQsMi0xLTQ=';
  await db.upsert('gkms_box_binding', [
    {
      userKey: 'qq:u100',
      shortCode: '',
      supportCode: realB64,
      cidolCode: '',
      supportCount: 58,
      cidolCount: 0,
      updatedAt: new Date(),
    },
  ]);

  // 2a. 缺少卡名且多流派时仅给文字引导，且不扣冷却
  const askPlanRes = await ctx.dispatch(createSession('hif配卡 姬崎莉波'));
  assert.equal(askPlanRes.ret.type, 'text');
  assert.match(askPlanRes.ret.attrs.content, /流派/);

  // 2b. 正常命中：严格只返回一张图片，且即使配置了 boxQueryRecallSeconds 也不会自动撤回
  let deleteCalls = 0;
  let timerCalls = 0;
  const origSetTimeout = ctx.setTimeout;
  ctx.setTimeout = (...args) => {
    timerCalls += 1;
    return origSetTimeout(...args);
  };
  const sessOk = createSession('hif配卡 姬崎莉波 ガラクタロード', {
    author: { nick: '<script>alert(1)</script>' },
    bot: {
      async deleteMessage() {
        deleteCalls += 1;
      },
    },
  });
  const okRes = await ctx.dispatch(sessOk);
  ctx.setTimeout = origSetTimeout;
  assert.equal(okRes.nextCalled, false);
  assert.equal(sessOk.sent.length, 0, '不应走自动撤回队列，应由中间件直接返图');
  assert.equal(timerCalls, 0, '不应调度自动撤回定时器');
  assert.equal(deleteCalls, 0, '不应触发 deleteMessage');
  const sentPayload = okRes.ret;
  assert.equal(Array.isArray(sentPayload), false, '不得返回含文字的多元素数组');
  assert.equal(sentPayload.type, 'image');
  assert.ok(Buffer.isBuffer(sentPayload.attrs.data));

  const html = capturedPages[0].handlers.html;
  const cardMatches = html.match(/class="h-card /g) || [];
  assert.equal(cardMatches.length, 6, '拼图必须严格展示 6 张支援卡');
  assert.ok(html.includes('借 · 满破'), '拼图必须包含借卡标识');
  assert.ok(html.includes('34990'), '拼图必须包含精准预计 HIF 总评 34990');
  assert.ok(html.includes('全局 +10%/+100'), '拼图注脚须标注 HIF 全局 +10%/+100');
  assert.ok(html.includes('ガラクタロード'), '拼图必须包含目标 P 卡名');
  assert.equal(html.includes('<script>alert(1)</script>'), false, '昵称 XSS 必须被转义');
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));

  // 2c. 冷却中再次请求应拦截
  const cdRes = await ctx.dispatch(createSession('hif配卡 姬崎莉波 ガラクタロード'));
  assert.equal(cdRes.ret.type, 'text');
  assert.match(cdRes.ret.attrs.content, /冷却中/);

  // 3. recallSeconds=0 时同样直接返回单个 image 元素（不含 text）
  const ctxNoRecall = createMockCtx(db, { cooldownSeconds: 0, boxQueryRecallSeconds: 0 }, () =>
    createFakePage({ boundingBox: { x: 0, y: 0, width: 1200, height: 960 } })
  );
  const directRes = await ctxNoRecall.dispatch(createSession('hif配卡 姬崎莉波 ガラクタロード'));
  assert.equal(directRes.ret.type, 'image');
  assert.equal(Array.isArray(directRes.ret), false);

  // 4. 渲染异常时自动退还冷却（立即重试可直接触发渲染）
  let failNext = true;
  const ctxFail = createMockCtx(db, { cooldownSeconds: 60, boxQueryRecallSeconds: 0 }, async () => {
    if (failNext) throw new Error('render crashed');
    return createFakePage({ boundingBox: { x: 0, y: 0, width: 1200, height: 960 } });
  });
  const errRes = await ctxFail.dispatch(createSession('hif配卡 姬崎莉波 ガラクタロード'));
  assert.equal(errRes.ret.type, 'text');
  assert.match(errRes.ret.attrs.content, /暂时失败/);

  failNext = false;
  const retryRes = await ctxFail.dispatch(createSession('hif配卡 姬崎莉波 ガラクタロード'));
  assert.equal(retryRes.ret.type, 'image');

  // 5. hif配卡 同样受 MAX_RENDER_PENDING (>=4) 排队拦截且不扣冷却
  for (let i = 1; i <= 5; i += 1) {
    await db.upsert('gkms_box_binding', [
      {
        userKey: `qq:hq${i}`,
        shortCode: '',
        supportCode: realB64,
        cidolCode: '',
        supportCount: 58,
        cidolCount: 0,
        updatedAt: new Date(),
      },
    ]);
  }
  let releaseQ;
  const gateQ = new Promise((r) => {
    releaseQ = r;
  });
  let notifyEnterQ;
  const enterQ = new Promise((r) => {
    notifyEnterQ = r;
  });
  let firstQ = true;
  const ctxQueue = createMockCtx(db, { cooldownSeconds: 60, boxQueryRecallSeconds: 0 }, async () => {
    if (firstQ) {
      firstQ = false;
      notifyEnterQ();
      await gateQ;
    }
    return createFakePage({ boundingBox: { x: 0, y: 0, width: 1200, height: 960 } });
  });
  const qp1 = ctxQueue.dispatch(createSession('hif配卡 姬崎莉波 ガラクタロード', { userId: 'hq1' }));
  const qp2 = ctxQueue.dispatch(createSession('hif配卡 姬崎莉波 ガラクタロード', { userId: 'hq2' }));
  const qp3 = ctxQueue.dispatch(createSession('hif配卡 姬崎莉波 ガラクタロード', { userId: 'hq3' }));
  const qp4 = ctxQueue.dispatch(createSession('hif配卡 姬崎莉波 ガラクタロード', { userId: 'hq4' }));
  try {
    await enterQ;
    await new Promise((r) => setTimeout(r, 10));
    const qp5 = await ctxQueue.dispatch(createSession('hif配卡 姬崎莉波 ガラクタロード', { userId: 'hq5' }));
    assert.equal(qp5.ret.type, 'text');
    assert.match(qp5.ret.attrs.content, /排队较多/);
  } finally {
    releaseQ();
    await Promise.allSettled([qp1, qp2, qp3, qp4]);
  }
  const q5After = await ctxQueue.dispatch(createSession('hif配卡 姬崎莉波 ガラクタロード', { userId: 'hq5' }));
  assert.equal(q5After.ret.type, 'image');

  // 6. 带自定义参数代码（前置/后置）求解出图 & 非法参数码文字提示且不扣冷却
  const HifParamsCodec = require(path.join(ROOT, 'koishi-plugin', 'hif-params-codec.js'));
  const customCode = HifParamsCodec.encodeHifParams({
    ...HifParamsCodec.getDefaultParams(),
    mp1: 20,
    B40: 30,
    B44: 12,
  });
  const customPages = [];
  const ctxCustom = createMockCtx(db, { cooldownSeconds: 60, boxQueryRecallSeconds: 30 }, () => {
    const p = createFakePage({ boundingBox: { x: 0, y: 0, width: 1200, height: 960 } });
    customPages.push(p);
    return p;
  });

  // 6a. 非法参数码返回提示，且不写入冷却
  const badParamRes = await ctxCustom.dispatch(
    createSession('hif配卡 姬崎莉波 ガラクタロード hp1_!!!', { userId: 'u100' })
  );
  assert.equal(badParamRes.ret.type, 'text');
  assert.match(badParamRes.ret.attrs.content, /参数代码有误/);

  // 6b. 带合法参数码（放在卡名后面），直接返图、不撤回、底部含自定义参数说明且总评高于默认 34990
  const okParamRes = await ctxCustom.dispatch(
    createSession(`hif配卡 姬崎莉波 ガラクタロード ${customCode}`, { userId: 'u100' })
  );
  assert.equal(okParamRes.ret.type, 'image');
  assert.equal(Array.isArray(okParamRes.ret), false);
  const customHtml = customPages[0].handlers.html;
  assert.ok(customHtml.includes('自定义参数：'), '拼图注脚须显示自定义参数说明');
  assert.ok(customHtml.includes('一属回忆%=20%'), '自定义参数摘要应包含修改项');
  const ratingMatch = /预计 HIF 总评<\/div>\s*<div class="stat-v">(\d+)<\/div>/.exec(customHtml);
  assert.ok(ratingMatch && Number(ratingMatch[1]) > 34990, '自定义提高回忆%和饮料后总评应高于基准 34990');

  // 6c. 带参数码放在最前面的格式同样可被剥离解析
  const ctxPrefix = createMockCtx(db, { cooldownSeconds: 0, boxQueryRecallSeconds: 0 }, () =>
    createFakePage({ boundingBox: { x: 0, y: 0, width: 1200, height: 960 } })
  );
  const prefixRes = await ctxPrefix.dispatch(
    createSession(`hif配卡 ${customCode} 姬崎莉波 ガラクタロード`, { userId: 'u100' })
  );
  assert.equal(prefixRes.ret.type, 'image');
});
