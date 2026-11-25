'use strict';

const fs = require('fs');
const path = require('path');
const { Schema, h } = require('koishi');
const Codec = require('./codec');
const { renderBoxImage } = require('./renderer');

const name = 'gkms-box';
const inject = ['database', 'puppeteer'];

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
  botDisplayName: Schema.string()
    .default('Bot')
    .description('提示文案中显示的机器人名称'),
});

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

function extractTargetMention(session) {
  if (!Array.isArray(session.elements)) return null;
  for (const el of session.elements) {
    if (
      el &&
      el.type === 'at' &&
      el.attrs &&
      el.attrs.id &&
      String(el.attrs.id) !== String(session.selfId || '')
    ) {
      return {
        id: String(el.attrs.id),
        name: el.attrs.name ? String(el.attrs.name) : '',
      };
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
    if (!characters || !characters[code]) continue;
    if (aliases.some((a) => clean === a.toLowerCase() || clean.includes(a.toLowerCase()))) {
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
    `2. @${bot} 绑定 <9位短码 或 Base64代码> — 绑定/更新你的 BOX（也支持 绑定box）`,
    `3. @${bot} 查box / 晒box — 生成你的持卡统计与拼图`,
    `4. @${bot} 查box 支援卡 / P卡 / 筱泽广 — 按分类或偶像晒图（也可 @群友 看对方 BOX）`,
    `5. @${bot} 解绑box — 清除已绑定的数据`,
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

    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const errMsg = body.message || `读取短码 ${code} 失败（HTTP ${res.status}）`;
      if (res.status >= 500 && attempt < maxAttempts) {
        lastErr = new Error(errMsg);
        continue;
      }
      throw new Error(errMsg);
    }
    return body;
  }

  throw lastErr || new Error(`读取短码 ${code} 失败`);
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

  ctx.middleware(async (session, next) => {
    const plainText = extractPlainText(session);
    if (!plainText) return next();

    const isHelp = /^(?:绑定|box|box帮助|boxhelp)$/i.test(plainText);
    const bindMatch = /^绑定(?:\s*box)?(?:\s+([\s\S]+))?$/i.exec(plainText);
    const queryMatch = /^(?:查|晒)\s*box(?:\s+([\s\S]*))?$/i.exec(plainText);
    const unbindMatch = /^解绑\s*box$/i.test(plainText);

    if (!isHelp && !bindMatch && !queryMatch && !unbindMatch) {
      return next();
    }

    if (!canTriggerInSession(config, session)) {
      return next();
    }

    const platform = session.platform || 'unknown';
    const userId = session.userId || session.channelId || 'anonymous';
    const userKey = `${platform}:${userId}`;
    const botName = config.botDisplayName || 'Bot';

    if (isHelp) {
      return buildHelpMessage(config, catalog);
    }

    if (unbindMatch) {
      const existing = await ctx.database.get('gkms_box_binding', { userKey });
      if (!existing.length) {
        return '你还没有绑定过 BOX 记录哦。';
      }
      await ctx.database.remove('gkms_box_binding', { userKey });
      return '已清除你绑定的学马仕 BOX 数据。';
    }

    if (bindMatch) {
      const rawArg = (bindMatch[1] || '').trim();
      if (!rawArg) {
        return (
          `请附上从网页生成的 9 位短码或 Base64 代码，例如：\n` +
          `@${botName} 绑定 g12345678\n` +
          (config.webUrl ? `网页工具：${config.webUrl}` : '')
        ).trim();
      }

      const tokens = rawArg.split(/\s+/).filter(Boolean);
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
            return '当前尚未配置 Cloudflare 短码接口地址，请先发送 Base64 长码绑定，或等管理员绑定好自定义域名。';
          }
          let payload;
          try {
            payload = await fetchShortBindRecord(apiBase, detected.code);
          } catch (err) {
            return `读取短码失败：${err.message}`;
          }
          nextShortCode = detected.code;
          if (payload.box) {
            const decSup = Codec.decodeSupportBox(payload.box, catalog.supportByKey);
            if (!decSup.ok) return `短码中的支援卡数据无效：${decSup.error}`;
            nextSupportCode = decSup.b64;
            nextSupportCount = decSup.items.length;
            updatedParts.push(`支援卡 ${nextSupportCount} 张`);
          } else {
            nextSupportCode = '';
            nextSupportCount = 0;
          }
          if (payload.cidol) {
            const decCid = Codec.decodeCidolBox(payload.cidol, catalog.cidolByKey);
            if (!decCid.ok) return `短码中的P卡数据无效：${decCid.error}`;
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

        return `绑定失败：${detected.error || '无法识别的代码格式'}。请复制完整的 9 位短码（g########）或网页生成的 Base64 代码。`;
      }

      if (!nextSupportCode && !nextCidolCode) {
        return '没有解析到有效的持有卡片，请确认网页中至少勾选了 1 张卡片后再导出代码。';
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

      return (
        `BOX 绑定成功（本次更新：${updatedParts.join('、')}）！\n` +
        `当前存档：支援卡 ${nextSupportCount} 张 · P卡与皮肤 ${nextCidolCount} 项\n` +
        `发送「@${botName} 查box」即可生成你的汇总拼图。`
      );
    }

    if (queryMatch) {
      const targetAt = extractTargetMention(session);
      const targetUserKey = targetAt ? `${platform}:${targetAt.id}` : userKey;
      const isSelf = targetUserKey === userKey;
      const ownerLabel = isSelf
        ? (session.author && (session.author.nick || session.author.name)) ||
          (session.username || '当前制作人')
        : targetAt.name || `制作人(${targetAt.id.slice(-4)})`;

      const rows = await ctx.database.get('gkms_box_binding', { userKey: targetUserKey });
      if (!rows.length) {
        return isSelf
          ? `你还没有绑定 BOX 哦，请先发送「@${botName} 绑定」查看教程或「@${botName} 绑定 <代码>」完成绑定。`
          : '这位群友还没有绑定过 BOX 哦。';
      }

      const binding = rows[0];
      const decSup = Codec.decodeSupportBox(binding.supportCode || '', catalog.supportByKey);
      const decCid = Codec.decodeCidolBox(binding.cidolCode || '', catalog.cidolByKey);
      const supportMap = decSup.ok ? decSup.map : {};
      const cidolSet = decCid.ok ? decCid.set : {};

      const { mode, character } = parseQueryArgs(queryMatch[1] || '', catalog.characters);

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
        return `${ownerLabel} 的档案里还没有绑定支援卡数据。`;
      }
      if (mode === 'cidol' && cidolItems.length === 0) {
        return character
          ? `${ownerLabel} 还没有勾选【${character.name}】的任何角色卡或皮肤。`
          : `${ownerLabel} 的档案里还没有绑定角色与皮肤数据。`;
      }
      if (supportItems.length === 0 && cidolItems.length === 0) {
        return `${ownerLabel} 绑定的 BOX 目前为空。`;
      }

      const cdMs = (config.cooldownSeconds || 0) * 1000;
      if (cdMs > 0) {
        const lastTs = renderCooldowns.get(userKey) || 0;
        const diff = Date.now() - lastTs;
        if (diff < cdMs) {
          const remain = Math.ceil((cdMs - diff) / 1000);
          return `拼图正在冷却中，请 ${remain} 秒后再试。`;
        }
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

      try {
        const rendered = await renderBoxImage({
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

        logger.info(
          '[%s] 拼图完成 user=%s mode=%s size=%d bytes (q=%d, scale=%s)',
          userKey,
          targetUserKey,
          mode,
          rendered.buffer.length,
          rendered.quality,
          rendered.scale
        );

        return [
          h.text(`${summaryText}\n`),
          h.image(rendered.buffer, 'image/jpeg', { title: 'gkms_box.jpg' }),
        ];
      } catch (err) {
        logger.error('BOX 拼图渲染失败：%s', err && err.stack ? err.stack : err);
        return `${summaryText}\n\n（拼图生成暂时失败，已为你先返回文字统计）`;
      }
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
  formatSummaryText,
};
