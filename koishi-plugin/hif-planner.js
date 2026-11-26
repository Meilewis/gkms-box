(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  if (root && typeof root === 'object') {
    root.GkmsHifPlanner = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const fs = require('fs');
  const path = require('path');

  const ATTR_NAMES = { 1: '红(Vo)', 2: '蓝(Da)', 3: '黄(Vi)' };
  const ATTR_SHORT = { 1: '红', 2: '蓝', 3: '黄' };
  const ATTR_KEYS = { 1: 'vo', 2: 'da', 3: 'vi' };
  const ATTR_EN = { 1: 'VO', 2: 'DA', 3: 'VI' };
  const PLAN_NAMES = { 0: '通用', 1: '感性', 2: '理性', 3: '非凡' };
  const PLAN_MAP = { Sense: 1, Logic: 2, Anomaly: 3 };

  const STAT_CAP = 3200;
  const HIF_EXAM_LINES = [1960, 1307, 1089];

  // 13 位角色实测初始三维与成长率（与 hif_planner.py 完全对齐）
  const CHAR_BASE_STATS = {
    hume: { vo: 115, da: 120, vi: 125, voRate: 20.0, daRate: 23.0, viRate: 18.0 },
    hmsz: { vo: 95, da: 125, vi: 140, voRate: 27.0, daRate: 13.0, viRate: 20.0 },
    hski: { vo: 120, da: 125, vi: 135, voRate: 16.5, daRate: 16.5, viRate: 20.5 },
    ttmr: { vo: 120, da: 100, vi: 80, voRate: 27.0, daRate: 22.5, viRate: 11.5 },
    fktn: { vo: 95, da: 105, vi: 135, voRate: 11.0, daRate: 24.5, viRate: 22.5 },
    atbm: { vo: 115, da: 140, vi: 110, voRate: 17.0, daRate: 20.0, viRate: 13.0 },
    amao: { vo: 125, da: 90, vi: 115, voRate: 23.0, daRate: 11.0, viRate: 24.0 },
    kllj: { vo: 60, da: 80, vi: 95, voRate: 18.0, daRate: 20.0, viRate: 18.0 },
    kcna: { vo: 95, da: 125, vi: 135, voRate: 13.0, daRate: 24.0, viRate: 21.5 },
    ssmk: { vo: 105, da: 115, vi: 95, voRate: 12.0, daRate: 25.0, viRate: 24.0 },
    shro: { vo: 130, da: 125, vi: 95, voRate: 25.0, daRate: 19.5, viRate: 13.0 },
    jsna: { vo: 175, da: 125, vi: 140, voRate: 16.0, daRate: 13.0, viRate: 22.5 },
    hrnm: { vo: 85, da: 120, vi: 125, voRate: 13.0, daRate: 21.5, viRate: 25.5 },
  };

  // 扩展全部 14 位偶像常见简繁/日文原名与假名别称用于 P 卡检索
  const EXTRA_CHAR_ALIASES = {
    amao: ['まお'],
    atbm: ['つばめ'],
    fktn: ['藤田ことね', 'ことね'],
    hkne: ['氷渡香名江', 'かなえ'],
    hmsz: ['秦谷美鈴', 'みすず'],
    hrnm: ['姫崎莉波', '姫崎', 'りなみ'],
    hski: ['さき'],
    hume: ['うめ'],
    jsna: ['せな'],
    kcna: ['倉本千奈', '倉本', 'ちな'],
    kllj: ['葛城リーリヤ', 'リーリヤ', '莉莉亚'],
    shro: ['篠泽广', '篠泽', '広', 'ひろ'],
    ssmk: ['紫雲清夏', '紫雲', 'すみか'],
    ttmr: ['てまり'],
  };

  const PLAN_KEYWORDS = {
    Sense: ['感性', 'sense'],
    Logic: ['理性', 'logic'],
    Anomaly: ['非凡', '异常', 'anomaly'],
  };

  const SP_DAYS = ['2日', '4日', '9日', '11日', '15日', '18日', '本战2日', '本战5日'];
  const SP_PRIMARY_BONUS = [60, 80, 80, 100, 100, 120, 120, 140];
  const SP_OTHER_BONUS = [20, 50, 20, 60, 20, 70, 20, 80];

  const EXAM_FIXED = [20, 80, 100];
  const EXAM_ALLOC_VALS = [80, 200, 220];

  const BIZ_DAYS = ['3日', '6日', '10日', '17日', '本战1日', '本战4日'];
  const BIZ_VALUES = [120, 120, 150, 150, 180, 180];

  const ROUND1_SEGMENTS = [
    [30, 70, 100],
    [70, 100, 30],
    [100, 120, 20],
    [120, 140, 10],
  ];
  const ROUND2_SEGMENTS = [
    [60, 90, 40],
    [90, 150, 80],
    [150, 200, 20],
    [200, 240, 10],
  ];

  const BASE_HIF_ACTIONS = {
    B23: 6,
    B24: 12,
    B25: 10,
    B26: 10,
    B27: 12,
    B28: 2,
    B29: 2,
    B30: 6,
    B31: 2,
    B32: 0,
    B33: 2,
    B34: 4,
    B35: 6,
    B36: 3,
    B37: 3,
    B38: 3,
    B39: 0,
    B40: 20,
    B41: 4,
    B42: 10,
    B43: 12,
    B44: 10,
    B45: 12,
    B46: 1,
    B47: 6,
    B48: 2,
    B49: 4,
    B50: 5,
  };

  // 全量 22 种合理 6 卡配比 (n1+n2+n3=6, n3<=3)
  const DECK_RATIOS = [];
  for (let n3 = 0; n3 < 4; n3 += 1) {
    for (let n1 = 6 - n3; n1 >= 0; n1 -= 1) {
      const n2 = 6 - n3 - n1;
      const ratioName = n3 === 0 ? `${n1} / ${n2}` : `${n1} / ${n2} / ${n3}`;
      DECK_RATIOS.push([ratioName, [n1, n2, n3]]);
    }
  }

  // 严格实战日程树：能支就支，能进商店(相谈)就不特指，仅 5 日可选相谈/外出
  const HIF_ACTION_NODES_STRICT = [
    ['1日', ['支给']],
    ['5日', ['相谈', '外出']],
    ['8日', ['支给']],
    ['12日', ['相谈']],
    ['14日', ['支给']],
    ['16日', ['支给']],
    ['19日', ['相谈']],
    ['本战3日', ['支给']],
    ['本战6日', ['相谈']],
  ];

  function roundN(v, digits) {
    const f = Math.pow(10, digits);
    return Math.round(v * f) / f;
  }

  // ---------------------------------------------------------------------------
  // 安全表达式编译器（无 eval / Function，支持全部支援卡 Python 表达式子集）
  // ---------------------------------------------------------------------------
  function tokenizeExpr(src) {
    const tokens = [];
    let i = 0;
    const len = src.length;
    while (i < len) {
      const ch = src[i];
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
        i += 1;
        continue;
      }
      if (ch === "'") {
        let j = i + 1;
        let val = '';
        while (j < len && src[j] !== "'") {
          val += src[j];
          j += 1;
        }
        if (j >= len) throw new Error(`表达式字符串未闭合: ${src}`);
        tokens.push({ type: 'str', value: val });
        i = j + 1;
        continue;
      }
      if ((ch >= '0' && ch <= '9') || (ch === '.' && i + 1 < len && src[i + 1] >= '0' && src[i + 1] <= '9')) {
        const m = /^\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(src.slice(i));
        if (!m) throw new Error(`表达式数字解析失败: ${src.slice(i)}`);
        tokens.push({ type: 'num', value: Number(m[0]) });
        i += m[0].length;
        continue;
      }
      if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_') {
        const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
        const word = m[0];
        if (word === 'if' || word === 'else') {
          tokens.push({ type: 'kw', value: word });
        } else {
          tokens.push({ type: 'id', value: word });
        }
        i += word.length;
        continue;
      }
      const two = src.slice(i, i + 2);
      if (two === '==' || two === '!=' || two === '<=' || two === '>=') {
        tokens.push({ type: 'op', value: two });
        i += 2;
        continue;
      }
      if ('+-*/()[].,<>'.includes(ch)) {
        tokens.push({ type: 'punc', value: ch });
        i += 1;
        continue;
      }
      throw new Error(`表达式存在不支持的字符 "${ch}": ${src}`);
    }
    return tokens;
  }

  function compileCardExpr(exprStr) {
    const tokens = tokenizeExpr(exprStr);
    let pos = 0;
    const peek = () => tokens[pos] || null;
    const consume = () => {
      const t = tokens[pos];
      pos += 1;
      return t;
    };
    const expect = (type, value) => {
      const t = peek();
      if (!t || t.type !== type || (value !== undefined && t.value !== value)) {
        throw new Error(`表达式语法错误 (${exprStr}): 期望 ${value || type}, 实际 ${t ? t.value : 'EOF'}`);
      }
      pos += 1;
      return t;
    };

    function parsePrimary() {
      const t = peek();
      if (!t) throw new Error(`表达式意外结束: ${exprStr}`);
      if (t.type === 'num') {
        consume();
        const v = t.value;
        return () => v;
      }
      if (t.type === 'str') {
        consume();
        const v = t.value;
        return () => v;
      }
      if (t.type === 'punc' && t.value === '(') {
        consume();
        const inner = parseIfExpr();
        expect('punc', ')');
        return inner;
      }
      if (t.type === 'id') {
        consume();
        if (t.value === 'calc_seika') {
          return (_R, calcSeika) => Boolean(calcSeika);
        }
        if (t.value === 'R') {
          expect('punc', '[');
          const keyToken = expect('str');
          expect('punc', ']');
          const key = keyToken.value;
          return (R) => R[key] || 0;
        }
        if (t.value === 'math') {
          expect('punc', '.');
          const fn = expect('id', 'floor');
          void fn;
          expect('punc', '(');
          const argFn = parseIfExpr();
          expect('punc', ')');
          return (R, calcSeika) => Math.floor(argFn(R, calcSeika));
        }
        throw new Error(`表达式不支持的标识符 "${t.value}": ${exprStr}`);
      }
      throw new Error(`表达式意外符号 "${t.value}": ${exprStr}`);
    }

    function parseUnary() {
      const t = peek();
      if (t && t.type === 'punc' && (t.value === '-' || t.value === '+')) {
        consume();
        const operand = parseUnary();
        return t.value === '-' ? (R, s) => -operand(R, s) : operand;
      }
      return parsePrimary();
    }

    function parseMul() {
      let left = parseUnary();
      while (peek() && peek().type === 'punc' && (peek().value === '*' || peek().value === '/')) {
        const op = consume().value;
        const right = parseUnary();
        const prev = left;
        left = op === '*' ? (R, s) => prev(R, s) * right(R, s) : (R, s) => prev(R, s) / right(R, s);
      }
      return left;
    }

    function parseAdd() {
      let left = parseMul();
      while (peek() && peek().type === 'punc' && (peek().value === '+' || peek().value === '-')) {
        const op = consume().value;
        const right = parseMul();
        const prev = left;
        left = op === '+' ? (R, s) => prev(R, s) + right(R, s) : (R, s) => prev(R, s) - right(R, s);
      }
      return left;
    }

    function parseCmp() {
      let left = parseAdd();
      while (
        peek() &&
        ((peek().type === 'op' && ['==', '!=', '<=', '>='].includes(peek().value)) ||
          (peek().type === 'punc' && (peek().value === '<' || peek().value === '>')))
      ) {
        const op = consume().value;
        const right = parseAdd();
        const prev = left;
        if (op === '==') left = (R, s) => prev(R, s) === right(R, s);
        else if (op === '!=') left = (R, s) => prev(R, s) !== right(R, s);
        else if (op === '<=') left = (R, s) => prev(R, s) <= right(R, s);
        else if (op === '<') left = (R, s) => prev(R, s) < right(R, s);
        else if (op === '>=') left = (R, s) => prev(R, s) >= right(R, s);
        else left = (R, s) => prev(R, s) > right(R, s);
      }
      return left;
    }

    function parseIfExpr() {
      const bodyFn = parseCmp();
      if (peek() && peek().type === 'kw' && peek().value === 'if') {
        consume();
        const condFn = parseCmp();
        expect('kw', 'else');
        const elseFn = parseIfExpr();
        return (R, s) => (condFn(R, s) ? bodyFn(R, s) : elseFn(R, s));
      }
      return bodyFn;
    }

    const compiledFn = parseIfExpr();
    if (pos !== tokens.length) {
      throw new Error(`表达式存在未消费的尾随符号: ${exprStr}`);
    }
    return compiledFn;
  }

  // ---------------------------------------------------------------------------
  // 预计算常量表（营业分割 / SP序列 / 选拔分配 / 自由日日程）
  // ---------------------------------------------------------------------------
  function precomputeBizSplits() {
    const splits = [];
    const seen = new Set();
    const choices = new Array(6).fill(0);
    function dfs(dayIdx) {
      if (dayIdx === 6) {
        let s0 = 0;
        let s1 = 0;
        let s2 = 0;
        for (let i = 0; i < 6; i += 1) {
          if (choices[i] === 0) s0 += BIZ_VALUES[i];
          else if (choices[i] === 1) s1 += BIZ_VALUES[i];
          else s2 += BIZ_VALUES[i];
        }
        const key = `${s0},${s1},${s2}`;
        if (!seen.has(key)) {
          seen.add(key);
          splits.push({ split: [s0, s1, s2], choices: choices.slice() });
        }
        return;
      }
      for (let slot = 0; slot < 3; slot += 1) {
        choices[dayIdx] = slot;
        dfs(dayIdx + 1);
      }
    }
    dfs(0);
    return splits;
  }

  function precomputeSpSeqs() {
    const byCount = Array.from({ length: 9 }, () => []);
    const seen = new Set();
    for (let mask = 0; mask < 256; mask += 1) {
      // 保持与 Python itertools.product((1, 2), repeat=8) 完全一致顺序
      const seq = [];
      let sp1Count = 0;
      const ev0 = [];
      const ev1 = [];
      let sum0 = 0;
      let sum1 = 0;
      for (let w = 0; w < 8; w += 1) {
        const pick = ((mask >> (7 - w)) & 1) + 1;
        seq.push(pick);
        if (pick === 1) {
          sp1Count += 1;
          ev0.push(SP_PRIMARY_BONUS[w]);
          ev1.push(SP_OTHER_BONUS[w]);
          sum0 += SP_PRIMARY_BONUS[w];
          sum1 += SP_OTHER_BONUS[w];
        } else {
          ev1.push(SP_PRIMARY_BONUS[w]);
          ev0.push(SP_OTHER_BONUS[w]);
          sum1 += SP_PRIMARY_BONUS[w];
          sum0 += SP_OTHER_BONUS[w];
        }
      }
      const key = `${sp1Count}:${sum0}`;
      if (!seen.has(key)) {
        seen.add(key);
        byCount[sp1Count].push({
          seq,
          sp1Count,
          sp2Count: 8 - sp1Count,
          events: [ev0, ev1, []],
          sum0,
          sum1,
        });
      }
    }
    return byCount;
  }

  function precomputeExamAllocs() {
    const cands = [];
    for (let c1 = 0; c1 < 3; c1 += 1) {
      for (let c2 = 0; c2 < 3; c2 += 1) {
        for (let c3 = 0; c3 < 3; c3 += 1) {
          const ev = [
            EXAM_FIXED.slice(),
            EXAM_FIXED.slice(),
            EXAM_FIXED.slice(),
          ];
          ev[c1][0] += EXAM_ALLOC_VALS[0];
          ev[c2][1] += EXAM_ALLOC_VALS[1];
          ev[c3][2] += EXAM_ALLOC_VALS[2];
          cands.push({
            targets: [c1, c2, c3],
            events: ev,
          });
        }
      }
    }
    return cands;
  }

  function enumerateStrictActionCounts() {
    const seen = new Map();
    const nodeNames = HIF_ACTION_NODES_STRICT.map((x) => x[0]);
    const nodeOpts = HIF_ACTION_NODES_STRICT.map((x) => x[1]);
    const combo = new Array(nodeOpts.length);
    function dfs(idx) {
      if (idx === nodeOpts.length) {
        let consult = 0;
        let supply = 0;
        let outing = 0;
        let special = 0;
        for (const x of combo) {
          if (x === '相谈') consult += 1;
          else if (x === '支给') supply += 1;
          else if (x === '外出') outing += 1;
          else if (x === '特别指导') special += 1;
        }
        const key = `${consult},${supply},${outing},${special}`;
        if (!seen.has(key)) {
          const pathExample = nodeNames.map((day, i) => `${day}${combo[i]}`).join('/');
          seen.set(key, { consult, supply, outing, special, pathExample });
        }
        return;
      }
      for (const opt of nodeOpts[idx]) {
        combo[idx] = opt;
        dfs(idx + 1);
      }
    }
    dfs(0);
    return Array.from(seen.values());
  }

  const UNIQUE_BIZ_SPLITS = precomputeBizSplits();
  const UNIQUE_SP_SEQS_BY_COUNT = precomputeSpSeqs();
  const EXAM_ALLOC_CANDIDATES = precomputeExamAllocs();
  const STRICT_ACTION_COUNTS = enumerateStrictActionCounts();

  // ---------------------------------------------------------------------------
  // 引擎加载、预编译与线性校验
  // ---------------------------------------------------------------------------
  const engineCache = new Map();

  function resolveCardsDataPath(dataDir, explicitPath) {
    if (explicitPath && fs.existsSync(explicitPath)) return explicitPath;
    const candidates = [];
    if (dataDir) candidates.push(path.join(dataDir, 'data', 'hif_cards.json'));
    candidates.push(path.join(__dirname, 'data', 'hif_cards.json'));
    candidates.push(path.join(__dirname, '..', 'hif-planner', 'cards_data.json'));
    for (const p of candidates) {
      if (fs.existsSync(p)) return p;
    }
    throw new Error(`缺少 HIF 支援卡公式文件 hif_cards.json（已查找：${candidates.join(', ')}）`);
  }

  function loadHifEngine(dataDir, explicitPath) {
    const filePath = resolveCardsDataPath(dataDir, explicitPath);
    const stat = fs.statSync(filePath);
    const cached = engineCache.get(filePath);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return cached.engine;
    }

    const rawData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const cards = Array.isArray(rawData && rawData.cards) ? rawData.cards : [];
    const cardsById = new Map();
    const compiled = new Map();
    const pctTable = new Map();

    const rvZero = {};
    for (let i = 11; i <= 50; i += 1) {
      rvZero[`B${i}`] = i === 49 ? 4 : 10;
    }
    rvZero.B11 = 0;
    rvZero.B12 = 0;
    rvZero.B13 = 0;
    const rv1000 = { ...rvZero, B11: 1000, B12: 1000, B13: 1000 };

    let verified = 0;
    let total = 0;
    const pctRegex = /([0-9.]+)\s*\*\s*R\['B1[123]'\]/;

    for (const c of cards) {
      cardsById.set(c.id, c);
      const compCard = { noItem: [], withItem: [] };
      const pctCard = [];

      for (const mode of ['noItem', 'withItem']) {
        for (let lb = 0; lb < 5; lb += 1) {
          const exprs = c.exprs[mode][String(lb)];
          const fns = exprs.map((expr) => compileCardExpr(expr));
          compCard[mode][lb] = fns;

          if (mode === 'noItem') {
            const pcts = [];
            for (let si = 0; si < 3; si += 1) {
              const expr = exprs[si];
              const m = pctRegex.exec(expr);
              const pct = m ? roundN(parseFloat(m[1]) * 100.0, 4) : 0.0;
              pcts.push(pct);

              const v0 = Math.trunc(fns[si](rvZero, false));
              const v1 = Math.trunc(fns[si](rv1000, false));
              total += 1;
              if (Math.abs(v1 - v0 - Math.round(pct * 10.0)) <= 1) {
                verified += 1;
              } else {
                throw new Error(
                  `卡片百分比非线性校验失败: ${c.rawName} lb=${lb} slot=${si + 1}: diff=${v1 - v0}, pct=${pct}`
                );
              }
            }
            pctCard[lb] = pcts;
          }
        }
      }

      compiled.set(c.id, compCard);
      pctTable.set(c.id, pctCard);
    }

    const engine = {
      sourcePath: filePath,
      cardCount: cards.length,
      verifiedCount: verified,
      totalChecks: total,
      cards,
      cardsById,
      compiled,
      pctTable,
    };
    engineCache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, engine });
    return engine;
  }

  // ---------------------------------------------------------------------------
  // 核心算分与求解逻辑（与 Python v2 完全对齐）
  // ---------------------------------------------------------------------------
  function calcSegmentedScore(scoreWan, segments) {
    if (scoreWan <= 0) return 0.0;
    let total = 0.0;
    for (const [mn, mx, rate] of segments) {
      if (scoreWan <= mn) break;
      const overlap = roundN(Math.min(scoreWan, mx) - mn, 6);
      if (overlap > 0) {
        total = roundN(total + roundN(overlap * rate, 6), 6);
      }
    }
    return total;
  }

  function calcHifRating(effectiveStatSum, round1Wan = 140.0, round2Wan = 240.0, star = 1335) {
    const statScore = effectiveStatSum * 2;
    const starScore = roundN(star * 7.5, 6);
    const r1Score = calcSegmentedScore(round1Wan, ROUND1_SEGMENTS);
    const r2Score = calcSegmentedScore(round2Wan, ROUND2_SEGMENTS);
    const raw = roundN(statScore + starScore + r1Score + r2Score - 2000, 6);
    return {
      finalRating: Math.floor(raw),
      statScore,
      starScore,
      round1Score: r1Score,
      round2Score: r2Score,
    };
  }

  function getIdolRealStats(idol) {
    const ch = (idol && idol.character) || '';
    if (ch && Object.prototype.hasOwnProperty.call(CHAR_BASE_STATS, ch)) {
      return { ...CHAR_BASE_STATS[ch] };
    }
    return { ...(idol && idol.stats ? idol.stats : { vo: 100, da: 100, vi: 100, voRate: 15, daRate: 15, viRate: 15 }) };
  }

  function idolAttrOrder(stats) {
    const pairs = [
      [stats.voRate, stats.vo, 1],
      [stats.daRate, stats.da, 2],
      [stats.viRate, stats.vi, 3],
    ];
    pairs.sort((a, b) => b[0] - a[0] || b[1] - a[1]);
    return [pairs[0][2], pairs[1][2], pairs[2][2]];
  }

  function buildBaseRouteVars({ act, spSeq, extraDrinks = 0 }) {
    const r = { ...BASE_HIF_ACTIONS };
    r.B44 = 10;
    r.B33 = act.consult;
    r.B34 = act.supply;
    r.B31 = act.outing;
    r.B46 = act.special;
    r.B41 = act.special * 4;
    r.B30 = 6;
    r.B35 = 6;
    r.B32 = 0;
    r.B39 = 0;
    r.B49 = 4;
    r.B40 = 20 + extraDrinks;
    r.B11 = 0;
    r.B12 = 0;
    r.B13 = 0;

    let sp1 = 0;
    let sp2 = 0;
    let sp3 = 0;
    for (let i = 0; i < 8; i += 1) {
      const x = spSeq[i];
      if (x === 1) sp1 += 1;
      else if (x === 2) sp2 += 1;
      else if (x === 3) sp3 += 1;
    }
    r.B15 = sp1;
    r.B16 = 0;
    r.B14 = sp1;
    r.B18 = sp2;
    r.B19 = 0;
    r.B17 = sp2;
    r.B21 = sp3;
    r.B22 = 0;
    r.B20 = sp3;
    return r;
  }

  function evalCardsFlatAndPct(engine, slotAttrs, idolPlan, rvZero, boxLbs, calcItem = true, calcSeika = false) {
    const { cards, compiled, pctTable } = engine;
    const attrToSlot = { [slotAttrs[0]]: 0, [slotAttrs[1]]: 1, [slotAttrs[2]]: 2 };
    const byAttrPool = { 1: [], 2: [], 3: [] };
    let miniCard = null;

    for (const c of cards) {
      if (c.isMiniDrink) miniCard = c;
      if (c.plan !== 0 && c.plan !== idolPlan) continue;
      const sIdx = attrToSlot[c.attr];
      // 显式要求未持有为 -1，绝不缺省当成 4 破
      let lb = -1;
      if (boxLbs == null) {
        lb = 4;
      } else if (Object.prototype.hasOwnProperty.call(boxLbs, c.supportKey)) {
        const val = Number(boxLbs[c.supportKey]);
        lb = Number.isInteger(val) && val >= -1 && val <= 4 ? val : -1;
      }

      const useItem = c.isMiniDrink ? false : calcItem;
      const mode = useItem ? 'withItem' : 'noItem';
      const fns = compiled.get(c.id)[mode];
      const pcts = pctTable.get(c.id);

      const selfFlat = lb >= 0 ? Math.trunc(fns[lb][sIdx](rvZero, calcSeika)) : 0;
      const maxFlat = Math.trunc(fns[4][sIdx](rvZero, calcSeika));
      const selfPct = lb >= 0 ? pcts[lb][sIdx] : 0.0;
      const maxPct = pcts[4][sIdx];

      byAttrPool[c.attr].push({
        card: c,
        lb,
        useItem,
        owned: lb >= 0,
        isSp: c.isSp === 1,
        selfFlat,
        maxFlat,
        selfPct,
        maxPct,
      });
    }
    return { byAttrPool, miniCard };
  }

  function pickBestColorAtBlue({ pool, need, minSp, allowBorrow, extraMustIds, blueApprox }) {
    if (need < minSp) return null;
    if (need === 0) return extraMustIds.size === 0 ? [] : null;
    const extraItems = pool.filter((x) => extraMustIds.has(x.card.id));
    if (extraItems.length !== extraMustIds.size) return null;

    let bestTotal = -1;
    let bestPicks = null;

    let borrowCandidates = [null];
    if (allowBorrow) {
      const topBorrow = pool
        .slice()
        .sort(
          (a, b) =>
            b.maxFlat + (blueApprox * b.maxPct) / 100.0 - (a.maxFlat + (blueApprox * a.maxPct) / 100.0)
        )
        .slice(0, need + 6);
      const borrowIds = new Set();
      for (const x of topBorrow) borrowIds.add(x.card.id);
      for (const id of extraMustIds) borrowIds.add(id);
      borrowCandidates = Array.from(borrowIds).sort((a, b) => a - b);
    }

    for (const bId of borrowCandidates) {
      const entries = [];
      for (const x of pool) {
        const isBorrowed = x.card.id === bId;
        if (!isBorrowed && !x.owned) continue;
        const flat = isBorrowed ? x.maxFlat : x.selfFlat;
        const pct = isBorrowed ? x.maxPct : x.selfPct;
        const approxVal = flat + (blueApprox * pct) / 100.0;
        const must = extraMustIds.has(x.card.id);
        entries.push({ approxVal, flat, pct, isSp: x.isSp, must, item: x, isBorrowed });
      }

      const mustList = entries.filter((e) => e.must);
      // 严禁未持有强绑卡在未借到时被当作不占坑位白嫖联动
      if (mustList.length !== extraMustIds.size || mustList.length > need) continue;

      const remNeed = need - mustList.length;
      let mustSp = 0;
      for (const e of mustList) if (e.isSp) mustSp += 1;
      const needMoreSp = Math.max(0, minSp - mustSp);

      const optSp = entries.filter((e) => !e.must && e.isSp).sort((a, b) => b.approxVal - a.approxVal);
      const optNon = entries.filter((e) => !e.must && !e.isSp).sort((a, b) => b.approxVal - a.approxVal);

      if (optSp.length < needMoreSp || optSp.length + optNon.length < remNeed) continue;

      const chosen = mustList.concat(optSp.slice(0, needMoreSp));
      const restPool = optSp
        .slice(needMoreSp)
        .concat(optNon)
        .sort((a, b) => b.approxVal - a.approxVal);
      for (let i = 0; i < remNeed - needMoreSp; i += 1) {
        chosen.push(restPool[i]);
      }

      if (bId !== null && !chosen.some((e) => e.isBorrowed)) continue;

      let total = 0;
      for (const e of chosen) total += e.approxVal;
      if (total > bestTotal) {
        bestTotal = total;
        bestPicks = chosen;
      }
    }

    return bestPicks;
  }

  const BLUE_PROBES = [
    [450.0, 1200.0, 200.0],
    [850.0, 850.0, 200.0],
    [1350.0, 550.0, 200.0],
    [1750.0, 350.0, 420.0],
  ];

  function generateCandidateDecksForRatio({
    slotAttrs,
    ratioName,
    slotCounts,
    byAttrPool,
    miniCard,
    forceMiniDrink,
    colorPickCache,
  }) {
    const daSlot = slotAttrs.indexOf(2);
    if (forceMiniDrink) {
      if (slotCounts[daSlot] < 1) return [];
      if (!miniCard || !byAttrPool[2].some((x) => x.card.id === miniCard.id)) return [];
    }
    const blueExtraMust = new Set();
    if (forceMiniDrink && miniCard) blueExtraMust.add(miniCard.id);

    const borrowAttrChoices = [null];
    for (let s = 0; s < 3; s += 1) {
      if (slotCounts[s] > 0) borrowAttrChoices.push(slotAttrs[s]);
    }

    const seenDecks = new Map();

    for (const blues of BLUE_PROBES) {
      for (const bAttr of borrowAttrChoices) {
        const slotResults = [];
        const supPct = [0.0, 0.0, 0.0];
        const supFlat = [0, 0, 0];
        let borrowedInfo = null;
        let ok = true;

        for (let sIdx = 0; sIdx < 3; sIdx += 1) {
          const cnt = slotCounts[sIdx];
          const attr = slotAttrs[sIdx];
          const exMust = attr === 2 ? blueExtraMust : new Set();
          const exKey = exMust.size ? miniCard.id : '';
          const ckey = `${sIdx}:${cnt}:${bAttr === attr ? 1 : 0}:${exKey}:${blues[sIdx]}`;

          let picks;
          if (colorPickCache.has(ckey)) {
            picks = colorPickCache.get(ckey);
          } else {
            picks = pickBestColorAtBlue({
              pool: byAttrPool[attr],
              need: cnt,
              minSp: 0,
              allowBorrow: bAttr === attr,
              extraMustIds: exMust,
              blueApprox: blues[sIdx],
            });
            colorPickCache.set(ckey, picks);
          }

          if (!picks) {
            ok = false;
            break;
          }

          for (const pick of picks) {
            supFlat[sIdx] += pick.flat;
            supPct[sIdx] = roundN(supPct[sIdx] + pick.pct, 4);
            const c = pick.item.card;
            slotResults.push({
              id: c.id,
              supportKey: c.supportKey,
              slot: sIdx + 1,
              attr,
              rawName: c.rawName,
              jpName: c.jpName,
              isSp: pick.isSp,
              lb: pick.isBorrowed ? 4 : pick.item.lb,
              useItem: pick.item.useItem,
              flat: pick.flat,
              pct: pick.pct,
              borrowed: pick.isBorrowed,
              isMiniDrink: Boolean(c.isMiniDrink),
              itemNote: c.itemNote || '',
            });
            if (pick.isBorrowed) {
              borrowedInfo = `【借】${c.rawName} (放${ATTR_SHORT[attr]}/第${sIdx + 1}属)`;
            }
          }
        }

        if (!ok) continue;

        const deckKey = slotResults
          .map((it) => `${it.slot}:${it.id}:${it.borrowed ? 1 : 0}`)
          .sort()
          .join('|');
        if (!seenDecks.has(deckKey)) {
          seenDecks.set(deckKey, {
            ratio: ratioName,
            slotCounts,
            cards: slotResults,
            supPct,
            supFlat,
            borrowed: borrowedInfo || '无(自持最优)',
            miniDrinkActive: forceMiniDrink,
          });
        }
      }
    }

    return Array.from(seenDecks.values());
  }

  function allocateBusinessStats(p0, p1, p2, bizCache) {
    const useNumKey = p0 >= 0 && p0 < 65536 && p1 >= 0 && p1 < 65536 && p2 >= 0 && p2 < 65536;
    const key = useNumKey ? (p0 * 65536 + p1) * 65536 + p2 : `${p0},${p1},${p2}`;
    const cached = bizCache.get(key);
    if (cached) return cached;

    let bestKey = null;
    let bestRes = null;

    for (const item of UNIQUE_BIZ_SPLITS) {
      const [b0, b1, b2] = item.split;
      const r0 = p0 + b0;
      const r1 = p1 + b1;
      const r2 = p2 + b2;
      const c0 = r0 > STAT_CAP ? STAT_CAP : r0;
      const c1 = r1 > STAT_CAP ? STAT_CAP : r1;
      const c2 = r2 > STAT_CAP ? STAT_CAP : r2;
      const effSum = c0 + c1 + c2;
      const overflow = r0 - c0 + (r1 - c1) + (r2 - c2);
      const shortfall =
        Math.max(0, HIF_EXAM_LINES[0] - c0) +
        Math.max(0, HIF_EXAM_LINES[1] - c1) +
        Math.max(0, HIF_EXAM_LINES[2] - c2);

      const rank = [effSum, -overflow, -shortfall, c0, c1, c2];
      let better = bestKey === null;
      if (!better) {
        for (let i = 0; i < 6; i += 1) {
          if (rank[i] !== bestKey[i]) {
            better = rank[i] > bestKey[i];
            break;
          }
        }
      }
      if (better) {
        bestKey = rank;
        bestRes = {
          bizSplit: [b0, b1, b2],
          bizChoices: item.choices,
          cappedStats: [c0, c1, c2],
          rawStats: [r0, r1, r2],
          effectiveTotal: effSum,
          overflowLoss: overflow,
        };
      }
    }

    bizCache.set(key, bestRes);
    return bestRes;
  }

  function compareSortKeys(a, b) {
    for (let i = 0; i < a.length; i += 1) {
      if (a[i] !== b[i]) return a[i] - b[i];
    }
    return 0;
  }

  function solveBestHifDeck(idol, boxLbs, engine, supportByKey, options = {}) {
    if (!idol) return { ok: false, error: '未指定目标 P 卡。' };
    const idolPlan = PLAN_MAP[idol.plan];
    if (!idolPlan) {
      return { ok: false, error: `暂不支持的 P 卡流派: ${idol.plan}` };
    }

    const round1Wan = options.round1Wan ?? 140.0;
    const round2Wan = options.round2Wan ?? 240.0;
    const star = options.star ?? 1335;
    const memPct = options.memPct || [11.2, 11.2, 0.0];
    const memFlat = options.memFlat || [0, 0, 120];
    const calcItem = options.calcItem !== undefined ? Boolean(options.calcItem) : true;
    const calcSeika = Boolean(options.calcSeika);

    const realStats = getIdolRealStats(idol);
    const slotAttrs = idolAttrOrder(realStats);
    const daSlot = slotAttrs.indexOf(2);

    const bizCache = new Map();
    const spGainCache = new Map();
    const exGainCache = new Map();

    const getSpGainArr = (sp1Count, s, totalPctVal, spVariants) => {
      const ck = `${sp1Count}:${s}:${totalPctVal}`;
      let arr = spGainCache.get(ck);
      if (arr) return arr;
      const m = 1.0 + totalPctVal / 100.0;
      arr = new Int32Array(spVariants.length);
      for (let vi = 0; vi < spVariants.length; vi += 1) {
        const spEv = spVariants[vi].events[s];
        let bg = 0;
        for (let i = 0; i < spEv.length; i += 1) {
          if (spEv[i] > 0) bg += Math.floor(spEv[i] * m + 1e-9);
        }
        arr[vi] = bg;
      }
      spGainCache.set(ck, arr);
      return arr;
    };

    const getExGainArr = (s, totalPctVal) => {
      const ck = `${s}:${totalPctVal}`;
      let arr = exGainCache.get(ck);
      if (arr) return arr;
      const m = 1.0 + totalPctVal / 100.0;
      arr = new Int32Array(EXAM_ALLOC_CANDIDATES.length);
      for (let ei = 0; ei < EXAM_ALLOC_CANDIDATES.length; ei += 1) {
        const exEv = EXAM_ALLOC_CANDIDATES[ei].events[s];
        let bg = 0;
        for (let i = 0; i < exEv.length; i += 1) {
          if (exEv[i] > 0) bg += Math.floor(exEv[i] * m + 1e-9);
        }
        arr[ei] = bg;
      }
      exGainCache.set(ck, arr);
      return arr;
    };

    const slotKey0 = ATTR_KEYS[slotAttrs[0]];
    const slotKey1 = ATTR_KEYS[slotAttrs[1]];
    const slotKey2 = ATTR_KEYS[slotAttrs[2]];
    const init0 = realStats[slotKey0] + memFlat[0];
    const init1 = realStats[slotKey1] + memFlat[1];
    const init2 = realStats[slotKey2] + memFlat[2];

    let bestRec = null;
    let bestGlobalEff = -1;

    for (const act of STRICT_ACTION_COUNTS) {
      const actLabel = `${act.consult}相谈/${act.supply}支给/${act.outing}外出/${act.special}特指`;
      for (let sp1Count = 8; sp1Count >= 0; sp1Count -= 1) {
        const spVariants = UNIQUE_SP_SEQS_BY_COUNT[sp1Count];
        const repSeq = spVariants[0].seq;
        let daSpCount = 0;
        for (const x of repSeq) if (x === daSlot + 1) daSpCount += 1;

        const drinkModes = [
          [false, 0],
          [true, daSpCount * 2],
        ];

        for (const [forceMini, extraDrinks] of drinkModes) {
          const rvZero = buildBaseRouteVars({ act, spSeq: repSeq, extraDrinks });
          const { byAttrPool, miniCard } = evalCardsFlatAndPct(
            engine,
            slotAttrs,
            idolPlan,
            rvZero,
            boxLbs,
            calcItem,
            calcSeika
          );
          const colorPickCache = new Map();

          for (const [ratioName, slotCounts] of DECK_RATIOS) {
            const candDecks = generateCandidateDecksForRatio({
              slotAttrs,
              ratioName,
              slotCounts,
              byAttrPool,
              miniCard,
              forceMiniDrink: forceMini,
              colorPickCache,
            });

            for (const deck of candDecks) {
              if (!forceMini && deck.cards.some((c) => c.isMiniDrink)) continue;

              const tp0 = roundN(realStats[`${slotKey0}Rate`] + memPct[0] + deck.supPct[0], 4);
              const tp1 = roundN(realStats[`${slotKey1}Rate`] + memPct[1] + deck.supPct[1], 4);
              const tp2 = roundN(realStats[`${slotKey2}Rate`] + memPct[2] + deck.supPct[2], 4);
              const totalPctDisplay = [roundN(tp0, 2), roundN(tp1, 2), roundN(tp2, 2)];

              const spArr0 = getSpGainArr(sp1Count, 0, tp0, spVariants);
              const spArr1 = getSpGainArr(sp1Count, 1, tp1, spVariants);
              const spArr2 = getSpGainArr(sp1Count, 2, tp2, spVariants);
              const exArr0 = getExGainArr(0, tp0);
              const exArr1 = getExGainArr(1, tp1);
              const exArr2 = getExGainArr(2, tp2);

              const base0 = init0 + deck.supFlat[0];
              const base1 = init1 + deck.supFlat[1];
              const base2 = init2 + deck.supFlat[2];
              const supFlatTotal = deck.supFlat[0] + deck.supFlat[1] + deck.supFlat[2];

              for (let vi = 0; vi < spVariants.length; vi += 1) {
                const sv0 = spArr0[vi];
                const sv1 = spArr1[vi];
                const sv2 = spArr2[vi];
                const bSp0 = base0 + sv0;
                const bSp1 = base1 + sv1;
                const bSp2 = base2 + sv2;

                for (let ei = 0; ei < EXAM_ALLOC_CANDIDATES.length; ei += 1) {
                  const ev0 = exArr0[ei];
                  const ev1 = exArr1[ei];
                  const ev2 = exArr2[ei];
                  const p0 = bSp0 + ev0;
                  const p1 = bSp1 + ev1;
                  const p2 = bSp2 + ev2;

                  if (bestGlobalEff > 0) {
                    const c0 = p0 > STAT_CAP ? STAT_CAP : p0;
                    const c1 = p1 > STAT_CAP ? STAT_CAP : p1;
                    const c2 = p2 > STAT_CAP ? STAT_CAP : p2;
                    const remCap = STAT_CAP - c0 + (STAT_CAP - c1) + (STAT_CAP - c2);
                    const upperBound = c0 + c1 + c2 + (remCap >= 900 ? 900 : remCap);
                    if (upperBound < bestGlobalEff) continue;
                  }

                  const biz = allocateBusinessStats(p0, p1, p2, bizCache);
                  const rating = calcHifRating(biz.effectiveTotal, round1Wan, round2Wan, star);
                  const sortKey = [
                    rating.finalRating,
                    biz.effectiveTotal,
                    -biz.overflowLoss,
                    -act.outing,
                    supFlatTotal,
                  ];

                  if (!bestRec || compareSortKeys(sortKey, bestRec.sortKey) > 0) {
                    bestGlobalEff = Math.max(bestGlobalEff, biz.effectiveTotal);
                    bestRec = {
                      sortKey,
                      idol,
                      realStats,
                      slotAttrs,
                      ratio: deck.ratio,
                      slotCounts: deck.slotCounts,
                      cards: deck.cards,
                      borrowed: deck.borrowed,
                      miniDrinkActive: deck.miniDrinkActive,
                      miniDrinks: extraDrinks,
                      actLabel,
                      actCounts: act,
                      spSeq: spVariants[vi].seq,
                      examTargets: EXAM_ALLOC_CANDIDATES[ei].targets,
                      bizSplit: biz.bizSplit,
                      bizChoices: biz.bizChoices,
                      rawStats: biz.rawStats,
                      cappedStats: biz.cappedStats,
                      effectiveTotal: biz.effectiveTotal,
                      overflowLoss: biz.overflowLoss,
                      totalPct: totalPctDisplay,
                      supPctSum: deck.supPct,
                      supFlatSum: deck.supFlat,
                      blueGain: [sv0 + ev0, sv1 + ev1, sv2 + ev2],
                      rating,
                    };
                  }
                }
              }
            }
          }
        }
      }
    }

    if (!bestRec) {
      return {
        ok: false,
        error: '当前绑定的支援卡数量不足，无法组成 6 卡配队（至少需持有 5 张同流派/通用可用支援卡）。',
      };
    }

    // 补充 supportCard 对象并按槽位排序（同槽内借卡优先，其次近似价值降序）
    const sortedCards = bestRec.cards
      .map((c) => ({
        ...c,
        supportCard: supportByKey ? supportByKey[c.supportKey] || null : null,
      }))
      .sort((a, b) => {
        if (a.slot !== b.slot) return a.slot - b.slot;
        if (a.borrowed !== b.borrowed) return a.borrowed ? -1 : 1;
        return b.flat + b.pct * 10 - (a.flat + a.pct * 10);
      });

    return {
      ok: true,
      result: {
        ...bestRec,
        cards: sortedCards,
      },
    };
  }

  // ---------------------------------------------------------------------------
  // P 卡智能解析（支持 P卡key / 角色+卡名 / 仅卡名 / 角色+流派 / 单流派角色）
  // ---------------------------------------------------------------------------
  function normText(s) {
    const half = String(s || '').replace(/[\uFF01-\uFF5E]/g, (ch) =>
      String.fromCharCode(ch.charCodeAt(0) - 0xfee0)
    );
    return half
      .toLowerCase()
      .replace(/[\s\u3000！!？?・･·「」『』()（）♪♡♥★☆↑↓.,、。~～\-_:：/\\]+/g, '');
  }

  const ROLE_CHAR_VARIANTS = {
    篠: '筱',
    澤: '泽',
    広: '广',
    廣: '广',
    姫: '姬',
    倉: '仓',
    雲: '云',
    鈴: '铃',
    亞: '娅',
    婭: '娅',
    亚: '娅',
    會: '会',
    長: '长',
    氷: '冰',
    毬: '毬',
  };

  function normRoleText(s) {
    return normText(s).replace(/[篠澤広廣姫倉雲鈴亞婭亚會長氷毬]/g, (ch) => ROLE_CHAR_VARIANTS[ch] || ch);
  }

  function buildCharAliasList(characters, externalAliases) {
    const list = [];
    const seen = new Set();
    const add = (code, alias) => {
      if (!alias) return;
      const n = normRoleText(alias);
      if (!n) return;
      const k = `${code}:${n}`;
      if (seen.has(k)) return;
      seen.add(k);
      list.push({ code, raw: String(alias), norm: n, isSingleChar: Array.from(n).length <= 1 });
    };

    for (const [code, fullName] of Object.entries(characters || {})) {
      add(code, code);
      add(code, fullName);
    }
    for (const map of [externalAliases, EXTRA_CHAR_ALIASES]) {
      for (const [code, aliases] of Object.entries(map || {})) {
        if (!characters || !Object.prototype.hasOwnProperty.call(characters, code)) continue;
        for (const a of aliases || []) add(code, a);
      }
    }

    // 长别名优先匹配，防止短词抢占前缀
    list.sort((a, b) => b.norm.length - a.norm.length);
    return list;
  }

  function sortCidolPreference(items, ownedCidolSet) {
    const owned = ownedCidolSet || {};
    return items.slice().sort((a, b) => {
      const ao = owned[a.key] ? 1 : 0;
      const bo = owned[b.key] ? 1 : 0;
      if (ao !== bo) return bo - ao;
      const ar = Number(a.rarity) || 0;
      const br = Number(b.rarity) || 0;
      if (ar !== br) return br - ar;
      return Number(b.number) - Number(a.number);
    });
  }

  function extractRoleAndPlanFromTokens(rawQuery, characters, charAliases) {
    const aliasList = buildCharAliasList(characters, charAliases);
    const planWordMap = new Map();
    for (const [plan, words] of Object.entries(PLAN_KEYWORDS)) {
      for (const w of words) planWordMap.set(normText(w), plan);
    }

    const rawTokens = String(rawQuery || '')
      .trim()
      .split(/\s+/)
      .filter(Boolean);

    let matchedChar = null;
    let matchedPlan = null;
    const remainParts = [];

    for (const tk of rawTokens) {
      const nt = normText(tk);
      if (!nt) continue;
      const rt = normRoleText(tk);

      if (!matchedPlan && planWordMap.has(nt)) {
        matchedPlan = planWordMap.get(nt);
        continue;
      }

      // 先查完整 token 匹配（含简繁/日文混写及单字别名）
      const exactChar = aliasList.find((a) => a.norm === rt);
      if (!matchedChar && exactChar) {
        matchedChar = { code: exactChar.code, name: (characters && characters[exactChar.code]) || exactChar.code };
        continue;
      }

      // 处理同一无空格 token 中混入多字角色或流派前缀/后缀（如「莉波感性」「篠泽广ガラクタロード」）
      let rest = nt;
      let roleRest = rt;
      let changed = true;
      while (changed) {
        changed = false;
        if (!matchedChar) {
          for (const a of aliasList) {
            if (a.isSingleChar) continue;
            if (roleRest.startsWith(a.norm)) {
              matchedChar = { code: a.code, name: (characters && characters[a.code]) || a.code };
              rest = rest.slice(a.norm.length);
              roleRest = roleRest.slice(a.norm.length);
              changed = true;
              break;
            }
            if (roleRest.endsWith(a.norm)) {
              matchedChar = { code: a.code, name: (characters && characters[a.code]) || a.code };
              rest = rest.slice(0, rest.length - a.norm.length);
              roleRest = roleRest.slice(0, roleRest.length - a.norm.length);
              changed = true;
              break;
            }
          }
          if (changed) continue;
        }
        if (!matchedPlan) {
          for (const [pw, pVal] of planWordMap.entries()) {
            if (rest.startsWith(pw)) {
              matchedPlan = pVal;
              rest = rest.slice(pw.length);
              roleRest = roleRest.slice(pw.length);
              changed = true;
              break;
            }
            if (rest.endsWith(pw)) {
              matchedPlan = pVal;
              rest = rest.slice(0, rest.length - pw.length);
              roleRest = roleRest.slice(0, roleRest.length - pw.length);
              changed = true;
              break;
            }
          }
        }
      }
      if (rest) remainParts.push(rest);
    }

    return {
      matchedChar,
      matchedPlan,
      cardNormQuery: remainParts.join(''),
    };
  }

  function resolveIdolForHif(rawQuery, catalog, ownedCidolSet = {}, charAliases = {}) {
    const clean = String(rawQuery || '').trim();
    if (!clean) return { ok: false, reason: 'empty' };

    const cidolCatalog = (catalog && catalog.cidol) || [];
    const cidolByKey = (catalog && catalog.cidolByKey) || {};
    const characters = (catalog && catalog.characters) || {};

    // 1. 直接匹配 cidol key
    const lowKey = clean.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(cidolByKey, lowKey)) {
      const hit = cidolByKey[lowKey];
      const base = !hit.isSkinVariant
        ? hit
        : cidolCatalog.find((x) => !x.isSkinVariant && x.idolCardId === hit.idolCardId) || hit;
      return { ok: true, idol: base };
    }

    const { matchedChar, matchedPlan, cardNormQuery } = extractRoleAndPlanFromTokens(clean, characters, charAliases);

    const filterPool = (includeSkins) =>
      cidolCatalog.filter((x) => {
        if (!includeSkins && x.isSkinVariant) return false;
        if (matchedChar && x.character !== matchedChar.code) return false;
        if (matchedPlan && x.plan !== matchedPlan) return false;
        return true;
      });

    // 2. 带有卡名关键词的检索
    if (cardNormQuery) {
      let matches = [];
      for (const includeSkins of [false, true]) {
        const pool = filterPool(includeSkins);
        const exact = pool.filter(
          (x) => normText(x.name) === cardNormQuery || normText(x.baseName) === cardNormQuery
        );
        if (exact.length > 0) {
          matches = exact;
          break;
        }
        const partial = pool.filter(
          (x) => normText(x.name).includes(cardNormQuery) || normText(x.baseName).includes(cardNormQuery)
        );
        if (partial.length > 0) {
          matches = partial;
          break;
        }
      }

      if (matches.length === 0) {
        return { ok: false, reason: 'not_found', query: clean };
      }

      // 将皮肤变体还原为对应正卡（如无对应正卡保留自身）并按 key 去重
      const normalizedMap = new Map();
      for (const hit of matches) {
        const canonical = !hit.isSkinVariant
          ? hit
          : cidolCatalog.find((x) => !x.isSkinVariant && x.idolCardId === hit.idolCardId) || hit;
        normalizedMap.set(canonical.key, canonical);
      }
      const uniqueHits = Array.from(normalizedMap.values());

      // 判断是否均归属同一角色 + 同一流派
      const groups = new Set(uniqueHits.map((x) => `${x.character}:${x.plan}`));
      if (groups.size === 1) {
        return { ok: true, idol: sortCidolPreference(uniqueHits, ownedCidolSet)[0] };
      }

      // 撞名（如 ガラクタロード / Campus mode!!）：先看用户已持有的 P 卡能否唯一消歧
      const ownedHits = uniqueHits.filter((x) => Boolean(ownedCidolSet && ownedCidolSet[x.key]));
      const ownedGroups = new Set(ownedHits.map((x) => `${x.character}:${x.plan}`));
      if (ownedGroups.size === 1 && ownedHits.length > 0) {
        return { ok: true, idol: sortCidolPreference(ownedHits, ownedCidolSet)[0] };
      }

      const examples = uniqueHits.slice(0, 3).map((x) => `${characters[x.character] || x.character} ${x.name}`);
      return { ok: false, reason: 'ambiguous_name', query: clean, examples };
    }

    // 3. 仅指定了角色（或 角色+流派）而没有具体卡名
    if (matchedChar) {
      const charBasePool = filterPool(false);
      if (charBasePool.length === 0) {
        return { ok: false, reason: 'not_found', query: clean };
      }
      const charPlans = Array.from(new Set(charBasePool.map((x) => x.plan)));
      if (matchedPlan || charPlans.length === 1) {
        return { ok: true, idol: sortCidolPreference(charBasePool, ownedCidolSet)[0] };
      }
      const sample = sortCidolPreference(charBasePool, ownedCidolSet)[0];
      return {
        ok: false,
        reason: 'need_plan_or_card',
        characterName: matchedChar.name,
        sampleCardName: sample ? sample.name : '',
      };
    }

    return { ok: false, reason: 'not_found', query: clean };
  }

  return {
    ATTR_NAMES,
    ATTR_SHORT,
    ATTR_KEYS,
    ATTR_EN,
    PLAN_NAMES,
    PLAN_MAP,
    CHAR_BASE_STATS,
    SP_DAYS,
    BIZ_DAYS,
    STAT_CAP,
    HIF_EXAM_LINES,
    compileCardExpr,
    loadHifEngine,
    getIdolRealStats,
    idolAttrOrder,
    calcHifRating,
    solveBestHifDeck,
    resolveIdolForHif,
    normText,
  };
});
