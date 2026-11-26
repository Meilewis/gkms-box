import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Module, { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PLUGIN_DIR = path.join(ROOT, 'koishi-plugin');
const WEB_DATA_DIR = path.join(ROOT, 'web', 'public', 'data');

const HifPlanner = require(path.join(PLUGIN_DIR, 'hif-planner.js'));
const Codec = require(path.join(PLUGIN_DIR, 'codec.js'));

function loadPluginHelpers() {
  const STUB_ID = '\u0000koishi-stub-hif-test';
  const noop = () => noop;
  const schemaProxy = new Proxy(function schema() {}, {
    get: (_t, prop) => (prop === Symbol.toPrimitive ? () => '[Schema]' : schemaProxy),
    apply: () => schemaProxy,
  });
  const stub = { Schema: schemaProxy, h: { text: (s) => s, image: (d) => d } };
  const origResolve = Module._resolveFilename;
  const origLoad = Module._load;
  Module._resolveFilename = function (req, ...rest) {
    if (req === 'koishi') return STUB_ID;
    return origResolve.call(this, req, ...rest);
  };
  Module._load = function (req, ...rest) {
    if (req === 'koishi' || req === STUB_ID) return stub;
    return origLoad.call(this, req, ...rest);
  };
  try {
    return require(path.join(PLUGIN_DIR, 'index.js'));
  } finally {
    Module._resolveFilename = origResolve;
    Module._load = origLoad;
  }
}

const characters = JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, 'data', 'characters.json'), 'utf8'));
const supportCatalog = JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, 'data', 'support.json'), 'utf8'));
const cidolCatalog = JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, 'data', 'cidol.json'), 'utf8'));

const supportByKey = Object.fromEntries(supportCatalog.map((c) => [c.key, c]));
const cidolByKey = Object.fromEntries(cidolCatalog.map((c) => [c.key, c]));
const catalog = { characters, support: supportCatalog, supportByKey, cidol: cidolCatalog, cidolByKey };

const REAL_BOX_B64 =
  'My0xMjItNCwzLTExNC0xLDMtMTEwLTQsMy0xMDctNCwzLTk2LTEsMy05NC0xLDMtOTItMCwzLTkwLTAsMy04OS0xLDMtODMtMSwzLTgyLTEsMy04MS0xLDMtNzktMSwzLTc4LTEsMy03Ni0wLDMtNzAtMCwzLTY5LTQsMy02Ni00LDMtNjQtNCwzLTYyLTAsMy01OC0zLDMtNTctMCwzLTU1LTAsMy00Ni0wLDMtNDQtMCwzLTQyLTAsMy0zNy0wLDMtMzUtMCwzLTM0LTMsMy0zMS0wLDMtMjgtMSwzLTI3LTMsMy0yNS00LDMtMjQtMCwzLTIyLTEsMy0xOC0wLDMtMTctMCwzLTE2LTAsMy0xMy0wLDMtMTItMSwzLTExLTIsMy05LTQsMy03LTQsMy02LTAsMy01LTQsMy00LTAsMy0zLTAsMy0yLTQsMy0wLTAsMi04Mi0wLDItODEtMCwyLTcyLTQsMi02OC0wLDItNjEtNCwyLTQzLTQsMi03LTQsMi0zLTQsMi0xLTQ=';

const CHAR_ALIASES = {
  amao: ['amao', '有村麻央', '有村', '麻央'],
  atbm: ['atbm', '雨夜燕', '雨夜', '燕'],
  fktn: ['fktn', '藤田琴音', '藤田', '琴音'],
  hkne: ['hkne', '冰渡香名江', '冰渡', '香名江'],
  hmsz: ['hmsz', '秦谷美铃', '秦谷', '美铃'],
  hrnm: ['hrnm', '姬崎莉波', '姬崎', '莉波'],
  hski: ['hski', '花海咲季', '咲季', '大佑芽'],
  hume: ['hume', '花海佑芽', '佑芽'],
  jsna: ['jsna', '十王星南', '十王', '星南', '会长'],
  kcna: ['kcna', '仓本千奈', '仓本', '千奈'],
  kllj: ['kllj', '葛城莉莉娅', '葛城', '莉莉娅'],
  shro: ['shro', '筱泽广', '篠澤広', '筱泽', '广', 'hiro'],
  ssmk: ['ssmk', '紫云清夏', '紫云', '清夏'],
  ttmr: ['ttmr', '月村手毬', '月村', '手毬', '手球'],
};

test('HIF 引擎编译与 2895/2895 线性百分比校验通过', () => {
  const engine = HifPlanner.loadHifEngine(PLUGIN_DIR);
  assert.equal(engine.cardCount, 193);
  assert.equal(engine.totalChecks, 2895);
  assert.equal(engine.verifiedCount, 2895);
});

test('HIF 求解引擎三组黄金基准与 Python v2 100% 一致且耗时 < 2.5s', () => {
  const engine = HifPlanner.loadHifEngine(PLUGIN_DIR);

  // 1. 全 4 破 姬崎莉波 hrnm-3-017（含小饮料+16与三折叠+2）
  const t1 = Date.now();
  const r1 = HifPlanner.solveBestHifDeck(cidolByKey['hrnm-3-017'], null, engine, supportByKey);
  const dt1 = Date.now() - t1;
  assert.equal(r1.ok, true);
  assert.equal(r1.result.rating.finalRating, 35230);
  assert.equal(r1.result.effectiveTotal, 7159);
  assert.equal(r1.result.overflowLoss, 61);
  assert.equal(r1.result.ratio, '2 / 4');
  assert.equal(r1.result.trifoldDrinkActive, true);
  assert.equal(r1.result.trifoldDrinks, 2);
  assert.equal(r1.result.itemDrinksTotal, 18);
  assert.ok(dt1 < 2500, `全4破莉波求解耗时过久: ${dt1}ms`);

  // 2. 全 4 破 藤田琴音 fktn-3-013（含小饮料+16与三折叠+2）
  const t2 = Date.now();
  const r2 = HifPlanner.solveBestHifDeck(cidolByKey['fktn-3-013'], null, engine, supportByKey);
  const dt2 = Date.now() - t2;
  assert.equal(r2.ok, true);
  assert.equal(r2.result.rating.finalRating, 35198);
  assert.equal(r2.result.effectiveTotal, 7143);
  assert.equal(r2.result.overflowLoss, 76);
  assert.equal(r2.result.ratio, '4 / 2');
  assert.equal(r2.result.trifoldDrinkActive, true);
  assert.equal(r2.result.trifoldDrinks, 2);
  assert.equal(r2.result.itemDrinksTotal, 18);
  assert.ok(dt2 < 2500, `全4破琴音求解耗时过久: ${dt2}ms`);

  // 3. 真实用户 BOX (g41505436) + 姬崎莉波 hrnm-3-017
  const dec = Codec.decodeSupportBox(REAL_BOX_B64, supportByKey);
  assert.equal(dec.ok, true);
  const fullBoxLbs = Object.fromEntries(supportCatalog.map((c) => [c.key, -1]));
  Object.assign(fullBoxLbs, dec.map);

  const t3 = Date.now();
  const r3 = HifPlanner.solveBestHifDeck(cidolByKey['hrnm-3-017'], fullBoxLbs, engine, supportByKey);
  const dt3 = Date.now() - t3;
  assert.equal(r3.ok, true);
  const res3 = r3.result;
  assert.equal(res3.rating.finalRating, 34910);
  assert.equal(res3.effectiveTotal, 6999);
  assert.equal(res3.overflowLoss, 0);
  assert.equal(res3.ratio, '2 / 4');
  assert.equal(res3.trifoldDrinkActive, false);
  assert.equal(res3.trifoldDrinks, 0);
  assert.equal(res3.bigDrinkActive, false);
  assert.equal(res3.bigDrinks, 0);
  assert.equal(res3.cards.length, 6);
  // 8 天 SP 全蓝(二属 idx=2)，选拔蓝/黄/黄(slot 1,0,0)，营业累计黄+300/红+600
  assert.deepEqual(res3.spSeq, [2, 2, 2, 2, 2, 2, 2, 2]);
  assert.deepEqual(res3.examTargets, [1, 0, 0]);
  assert.deepEqual(res3.bizSplit, [300, 0, 600]);
  const borrowedCard = res3.cards.find((c) => c.borrowed);
  assert.ok(borrowedCard);
  assert.equal(borrowedCard.supportKey, '3-0099');
  assert.deepEqual(
    res3.cards.map((c) => c.supportKey).sort(),
    ['2-0007', '3-0055', '3-0064', '3-0069', '3-0070', '3-0099'].sort()
  );
  assert.ok(dt3 < 2500, `用户BOX莉波求解耗时过久: ${dt3}ms`);
  console.log(`HIF JS solve timings: allMaxHrnm=${dt1}ms, allMaxFktn=${dt2}ms, realBoxHrnm=${dt3}ms`);
});

test('HIF 引擎安全性校验：缺键默认未持有、禁止未持有小饮料白嫖加成、卡数不足优雅报错', () => {
  const engine = HifPlanner.loadHifEngine(PLUGIN_DIR);

  // 1. 仅传入少量 4 破卡（且不包含 2-0007 小饮料），缺失卡不得被误当 4 破，也不能白嫖小饮料+16瓶
  const sparseBox = {
    '3-0064': 4, // 黄绝好调 (Vi 感性)
    '3-0107': 4, // 向日葵 (Vo 感性)
    '3-0069': 4, // 马自立 (Da 通用)
    '3-0070': 4, // oi! (Da 感性)
    '3-0055': 4, // 相册 (Da 感性)
  };
  const r = HifPlanner.solveBestHifDeck(cidolByKey['hrnm-3-017'], sparseBox, engine, supportByKey);
  assert.equal(r.ok, true);
  // 缺失键不得当成 4 破三折叠/本番前昼等多张入队：未借且不在 sparseBox 的卡绝不能出现
  for (const card of r.result.cards) {
    if (!card.borrowed) {
      assert.ok(Object.prototype.hasOwnProperty.call(sparseBox, card.supportKey), `未持有卡被误算入队: ${card.supportKey}`);
    }
  }
  // 借卡位如果给了本番前昼，小饮料绝不应该出现在队伍中或激活额外饮料；且未持有三折叠/大饮料亦不得白嫖
  const hasMini = r.result.cards.some((c) => c.supportKey === '2-0007');
  if (!hasMini) {
    assert.equal(r.result.miniDrinkActive, false);
    assert.equal(r.result.miniDrinks, 0);
  }
  assert.equal(r.result.trifoldDrinkActive, false);
  assert.equal(r.result.trifoldDrinks, 0);
  assert.equal(r.result.bigDrinkActive, false);
  assert.equal(r.result.bigDrinks, 0);

  // 2. 持有大饮料 (3-0030) 时触发 +min(B25, 4) 饮料联动，且 B25=2 时精确衰减为 +2 瓶
  const bigDrinkBox = {
    '3-0030': 4, // 大饮料 (Da 感性)
    '3-0064': 4, // 黄绝好调
    '3-0069': 4, // 马自立
    '3-0070': 4, // oi!
    '3-0099': 4, // 本番前昼
  };
  const rBigDefault = HifPlanner.solveBestHifDeck(cidolByKey['hrnm-3-017'], bigDrinkBox, engine, supportByKey);
  assert.equal(rBigDefault.ok, true);
  assert.equal(rBigDefault.result.bigDrinkActive, true);
  assert.equal(rBigDefault.result.bigDrinks, 4);
  assert.equal(rBigDefault.result.itemDrinksTotal, 20);

  const rBigCap2 = HifPlanner.solveBestHifDeck(cidolByKey['hrnm-3-017'], bigDrinkBox, engine, supportByKey, {
    actionOverrides: { B25: 2 },
  });
  assert.equal(rBigCap2.ok, true);
  assert.equal(rBigCap2.result.bigDrinkActive, true);
  assert.equal(rBigCap2.result.bigDrinks, 2);

  // 3. 卡数不足 5 张无法凑齐 6 卡（5+1借）时返回优雅错误
  const tinyBox = { '3-0064': 4, '3-0069': 4 };
  const rTiny = HifPlanner.solveBestHifDeck(cidolByKey['hrnm-3-017'], tinyBox, engine, supportByKey);
  assert.equal(rTiny.ok, false);
  assert.match(rTiny.error, /数量不足/);
});

test('resolveIdolForHif 智能匹配各类查询', () => {
  const ownedSet = { 'hrnm-3-017': true, 'amao-3-000': true };

  // P 卡 key 精确命中
  const byKey = HifPlanner.resolveIdolForHif('hrnm-3-017', catalog, ownedSet, CHAR_ALIASES);
  assert.equal(byKey.ok, true);
  assert.equal(byKey.idol.key, 'hrnm-3-017');

  // 角色 + 全角/日语卡名
  const byCharCard = HifPlanner.resolveIdolForHif('姬崎莉波 ガラクタロード', catalog, ownedSet, CHAR_ALIASES);
  assert.equal(byCharCard.ok, true);
  assert.equal(byCharCard.idol.key, 'hrnm-3-017');

  // 简称 + 中文流派 / 英文流派
  const byPlanZh = HifPlanner.resolveIdolForHif('莉波 感性', catalog, ownedSet, CHAR_ALIASES);
  assert.equal(byPlanZh.ok, true);
  assert.equal(byPlanZh.idol.character, 'hrnm');
  assert.equal(byPlanZh.idol.plan, 'Sense');

  const byPlanEn = HifPlanner.resolveIdolForHif('莉波 sense', catalog, ownedSet, CHAR_ALIASES);
  assert.equal(byPlanEn.ok, true);
  assert.equal(byPlanEn.idol.character, 'hrnm');
  assert.equal(byPlanEn.idol.plan, 'Sense');

  // 无空格连写（莉波感性）
  const byCompact = HifPlanner.resolveIdolForHif('莉波感性', catalog, ownedSet, CHAR_ALIASES);
  assert.equal(byCompact.ok, true);
  assert.equal(byCompact.idol.character, 'hrnm');
  assert.equal(byCompact.idol.plan, 'Sense');

  // 唯一 P 卡名
  const byUniqueCard = HifPlanner.resolveIdolForHif('Fluorite', catalog, ownedSet, CHAR_ALIASES);
  assert.equal(byUniqueCard.ok, true);
  assert.equal(byUniqueCard.idol.key, 'amao-3-000');

  // 同名卡 ガラクタロード：在持有列表唯一时自动消歧，否则提示歧义
  const disambigOwned = HifPlanner.resolveIdolForHif('ガラクタロード', catalog, { 'hrnm-3-017': true }, CHAR_ALIASES);
  assert.equal(disambigOwned.ok, true);
  assert.equal(disambigOwned.idol.key, 'hrnm-3-017');

  const ambiguous = HifPlanner.resolveIdolForHif('ガラクタロード', catalog, {}, CHAR_ALIASES);
  assert.equal(ambiguous.ok, false);
  assert.equal(ambiguous.reason, 'ambiguous_name');
  assert.ok(ambiguous.examples.length >= 2);

  // 多流派只输入角色名：提示补充流派或 P 卡名
  const onlyChar = HifPlanner.resolveIdolForHif('姬崎莉波', catalog, ownedSet, CHAR_ALIASES);
  assert.equal(onlyChar.ok, false);
  assert.equal(onlyChar.reason, 'need_plan_or_card');

  // 单流派角色（hkne 冰渡香名江）：直接命中最新 SSR Sense
  const singlePlanChar = HifPlanner.resolveIdolForHif('香名江', catalog, {}, CHAR_ALIASES);
  assert.equal(singlePlanChar.ok, true);
  assert.equal(singlePlanChar.idol.character, 'hkne');
  assert.equal(singlePlanChar.idol.plan, 'Sense');

  // 简繁/日文混写及日文原名/假名别名检索
  const mixedShro = HifPlanner.resolveIdolForHif('篠泽广 ガラクタロード', catalog, {}, CHAR_ALIASES);
  assert.equal(mixedShro.ok, true);
  assert.equal(mixedShro.idol.key, 'shro-3-018');
  assert.equal(mixedShro.idol.character, 'shro');

  const jpHrnm = HifPlanner.resolveIdolForHif('姫崎莉波 ガラクタロード', catalog, {}, CHAR_ALIASES);
  assert.equal(jpHrnm.ok, true);
  assert.equal(jpHrnm.idol.key, 'hrnm-3-017');

  const jpFktn = HifPlanner.resolveIdolForHif('藤田ことね 感性', catalog, {}, CHAR_ALIASES);
  assert.equal(jpFktn.ok, true);
  assert.equal(jpFktn.idol.character, 'fktn');
  assert.equal(jpFktn.idol.plan, 'Sense');

  const jpKllj = HifPlanner.resolveIdolForHif('葛城リーリヤ 理性', catalog, {}, CHAR_ALIASES);
  assert.equal(jpKllj.ok, true);
  assert.equal(jpKllj.idol.character, 'kllj');
  assert.equal(jpKllj.idol.plan, 'Logic');
});

test('网页端全量 315 张 P 卡与皮肤生成的「复制配卡指令」100% 精准命中目标角色与流派', () => {
  const Plugin = loadPluginHelpers();
  const webChars = JSON.parse(fs.readFileSync(path.join(WEB_DATA_DIR, 'characters.json'), 'utf8'));
  const webCidol = JSON.parse(fs.readFileSync(path.join(WEB_DATA_DIR, 'cidol.json'), 'utf8'));
  const webCidolByKey = Object.fromEntries(webCidol.map((c) => [c.key, c]));
  const webCatalog = { characters: webChars, cidol: webCidol, cidolByKey: webCidolByKey };

  assert.equal(webCidol.length, 315);
  let matched = 0;
  for (const s of webCidol) {
    const charName = webChars[s.character] || s.character.toUpperCase();
    const targetName = s.isSkinVariant && s.baseName ? s.baseName : s.name;
    const hifCmd = `hif配卡 ${charName} ${targetName}`;
    const parsed = Plugin.parseHifDeckCommand(hifCmd);
    assert.ok(parsed && parsed.rawArg, `指令解析失败: ${hifCmd}`);
    const resolved = HifPlanner.resolveIdolForHif(parsed.rawArg, webCatalog, {}, Plugin.CHAR_ALIASES);
    assert.equal(resolved.ok, true, `未命中 ${s.key}: ${hifCmd} => ${JSON.stringify(resolved)}`);
    assert.equal(resolved.idol.character, s.character, `角色不匹配 ${s.key}: ${hifCmd}`);
    assert.equal(resolved.idol.plan, s.plan, `流派不匹配 ${s.key}: ${hifCmd}`);
    matched += 1;
  }
  assert.equal(matched, 315);
});

test('HIF 参数编解码器前后端字节一致、边界拒绝与自定义求解生效', () => {
  const pluginCodecPath = path.join(PLUGIN_DIR, 'hif-params-codec.js');
  const webCodecPath = path.join(ROOT, 'web', 'public', 'hif-params-codec.js');
  assert.equal(
    fs.readFileSync(pluginCodecPath, 'utf8'),
    fs.readFileSync(webCodecPath, 'utf8'),
    'koishi-plugin 与 web/public 的 hif-params-codec.js 必须字节级完全一致'
  );

  const HifParamsCodec = require(pluginCodecPath);

  // 1. 全默认编码为空字符串，且默认三属回忆固值为 80 (4×20)，B41/B46 为 0
  const defaults = HifParamsCodec.getDefaultParams();
  assert.equal(defaults.mf3, 80);
  assert.equal(defaults.B41, 0);
  assert.equal(defaults.B46, 0);
  assert.equal(HifParamsCodec.encodeHifParams(defaults), '');

  // 2. 仅编码非默认修改项并无损回环解码
  const customParams = { ...defaults, mp1: 20, B40: 30, B39: 10, B44: 12 };
  const code = HifParamsCodec.encodeHifParams(customParams);
  assert.ok(code.startsWith('hp1_'));
  assert.ok(code.length < 64);

  const dec = HifParamsCodec.decodeHifParams(code);
  assert.equal(dec.ok, true);
  assert.equal(dec.code, code);
  assert.deepEqual(dec.overrides, { mp1: 20, B39: 10, B40: 30, B44: 12 });
  assert.deepEqual(dec.solveOptions.memPct, [20, 11.2, 0]);
  assert.equal(dec.solveOptions.baseDrinks, 30);
  assert.deepEqual(dec.solveOptions.actionOverrides, { B39: 10, B44: 12 });

  // 3. 安全拒收：B30 锁定不可改 / 未知键 / 越界 / 非整数 / 坏字符
  const badB30 = `hp1_${Buffer.from('B30=8', 'utf8').toString('base64url')}`;
  assert.equal(HifParamsCodec.decodeHifParams(badB30).ok, false);
  const badUnknown = `hp1_${Buffer.from('B99=1', 'utf8').toString('base64url')}`;
  assert.equal(HifParamsCodec.decodeHifParams(badUnknown).ok, false);
  const badFloat = `hp1_${Buffer.from('B40=20.5', 'utf8').toString('base64url')}`;
  assert.equal(HifParamsCodec.decodeHifParams(badFloat).ok, false);
  const badRange = `hp1_${Buffer.from('mp1=150', 'utf8').toString('base64url')}`;
  assert.equal(HifParamsCodec.decodeHifParams(badRange).ok, false);
  assert.equal(HifParamsCodec.decodeHifParams('hp1_!!!').ok, false);

  // 4. extractHifParamsCode 前置与后置均能正确剥离，多段拒绝
  const tailExt = HifParamsCodec.extractHifParamsCode(`姬崎莉波 ガラクタロード ${code}`);
  assert.equal(tailExt.ok, true);
  assert.equal(tailExt.hasParams, true);
  assert.equal(tailExt.remainQuery, '姬崎莉波 ガラクタロード');

  const headExt = HifParamsCodec.extractHifParamsCode(`HP1_${code.slice(4)} 莉波 感性`);
  assert.equal(headExt.ok, true);
  assert.equal(headExt.hasParams, true);
  assert.equal(headExt.decoded.code, code);
  assert.equal(headExt.remainQuery, '莉波 感性');

  const multiExt = HifParamsCodec.extractHifParamsCode(`莉波 ${code} ${code}`);
  assert.equal(multiExt.ok, false);

  // 5. 自定义参数进入 solveBestHifDeck 实际影响求解分数与面板
  const engine = HifPlanner.loadHifEngine(PLUGIN_DIR);
  const decBox = Codec.decodeSupportBox(REAL_BOX_B64, supportByKey);
  const fullBoxLbs = Object.fromEntries(supportCatalog.map((c) => [c.key, -1]));
  Object.assign(fullBoxLbs, decBox.map);

  const baseline = HifPlanner.solveBestHifDeck(cidolByKey['hrnm-3-017'], fullBoxLbs, engine, supportByKey);
  const customSolved = HifPlanner.solveBestHifDeck(
    cidolByKey['hrnm-3-017'],
    fullBoxLbs,
    engine,
    supportByKey,
    dec.solveOptions
  );
  assert.equal(baseline.ok, true);
  assert.equal(customSolved.ok, true);
  assert.ok(customSolved.result.rating.finalRating > baseline.result.rating.finalRating);
  assert.ok(customSolved.result.customSummary.includes('一属回忆%=20%'));

  // 6. 自定义参数下三折叠(+2瓶)自动助力 2/4 7蓝1黄 0溢出登顶 (35794)
  const triDec = HifParamsCodec.decodeHifParams(
    'hp1_QjM1PTQsQjM3PTIsQjM4PTQsQjM5PTIwLEI0MD0zMSxCNDQ9MTMsQjUwPTIsbWYzPTEwMCxtcDE9MTgsbXAyPTE3'
  );
  assert.equal(triDec.ok, true);
  const rTri = HifPlanner.solveBestHifDeck(
    cidolByKey['hrnm-3-017'],
    null,
    engine,
    supportByKey,
    triDec.solveOptions
  );
  assert.equal(rTri.ok, true);
  assert.equal(rTri.result.rating.finalRating, 35794);
  assert.equal(rTri.result.effectiveTotal, 7441);
  assert.equal(rTri.result.overflowLoss, 0);
  assert.equal(rTri.result.ratio, '2 / 4');
  assert.equal(rTri.result.trifoldDrinkActive, true);
  assert.equal(rTri.result.trifoldDrinks, 2);

  // 7. B41(敲卡) 与 B46(特别指导) 独立覆盖生效、彼此互不影响，且正确给猫头鹰(3-0063)加分
  const b41Code = HifParamsCodec.encodeHifParams({ ...defaults, B41: 6 });
  const b41Dec = HifParamsCodec.decodeHifParams(b41Code);
  assert.equal(b41Dec.ok, true);
  assert.deepEqual(b41Dec.solveOptions.actionOverrides, { B41: 6 });

  const b46Code = HifParamsCodec.encodeHifParams({ ...defaults, B46: 2 });
  const b46Dec = HifParamsCodec.decodeHifParams(b46Code);
  assert.equal(b46Dec.ok, true);
  assert.deepEqual(b46Dec.solveOptions.actionOverrides, { B46: 2 });

  const logicOwlBox = {
    '3-0063': 4, // 猫头鹰 (Vi 理性，敲卡 B41 上限6 × 11 = +66)
    '3-0092': 4, // Vi 理性
    '3-0099': 4, // Vi 通用
    '3-0105': 4, // Da 理性
    '3-0094': 4, // Da 理性
  };
  const rOwl0 = HifPlanner.solveBestHifDeck(cidolByKey['amao-3-002'], logicOwlBox, engine, supportByKey);
  const rOwl6 = HifPlanner.solveBestHifDeck(
    cidolByKey['amao-3-002'],
    logicOwlBox,
    engine,
    supportByKey,
    b41Dec.solveOptions
  );
  const rOwlB46Only = HifPlanner.solveBestHifDeck(
    cidolByKey['amao-3-002'],
    logicOwlBox,
    engine,
    supportByKey,
    b46Dec.solveOptions
  );
  assert.equal(rOwl0.ok, true);
  assert.equal(rOwl6.ok, true);
  assert.equal(rOwlB46Only.ok, true);
  const owl0 = rOwl0.result.cards.find((c) => c.supportKey === '3-0063');
  const owl6 = rOwl6.result.cards.find((c) => c.supportKey === '3-0063');
  const owlB46 = rOwlB46Only.result.cards.find((c) => c.supportKey === '3-0063');
  assert.ok(owl0 && owl6 && owlB46, '5 张测试 BOX 下猫头鹰应上阵');
  assert.equal(owl6.flat - owl0.flat, 66, 'B41=6 应精确为猫头鹰增加 6×11=+66 固值');
  assert.equal(owlB46.flat, owl0.flat, '仅改 B46 不应联动影响 B41 敲卡固值');
});
