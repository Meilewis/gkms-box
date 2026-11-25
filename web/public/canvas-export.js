(function (root) {
  'use strict';

  const PLAN_STYLES = {
    Sense: { bg1: '#2d1122', bg2: '#13162b', accent: '#fb7185', label: '感性 Sense' },
    Logic: { bg1: '#0c2742', bg2: '#10182f', accent: '#38bdf8', label: '理性 Logic' },
    Anomaly: { bg1: '#291342', bg2: '#151530', accent: '#c084fc', label: '非凡 Anomaly' },
    Common: { bg1: '#0b2b27', bg2: '#10192d', accent: '#34d399', label: '通用 Common' },
  };

  const ATTR_BADGES = {
    vo: { bg: '#ef4444', fg: '#ffffff', text: 'VO' },
    da: { bg: '#3b82f6', fg: '#ffffff', text: 'DA' },
    vi: { bg: '#eab308', fg: '#1c1917', text: 'VI' },
    as: { bg: '#10b981', fg: '#052e16', text: 'AS' },
  };

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(`加载图片失败: ${src}`));
      img.src = src;
    });
  }

  function roundRect(ctx, x, y, w, h, r) {
    const radius = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + w, y, x + w, y + h, radius);
    ctx.arcTo(x + w, y + h, x, y + h, radius);
    ctx.arcTo(x, y + h, x, y, radius);
    ctx.arcTo(x, y, x + w, y, radius);
    ctx.closePath();
  }

  function drawWrappedText(ctx, text, cx, cy, maxWidth, lineHeight, maxLines) {
    const chars = Array.from(String(text || ''));
    const lines = [];
    let current = '';
    for (const ch of chars) {
      const test = current + ch;
      if (ctx.measureText(test).width > maxWidth && current.length > 0) {
        lines.push(current);
        current = ch;
        if (lines.length === maxLines) break;
      } else {
        current = test;
      }
    }
    if (current && lines.length < maxLines) {
      lines.push(current);
    }
    const totalH = lines.length * lineHeight;
    const startY = cy - totalH / 2 + lineHeight * 0.72;
    lines.forEach((line, idx) => {
      ctx.fillText(line, cx, startY + idx * lineHeight);
    });
  }

  function computeSafeLayout(count, baseCols, itemW, itemH, gap) {
    const maxCanvasH = 13600;
    const maxCanvasArea = 12000000;
    let cols = Math.min(Math.max(1, count), baseCols);
    if (count > cols * 16) {
      cols = Math.min(baseCols + 2, 8);
    }
    const rows = Math.max(1, Math.ceil(count / cols));
    const rawW = cols * itemW + (cols + 1) * gap;
    const rawH = rows * itemH + (rows + 1) * gap + 190;
    const hScale = rawH > maxCanvasH ? maxCanvasH / rawH : 1;
    const areaScale = rawW * rawH > maxCanvasArea ? Math.sqrt(maxCanvasArea / (rawW * rawH)) : 1;
    const scale = Math.min(1, hScale, areaScale);
    return {
      cols,
      rows,
      scale,
      itemW: Math.floor(itemW * scale),
      itemH: Math.floor(itemH * scale),
      gap: Math.max(6, Math.floor(gap * scale)),
    };
  }

  function drawRarityBadge(ctx, rarity, x, y, scale) {
    const label = rarity === '3' ? 'SSR' : rarity === '2' ? 'SR' : 'R';
    const w = Math.round(48 * scale);
    const h = Math.round(22 * scale);
    ctx.save();
    roundRect(ctx, x, y, w, h, 6 * scale);
    if (rarity === '3') {
      const g = ctx.createLinearGradient(x, y, x + w, y + h);
      g.addColorStop(0, '#22d3ee');
      g.addColorStop(0.5, '#6366f1');
      g.addColorStop(1, '#ec4899');
      ctx.fillStyle = g;
    } else if (rarity === '2') {
      ctx.fillStyle = '#eab308';
    } else {
      ctx.fillStyle = '#94a3b8';
    }
    ctx.fill();
    ctx.fillStyle = rarity === '2' ? '#271502' : '#ffffff';
    ctx.font = `900 ${Math.max(10, Math.round(12 * scale))}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, x + w / 2, y + h / 2 + 1);
    ctx.restore();
  }

  function drawAttrBadge(ctx, attr, rightX, y, scale) {
    const info = ATTR_BADGES[attr];
    if (!info) return;
    const w = Math.round(36 * scale);
    const h = Math.round(22 * scale);
    ctx.save();
    roundRect(ctx, rightX - w, y, w, h, 6 * scale);
    ctx.fillStyle = info.bg;
    ctx.fill();
    ctx.fillStyle = info.fg;
    ctx.font = `900 ${Math.max(10, Math.round(11 * scale))}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(info.text, rightX - w / 2, y + h / 2 + 1);
    ctx.restore();
  }

  async function drawSupportItem(ctx, item, breakLevel, x, y, w, h, manifestCardSet) {
    const scale = w / 340;
    const plan = PLAN_STYLES[item.plan] || PLAN_STYLES.Common;
    ctx.save();
    roundRect(ctx, x, y, w, h, 12 * scale);
    ctx.clip();

    const hasImage = manifestCardSet.has(item.key);
    let drewImg = false;
    if (hasImage) {
      try {
        const img = await loadImage(`./${item.image}`);
        ctx.drawImage(img, x, y, w, h);
        drewImg = true;
      } catch {
        drewImg = false;
      }
    }

    if (!drewImg) {
      const grad = ctx.createLinearGradient(x, y, x + w, y + h);
      grad.addColorStop(0, plan.bg1);
      grad.addColorStop(1, plan.bg2);
      ctx.fillStyle = grad;
      ctx.fillRect(x, y, w, h);

      ctx.fillStyle = plan.accent;
      ctx.globalAlpha = 0.25;
      ctx.fillRect(x, y, w, Math.max(3, 4 * scale));
      ctx.globalAlpha = 1;

      ctx.fillStyle = '#f8fafc';
      ctx.textAlign = 'center';
      ctx.font = `800 ${Math.max(12, Math.round(17 * scale))}px "PingFang SC","Microsoft YaHei",sans-serif`;
      drawWrappedText(ctx, item.name, x + w / 2, y + h * 0.45, w - 28 * scale, 22 * scale, 2);

      ctx.fillStyle = '#94a3b8';
      ctx.font = `700 ${Math.max(10, Math.round(12 * scale))}px sans-serif`;
      ctx.fillText(`${plan.label} · #${item.number}`, x + w / 2, y + h * 0.67);
    }

    const overlay = ctx.createLinearGradient(x, y + h * 0.55, x, y + h);
    overlay.addColorStop(0, 'rgba(2, 6, 23, 0)');
    overlay.addColorStop(1, 'rgba(2, 6, 23, 0.92)');
    ctx.fillStyle = overlay;
    ctx.fillRect(x, y + h * 0.55, w, h * 0.45);

    drawRarityBadge(ctx, item.rarity, x + 10 * scale, y + 10 * scale, scale);
    drawAttrBadge(ctx, item.attr, x + w - 10 * scale, y + 10 * scale, scale);

    const baseLv = item.rarity === '3' ? 40 : 30;
    const lvText = `LV.${baseLv + breakLevel * 5}`;
    ctx.fillStyle = breakLevel === 4 ? '#fde047' : '#ffffff';
    ctx.font = `italic 900 ${Math.max(14, Math.round(24 * scale))}px sans-serif`;
    ctx.textAlign = 'left';
    ctx.fillText(lvText, x + 12 * scale, y + h - 12 * scale);

    ctx.fillStyle = '#cbd5e1';
    ctx.font = `700 ${Math.max(10, Math.round(12 * scale))}px sans-serif`;
    ctx.textAlign = 'right';
    ctx.fillText(breakLevel === 4 ? '满破 MAX' : `${breakLevel} 破`, x + w - 12 * scale, y + h - 14 * scale);

    ctx.restore();

    ctx.save();
    roundRect(ctx, x, y, w, h, 12 * scale);
    ctx.lineWidth = breakLevel === 4 ? 2.5 : 1.5;
    ctx.strokeStyle = breakLevel === 4 ? '#fbbf24' : 'rgba(56, 189, 248, 0.55)';
    ctx.stroke();
    ctx.restore();
  }

  async function drawCidolItem(ctx, skin, charName, variant, x, y, w, h, manifestCidolMap) {
    const scale = w / 220;
    const plan = PLAN_STYLES[skin.plan] || PLAN_STYLES.Common;
    const footerH = Math.round(44 * scale);
    const mediaH = h - footerH;

    ctx.save();
    roundRect(ctx, x, y, w, h, 12 * scale);
    ctx.clip();

    ctx.fillStyle = '#0f172a';
    ctx.fillRect(x, y, w, h);

    const availVariants = manifestCidolMap[skin.key] || [];
    const chosenVariant = availVariants.includes(variant)
      ? variant
      : availVariants[0] || '';

    let drewImg = false;
    if (chosenVariant) {
      try {
        const img = await loadImage(`./${skin.images[chosenVariant]}`);
        const ratio = Math.max(w / img.naturalWidth, mediaH / img.naturalHeight);
        const dw = img.naturalWidth * ratio;
        const dh = img.naturalHeight * ratio;
        ctx.drawImage(img, x + (w - dw) / 2, y + (mediaH - dh) / 2, dw, dh);
        drewImg = true;
      } catch {
        drewImg = false;
      }
    }

    if (!drewImg) {
      const grad = ctx.createLinearGradient(x, y, x + w, y + mediaH);
      grad.addColorStop(0, plan.bg1);
      grad.addColorStop(1, plan.bg2);
      ctx.fillStyle = grad;
      ctx.fillRect(x, y, w, mediaH);

      ctx.fillStyle = '#f8fafc';
      ctx.textAlign = 'center';
      ctx.font = `800 ${Math.max(12, Math.round(16 * scale))}px "PingFang SC","Microsoft YaHei",sans-serif`;
      drawWrappedText(ctx, skin.name, x + w / 2, y + mediaH * 0.46, w - 24 * scale, 22 * scale, 3);

      ctx.fillStyle = plan.accent;
      ctx.font = `700 ${Math.max(10, Math.round(11 * scale))}px sans-serif`;
      ctx.fillText(plan.label, x + w / 2, y + mediaH * 0.72);
    }

    drawRarityBadge(ctx, skin.rarity, x + 8 * scale, y + 8 * scale, scale * 0.9);

    ctx.fillStyle = '#090e1c';
    ctx.fillRect(x, y + mediaH, w, footerH);

    ctx.fillStyle = '#e2e8f0';
    ctx.font = `800 ${Math.max(11, Math.round(13 * scale))}px sans-serif`;
    ctx.textAlign = 'left';
    ctx.fillText(charName, x + 10 * scale, y + mediaH + 17 * scale);

    ctx.fillStyle = '#a5b4fc';
    ctx.font = `700 ${Math.max(10, Math.round(12 * scale))}px sans-serif`;
    ctx.fillText(skin.name.slice(0, 12), x + 10 * scale, y + mediaH + 34 * scale);

    ctx.restore();

    ctx.save();
    roundRect(ctx, x, y, w, h, 12 * scale);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(34, 211, 238, 0.7)';
    ctx.stroke();
    ctx.restore();
  }

  async function renderSummaryCanvas({
    mode,
    supportList,
    supportMap,
    cidolList,
    characters,
    cidolVariant,
    manifest,
    summary,
  }) {
    if (window.location.protocol === 'file:') {
      throw new Error('直接双击本地 HTML 文件打开时浏览器会拦截画布导出，请通过 HTTP 服务或 Cloudflare Pages 访问。');
    }

    const manifestCardSet = new Set((manifest && manifest.cards) || []);
    const manifestCidolMap = (manifest && manifest.cidol) || {};

    const includeSupport = mode === 'support' || mode === 'all';
    const includeCidol = mode === 'cidol' || mode === 'all';

    const sItems = includeSupport ? supportList : [];
    const cItems = includeCidol ? cidolList : [];
    if (sItems.length === 0 && cItems.length === 0) {
      throw new Error('当前没有已勾选的卡片可导出');
    }

    const canvasW = 1480;
    const padX = 28;
    const headerH = 112;
    const footerH = 44;

    const sCols = 4;
    const sGap = 14;
    const sW = Math.floor((canvasW - padX * 2 - sGap * (sCols - 1)) / sCols);
    const sH = Math.round((sW * 9) / 16);
    const sRows = sItems.length ? Math.ceil(sItems.length / sCols) : 0;
    const sSecH = sItems.length ? 40 + sRows * sH + (sRows - 1) * sGap + 18 : 0;

    const cCols = 6;
    const cGap = 12;
    const cW = Math.floor((canvasW - padX * 2 - cGap * (cCols - 1)) / cCols);
    const cH = Math.round(cW * 1.38) + 44;
    const cRows = cItems.length ? Math.ceil(cItems.length / cCols) : 0;
    const cSecH = cItems.length ? 40 + cRows * cH + (cRows - 1) * cGap + 18 : 0;

    let rawTotalH = headerH + sSecH + cSecH + footerH;
    let scale = 1;
    if (rawTotalH > 13600) {
      scale = 13600 / rawTotalH;
    }
    if (canvasW * rawTotalH * scale * scale > 12000000) {
      scale = Math.min(scale, Math.sqrt(12000000 / (canvasW * rawTotalH)));
    }

    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(canvasW * scale);
    canvas.height = Math.floor(rawTotalH * scale);
    const ctx = canvas.getContext('2d');
    ctx.scale(scale, scale);

    ctx.fillStyle = '#070b14';
    ctx.fillRect(0, 0, canvasW, rawTotalH);

    const hGrad = ctx.createLinearGradient(0, 0, canvasW, headerH);
    hGrad.addColorStop(0, '#111c3a');
    hGrad.addColorStop(1, '#191335');
    ctx.fillStyle = hGrad;
    ctx.fillRect(0, 0, canvasW, headerH);

    ctx.fillStyle = '#f8fafc';
    ctx.font = '900 28px "PingFang SC","Microsoft YaHei",sans-serif';
    const titleMap = {
      support: '学园偶像大师 · 支援卡 BOX 汇总',
      cidol: '学园偶像大师 · 角色与皮肤 BOX 汇总',
      all: '学园偶像大师 · 全图鉴 BOX 汇总',
    };
    ctx.fillText(titleMap[mode] || titleMap.all, padX, 46);

    ctx.fillStyle = '#93c5fd';
    ctx.font = '700 16px sans-serif';
    const statLine =
      `支援卡 ${summary.support.owned}/${summary.support.total}（SSR ${summary.support.ssrOwned} · 满破 ${summary.support.maxBreakTotal}）  |  ` +
      `角色皮肤 ${summary.cidol.owned}/${summary.cidol.total}（SSR ${summary.cidol.ssrOwned}）  |  生成日期 ${new Date().toLocaleDateString('zh-CN')}`;
    ctx.fillText(statLine, padX, 82);

    let cursorY = headerH + 14;

    if (sItems.length > 0) {
      ctx.fillStyle = '#38bdf8';
      ctx.font = '800 18px sans-serif';
      ctx.fillText(`支援卡（共展示 ${sItems.length} 张）`, padX, cursorY + 22);
      cursorY += 36;
      for (let i = 0; i < sItems.length; i += 1) {
        const col = i % sCols;
        const row = Math.floor(i / sCols);
        const x = padX + col * (sW + sGap);
        const y = cursorY + row * (sH + sGap);
        const card = sItems[i];
        await drawSupportItem(ctx, card, supportMap[card.key] ?? 0, x, y, sW, sH, manifestCardSet);
      }
      cursorY += sRows * sH + (sRows - 1) * sGap + 24;
    }

    if (cItems.length > 0) {
      ctx.fillStyle = '#c084fc';
      ctx.font = '800 18px sans-serif';
      ctx.fillText(`角色与皮肤（共展示 ${cItems.length} 项）`, padX, cursorY + 22);
      cursorY += 36;
      for (let i = 0; i < cItems.length; i += 1) {
        const col = i % cCols;
        const row = Math.floor(i / cCols);
        const x = padX + col * (cW + cGap);
        const y = cursorY + row * (cH + cGap);
        const skin = cItems[i];
        await drawCidolItem(
          ctx,
          skin,
          (characters && characters[skin.character]) || skin.character.toUpperCase(),
          cidolVariant,
          x,
          y,
          cW,
          cH,
          manifestCidolMap
        );
      }
      cursorY += cRows * cH + (cRows - 1) * cGap + 20;
    }

    ctx.fillStyle = '#64748b';
    ctx.font = '600 13px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(
      '数据同步自 vertesan/gakumasu-diff · 非官方同好交流工具 · © Bandai Namco Entertainment Inc.',
      canvasW / 2,
      rawTotalH - 16
    );

    return canvas.toDataURL('image/jpeg', 0.88);
  }

  root.GkmsCanvasExport = { renderSummaryCanvas };
})(typeof globalThis !== 'undefined' ? globalThis : this);
