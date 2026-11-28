(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  if (root && typeof root === 'object') {
    root.GkmsCodec = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SHORT_CODE_RE = /^g\d{8}$/i;
  const BASE64_CHARS_RE = /^[A-Za-z0-9+/]+={0,2}$/;
  const SUPPORT_ITEM_RE = /^([23])-(\d{1,4})-(\d{1,2})$/;
  const CIDOL_ITEM_RE = /^([a-z0-9]+)-([123])-(\d{1,3})(?:-([0-7])-([0-4]))?$/;

  function hasOwn(obj, key) {
    return obj != null && Object.prototype.hasOwnProperty.call(obj, key);
  }

  function base64EncodeAscii(str) {
    if (!str) return '';
    if (typeof Buffer !== 'undefined') {
      return Buffer.from(str, 'utf8').toString('base64');
    }
    return btoa(str);
  }

  function base64DecodeAscii(b64) {
    const clean = String(b64 || '').replace(/\s+/g, '');
    if (!clean) return '';
    if (!BASE64_CHARS_RE.test(clean) || clean.length % 4 !== 0) {
      throw new Error('无效的 Base64 字符格式');
    }
    if (typeof Buffer !== 'undefined') {
      const buf = Buffer.from(clean, 'base64');
      // 校验是否为规范回环
      if (buf.toString('base64').replace(/=+$/, '') !== clean.replace(/=+$/, '')) {
        throw new Error('无效的 Base64 编码');
      }
      return buf.toString('utf8');
    }
    return atob(clean);
  }

  function encodeSupportBox(entries) {
    if (!Array.isArray(entries) || entries.length === 0) return '';
    const valid = [];
    for (const item of entries) {
      if (!item) continue;
      const rarity = String(item.rarity || '');
      const numInt = parseInt(String(item.number ?? item.id ?? ''), 10);
      const lvInt = Number(item.breakLevel);
      if ((rarity !== '2' && rarity !== '3') || !Number.isInteger(numInt) || numInt < 0) continue;
      if (!Number.isInteger(lvInt) || lvInt < 0 || lvInt > 4) continue;
      valid.push({ rarity, numInt, lvInt });
    }
    if (valid.length === 0) return '';
    valid.sort((a, b) => Number(b.rarity) - Number(a.rarity) || b.numInt - a.numInt);
    const raw = valid.map((v) => `${v.rarity}-${v.numInt}-${v.lvInt}`).join(',');
    return base64EncodeAscii(raw);
  }

  function levelToBreakLevel(rarity, level) {
    if (rarity === '3') {
      if (level <= 40) return 0;
      if (level <= 45) return 1;
      if (level <= 50) return 2;
      if (level <= 55) return 3;
      return 4;
    }
    if (level <= 30) return 0;
    if (level <= 35) return 1;
    if (level <= 40) return 2;
    if (level <= 45) return 3;
    return 4;
  }

  function decodeSupportBox(b64, catalogByKey) {
    const clean = String(b64 || '').trim();
    if (!clean) {
      return { ok: true, items: [], map: {}, b64: '', format: 'break' };
    }
    let raw;
    try {
      raw = base64DecodeAscii(clean);
    } catch (e) {
      return { ok: false, error: '支援卡代码不是有效的 Base64 格式' };
    }
    const tokens = raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (tokens.length === 0) {
      return { ok: false, error: '支援卡代码内容为空' };
    }

    const parsed = [];
    for (const token of tokens) {
      const m = SUPPORT_ITEM_RE.exec(token);
      if (!m) {
        return { ok: false, error: `支援卡条目格式无效: ${token}` };
      }
      parsed.push({
        token,
        rarity: m[1],
        numRaw: m[2],
        number: m[2].padStart(4, '0'),
        rawVal: Number(m[3]),
      });
    }

    // 兼容原版导出器按真实等级（如 3-0100-42）导出的旧版代码，同时保持 3-0-5 等非法突破值拦截
    const isLevelMode =
      parsed.some((p) => p.rawVal >= 10) ||
      (parsed.every((p) => p.numRaw.length === 4) && parsed.some((p) => p.rawVal >= 5));

    const map = {};
    const items = [];
    const indexByKey = {};
    for (const p of parsed) {
      let breakLevel;
      if (isLevelMode) {
        const maxLv = p.rarity === '3' ? 60 : 50;
        if (p.rawVal < 0 || p.rawVal > maxLv) {
          return { ok: false, error: `支援卡等级超出范围: ${p.token}` };
        }
        breakLevel = levelToBreakLevel(p.rarity, p.rawVal);
      } else {
        if (p.rawVal < 0 || p.rawVal > 4) {
          return { ok: false, error: `支援卡条目格式无效: ${p.token}` };
        }
        breakLevel = p.rawVal;
      }
      const key = `${p.rarity}-${p.number}`;
      if (catalogByKey && !hasOwn(catalogByKey, key)) {
        return { ok: false, error: `目录中不存在支援卡: ${key}` };
      }
      if (!hasOwn(map, key)) {
        indexByKey[key] = items.length;
        items.push({ key, rarity: p.rarity, number: p.number, breakLevel });
      } else {
        items[indexByKey[key]].breakLevel = breakLevel;
      }
      map[key] = breakLevel;
    }
    return {
      ok: true,
      items,
      map,
      b64: encodeSupportBox(items),
      format: isLevelMode ? 'level' : 'break',
    };
  }

  function encodeCidolBox(entries) {
    if (!Array.isArray(entries) || entries.length === 0) return '';
    const valid = [];
    const seen = new Set();
    for (const item of entries) {
      let character;
      let rarity;
      let number;
      if (typeof item === 'string') {
        const m = CIDOL_ITEM_RE.exec(item.trim());
        if (!m) continue;
        character = m[1].toLowerCase();
        rarity = m[2];
        number = m[3].padStart(3, '0');
      } else if (item && typeof item === 'object') {
        character = String(item.character || '').toLowerCase();
        rarity = String(item.rarity || '');
        const rawNum = String(item.number ?? item.id ?? '');
        if (!/^\d{1,3}$/.test(rawNum)) continue;
        number = rawNum.padStart(3, '0');
      } else {
        continue;
      }
      if (!character || !['1', '2', '3'].includes(rarity)) continue;
      const key = `${character}-${rarity}-${number}`;
      if (seen.has(key)) continue;
      seen.add(key);
      valid.push({ key, character, rarity, number });
    }
    if (valid.length === 0) return '';
    valid.sort(
      (a, b) =>
        a.character.localeCompare(b.character) ||
        Number(b.rarity) - Number(a.rarity) ||
        b.number.localeCompare(a.number)
    );
    return base64EncodeAscii(valid.map((v) => v.key).join(','));
  }

  function decodeCidolBox(b64, catalogByKey) {
    const clean = String(b64 || '').trim();
    if (!clean) {
      return { ok: true, items: [], set: {}, b64: '' };
    }
    let raw;
    try {
      raw = base64DecodeAscii(clean);
    } catch (e) {
      return { ok: false, error: 'P卡代码不是有效的 Base64 格式' };
    }
    const tokens = raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (tokens.length === 0) {
      return { ok: false, error: 'P卡代码内容为空' };
    }

    const set = {};
    const items = [];
    for (const token of tokens) {
      const m = CIDOL_ITEM_RE.exec(token);
      if (!m) {
        return { ok: false, error: `P卡条目格式无效: ${token}` };
      }
      const character = m[1].toLowerCase();
      const rarity = m[2];
      const number = m[3].padStart(3, '0');
      const key = `${character}-${rarity}-${number}`;
      if (catalogByKey && !hasOwn(catalogByKey, key)) {
        return { ok: false, error: `目录中不存在P卡: ${key}` };
      }
      if (!hasOwn(set, key)) {
        set[key] = true;
        items.push({ key, character, rarity, number });
      }
    }
    return {
      ok: true,
      items,
      set,
      b64: encodeCidolBox(items),
    };
  }

  function detectCodePayload(rawInput, supportCatalogByKey, cidolCatalogByKey) {
    const text = String(rawInput || '').trim();
    if (!text) return { kind: 'empty', error: '输入内容为空' };
    if (SHORT_CODE_RE.test(text)) {
      return { kind: 'short', code: text.toLowerCase() };
    }

    const sup = decodeSupportBox(text, supportCatalogByKey);
    if (sup.ok && sup.items.length > 0) {
      return { kind: 'support', decoded: sup };
    }

    const cid = decodeCidolBox(text, cidolCatalogByKey);
    if (cid.ok && cid.items.length > 0) {
      return { kind: 'cidol', decoded: cid };
    }

    // 两种解析都失败时，按首个条目形态挑选更贴切的错误信息
    let firstEntry = '';
    try {
      firstEntry =
        base64DecodeAscii(text)
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)[0] || '';
    } catch (e) {
      firstEntry = '';
    }
    const looksLikeCidol =
      !SUPPORT_ITEM_RE.test(firstEntry) &&
      (CIDOL_ITEM_RE.test(firstEntry) || /^[a-z][a-z0-9]*-/i.test(firstEntry));
    const preferred = looksLikeCidol ? cid.error || sup.error : sup.error || cid.error;

    return {
      kind: 'invalid',
      error: preferred || '无法识别的 BOX 代码格式',
    };
  }

  function pct(owned, total) {
    return total > 0 ? Math.round((owned / total) * 100) : 0;
  }

  function summarizeBox({
    supportMap = {},
    cidolSet = {},
    supportCatalog = [],
    cidolCatalog = [],
    characters = {},
  }) {
    const attrKeys = ['vo', 'da', 'vi', 'as'];
    const byAttr = {};
    for (const a of attrKeys) {
      byAttr[a] = { key: a, owned: 0, total: 0, maxBreak: 0, percent: 0 };
    }

    let ssrTotal = 0;
    let ssrOwned = 0;
    let srTotal = 0;
    let srOwned = 0;
    let maxBreakTotal = 0;
    let maxBreakSsr = 0;
    let maxBreakSr = 0;
    let supportOwned = 0;

    for (const card of supportCatalog) {
      const lv = hasOwn(supportMap, card.key) ? supportMap[card.key] : -1;
      const owned = lv >= 0 && lv <= 4;
      const isMax = lv === 4;

      if (card.rarity === '3') {
        ssrTotal += 1;
        if (owned) ssrOwned += 1;
        if (isMax) maxBreakSsr += 1;
      } else if (card.rarity === '2') {
        srTotal += 1;
        if (owned) srOwned += 1;
        if (isMax) maxBreakSr += 1;
      }

      if (owned) supportOwned += 1;
      if (isMax) maxBreakTotal += 1;

      const attrStat = hasOwn(byAttr, card.attr) ? byAttr[card.attr] : null;
      if (attrStat) {
        attrStat.total += 1;
        if (owned) attrStat.owned += 1;
        if (isMax) attrStat.maxBreak += 1;
      }
    }

    for (const a of attrKeys) {
      byAttr[a].percent = pct(byAttr[a].owned, byAttr[a].total);
    }

    const charBuckets = {};
    for (const code of Object.keys(characters || {})) {
      charBuckets[code] = {
        code,
        name: characters[code],
        owned: 0,
        total: 0,
        percent: 0,
      };
    }

    let cidolOwned = 0;
    let cidolSsrTotal = 0;
    let cidolSsrOwned = 0;
    let cidolSrTotal = 0;
    let cidolSrOwned = 0;
    let cidolRTotal = 0;
    let cidolROwned = 0;

    for (const skin of cidolCatalog) {
      const owned = hasOwn(cidolSet, skin.key) && !!cidolSet[skin.key];
      if (owned) cidolOwned += 1;
      if (skin.rarity === '3') {
        cidolSsrTotal += 1;
        if (owned) cidolSsrOwned += 1;
      } else if (skin.rarity === '2') {
        cidolSrTotal += 1;
        if (owned) cidolSrOwned += 1;
      } else {
        cidolRTotal += 1;
        if (owned) cidolROwned += 1;
      }
      if (!hasOwn(charBuckets, skin.character)) {
        charBuckets[skin.character] = {
          code: skin.character,
          name: (hasOwn(characters, skin.character) && characters[skin.character]) ||
            String(skin.character).toUpperCase(),
          owned: 0,
          total: 0,
          percent: 0,
        };
      }
      charBuckets[skin.character].total += 1;
      if (owned) charBuckets[skin.character].owned += 1;
    }

    const byCharacter = Object.values(charBuckets).map((item) => ({
      ...item,
      percent: pct(item.owned, item.total),
    }));

    return {
      support: {
        owned: supportOwned,
        total: supportCatalog.length,
        percent: pct(supportOwned, supportCatalog.length),
        ssrOwned,
        ssrTotal,
        srOwned,
        srTotal,
        maxBreakTotal,
        maxBreakSsr,
        maxBreakSr,
        byAttr,
      },
      cidol: {
        owned: cidolOwned,
        total: cidolCatalog.length,
        percent: pct(cidolOwned, cidolCatalog.length),
        ssrOwned: cidolSsrOwned,
        ssrTotal: cidolSsrTotal,
        srOwned: cidolSrOwned,
        srTotal: cidolSrTotal,
        rOwned: cidolROwned,
        rTotal: cidolRTotal,
        byCharacter,
      },
    };
  }

  return {
    SHORT_CODE_RE,
    SUPPORT_ITEM_RE,
    CIDOL_ITEM_RE,
    base64EncodeAscii,
    base64DecodeAscii,
    encodeSupportBox,
    decodeSupportBox,
    encodeCidolBox,
    decodeCidolBox,
    detectCodePayload,
    summarizeBox,
  };
});
