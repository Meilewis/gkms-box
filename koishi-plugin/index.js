'use strict';

const fs = require('fs');
const path = require('path');
const { Schema, h } = require('koishi');
const Codec = require('./codec');
const renderer = require('./renderer');
const HifPlanner = require('./hif-planner');

const name = 'gkms-box';
const inject = ['database', 'puppeteer'];

const MAX_RENDER_PENDING = 4;
const COOLDOWN_SWEEP_INTERVAL_MS = 10 * 60 * 1000;
const MAX_SHORT_RECORD_CHARS = 262144;
const BIND_TOKEN_RE = /^(?:g\d{8}|[A-Za-z0-9+/]{6,}={0,2})$/i;

const CHAR_ALIASES = {
  amao: ['amao', '有村麻央', '有村', '麻央'],
  atbm: ['atbm', '雨夜燕', '雨夜', '燕'],
  fktn: ['fktn', '藤田琴音', '藤田', '琴音'],
  hkne: ['hkne', '冰渡香名江', '冰渡', '香名江'],
  hmsz: ['hmsz', '秦谷美铃', '秦谷美鈴', '秦谷', '美铃'],
  hrnm: ['hrnm', '姬崎莉波', '姫崎莉波', '姬崎', '姫崎', '莉波'],
  hski: ['hski', '花海咲季', '咲季', '大佑芽'],
  hume: ['hume', '花海佑芽', '佑芽'],
  jsna: ['jsna', '十王星南', '十王', '星南', '会长'],
  kcna: ['kcna', '仓本千奈', '倉本千奈', '仓本', '千奈'],
  kllj: ['kllj', '葛城莉莉娅', '葛城リーリヤ', '葛城', '莉莉娅', '莉莉亚'],
  shro: ['shro', '筱泽广', '篠澤広', '篠泽广', '篠泽', '筱泽', '广', 'hiro'],
  ssmk: ['ssmk', '紫云清夏', '紫雲清夏', '紫云', '清夏'],
  ttmr: ['ttmr', '月村手毬', '月村', '手毬', '手球'],
};

const Config = Schema.object({
  webUrl: Schema.string()
    .default('')
    .description('前端 BOX 录入网页地址（部署到 Cloudflare Pages 并绑定自定义域名后填入，例如 https://box.example.com）'),
  apiBaseUrl: Schema.string()
    .default('')
    .description('短码后端接口根地址（留空时自动复用 webUrl）'),
  dataDir: Schema.string()
    .default('gkms-box')
    .description('卡池 JSON 与本地卡面图片目录（相对 Koishi 工作目录或绝对路径）'),
  requireAt: Schema.boolean()
    .default(true)
    .description('群聊中是否需要 @机器人 才响应 BOX 指令'),
  allowDirectWithoutAt: Schema.boolean()
    .default(true)
    .description('私聊/单聊是否允许不 @ 直接触发'),
  cooldownSeconds: Schema.natural()
    .default(20)
    .description('每人连续查box/晒box拼图冷却秒数（防刷图拖慢响应）'),
  bindSuccessRecallSeconds: Schema.natural()
    .max(120)
    .default(30)
    .description('BOX 绑定成功提示发出后自动撤回的秒数（0 表示不自动撤回；QQ 官方限制须在 120 秒内）'),
  boxQueryRecallSeconds: Schema.natural()
    .max(120)
    .default(30)
    .description('查box/晒box 拼图发出后自动撤回的秒数（0 表示不自动撤回；QQ 官方限制须在 120 秒内）'),
  botDisplayName: Schema.string()
    .default('Bot')
    .description('提示文案中显示的机器人名称'),
});

/**
 * 统一的纯文本回复：一律包装为 text 元素，内容中的 < > & 等字符不会被解析为消息元素
 * （用户输入、QQ 昵称、错误信息、配置项等动态内容都经此输出）
 */
function textReply(content) {
  return h.text(String(content ?? ''));
}

function truncateText(str, maxChars) {
  const chars = Array.from(String(str ?? ''));
  if (chars.length <= maxChars) return chars.join('');
  return `${chars.slice(0, maxChars).join('')}…`;
}

function resolveDataDir(baseDir, configured) {
  if (!configured) return path.join(baseDir, 'gkms-box');
  return path.isAbsolute(configured) ? configured : path.join(baseDir, configured);
}

function loadCatalog(dataDir) {
  const readJson = (rel, fallback) => {
    const p = path.join(dataDir, 'data', rel);
    if (!fs.existsSync(p)) {
      if (fallback !== undefined) return fallback;
      throw new Error(`缺少卡池目录文件: ${p}`);
    }
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  };

  const characters = readJson('characters.json', {});
  const support = readJson('support.json', []);
  const cidol = readJson('cidol.json', []);
  const meta = readJson('meta.json', null);

  const supportByKey = {};
  for (const c of support) supportByKey[c.key] = c;

  const cidolByKey = {};
  for (const s of cidol) cidolByKey[s.key] = s;

  return { characters, support, supportByKey, cidol, cidolByKey, meta };
}

function isMentioningBot(session) {
  if (session.stripped && session.stripped.appel) return true;
  if (!session.selfId || !Array.isArray(session.elements)) return false;
  return session.elements.some(
    (el) => el && el.type === 'at' && el.attrs && String(el.attrs.id) === String(session.selfId)
  );
}

function canTriggerInSession(config, session) {
  if (!config.requireAt) return true;
  if (session.isDirect && config.allowDirectWithoutAt) return true;
  return isMentioningBot(session);
}

function extractPlainText(session) {
  if (Array.isArray(session.elements) && session.elements.length > 0) {
    const parts = [];
    for (const el of session.elements) {
      if (el && el.type === 'text' && el.attrs && typeof el.attrs.content === 'string') {
        parts.push(el.attrs.content);
      }
    }
    if (parts.length > 0) {
      return parts.join(' ').replace(/\s+/g, ' ').trim();
    }
  }
  const fallback =
    session.stripped && typeof session.stripped.content === 'string'
      ? session.stripped.content
      : session.content || '';
  return fallback.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function findOtherAtElement(nodes, selfId) {
  if (!Array.isArray(nodes)) return null;
  for (const el of nodes) {
    if (!el) continue;
    if (
      el.type === 'at' &&
      el.attrs &&
      el.attrs.id &&
      String(el.attrs.id) !== String(selfId || '')
    ) {
      return {
        id: String(el.attrs.id),
        name: el.attrs.name ? String(el.attrs.name) : '',
      };
    }
    if (Array.isArray(el.children)) {
      const nested = findOtherAtElement(el.children, selfId);
      if (nested) return nested;
    }
  }
  return null;
}

function extractTargetMention(session) {
  if (!session || typeof session !== 'object') return null;
  const fromEls = findOtherAtElement(session.elements, session.selfId);
  if (fromEls) return fromEls;
  if (typeof session.content === 'string' && session.content.includes('<at')) {
    try {
      return findOtherAtElement(h.parse(session.content), session.selfId);
    } catch (_) {
      return null;
    }
  }
  return null;
}

function resolveCharacterFilter(argText, characters) {
  const clean = String(argText || '').trim().toLowerCase();
  if (!clean) return null;

  for (const [code, fullName] of Object.entries(characters || {})) {
    if (clean === code.toLowerCase() || clean === String(fullName).toLowerCase()) {
      return { code, name: fullName };
    }
  }
  for (const [code, aliases] of Object.entries(CHAR_ALIASES)) {
    if (!characters || !Object.prototype.hasOwnProperty.call(characters, code)) continue;
    const hit = aliases.some((a) => {
      const alias = a.toLowerCase();
      if (clean === alias) return true;
      // 单字别名（如「广」「燕」）只做精确匹配，避免误命中包含该字的其他词
      return Array.from(alias).length > 1 && clean.includes(alias);
    });
    if (hit) {
      return { code, name: characters[code] };
    }
  }
  return null;
}

function parseQueryArgs(rawArgs, characters) {
  const tokens = String(rawArgs || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  let mode = 'all';
  let character = null;

  for (const tk of tokens) {
    const low = tk.toLowerCase();
    if (['支援卡', 's卡', 's', 'support'].includes(low)) {
      mode = 'support';
      continue;
    }
    if (['角色', '皮肤', 'p卡', 'p', 'cidol', '角色皮肤'].includes(low)) {
      mode = 'cidol';
      continue;
    }
    const matchedChar = resolveCharacterFilter(tk, characters);
    if (matchedChar) {
      character = matchedChar;
      mode = 'cidol';
    }
  }

  return { mode, character };
}

/**
 * 解析「绑定」指令：返回 null 表示不是绑定指令（交给后续中间件）；
 * 返回 { tokens } 表示合法的绑定指令（tokens 可能为空数组，表示缺少代码）。
 * 兼容：绑定My0wLTQ= / 绑定+g12345678 / 绑定 box g12345678 / 绑定box g12345678
 */
function parseBindCommand(plainText) {
  const m = /^绑定([\s\S]*)$/i.exec(String(plainText || ''));
  if (!m) return null;
  const tail = m[1];
  const candidates = [];
  if (/^\s*box/i.test(tail)) candidates.push(tail.replace(/^\s*box/i, ''));
  candidates.push(tail);

  for (const cand of candidates) {
    const rest = cand.replace(/^[\s+]+/, '').trim();
    if (!rest) return { tokens: [] };
    const tokens = rest.split(/\s+/).filter(Boolean);
    if (tokens.length > 0 && tokens.every((tk) => BIND_TOKEN_RE.test(tk))) {
      return { tokens };
    }
  }
  return null;
}

function parseHifDeckCommand(plainText) {
  const m = /^hif\s*配卡(?:\s*([\s\S]*))?$/i.exec(String(plainText || '').trim());
  if (!m) return null;
  return { rawArg: String(m[1] || '').trim() };
}

function buildFullSupportBoxLbs(supportCatalog, supportMap) {
  const boxLbs = {};
  for (const c of supportCatalog || []) {
    boxLbs[c.key] = -1;
  }
  for (const [k, lb] of Object.entries(supportMap || {})) {
    boxLbs[k] = lb;
  }
  return boxLbs;
}

function formatHifResolveError(resolved, botName) {
  if (!resolved || resolved.reason === 'empty') {
    return `请附上 P 卡名称或「角色名 + 流派」，例如：@${botName} hif配卡 姬崎莉波 ガラクタロード`;
  }
  if (resolved.reason === 'need_plan_or_card') {
    const example = resolved.sampleCardName || '感性';
    return `请补充【${resolved.characterName}】的流派（感性/理性/非凡）或具体 P 卡名，例如：@${botName} hif配卡 ${resolved.characterName} ${example}`;
  }
  if (resolved.reason === 'ambiguous_name') {
    return `【${truncateText(resolved.query, 24)}】对应多张不同角色或流派的 P 卡，请加上角色名，例如：${resolved.examples.join(' / ')}`;
  }
  return `未找到匹配「${truncateText(resolved.query, 24)}」的 P 卡，请检查卡名或发送「角色名 + 卡名/流派」。`;
}

function buildHelpMessage(config, catalog) {
  const bot = config.botDisplayName || 'Bot';
  const lines = [
    `【${bot} · 学园偶像大师 BOX 助手】`,
    config.webUrl
      ? `网页点卡工具：${config.webUrl}`
      : '网页工具：尚未配置自定义域名（当前已可直接发送 Base64 代码进行绑定与拼图）',
    '',
    '可用指令：',
    `1. @${bot} 绑定 — 获取网页链接与使用说明`,
    `2. @${bot} 绑定+代码 — 绑定/更新你的 BOX（例如：@${bot} 绑定 g12345678）`,
    `3. @${bot} 查box / 晒box — 生成自己的持卡统计与拼图（30 秒后自动撤回）`,
    `4. @${bot} 查box 支援卡 / P卡 / 筱泽广 — 按分类或偶像查看自己的 BOX（仅支持查自己）`,
    `5. @${bot} 解绑box — 清除已绑定的数据`,
    `6. @${bot} hif配卡 <P卡名/角色+流派> — 根据已绑定的 BOX 生成最优 6 配卡拼图`,
    '',
    `当前收录：支援卡 ${catalog.support.length} 张 · P卡与皮肤 ${catalog.cidol.length} 项`,
  ];
  return lines.join('\n');
}

function formatSummaryText(ownerLabel, summary, mode, characterFilter) {
  const s = summary.support;
  const c = summary.cidol;
  if (mode === 'support') {
    return (
      `${ownerLabel} 的支援卡 BOX\n` +
      `总计 ${s.owned}/${s.total}（${s.percent}%）| SSR ${s.ssrOwned}/${s.ssrTotal}（满破 ${s.maxBreakSsr}）| SR ${s.srOwned}/${s.srTotal}（满破 ${s.maxBreakSr}）\n` +
      `Vo ${s.byAttr.vo.owned}/${s.byAttr.vo.total} · Da ${s.byAttr.da.owned}/${s.byAttr.da.total} · Vi ${s.byAttr.vi.owned}/${s.byAttr.vi.total} · As ${s.byAttr.as.owned}/${s.byAttr.as.total}`
    );
  }
  if (mode === 'cidol' && characterFilter) {
    const item = c.byCharacter.find((x) => x.code === characterFilter.code);
    const owned = item ? item.owned : 0;
    const total = item ? item.total : 0;
    const pct = item ? item.percent : 0;
    return `${ownerLabel} 的【${characterFilter.name}】P卡收集：${owned}/${total}（${pct}%）`;
  }
  if (mode === 'cidol') {
    return (
      `${ownerLabel} 的角色与皮肤 BOX\n` +
      `总计 ${c.owned}/${c.total}（${c.percent}%）| SSR ${c.ssrOwned}/${c.ssrTotal} · SR ${c.srOwned}/${c.srTotal} · R ${c.rOwned}/${c.rTotal}`
    );
  }
  return (
    `${ownerLabel} 的学马仕 BOX 统计\n` +
    `• 支援卡：${s.owned}/${s.total}（${s.percent}%），SSR ${s.ssrOwned} 张 / 满破 ${s.maxBreakTotal} 张\n` +
    `• 角色与皮肤：${c.owned}/${c.total}（${c.percent}%），SSR ${c.ssrOwned}/${c.ssrTotal}`
  );
}

function validateShortBindPayload(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('短码记录格式无效');
  }
  for (const field of ['box', 'cidol']) {
    const val = body[field];
    if (val !== undefined && val !== null && typeof val !== 'string') {
      throw new Error(`短码记录字段 ${field} 格式无效`);
    }
  }
  return body;
}

async function fetchShortBindRecord(apiBase, code) {
  const url = `${apiBase.replace(/\/$/, '')}/api/binds/${encodeURIComponent(code)}`;
  const maxAttempts = 2;
  let lastErr = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let res;
    try {
      res = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(15000),
      });
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts) continue;
      const reason = (err && err.cause && err.cause.code) || (err && err.code) || (err && err.message) || String(err);
      throw new Error(`连接短码服务超时或网络异常（${reason}）`);
    }

    const lenHeader = res.headers && typeof res.headers.get === 'function' ? res.headers.get('content-length') : null;
    if (lenHeader !== null && lenHeader !== undefined && lenHeader !== '' && Number(lenHeader) > MAX_SHORT_RECORD_CHARS) {
      throw new Error('短码服务返回的数据体积异常');
    }

    let text = '';
    try {
      text = await res.text();
    } catch (err) {
      if (res.ok) throw new Error('读取短码服务响应失败');
      text = '';
    }
    if (text.length > MAX_SHORT_RECORD_CHARS) {
      throw new Error('短码服务返回的数据体积异常');
    }

    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch (_) {
      body = null;
    }

    if (!res.ok) {
      const serverMsg = body && typeof body === 'object' && typeof body.message === 'string' ? body.message : '';
      const errMsg = serverMsg || `读取短码 ${code} 失败（HTTP ${res.status}）`;
      if (res.status >= 500 && attempt < maxAttempts) {
        lastErr = new Error(errMsg);
        continue;
      }
      throw new Error(errMsg);
    }
    return validateShortBindPayload(body);
  }

  throw lastErr || new Error(`读取短码 ${code} 失败`);
}

/**
 * 主动发送消息并在指定秒数后自动撤回（仅在拿到 messageId 且适配器支持 deleteMessage 时调度）
 * - recallSeconds<=0 或 bot 不支持 deleteMessage：原样返回 payload，交给 Koishi 默认发送
 * - 发送异常：若提供 fallbackText 则改发纯文字（再失败只记日志）；均返回 undefined，避免重复发送原 payload
 */
async function sendAndAutoRecall(ctx, session, payload, recallSeconds, logger, label = '消息', fallbackText) {
  const delaySec = Number(recallSeconds) || 0;
  if (
    delaySec <= 0 ||
    !session ||
    typeof session.send !== 'function' ||
    !session.bot ||
    typeof session.bot.deleteMessage !== 'function'
  ) {
    return payload;
  }

  const warn = (...args) => {
    if (logger && typeof logger.warn === 'function') logger.warn(...args);
  };
  const errText = (err) => (err && err.message ? err.message : err);

  let sentIds;
  try {
    sentIds = await session.send(payload);
  } catch (err) {
    warn('发送%s异常：%s', label, errText(err));
    if (!fallbackText) return undefined;
    try {
      sentIds = await session.send(textReply(fallbackText));
    } catch (err2) {
      warn('发送%s文字兜底同样失败：%s', label, errText(err2));
      return undefined;
    }
  }

  const ids = Array.isArray(sentIds) ? sentIds.filter(Boolean) : [];
  const channelId = session.channelId || '';
  if (!ids.length || !channelId) {
    warn('%s未拿到 messageId 或 channelId，跳过自动撤回', label);
    return undefined;
  }

  const schedule = (fn, ms) =>
    ctx && typeof ctx.setTimeout === 'function' ? ctx.setTimeout(fn, ms) : setTimeout(fn, ms);

  schedule(async () => {
    for (const msgId of ids) {
      try {
        await session.bot.deleteMessage(channelId, msgId);
        if (logger && typeof logger.info === 'function') {
          logger.info('已自动撤回%s msgId=%s channel=%s (delay=%ss)', label, msgId, channelId, delaySec);
        }
      } catch (err) {
        warn('自动撤回%s失败 msgId=%s channel=%s: %s', label, msgId, channelId, errText(err));
      }
    }
  }, delaySec * 1000);

  return undefined;
}

function apply(ctx, config) {
  const logger = ctx.logger('gkms-box');
  const dataDir = resolveDataDir(ctx.baseDir, config.dataDir);
  let catalog;

  try {
    catalog = loadCatalog(dataDir);
    logger.info(
      '已加载学马仕卡池目录：角色 %d 名、支援卡 %d 张、P卡 %d 项 (目录: %s)',
      Object.keys(catalog.characters).length,
      catalog.support.length,
      catalog.cidol.length,
      dataDir
    );
  } catch (err) {
    logger.error('加载学马仕卡池目录失败：%s', err.message);
    return;
  }

  let hifEngine = null;
  try {
    hifEngine = HifPlanner.loadHifEngine(dataDir);
    logger.info(
      '已加载 HIF 配卡算分引擎：%d 张支援卡公式 (%d/%d 线性校验通过)',
      hifEngine.cardCount,
      hifEngine.verifiedCount,
      hifEngine.totalChecks
    );
  } catch (err) {
    logger.warn('加载 HIF 配卡算分引擎失败（hif配卡功能暂不可用）：%s', err.message);
  }

  ctx.model.extend(
    'gkms_box_binding',
    {
      userKey: 'string',
      shortCode: 'string',
      supportCode: 'text',
      cidolCode: 'text',
      supportCount: 'unsigned',
      cidolCount: 'unsigned',
      updatedAt: 'timestamp',
    },
    { primary: 'userKey' }
  );

  const renderCooldowns = new Map();

  if (typeof ctx.setInterval === 'function') {
    ctx.setInterval(() => {
      const cdMs = (config.cooldownSeconds || 0) * 1000;
      const now = Date.now();
      for (const [key, ts] of renderCooldowns) {
        if (now - ts >= cdMs) renderCooldowns.delete(key);
      }
    }, COOLDOWN_SWEEP_INTERVAL_MS);
  }

  ctx.middleware(async (session, next) => {
    const plainText = extractPlainText(session);
    if (!plainText) return next();

    const isHelp = /^(?:绑定|box帮助|boxhelp)$/i.test(plainText);
    const bindCmd = isHelp ? null : parseBindCommand(plainText);
    const queryMatch = /^(?:查|晒)\s*box(?:\s+([\s\S]*))?$/i.exec(plainText);
    const unbindMatch = /^解绑\s*box$/i.test(plainText);
    const hifCmd = isHelp || bindCmd || queryMatch || unbindMatch ? null : parseHifDeckCommand(plainText);

    if (!isHelp && !bindCmd && !queryMatch && !unbindMatch && !hifCmd) {
      return next();
    }

    if (!canTriggerInSession(config, session)) {
      return next();
    }

    const botName = config.botDisplayName || 'Bot';

    if (isHelp) {
      return textReply(buildHelpMessage(config, catalog));
    }

    if (!session.userId) {
      return textReply('无法识别你的账号，暂不支持该会话。');
    }

    const platform = session.platform || 'unknown';
    const userId = String(session.userId);
    const userKey = `${platform}:${userId}`;

    if (unbindMatch) {
      const existing = await ctx.database.get('gkms_box_binding', { userKey });
      if (!existing.length) {
        return textReply('你还没有绑定过 BOX 记录哦。');
      }
      await ctx.database.remove('gkms_box_binding', { userKey });
      return textReply('已清除你绑定的学马仕 BOX 数据。');
    }

    if (bindCmd) {
      const tokens = bindCmd.tokens;
      if (!tokens.length) {
        return textReply(
          (
            `请附上从网页生成的 9 位短码或 Base64 代码，例如：\n` +
            `@${botName} 绑定 g12345678\n` +
            (config.webUrl ? `网页工具：${config.webUrl}` : '')
          ).trim()
        );
      }

      const existingRows = await ctx.database.get('gkms_box_binding', { userKey });
      const prev = existingRows[0] || {
        userKey,
        shortCode: '',
        supportCode: '',
        cidolCode: '',
        supportCount: 0,
        cidolCount: 0,
      };

      let nextShortCode = prev.shortCode || '';
      let nextSupportCode = prev.supportCode || '';
      let nextCidolCode = prev.cidolCode || '';
      let nextSupportCount = prev.supportCount || 0;
      let nextCidolCount = prev.cidolCount || 0;
      const updatedParts = [];

      for (const tk of tokens) {
        const detected = Codec.detectCodePayload(tk, catalog.supportByKey, catalog.cidolByKey);
        if (detected.kind === 'short') {
          const apiBase = (config.apiBaseUrl || config.webUrl || '').trim();
          if (!apiBase) {
            return textReply(
              '当前尚未配置 Cloudflare 短码接口地址，请先发送 Base64 长码绑定，或等管理员绑定好自定义域名。'
            );
          }
          let payload;
          try {
            payload = await fetchShortBindRecord(apiBase, detected.code);
          } catch (err) {
            return textReply(`读取短码失败：${truncateText(err && err.message ? err.message : err, 80)}`);
          }
          nextShortCode = detected.code;
          if (payload.box) {
            const decSup = Codec.decodeSupportBox(payload.box, catalog.supportByKey);
            if (!decSup.ok) return textReply(`短码中的支援卡数据无效：${truncateText(decSup.error, 80)}`);
            nextSupportCode = decSup.b64;
            nextSupportCount = decSup.items.length;
            updatedParts.push(`支援卡 ${nextSupportCount} 张`);
          } else {
            nextSupportCode = '';
            nextSupportCount = 0;
          }
          if (payload.cidol) {
            const decCid = Codec.decodeCidolBox(payload.cidol, catalog.cidolByKey);
            if (!decCid.ok) return textReply(`短码中的P卡数据无效：${truncateText(decCid.error, 80)}`);
            nextCidolCode = decCid.b64;
            nextCidolCount = decCid.items.length;
            updatedParts.push(`P卡 ${nextCidolCount} 项`);
          } else {
            nextCidolCode = '';
            nextCidolCount = 0;
          }
          continue;
        }

        if (detected.kind === 'support') {
          nextShortCode = '';
          nextSupportCode = detected.decoded.b64;
          nextSupportCount = detected.decoded.items.length;
          updatedParts.push(`支援卡 ${nextSupportCount} 张`);
          continue;
        }

        if (detected.kind === 'cidol') {
          nextShortCode = '';
          nextCidolCode = detected.decoded.b64;
          nextCidolCount = detected.decoded.items.length;
          updatedParts.push(`P卡 ${nextCidolCount} 项`);
          continue;
        }

        const reason = truncateText(detected.error || '无法识别的代码格式', 80);
        return textReply(
          `绑定失败：${reason}。请复制完整的 9 位短码（g########）或网页生成的 Base64 代码。`
        );
      }

      if (!nextSupportCode && !nextCidolCode) {
        return textReply('没有解析到有效的持有卡片，请确认网页中至少勾选了 1 张卡片后再导出代码。');
      }

      await ctx.database.upsert('gkms_box_binding', [
        {
          userKey,
          shortCode: nextShortCode,
          supportCode: nextSupportCode,
          cidolCode: nextCidolCode,
          supportCount: nextSupportCount,
          cidolCount: nextCidolCount,
          updatedAt: new Date(),
        },
      ]);

      const bindSuccessText =
        `BOX 绑定成功（本次更新：${updatedParts.join('、')}）！\n` +
        `当前存档：支援卡 ${nextSupportCount} 张 · P卡与皮肤 ${nextCidolCount} 项\n` +
        `发送「@${botName} 查box」即可生成你的汇总拼图。`;
      return await sendAndAutoRecall(
        ctx,
        session,
        textReply(bindSuccessText),
        config.bindSuccessRecallSeconds,
        logger,
        'BOX 绑定成功提示'
      );
    }

    if (queryMatch) {
      const rawQueryArg = queryMatch[1] || '';
      const targetAt = extractTargetMention(session);
      if ((targetAt && String(targetAt.id) !== userId) || /[@＠]\S+/.test(rawQueryArg)) {
        return textReply('为了保护隐私，仅支持查询自己的 BOX，不支持 @群友 查看对方的 BOX 哦。');
      }

      const ownerLabel = truncateText(
        (session.author && (session.author.nick || session.author.name)) ||
          session.username ||
          '当前制作人',
        32
      );

      const rows = await ctx.database.get('gkms_box_binding', { userKey });
      if (!rows.length) {
        return textReply(
          `你还没有绑定 BOX 哦，请先发送「@${botName} 绑定」查看教程或「@${botName} 绑定 <代码>」完成绑定。`
        );
      }

      const binding = rows[0];
      const decSup = Codec.decodeSupportBox(binding.supportCode || '', catalog.supportByKey);
      const decCid = Codec.decodeCidolBox(binding.cidolCode || '', catalog.cidolByKey);
      const supportMap = decSup.ok ? decSup.map : {};
      const cidolSet = decCid.ok ? decCid.set : {};

      const { mode, character } = parseQueryArgs(rawQueryArg, catalog.characters);

      const supportItems = (decSup.ok ? decSup.items : [])
        .map((it) => ({ card: catalog.supportByKey[it.key], breakLevel: it.breakLevel }))
        .filter((x) => Boolean(x.card))
        .sort(
          (a, b) =>
            Number(b.card.rarity) - Number(a.card.rarity) ||
            b.breakLevel - a.breakLevel ||
            Number(b.card.number) - Number(a.card.number)
        );

      const charKeys = Object.keys(catalog.characters);
      const cidolItems = (decCid.ok ? decCid.items : [])
        .map((it) => catalog.cidolByKey[it.key])
        .filter(Boolean)
        .filter((s) => !character || s.character === character.code)
        .sort((a, b) => {
          const ia = charKeys.indexOf(a.character);
          const ib = charKeys.indexOf(b.character);
          return (
            (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib) ||
            Number(b.rarity) - Number(a.rarity) ||
            Number(b.number) - Number(a.number)
          );
        });

      if (mode === 'support' && supportItems.length === 0) {
        return textReply(`${ownerLabel} 的档案里还没有绑定支援卡数据。`);
      }
      if (mode === 'cidol' && cidolItems.length === 0) {
        return textReply(
          character
            ? `${ownerLabel} 还没有勾选【${character.name}】的任何角色卡或皮肤。`
            : `${ownerLabel} 的档案里还没有绑定角色与皮肤数据。`
        );
      }
      if (supportItems.length === 0 && cidolItems.length === 0) {
        return textReply(`${ownerLabel} 绑定的 BOX 目前为空。`);
      }

      const isBypass = Boolean(session && session._adminBypass);
      const cdMs = (config.cooldownSeconds || 0) * 1000;
      if (!isBypass && cdMs > 0) {
        const lastTs = renderCooldowns.get(userKey) || 0;
        const diff = Date.now() - lastTs;
        if (diff < cdMs) {
          const remain = Math.ceil((cdMs - diff) / 1000);
          return textReply(`拼图正在冷却中，请 ${remain} 秒后再试。`);
        }
      }

      if (renderer.getPendingRenderCount() >= MAX_RENDER_PENDING) {
        return textReply('当前查box排队较多，请稍后再试。');
      }

      if (!isBypass && cdMs > 0) {
        renderCooldowns.set(userKey, Date.now());
      }

      const summary = Codec.summarizeBox({
        supportMap,
        cidolSet,
        supportCatalog: catalog.support,
        cidolCatalog: catalog.cidol,
        characters: catalog.characters,
      });

      const summaryText = formatSummaryText(ownerLabel, summary, mode, character);

      let rendered;
      try {
        rendered = await renderer.renderBoxImage({
          getPage: () => ctx.puppeteer.page(),
          dataDir,
          htmlPayload: {
            mode,
            ownerLabel,
            summary,
            supportItems: mode === 'cidol' ? [] : supportItems,
            cidolItems: mode === 'support' ? [] : cidolItems,
            characters: catalog.characters,
            characterFilterName: character ? character.name : '',
          },
        });
      } catch (err) {
        const tooLong = Boolean(err && err.message === '拼图过长');
        if (!tooLong) {
          // 临时性渲染失败不扣冷却；「拼图过长」属于确定性结果，保留冷却防止反复触发渲染
          renderCooldowns.delete(userKey);
          logger.error('BOX 拼图渲染失败：%s', err && err.stack ? err.stack : err);
        } else {
          logger.warn('[%s] 拼图过长，改为文字统计', userKey);
        }
        return textReply(
          tooLong
            ? `${summaryText}\n\n（卡片数量过多、拼图过长，已为你返回文字统计）`
            : `${summaryText}\n\n（拼图生成暂时失败，已为你先返回文字统计）`
        );
      }

      logger.info(
        '[%s] 拼图完成 mode=%s size=%d bytes (q=%d, scale=%s%s)',
        userKey,
        mode,
        rendered && rendered.buffer ? rendered.buffer.length : 0,
        rendered ? rendered.quality : 0,
        rendered ? rendered.scale : '',
        rendered && rendered.oversized ? ', oversized' : ''
      );

      if (!rendered || !rendered.buffer || rendered.oversized) {
        return textReply(`${summaryText}\n\n（拼图体积过大，已改为文字统计）`);
      }

      const queryPayload = [
        h.text(`${summaryText}\n`),
        h.image(rendered.buffer, 'image/jpeg', { title: 'gkms_box.jpg' }),
      ];
      return await sendAndAutoRecall(
        ctx,
        session,
        queryPayload,
        config.boxQueryRecallSeconds,
        logger,
        '查box 拼图',
        `${summaryText}\n（拼图发送失败，已改为文字统计）`
      );
    }

    if (hifCmd) {
      if (!hifEngine) {
        return textReply('HIF 配卡数据尚未加载，请联系管理员检查 hif_cards.json 数据文件。');
      }
      if (!hifCmd.rawArg) {
        return textReply(formatHifResolveError({ reason: 'empty' }, botName));
      }

      const targetAt = extractTargetMention(session);
      if ((targetAt && String(targetAt.id) !== userId) || /[@＠]\S+/.test(hifCmd.rawArg)) {
        return textReply('为了保护隐私，仅支持根据自己的 BOX 生成 HIF 配卡哦。');
      }

      const ownerLabel = truncateText(
        (session.author && (session.author.nick || session.author.name)) ||
          session.username ||
          '当前制作人',
        32
      );

      const rows = await ctx.database.get('gkms_box_binding', { userKey });
      if (!rows.length || !rows[0].supportCode) {
        return textReply(
          `你还没有绑定支援卡 BOX 哦，请先发送「@${botName} 绑定 <代码>」完成绑定。`
        );
      }

      const binding = rows[0];
      const decSup = Codec.decodeSupportBox(binding.supportCode || '', catalog.supportByKey);
      const decCid = Codec.decodeCidolBox(binding.cidolCode || '', catalog.cidolByKey);
      if (!decSup.ok || !decSup.items.length) {
        return textReply('你绑定的支援卡数据无效或为空，请重新发送「绑定 <代码>」更新 BOX。');
      }
      const cidolSet = decCid.ok ? decCid.set : {};

      const resolved = HifPlanner.resolveIdolForHif(hifCmd.rawArg, catalog, cidolSet, CHAR_ALIASES);
      if (!resolved.ok) {
        return textReply(formatHifResolveError(resolved, botName));
      }

      const isBypass = Boolean(session && session._adminBypass);
      const cdMs = (config.cooldownSeconds || 0) * 1000;
      if (!isBypass && cdMs > 0) {
        const lastTs = renderCooldowns.get(userKey) || 0;
        const diff = Date.now() - lastTs;
        if (diff < cdMs) {
          const remain = Math.ceil((cdMs - diff) / 1000);
          return textReply(`拼图正在冷却中，请 ${remain} 秒后再试。`);
        }
      }

      if (renderer.getPendingRenderCount() >= MAX_RENDER_PENDING) {
        return textReply('当前生成排队较多，请稍后再试。');
      }

      if (!isBypass && cdMs > 0) {
        renderCooldowns.set(userKey, Date.now());
      }

      const boxLbs = buildFullSupportBoxLbs(catalog.support, decSup.map);
      const solved = HifPlanner.solveBestHifDeck(resolved.idol, boxLbs, hifEngine, catalog.supportByKey);
      if (!solved.ok) {
        renderCooldowns.delete(userKey);
        return textReply(solved.error);
      }

      let rendered;
      try {
        rendered = await renderer.renderHifDeckImage({
          getPage: () => ctx.puppeteer.page(),
          dataDir,
          htmlPayload: {
            ownerLabel,
            idol: resolved.idol,
            characters: catalog.characters,
            result: solved.result,
          },
        });
      } catch (err) {
        renderCooldowns.delete(userKey);
        logger.error('HIF 配卡拼图渲染失败：%s', err && err.stack ? err.stack : err);
        return textReply('HIF 配卡拼图生成暂时失败，请稍后重试。');
      }

      if (!rendered || !rendered.buffer || rendered.oversized) {
        renderCooldowns.delete(userKey);
        return textReply('HIF 配卡拼图体积过大，请稍后重试。');
      }

      logger.info(
        '[%s] HIF配卡完成 idol=%s rating=%d size=%d bytes (q=%d, scale=%s)',
        userKey,
        resolved.idol.key,
        solved.result.rating.finalRating,
        rendered.buffer.length,
        rendered.quality,
        rendered.scale
      );

      // 回复严格只发一张 6 配卡拼图，且不自动撤回
      return h.image(rendered.buffer, 'image/jpeg', { title: 'gkms_hif_deck.jpg' });
    }

    return next();
  });
}

module.exports = {
  name,
  inject,
  Config,
  apply,
  CHAR_ALIASES,
  isMentioningBot,
  canTriggerInSession,
  extractPlainText,
  extractTargetMention,
  resolveCharacterFilter,
  parseQueryArgs,
  parseBindCommand,
  parseHifDeckCommand,
  formatSummaryText,
  fetchShortBindRecord,
  sendAndAutoRecall,
  truncateText,
};
