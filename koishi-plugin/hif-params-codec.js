(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  if (root && typeof root === 'object') {
    root.GkmsHifParamsCodec = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const PREFIX = 'hp1_';
  const MAX_CODE_CHARS = 256;
  const CODE_FORMAT_RE = /^hp1_[A-Za-z0-9_-]{2,252}$/;
  const ENTRY_KV_RE = /^([A-Za-z][A-Za-z0-9]*)=(-?\d+(?:\.\d+)?)$/;

  const PARAM_GROUPS = [
    {
      id: 'memory',
      title: '回忆加成（三属性）',
      desc: '默认一/二属各 +11.2%（4×2.8%）、三属 +80 固值（4×20）；可按你的实际回忆卡调整。',
      items: [
        { key: 'mp1', label: '一属回忆%', shortLabel: '一属回忆%', defaultVal: 11.2, min: 0, max: 100, step: 0.1, type: 'float', unit: '%' },
        { key: 'mp2', label: '二属回忆%', shortLabel: '二属回忆%', defaultVal: 11.2, min: 0, max: 100, step: 0.1, type: 'float', unit: '%' },
        { key: 'mp3', label: '三属回忆%', shortLabel: '三属回忆%', defaultVal: 0, min: 0, max: 100, step: 0.1, type: 'float', unit: '%' },
        { key: 'mf1', label: '一属回忆固值', shortLabel: '一属回忆固值', defaultVal: 0, min: 0, max: 1000, step: 10, type: 'int', unit: '' },
        { key: 'mf2', label: '二属回忆固值', shortLabel: '二属回忆固值', defaultVal: 0, min: 0, max: 1000, step: 10, type: 'int', unit: '' },
        { key: 'mf3', label: '三属回忆固值', shortLabel: '三属回忆固值', defaultVal: 80, min: 0, max: 1000, step: 10, type: 'int', unit: '' },
      ],
    },
    {
      id: 'picks',
      title: '抓卡类次数',
      desc: '培育整局内各类技能卡获取次数，对应 S 卡的「抓卡触发」词条加成。',
      items: [
        { key: 'B23', label: '抓 A 卡', shortLabel: '抓A卡', defaultVal: 6, min: 0, max: 50, step: 1, type: 'int', actionKey: 'B23' },
        { key: 'B24', label: '抓 M 卡', shortLabel: '抓M卡', defaultVal: 12, min: 0, max: 50, step: 1, type: 'int', actionKey: 'B24' },
        { key: 'B25', label: '抓好调卡', shortLabel: '抓好调', defaultVal: 10, min: 0, max: 50, step: 1, type: 'int', actionKey: 'B25' },
        { key: 'B26', label: '抓温存卡', shortLabel: '抓温存', defaultVal: 10, min: 0, max: 50, step: 1, type: 'int', actionKey: 'B26' },
        { key: 'B27', label: '抓好印象卡', shortLabel: '抓好印象', defaultVal: 12, min: 0, max: 50, step: 1, type: 'int', actionKey: 'B27' },
        { key: 'B42', label: '抓集中卡', shortLabel: '抓集中', defaultVal: 10, min: 0, max: 50, step: 1, type: 'int', actionKey: 'B42' },
        { key: 'B43', label: '抓元气卡', shortLabel: '抓元气', defaultVal: 12, min: 0, max: 50, step: 1, type: 'int', actionKey: 'B43' },
        { key: 'B44', label: '抓彩卡 (SSR)', shortLabel: '抓SSR', defaultVal: 10, min: 0, max: 50, step: 1, type: 'int', actionKey: 'B44' },
        { key: 'B45', label: '抓干劲卡', shortLabel: '抓干劲', defaultVal: 12, min: 0, max: 50, step: 1, type: 'int', actionKey: 'B45' },
      ],
    },
    {
      id: 'cardsOps',
      title: '强化 / 删卡 / 变卡 / 买卡 / 道具',
      desc: '培育中的卡组调整、商店购买与挑战道具触发次数。',
      items: [
        { key: 'B28', label: 'A 强化', shortLabel: 'A强化', defaultVal: 2, min: 0, max: 50, step: 1, type: 'int', actionKey: 'B28' },
        { key: 'B29', label: 'M 强化', shortLabel: 'M强化', defaultVal: 2, min: 0, max: 50, step: 1, type: 'int', actionKey: 'B29' },
        { key: 'B35', label: '删卡总数', shortLabel: '删卡', defaultVal: 6, min: 0, max: 50, step: 1, type: 'int', actionKey: 'B35' },
        { key: 'B36', label: '删 M 卡', shortLabel: '删M卡', defaultVal: 3, min: 0, max: 50, step: 1, type: 'int', actionKey: 'B36' },
        { key: 'B37', label: '删 A 卡', shortLabel: '删A卡', defaultVal: 3, min: 0, max: 50, step: 1, type: 'int', actionKey: 'B37' },
        { key: 'B38', label: '变卡', shortLabel: '变卡', defaultVal: 3, min: 0, max: 50, step: 1, type: 'int', actionKey: 'B38' },
        { key: 'B50', label: '买卡', shortLabel: '买卡', defaultVal: 5, min: 0, max: 50, step: 1, type: 'int', actionKey: 'B50' },
        { key: 'B47', label: '道具获得', shortLabel: '道具获得', defaultVal: 6, min: 0, max: 50, step: 1, type: 'int', actionKey: 'B47' },
      ],
    },
    {
      id: 'scheduleDrinks',
      title: '行程与饮料',
      desc: '营业固定 6 次不可修改；携带小饮料（ふわふわでワクワク）时会在饮料全局总数基础上额外叠加 蓝SP次数×2。',
      items: [
        { key: 'B30', label: '营业次数', shortLabel: '营业', defaultVal: 6, min: 6, max: 6, step: 1, type: 'int', locked: true },
        { key: 'B32', label: '休息次数', shortLabel: '休息', defaultVal: 0, min: 0, max: 20, step: 1, type: 'int', actionKey: 'B32' },
        { key: 'B39', label: '相谈买饮料', shortLabel: '相谈买饮料', defaultVal: 0, min: 0, max: 30, step: 1, type: 'int', actionKey: 'B39' },
        { key: 'B40', label: '饮料全局总数', shortLabel: '基础饮料', defaultVal: 20, min: 0, max: 60, step: 1, type: 'int', isBaseDrinks: true },
      ],
    },
  ];

  const PARAM_SPECS = {};
  const ALL_KEYS = [];
  for (const grp of PARAM_GROUPS) {
    for (const item of grp.items) {
      PARAM_SPECS[item.key] = item;
      ALL_KEYS.push(item.key);
    }
  }
  const SORTED_EDITABLE_KEYS = ALL_KEYS.filter((k) => !PARAM_SPECS[k].locked).sort();

  function hasOwn(obj, key) {
    return obj != null && Object.prototype.hasOwnProperty.call(obj, key);
  }

  function round2(n) {
    return Math.round(n * 100) / 100;
  }

  function getDefaultParams() {
    const out = {};
    for (const k of ALL_KEYS) {
      out[k] = PARAM_SPECS[k].defaultVal;
    }
    return out;
  }

  function normalizeValue(spec, rawVal) {
    if (rawVal === '' || rawVal === null || rawVal === undefined) {
      return { ok: false, error: `参数「${spec.label}」数值不能为空` };
    }
    const num = typeof rawVal === 'number' ? rawVal : Number(String(rawVal).trim());
    if (!Number.isFinite(num)) {
      return { ok: false, error: `参数「${spec.label}」不是合法数字` };
    }
    if (spec.type === 'int') {
      if (!Number.isInteger(num)) {
        return { ok: false, error: `参数「${spec.label}」必须为整数` };
      }
      if (num < spec.min || num > spec.max) {
        return { ok: false, error: `参数「${spec.label}」须在 ${spec.min}~${spec.max} 之间` };
      }
      return { ok: true, value: num };
    }
    const val = round2(num);
    if (Math.abs(val - num) > 1e-6) {
      return { ok: false, error: `参数「${spec.label}」最多保留 2 位小数` };
    }
    if (val < spec.min || val > spec.max) {
      return { ok: false, error: `参数「${spec.label}」须在 ${spec.min}~${spec.max} 之间` };
    }
    return { ok: true, value: val };
  }

  function toBase64UrlAscii(str) {
    let b64;
    if (typeof Buffer !== 'undefined') {
      b64 = Buffer.from(str, 'utf8').toString('base64');
    } else {
      b64 = btoa(str);
    }
    return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function fromBase64UrlAscii(b64url) {
    const clean = String(b64url || '').trim();
    if (!clean || clean.length % 4 === 1) {
      throw new Error('参数代码编码格式无效');
    }
    const padLen = (4 - (clean.length % 4)) % 4;
    const stdB64 = clean.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(padLen);
    let raw;
    if (typeof Buffer !== 'undefined') {
      raw = Buffer.from(stdB64, 'base64').toString('utf8');
    } else {
      raw = atob(stdB64);
    }
    if (toBase64UrlAscii(raw) !== clean) {
      throw new Error('参数代码校验失败（非规范编码）');
    }
    return raw;
  }

  function getChangedParams(params) {
    const overrides = {};
    const changedKeys = [];
    for (const k of ALL_KEYS) {
      const spec = PARAM_SPECS[k];
      if (spec.locked) continue;
      if (!params || !hasOwn(params, k)) continue;
      const norm = normalizeValue(spec, params[k]);
      if (!norm.ok) continue;
      if (norm.value !== spec.defaultVal) {
        overrides[k] = norm.value;
        changedKeys.push(k);
      }
    }
    return { overrides, changedKeys };
  }

  function encodeHifParams(params) {
    if (!params || typeof params !== 'object') return '';
    const pairs = [];
    for (const k of SORTED_EDITABLE_KEYS) {
      if (!hasOwn(params, k)) continue;
      const spec = PARAM_SPECS[k];
      const norm = normalizeValue(spec, params[k]);
      if (!norm.ok) {
        throw new Error(norm.error);
      }
      if (norm.value !== spec.defaultVal) {
        pairs.push(`${k}=${norm.value}`);
      }
    }
    if (pairs.length === 0) return '';
    return `${PREFIX}${toBase64UrlAscii(pairs.join(','))}`;
  }

  function formatParamsSummary(overrides) {
    if (!overrides || typeof overrides !== 'object') return '';
    const parts = [];
    for (const k of ALL_KEYS) {
      if (!hasOwn(overrides, k)) continue;
      const spec = PARAM_SPECS[k];
      const unit = spec.unit || '';
      parts.push(`${spec.shortLabel}=${overrides[k]}${unit}`);
    }
    return parts.join(' · ');
  }

  function buildSolveOptions(fullParams, overrides) {
    const actionOverrides = {};
    for (const k of ALL_KEYS) {
      const spec = PARAM_SPECS[k];
      if (spec.actionKey && hasOwn(overrides, k)) {
        actionOverrides[spec.actionKey] = fullParams[k];
      }
    }
    return {
      memPct: [fullParams.mp1, fullParams.mp2, fullParams.mp3],
      memFlat: [fullParams.mf1, fullParams.mf2, fullParams.mf3],
      baseDrinks: fullParams.B40,
      actionOverrides,
      customSummary: formatParamsSummary(overrides),
    };
  }

  function decodeHifParams(code) {
    const clean = String(code || '').trim();
    if (!clean) {
      return { ok: false, error: '参数代码为空' };
    }
    if (clean.length > MAX_CODE_CHARS) {
      return { ok: false, error: '参数代码长度超出限制' };
    }
    if (!CODE_FORMAT_RE.test(clean)) {
      return { ok: false, error: '参数代码格式无效（应以 hp1_ 开头）' };
    }

    const payload = clean.slice(PREFIX.length);
    let raw;
    try {
      raw = fromBase64UrlAscii(payload);
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : '参数代码解码失败' };
    }

    const entries = raw.split(',').map((s) => s.trim()).filter(Boolean);
    if (entries.length === 0) {
      return { ok: false, error: '参数代码内容为空' };
    }

    const fullParams = getDefaultParams();
    const overrides = {};
    const changedKeys = [];
    const seen = new Set();

    for (const entry of entries) {
      const m = ENTRY_KV_RE.exec(entry);
      if (!m) {
        return { ok: false, error: `参数条目格式无效: ${entry}` };
      }
      const key = m[1];
      const rawNumStr = m[2];
      if (!hasOwn(PARAM_SPECS, key)) {
        return { ok: false, error: `未知参数项: ${key}` };
      }
      if (seen.has(key)) {
        return { ok: false, error: `重复参数项: ${key}` };
      }
      seen.add(key);

      const spec = PARAM_SPECS[key];
      if (spec.locked) {
        return { ok: false, error: `参数「${spec.label}」固定为 ${spec.defaultVal}，不支持修改` };
      }
      if (spec.type === 'int' && rawNumStr.includes('.')) {
        return { ok: false, error: `参数「${spec.label}」必须为整数` };
      }
      const norm = normalizeValue(spec, rawNumStr);
      if (!norm.ok) {
        return { ok: false, error: norm.error };
      }
      fullParams[key] = norm.value;
      if (norm.value !== spec.defaultVal) {
        overrides[key] = norm.value;
        changedKeys.push(key);
      }
    }

    if (changedKeys.length === 0) {
      return { ok: false, error: '参数代码未包含任何与默认值不同的修改' };
    }

    const canonicalCode = encodeHifParams(fullParams);
    return {
      ok: true,
      code: canonicalCode,
      overrides,
      fullParams,
      changedKeys,
      summaryText: formatParamsSummary(overrides),
      solveOptions: buildSolveOptions(fullParams, overrides),
    };
  }

  function extractHifParamsCode(rawArg) {
    const tokens = String(rawArg || '')
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    const codeTokens = [];
    const remainTokens = [];

    for (const tk of tokens) {
      if (/^hp1_/i.test(tk)) {
        codeTokens.push(tk);
      } else {
        remainTokens.push(tk);
      }
    }

    if (codeTokens.length === 0) {
      return {
        ok: true,
        hasParams: false,
        decoded: null,
        remainQuery: remainTokens.join(' '),
      };
    }

    if (codeTokens.length > 1) {
      return { ok: false, error: '一次查询只能附带 1 串 HIF 参数代码。' };
    }

    const normalizedCode = `${PREFIX}${codeTokens[0].slice(PREFIX.length)}`;
    const decoded = decodeHifParams(normalizedCode);
    if (!decoded.ok) {
      return { ok: false, error: decoded.error };
    }

    return {
      ok: true,
      hasParams: true,
      decoded,
      remainQuery: remainTokens.join(' '),
    };
  }

  return {
    PREFIX,
    MAX_CODE_CHARS,
    PARAM_GROUPS,
    PARAM_SPECS,
    ALL_KEYS,
    getDefaultParams,
    normalizeValue,
    getChangedParams,
    encodeHifParams,
    decodeHifParams,
    extractHifParamsCode,
    formatParamsSummary,
  };
});
