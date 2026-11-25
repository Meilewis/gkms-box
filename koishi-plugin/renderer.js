'use strict';

const fs = require('fs');
const path = require('path');

const MAX_JPEG_BYTES = 2850000;
const RENDER_TIMEOUT_MS = 25000;
const ASSET_WAIT_MS = 10000;
const PAGE_CLOSE_WAIT_MS = 5000;
const MAX_SCALE = 1.5;
const MIN_SCALE = 0.5;
const MAX_OUTPUT_HEIGHT_PX = 15000;
const DATA_URL_CACHE_MAX_CHARS = 96 * 1024 * 1024;

let renderQueue = Promise.resolve();
let pendingRenderCount = 0;

/**
 * 串行渲染队列：前一个任务失败不影响后续任务；计数包含正在执行与排队中的任务
 */
function withRenderLock(fn) {
  pendingRenderCount += 1;
  const run = async () => {
    try {
      return await fn();
    } finally {
      pendingRenderCount -= 1;
    }
  };
  const task = renderQueue.then(run, run);
  renderQueue = task.catch(() => {});
  return task;
}

function getPendingRenderCount() {
  return pendingRenderCount;
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// 卡图 dataURL 缓存（按路径 + mtime + size 失效，超出总量时按最久未使用淘汰）
const dataUrlCache = new Map();
let dataUrlCacheChars = 0;

function fileToDataUrl(filePath) {
  if (!filePath) return '';
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (_) {
    return '';
  }
  if (!stat.isFile()) return '';

  const cached = dataUrlCache.get(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    dataUrlCache.delete(filePath);
    dataUrlCache.set(filePath, cached);
    return cached.dataUrl;
  }
  if (cached) {
    dataUrlCache.delete(filePath);
    dataUrlCacheChars -= cached.dataUrl.length;
  }

  const ext = path.extname(filePath).toLowerCase();
  const mime =
    ext === '.webp'
      ? 'image/webp'
      : ext === '.png'
        ? 'image/png'
        : ext === '.jpg' || ext === '.jpeg'
          ? 'image/jpeg'
          : 'application/octet-stream';
  let buf;
  try {
    buf = fs.readFileSync(filePath);
  } catch (_) {
    return '';
  }
  const dataUrl = `data:${mime};base64,${buf.toString('base64')}`;

  dataUrlCache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, dataUrl });
  dataUrlCacheChars += dataUrl.length;
  while (dataUrlCacheChars > DATA_URL_CACHE_MAX_CHARS && dataUrlCache.size > 1) {
    const oldestKey = dataUrlCache.keys().next().value;
    const oldest = dataUrlCache.get(oldestKey);
    dataUrlCache.delete(oldestKey);
    dataUrlCacheChars -= oldest.dataUrl.length;
  }
  return dataUrl;
}

function clearDataUrlCache() {
  dataUrlCache.clear();
  dataUrlCacheChars = 0;
}

function getDataUrlCacheSize() {
  return dataUrlCache.size;
}

function resolveSupportImageDataUrl(dataDir, card) {
  if (!dataDir || !card) return '';
  const p = path.join(dataDir, 'assets', 'cards', `s_card-${card.rarity}-${card.number}.webp`);
  return fileToDataUrl(p);
}

function resolveCidolImageDataUrl(dataDir, skin) {
  if (!dataDir || !skin) return '';
  const dir = path.join(dataDir, 'assets', 'cidol');
  for (const variant of ['1', '0']) {
    const url = fileToDataUrl(path.join(dir, `cidol-${skin.key}_${variant}.webp`));
    if (url) return url;
  }
  return '';
}

function buildRenderHtml({
  mode,
  ownerLabel,
  summary,
  supportItems,
  cidolItems,
  characters,
  dataDir,
  characterFilterName,
}) {
  const totalShown = supportItems.length + cidolItems.length;
  const compact = totalShown > 160;
  const sCols = compact ? 5 : 4;
  const cCols = compact ? 7 : 6;
  const nowStr = new Date().toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });

  const modeTitle =
    mode === 'support'
      ? '支援卡 BOX 总览'
      : mode === 'cidol'
        ? characterFilterName
          ? `${characterFilterName} · 角色卡汇总`
          : '角色与皮肤 BOX 总览'
        : '学园偶像大师 全图鉴 BOX';

  const attrBadge = (attr) => {
    const map = {
      vo: ['VO', '#ef4444', '#ffffff'],
      da: ['DA', '#3b82f6', '#ffffff'],
      vi: ['VI', '#eab308', '#1c1917'],
      as: ['AS', '#10b981', '#052e16'],
    };
    const [text, bg, fg] = map[attr] || ['?', '#64748b', '#fff'];
    return `<span class="badge-attr" style="background:${bg};color:${fg}">${text}</span>`;
  };

  const rarityBadge = (rarity) => {
    if (rarity === '3') return '<span class="badge-rarity r-3">SSR</span>';
    if (rarity === '2') return '<span class="badge-rarity r-2">SR</span>';
    return '<span class="badge-rarity r-1">R</span>';
  };

  const renderSupportCardsHtml = () => {
    if (!supportItems.length) return '';
    const cardsHtml = supportItems
      .map(({ card, breakLevel }) => {
        const baseLv = card.rarity === '3' ? 40 : 30;
        const lvText = `LV.${baseLv + breakLevel * 5}`;
        const isMax = breakLevel === 4;
        const imgUrl = resolveSupportImageDataUrl(dataDir, card);
        const media = imgUrl
          ? `<img class="card-img" src="${imgUrl}" alt="">`
          : `<div class="fallback-art plan-${escapeHtml(card.plan)}">
               <div class="fallback-title">${escapeHtml(card.name)}</div>
               <div class="fallback-sub">${escapeHtml(card.plan)} · #${escapeHtml(card.number)}</div>
             </div>`;
        return `
          <div class="s-card ${isMax ? 'is-max' : ''}">
            ${media}
            <div class="top-badges">
              ${rarityBadge(card.rarity)}
              ${attrBadge(card.attr)}
            </div>
            <div class="s-bottom">
              <span class="s-lv ${isMax ? 'max' : ''}">${lvText}</span>
              <span class="s-name">${escapeHtml(card.name)}</span>
            </div>
          </div>
        `;
      })
      .join('');

    return `
      <section class="section">
        <div class="section-head">
          <span class="section-dot dot-cyan"></span>
          <span>支援卡 S卡（展示 ${supportItems.length} 张 · 满破 ${summary.support.maxBreakTotal} 张）</span>
        </div>
        <div class="s-grid" style="grid-template-columns:repeat(${sCols},minmax(0,1fr))">
          ${cardsHtml}
        </div>
      </section>
    `;
  };

  const renderCidolCardsHtml = () => {
    if (!cidolItems.length) return '';
    const cardsHtml = cidolItems
      .map((skin) => {
        const charName = (characters && characters[skin.character]) || skin.character.toUpperCase();
        const imgUrl = resolveCidolImageDataUrl(dataDir, skin);
        const media = imgUrl
          ? `<img class="card-img" src="${imgUrl}" alt="">`
          : `<div class="fallback-art plan-${escapeHtml(skin.plan)}">
               <div class="fallback-title">${escapeHtml(skin.name)}</div>
               <div class="fallback-sub">${escapeHtml(skin.plan)}</div>
             </div>`;
        return `
          <div class="c-card">
            <div class="c-media">
              ${media}
              <div class="top-badges">${rarityBadge(skin.rarity)}</div>
            </div>
            <div class="c-footer">
              <div class="c-row">
                <span class="c-char">${escapeHtml(charName)}</span>
                <span class="c-plan p-${escapeHtml(skin.plan)}">${escapeHtml(skin.plan)}</span>
              </div>
              <div class="c-name">${escapeHtml(skin.name)}</div>
            </div>
          </div>
        `;
      })
      .join('');

    return `
      <section class="section">
        <div class="section-head">
          <span class="section-dot dot-purple"></span>
          <span>角色与皮肤 P卡（展示 ${cidolItems.length} 项）</span>
        </div>
        <div class="c-grid" style="grid-template-columns:repeat(${cCols},minmax(0,1fr))">
          ${cardsHtml}
        </div>
      </section>
    `;
  };

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    width: 1400px;
    background: #070b14;
    color: #f8fafc;
    font-family: "Noto Sans CJK SC", "Noto Sans CJK JP", "WenQuanYi Micro Hei", sans-serif;
  }
  #canvas-root {
    width: 1400px;
    padding: 26px 28px 20px;
    background: radial-gradient(circle at 10% 0%, rgba(56, 189, 248, 0.14), transparent 38%),
      radial-gradient(circle at 90% 5%, rgba(192, 132, 252, 0.14), transparent 40%),
      #070b14;
  }
  .header-card {
    background: linear-gradient(135deg, #111c3a 0%, #191438 100%);
    border: 1px solid rgba(148, 163, 184, 0.25);
    border-radius: 18px;
    padding: 20px 24px;
    margin-bottom: 20px;
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 20px;
  }
  .h-badge {
    font-size: 11px;
    font-weight: 800;
    letter-spacing: 0.14em;
    color: #38bdf8;
    margin-bottom: 6px;
  }
  .h-title {
    font-size: 28px;
    font-weight: 900;
    color: #ffffff;
    line-height: 1.2;
  }
  .h-owner {
    margin-top: 6px;
    font-size: 14px;
    color: #cbd5e1;
  }
  .h-stats {
    display: flex;
    gap: 12px;
    flex-shrink: 0;
  }
  .stat-box {
    background: rgba(2, 6, 23, 0.65);
    border: 1px solid rgba(148, 163, 184, 0.22);
    border-radius: 12px;
    padding: 10px 14px;
    min-width: 155px;
  }
  .stat-k { font-size: 11px; color: #94a3b8; font-weight: 700; }
  .stat-v { font-size: 22px; font-weight: 900; color: #38bdf8; margin-top: 2px; }
  .stat-s { font-size: 11px; color: #cbd5e1; margin-top: 2px; }

  .section { margin-bottom: 22px; }
  .section-head {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 16px;
    font-weight: 900;
    color: #e2e8f0;
    margin-bottom: 12px;
  }
  .section-dot { width: 8px; height: 18px; border-radius: 99px; display: inline-block; }
  .dot-cyan { background: linear-gradient(180deg, #22d3ee, #3b82f6); }
  .dot-purple { background: linear-gradient(180deg, #e879f9, #6366f1); }

  .s-grid, .c-grid { display: grid; gap: ${compact ? '10px' : '12px'}; }

  .s-card {
    position: relative;
    aspect-ratio: 16 / 9;
    border-radius: 12px;
    overflow: hidden;
    border: 2px solid rgba(56, 189, 248, 0.55);
    background: #0f172a;
  }
  .s-card.is-max {
    border-color: #fbbf24;
    box-shadow: 0 0 0 1px rgba(251, 191, 36, 0.45);
  }
  .card-img { width: 100%; height: 100%; object-fit: cover; display: block; }

  .fallback-art {
    width: 100%;
    height: 100%;
    padding: 14px 12px;
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: center;
    text-align: center;
  }
  .plan-Sense { background: linear-gradient(135deg, #2f1223 0%, #14172c 100%); }
  .plan-Logic { background: linear-gradient(135deg, #0d2842 0%, #111b33 100%); }
  .plan-Anomaly { background: linear-gradient(135deg, #291342 0%, #171433 100%); }
  .plan-Common { background: linear-gradient(135deg, #0c2e28 0%, #121c31 100%); }

  .fallback-title {
    font-size: ${compact ? '13px' : '15px'};
    font-weight: 800;
    color: #f8fafc;
    line-height: 1.3;
    word-break: break-word;
  }
  .fallback-sub {
    margin-top: 4px;
    font-size: 11px;
    color: #94a3b8;
    font-weight: 700;
  }

  .top-badges {
    position: absolute;
    top: 7px;
    left: 8px;
    right: 8px;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .badge-rarity {
    font-size: 10px;
    font-weight: 900;
    padding: 2px 7px;
    border-radius: 6px;
  }
  .r-3 { background: linear-gradient(135deg, #22d3ee, #6366f1, #ec4899); color: #fff; }
  .r-2 { background: #eab308; color: #271502; }
  .r-1 { background: #cbd5e1; color: #0f172a; }
  .badge-attr {
    font-size: 10px;
    font-weight: 900;
    padding: 2px 7px;
    border-radius: 6px;
  }

  .s-bottom {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    padding: 18px 10px 7px;
    background: linear-gradient(to top, rgba(2, 6, 23, 0.94), transparent);
    display: flex;
    justify-content: space-between;
    align-items: flex-end;
    gap: 6px;
  }
  .s-lv {
    font-size: ${compact ? '16px' : '20px'};
    font-weight: 900;
    font-style: italic;
    color: #ffffff;
    line-height: 1;
  }
  .s-lv.max { color: #fde047; }
  .s-name {
    font-size: 11px;
    color: #cbd5e1;
    font-weight: 700;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 64%;
  }

  .c-card {
    border-radius: 12px;
    overflow: hidden;
    border: 2px solid rgba(34, 211, 238, 0.6);
    background: #0b1120;
  }
  .c-media {
    position: relative;
    aspect-ratio: 3 / 4;
    background: #0f172a;
  }
  .c-footer { padding: 7px 9px; background: #090e1c; }
  .c-row { display: flex; justify-content: space-between; align-items: center; gap: 4px; }
  .c-char { font-size: 11px; font-weight: 800; color: #e2e8f0; }
  .c-plan { font-size: 9px; font-weight: 800; padding: 1px 5px; border-radius: 4px; }
  .p-Sense { background: rgba(251, 113, 133, 0.22); color: #fda4af; }
  .p-Logic { background: rgba(56, 189, 248, 0.22); color: #7dd3fc; }
  .p-Anomaly { background: rgba(192, 132, 252, 0.22); color: #d8b4fe; }
  .p-Common { background: rgba(52, 211, 153, 0.22); color: #6ee7b7; }
  .c-name {
    margin-top: 2px;
    font-size: 11px;
    font-weight: 800;
    color: #a5b4fc;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .footer {
    text-align: center;
    font-size: 11px;
    color: #64748b;
    padding-top: 8px;
    border-top: 1px solid rgba(148, 163, 184, 0.14);
  }
</style>
</head>
<body>
  <div id="canvas-root">
    <header class="header-card">
      <div>
        <div class="h-badge">GAKUEN IDOLMASTER · BOX CARD SUMMARY</div>
        <div class="h-title">${escapeHtml(modeTitle)}</div>
        <div class="h-owner">制作人：<strong>${escapeHtml(ownerLabel)}</strong> · 生成时间：${escapeHtml(nowStr)}</div>
      </div>
      <div class="h-stats">
        <div class="stat-box">
          <div class="stat-k">支援卡持有</div>
          <div class="stat-v">${summary.support.owned}/${summary.support.total}</div>
          <div class="stat-s">SSR ${summary.support.ssrOwned} · 满破 ${summary.support.maxBreakTotal}</div>
        </div>
        <div class="stat-box">
          <div class="stat-k">角色与皮肤</div>
          <div class="stat-v">${summary.cidol.owned}/${summary.cidol.total}</div>
          <div class="stat-s">SSR ${summary.cidol.ssrOwned} · 收集率 ${summary.cidol.percent}%</div>
        </div>
      </div>
    </header>

    ${mode === 'cidol' ? '' : renderSupportCardsHtml()}
    ${mode === 'support' ? '' : renderCidolCardsHtml()}

    <footer class="footer">
      数据同步自 vertesan/gakumasu-diff · 非官方同好交流工具 · © Bandai Namco Entertainment Inc.
    </footer>
  </div>
</body>
</html>`;
}

function floor2(n) {
  return Math.floor(n * 100) / 100;
}

/**
 * 关闭页面：重复关闭/关闭异常一律吞掉，且最多等待 PAGE_CLOSE_WAIT_MS，避免卡死渲染队列
 */
async function safeClosePage(page) {
  if (!page || typeof page.close !== 'function') return;
  let timer = null;
  try {
    await Promise.race([
      Promise.resolve()
        .then(() => page.close())
        .catch(() => {}),
      new Promise((resolve) => {
        timer = setTimeout(resolve, PAGE_CLOSE_WAIT_MS);
      }),
    ]);
  } catch (_) {
    // ignore
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 只放行 data: 与 about: 请求，其余外部资源一律拦截（必须在 setContent 之前注册）
 */
async function lockDownRequests(page) {
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    try {
      if (typeof req.isInterceptResolutionHandled === 'function' && req.isInterceptResolutionHandled()) {
        return;
      }
      const url = String((typeof req.url === 'function' ? req.url() : req.url) || '');
      const result = /^(?:data|about):/i.test(url) ? req.continue() : req.abort();
      if (result && typeof result.catch === 'function') result.catch(() => {});
    } catch (_) {
      // ignore
    }
  });
}

async function measureCanvasRoot(page) {
  const rootEl = await page.$('#canvas-root');
  const box = rootEl ? await rootEl.boundingBox() : null;
  if (!box || !(box.width > 0) || !(box.height > 0)) {
    throw new Error('拼图画布边界测量失败');
  }
  return {
    x: Math.floor(box.x),
    y: Math.floor(box.y),
    width: Math.ceil(box.width),
    height: Math.ceil(box.height),
  };
}

async function shootWithQualities(page, clip, scale, qualities) {
  let lastBuf = null;
  for (const q of qualities) {
    const buf = await page.screenshot({ clip, type: 'jpeg', quality: q });
    lastBuf = buf;
    if (buf.length < MAX_JPEG_BYTES) {
      return { buffer: buf, quality: q, scale, width: clip.width, height: clip.height, oversized: false };
    }
  }
  return {
    buffer: lastBuf,
    quality: qualities[qualities.length - 1],
    scale,
    width: clip.width,
    height: clip.height,
    oversized: true,
  };
}

/**
 * 在已获取的页面上完成：请求拦截 → 1x 测量 → 按高度自适应缩放 → 逐级降质量截图
 */
async function captureOnPage(page, html, { assetWaitMs = ASSET_WAIT_MS, contentTimeoutMs = RENDER_TIMEOUT_MS } = {}) {
  await lockDownRequests(page);
  await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
  await page.setContent(html, { waitUntil: 'load', timeout: contentTimeoutMs });
  await page.evaluate(async (waitMs) => {
    const ready = (async () => {
      if (document.fonts && document.fonts.ready) {
        await document.fonts.ready;
      }
      const imgs = Array.from(document.querySelectorAll('img'));
      await Promise.all(
        imgs.map((img) =>
          img.complete
            ? Promise.resolve()
            : new Promise((res) => {
                img.onload = res;
                img.onerror = res;
              })
        )
      );
    })();
    await Promise.race([ready, new Promise((res) => setTimeout(res, waitMs))]);
  }, assetWaitMs);

  const baseClip = await measureCanvasRoot(page);
  const scale = floor2(Math.min(MAX_SCALE, MAX_OUTPUT_HEIGHT_PX / baseClip.height));
  if (!(scale >= MIN_SCALE)) {
    throw new Error('拼图过长');
  }

  await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: scale });
  const clip = await measureCanvasRoot(page);
  const firstPass = await shootWithQualities(page, clip, scale, [86, 76, 66, 56]);
  if (!firstPass.oversized) return firstPass;

  // 体积仍超限：降低缩放倍率再按更低质量重试
  const fallbackScale = Math.max(MIN_SCALE, floor2(Math.min(1, scale * 0.7)));
  if (fallbackScale >= scale) return firstPass;
  await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: fallbackScale });
  const clip2 = await measureCanvasRoot(page);
  return shootWithQualities(page, clip2, fallbackScale, [74, 62, 52]);
}

async function renderBoxImage({ getPage, dataDir, htmlPayload, timeoutMs = RENDER_TIMEOUT_MS }) {
  return withRenderLock(async () => {
    const html = buildRenderHtml({ ...htmlPayload, dataDir });
    let page = null;
    let pageClosed = false;
    let timedOut = false;
    let timer = null;

    const closePageOnce = () => {
      if (!page || pageClosed) return Promise.resolve();
      pageClosed = true;
      return safeClosePage(page);
    };

    const work = (async () => {
      const acquired = await getPage();
      page = acquired;
      if (timedOut) {
        await closePageOnce();
        throw new Error('BOX 拼图渲染超时（页面获取过慢）');
      }
      return captureOnPage(acquired, html, { contentTimeoutMs: timeoutMs });
    })();
    work.catch(() => {});

    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        closePageOnce();
        reject(new Error(`BOX 拼图渲染超时（${Math.round(timeoutMs / 1000)}s）`));
      }, timeoutMs);
    });

    try {
      return await Promise.race([work, timeout]);
    } finally {
      clearTimeout(timer);
      await closePageOnce();
    }
  });
}

module.exports = {
  MAX_JPEG_BYTES,
  RENDER_TIMEOUT_MS,
  escapeHtml,
  buildRenderHtml,
  renderBoxImage,
  getPendingRenderCount,
  fileToDataUrl,
  clearDataUrlCache,
  getDataUrlCacheSize,
};
