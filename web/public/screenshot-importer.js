(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  if (root && typeof root === 'object') {
    root.GkmsScreenshotImporter = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DEFAULT_TARGET_WIDTH = 720;
  const LONG_IMAGE_SINGLE_LIMIT = 3200;
  const STRIP_HEIGHT = 2800;
  const STRIP_OVERLAP = 360;

  const CENTERS_1D = [0.180, 0.308, 0.436, 0.564];
  const CENTERS_2D = [0.260, 0.388, 0.516, 0.644];

  function decodeBase64ToBytes(b64) {
    if (!b64) return new Uint8Array(0);
    if (typeof Buffer === 'function') {
      return new Uint8Array(Buffer.from(b64, 'base64'));
    }
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) {
      bytes[i] = bin.charCodeAt(i);
    }
    return bytes;
  }

  /**
   * 将 support-fingerprints.json 解码为可直接做高速点积的内存向量库
   */
  function decodeFingerprintDb(payload) {
    if (!payload || typeof payload !== 'object' || !payload.dataB64) {
      throw new Error('无效的支援卡指纹库数据');
    }
    const featW = Number(payload.featW) || 14;
    const featH = Number(payload.featH) || 9;
    const variantsPerCard = Number(payload.variantsPerCard) || 7;
    const dim = featW * featH * 3;
    const keys = Array.isArray(payload.keys) ? payload.keys : [];
    const attrs = Array.isArray(payload.attrs) ? payload.attrs : [];

    const rawBytes = decodeBase64ToBytes(payload.dataB64);
    const int8 = new Int8Array(rawBytes.buffer, rawBytes.byteOffset, rawBytes.byteLength);
    const expectedLen = keys.length * variantsPerCard * dim;
    if (int8.length !== expectedLen) {
      throw new Error(`指纹库长度不匹配: 期望 ${expectedLen}, 实际 ${int8.length}`);
    }

    const entries = new Array(keys.length);
    let offset = 0;
    for (let i = 0; i < keys.length; i += 1) {
      const variants = new Array(variantsPerCard);
      for (let v = 0; v < variantsPerCard; v += 1) {
        const vec = new Float32Array(dim);
        let sqSum = 0;
        for (let k = 0; k < dim; k += 1) {
          const val = int8[offset + k];
          vec[k] = val;
          sqSum += val * val;
        }
        const invNorm = sqSum > 0 ? 1 / Math.sqrt(sqSum) : 1;
        for (let k = 0; k < dim; k += 1) {
          vec[k] *= invNorm;
        }
        variants[v] = vec;
        offset += dim;
      }
      entries[i] = {
        key: keys[i],
        attr: attrs[i] || '',
        variants,
      };
    }

    return {
      featW,
      featH,
      dim,
      variantsPerCard,
      entries,
    };
  }

  /**
   * 生成纯数学对称的 12x12 倾斜四角星模板（避免依赖游戏素材裁剪模板）
   */
  function makeSyntheticStarTemplate(invert = false) {
    const vals = new Float32Array(144);
    let sum = 0;
    for (let y = 0; y < 12; y += 1) {
      const ny = (y - 5.5) / 5.5;
      for (let x = 0; x < 12; x += 1) {
        const nx = (x - 5.5) / 5.5;
        const d1 = Math.abs(nx - ny);
        const d2 = Math.abs(nx + ny);
        const r = Math.hypot(nx, ny);
        const inStar = (Math.min(d1, d2) < 0.38 && r < 0.92) || r < 0.42;
        let v = inStar ? 1.0 : -0.6;
        if (invert) v = -v;
        vals[y * 12 + x] = v;
        sum += v;
      }
    }
    const mean = sum / 144;
    let sqSum = 0;
    for (let i = 0; i < 144; i += 1) {
      vals[i] -= mean;
      sqSum += vals[i] * vals[i];
    }
    const invNorm = sqSum > 0 ? 1 / Math.sqrt(sqSum) : 1;
    for (let i = 0; i < 144; i += 1) {
      vals[i] *= invNorm;
    }
    return vals;
  }

  const TMPL_BRIGHT = makeSyntheticStarTemplate(false);
  const TMPL_DARK = makeSyntheticStarTemplate(true);

  function dotFloat(a, b) {
    let s = 0;
    for (let i = 0; i < a.length; i += 1) {
      s += a[i] * b[i];
    }
    return s;
  }

  function sampleBilinearRgbAt(rgba, imgW, imgH, fx, fy) {
    const cx = Math.max(0, Math.min(imgW - 1, fx));
    const cy = Math.max(0, Math.min(imgH - 1, fy));
    const x0 = Math.floor(cx);
    const y0 = Math.floor(cy);
    const x1 = Math.min(imgW - 1, x0 + 1);
    const y1 = Math.min(imgH - 1, y0 + 1);
    const dx = cx - x0;
    const dy = cy - y0;

    const i00 = (y0 * imgW + x0) * 4;
    const i10 = (y0 * imgW + x1) * 4;
    const i01 = (y1 * imgW + x0) * 4;
    const i11 = (y1 * imgW + x1) * 4;

    const w00 = (1 - dx) * (1 - dy);
    const w10 = dx * (1 - dy);
    const w01 = (1 - dx) * dy;
    const w11 = dx * dy;

    const r = rgba[i00] * w00 + rgba[i10] * w10 + rgba[i01] * w01 + rgba[i11] * w11;
    const g = rgba[i00 + 1] * w00 + rgba[i10 + 1] * w10 + rgba[i01 + 1] * w01 + rgba[i11 + 1] * w11;
    const b = rgba[i00 + 2] * w00 + rgba[i10 + 2] * w10 + rgba[i01 + 2] * w01 + rgba[i11 + 2] * w11;
    return [r, g, b];
  }

  /**
   * 对卡片干净上半区域做抗锯齿双线性缩放到 featW x featH 并输出零均值单位向量
   */
  function extractCardFeatureFromRgba(rgba, imgW, imgH, rx1, ry1, rx2, ry2, featW, featH) {
    const cw = rx2 - rx1;
    const ch = ry2 - ry1;
    const sx = rx1 + cw * 0.05;
    const sy = ry1 + ch * 0.06;
    const sw = cw * 0.90;
    const sh = ch * 0.56;

    const dim = featW * featH * 3;
    const vec = new Float32Array(dim);
    let sum = 0;

    for (let oy = 0; oy < featH; oy += 1) {
      for (let ox = 0; ox < featW; ox += 1) {
        // 2x2 子像素超采样，缓解大比例缩小导致的锯齿
        let rAcc = 0;
        let gAcc = 0;
        let bAcc = 0;
        for (const subY of [0.25, 0.75]) {
          for (const subX of [0.25, 0.75]) {
            const fx = sx + ((ox + subX) / featW) * sw - 0.5;
            const fy = sy + ((oy + subY) / featH) * sh - 0.5;
            const [r, g, b] = sampleBilinearRgbAt(rgba, imgW, imgH, fx, fy);
            rAcc += r;
            gAcc += g;
            bAcc += b;
          }
        }
        const idx = (oy * featW + ox) * 3;
        const rn = rAcc / (4 * 255);
        const gn = gAcc / (4 * 255);
        const bn = bAcc / (4 * 255);
        vec[idx] = rn;
        vec[idx + 1] = gn;
        vec[idx + 2] = bn;
        sum += rn + gn + bn;
      }
    }

    const mean = sum / dim;
    let sqSum = 0;
    for (let i = 0; i < dim; i += 1) {
      vec[i] -= mean;
      sqSum += vec[i] * vec[i];
    }
    const invNorm = sqSum > 0 ? 1 / Math.sqrt(sqSum) : 1;
    for (let i = 0; i < dim; i += 1) {
      vec[i] *= invNorm;
    }
    return vec;
  }

  function isWhitePixel(rgba, imgW, x, y, thr) {
    const idx = (y * imgW + x) * 4;
    return rgba[idx] > thr && rgba[idx + 1] > thr && rgba[idx + 2] > thr;
  }

  function hasWhiteNearX(rgba, imgW, y, xCenterFrac, halfSpanFrac = 0.025, thr = 235) {
    const xa = Math.max(0, Math.floor(imgW * (xCenterFrac - halfSpanFrac)));
    const xb = Math.min(imgW - 1, Math.floor(imgW * (xCenterFrac + halfSpanFrac)));
    for (let x = xa; x <= xb; x += 1) {
      if (isWhitePixel(rgba, imgW, x, y, thr)) {
        return true;
      }
    }
    return false;
  }

  /**
   * 通用 3 列网格定位（兼容任意分辨率、单屏分段图与超长滚动图，自动避开顶部预览、右侧滚动条与底部悬浮栏）
   */
  function detectGridInRgba(rgba, w, h) {
    if (!rgba || w < 120 || h < 80) {
      return { cols: [], rows: [] };
    }

    const leftMarginX = Math.floor(w * 0.015);
    const rightMarginX = Math.min(w - 1, Math.floor(w * 0.985));
    const gridYs = [];
    const stepY = Math.max(2, Math.floor(h / 500));

    for (let y = 0; y < h; y += stepY) {
      if (
        hasWhiteNearX(rgba, w, y, 0.015, 0.012, 232) &&
        hasWhiteNearX(rgba, w, y, 0.978, 0.018, 232) &&
        hasWhiteNearX(rgba, w, y, 0.346, 0.025, 232) &&
        hasWhiteNearX(rgba, w, y, 0.654, 0.025, 232)
      ) {
        gridYs.push(y);
      }
    }

    if (gridYs.length < 6) {
      return { cols: [], rows: [] };
    }

    const cols = [];
    const colWhiteRatios = new Float32Array(w);
    let inRun = false;
    let runStart = 0;
    for (let x = 0; x < w; x += 1) {
      let whites = 0;
      for (let i = 0; i < gridYs.length; i += 1) {
        if (isWhitePixel(rgba, w, x, gridYs[i], 232)) {
          whites += 1;
        }
      }
      const whiteRatio = whites / gridYs.length;
      colWhiteRatios[x] = whiteRatio;
      if (whiteRatio < 0.72 && !inRun) {
        runStart = x;
        inRun = true;
      } else if (whiteRatio >= 0.72 && inRun) {
        if (x - runStart > w * 0.2) {
          cols.push([runStart, x]);
        }
        inRun = false;
      }
    }
    if (inRun && w - runStart > w * 0.2) {
      cols.push([runStart, w]);
    }

    if (cols.length !== 3) {
      return { cols, rows: [] };
    }

    const pickCleanestGutterX = (xStart, xEnd, fallbackX) => {
      if (xEnd < xStart) return fallbackX;
      let bestRatio = -1;
      for (let x = xStart; x <= xEnd; x += 1) {
        if (colWhiteRatios[x] > bestRatio) bestRatio = colWhiteRatios[x];
      }
      if (bestRatio < 0.5) return fallbackX;
      const cleanXs = [];
      for (let x = xStart; x <= xEnd; x += 1) {
        if (colWhiteRatios[x] >= bestRatio - 0.02) cleanXs.push(x);
      }
      return cleanXs.length > 0 ? cleanXs[Math.floor(cleanXs.length / 2)] : fallbackX;
    };

    const cardW = (cols[0][1] - cols[0][0] + (cols[1][1] - cols[1][0]) + (cols[2][1] - cols[2][0])) / 3;
    const expectedH = cardW / 1.77;
    const sampleXs = [];
    for (const [x1, x2] of cols) {
      for (const f of [0.15, 0.35, 0.5, 0.65, 0.85]) {
        sampleXs.push(Math.min(w - 1, Math.floor(x1 + (x2 - x1) * f)));
      }
    }

    const gutterXs = [
      pickCleanestGutterX(0, cols[0][0] - 1, leftMarginX),
      Math.floor((cols[0][1] + cols[1][0]) / 2),
      Math.floor((cols[1][1] + cols[2][0]) / 2),
      pickCleanestGutterX(cols[2][1], w - 1, rightMarginX),
    ];

    const rows = [];
    inRun = false;
    runStart = 0;
    const minRowH = expectedH * 0.85;
    const maxRowH = expectedH * 1.15;

    for (let y = 0; y < h; y += 1) {
      const g0 = isWhitePixel(rgba, w, gutterXs[0], y, 225);
      const g1 = isWhitePixel(rgba, w, gutterXs[1], y, 225);
      const g2 = isWhitePixel(rgba, w, gutterXs[2], y, 225);
      const g3 = isWhitePixel(rgba, w, gutterXs[3], y, 225);
      const gWhites = (g0 ? 1 : 0) + (g1 ? 1 : 0) + (g2 ? 1 : 0) + (g3 ? 1 : 0);
      const gutterOk = gWhites >= 2 && (g0 || g3) && (g1 || g2);

      if (!gutterOk) {
        if (inRun) {
          const rh = y - runStart;
          if (rh >= minRowH && rh <= maxRowH) {
            rows.push([runStart, y]);
          }
          inRun = false;
        }
        continue;
      }

      let whites = 0;
      for (let i = 0; i < sampleXs.length; i += 1) {
        if (isWhitePixel(rgba, w, sampleXs[i], y, 232)) {
          whites += 1;
        }
      }
      const isCard = whites / sampleXs.length < 0.75;
      if (isCard && !inRun) {
        runStart = y;
        inRun = true;
      } else if (!isCard && inRun) {
        const rh = y - runStart;
        if (rh >= minRowH && rh <= maxRowH) {
          rows.push([runStart, y]);
        }
        inRun = false;
      }
    }

    if (inRun) {
      const rh = h - runStart;
      if (rh >= minRowH && rh <= maxRowH) {
        rows.push([runStart, h]);
      }
    }

    return { cols, rows };
  }

  /**
   * 识别卡片右下角属性图标颜色，并按缩放后的 ROI 面积自适配像素阈值
   */
  function detectAttrFromRgba(rgba, imgW, imgH, rx1, ry1, rx2, ry2) {
    const cw = rx2 - rx1;
    const ch = ry2 - ry1;
    const x1 = Math.max(0, Math.floor(rx1 + cw * 0.8));
    const x2 = Math.min(imgW, Math.floor(rx1 + cw * 0.95));
    const y1 = Math.max(0, Math.floor(ry1 + ch * 0.72));
    const y2 = Math.min(imgH, Math.floor(ry1 + ch * 0.91));
    const roiArea = Math.max(1, (x2 - x1) * (y2 - y1));
    const minPixels = Math.max(10, Math.floor(roiArea * 0.1));

    const counts = { vo: 0, da: 0, vi: 0, as: 0 };
    for (let yy = y1; yy < y2; yy += 1) {
      for (let xx = x1; xx < x2; xx += 1) {
        const idx = (yy * imgW + xx) * 4;
        const r = rgba[idx];
        const g = rgba[idx + 1];
        const b = rgba[idx + 2];
        if (r > 200 && g < 110 && b > 70 && r - g > 100) {
          counts.vo += 1;
        } else if (b > 180 && r < 95 && g > 90 && b - r > 85) {
          counts.da += 1;
        } else if (r > 205 && g > 140 && b < 85 && r - b > 120) {
          counts.vi += 1;
        } else if (g > 160 && r < 120 && b < 130 && g - r > 50) {
          counts.as += 1;
        }
      }
    }

    let bestAttr = null;
    let bestCnt = 0;
    for (const attr of ['vo', 'da', 'vi', 'as']) {
      if (counts[attr] > bestCnt) {
        bestCnt = counts[attr];
        bestAttr = attr;
      }
    }
    return bestCnt >= minPixels ? bestAttr : null;
  }

  function cropStarGrayPatch(rgba, imgW, imgH, rx1, ry1, cw, ch, cxFrac) {
    const hw = cw * 0.062;
    const hh = ch * 0.1;
    const cx = rx1 + cw * cxFrac;
    const cy = ry1 + ch * 0.81;
    const sx = cx - hw;
    const sy = cy - hh;
    const sw = hw * 2;
    const sh = hh * 2;

    const vals = new Float32Array(144);
    let sum = 0;
    for (let oy = 0; oy < 12; oy += 1) {
      for (let ox = 0; ox < 12; ox += 1) {
        const fx = sx + ((ox + 0.5) / 12) * sw - 0.5;
        const fy = sy + ((oy + 0.5) / 12) * sh - 0.5;
        const [r, g, b] = sampleBilinearRgbAt(rgba, imgW, imgH, fx, fy);
        const lum = 0.299 * r + 0.587 * g + 0.114 * b;
        vals[oy * 12 + ox] = lum;
        sum += lum;
      }
    }

    const mean = sum / 144;
    let sqSum = 0;
    for (let i = 0; i < 144; i += 1) {
      vals[i] -= mean;
      sqSum += vals[i] * vals[i];
    }
    const invNorm = sqSum > 0 ? 1 / Math.sqrt(sqSum) : 1;
    for (let i = 0; i < 144; i += 1) {
      vals[i] *= invNorm;
    }
    return vals;
  }

  /**
   * 识别 0~4 破（兼容 1 位数 Lv 与 2 位数 Lv 偏移，自动判断遮挡低置信度）
   */
  function detectBreaksFromRgba(rgba, imgW, imgH, rx1, ry1, rx2, ry2) {
    const cw = rx2 - rx1;
    const ch = ry2 - ry1;

    function evalCenters(centers) {
      let shapeSum = 0;
      const brightRatios = [];
      for (const cxFrac of centers) {
        const patch = cropStarGrayPatch(rgba, imgW, imgH, rx1, ry1, cw, ch, cxFrac);
        const sb = dotFloat(patch, TMPL_BRIGHT);
        const sd = dotFloat(patch, TMPL_DARK);
        shapeSum += Math.max(sb, sd);

        const cx = rx1 + cw * cxFrac;
        const hw = cw * 0.055;
        const cy = ry1 + ch * 0.81;
        const hh = ch * 0.085;
        const x1 = Math.max(0, Math.floor(cx - hw));
        const x2 = Math.min(imgW, Math.ceil(cx + hw));
        const y1 = Math.max(0, Math.floor(cy - hh));
        const y2 = Math.min(imgH, Math.ceil(cy + hh));
        let bright = 0;
        let tot = 0;
        for (let yy = y1; yy < y2; yy += 1) {
          for (let xx = x1; xx < x2; xx += 1) {
            const idx = (yy * imgW + xx) * 4;
            tot += 1;
            if (rgba[idx] > 205 && rgba[idx + 1] > 205 && rgba[idx + 2] > 215) {
              bright += 1;
            }
          }
        }
        brightRatios.push(bright / Math.max(1, tot));
      }
      return { shapeSum, brightRatios };
    }

    let topBarWhite = 0;
    let topBarTot = 0;
    const tbY1 = Math.max(0, Math.floor(ry1 + ch * 0.7));
    const tbY2 = Math.min(imgH, Math.floor(ry1 + ch * 0.745));
    const tbX1 = Math.max(0, Math.floor(rx1 + cw * 0.115));
    const tbX2 = Math.min(imgW, Math.floor(rx1 + cw * 0.185));
    for (let yy = tbY1; yy < tbY2; yy += 1) {
      for (let xx = tbX1; xx < tbX2; xx += 1) {
        const idx = (yy * imgW + xx) * 4;
        topBarTot += 1;
        if (rgba[idx] > 225 && rgba[idx + 1] > 225 && rgba[idx + 2] > 225) {
          topBarWhite += 1;
        }
      }
    }
    const twoDigitPrior = topBarWhite / Math.max(1, topBarTot) >= 0.22 ? 0.45 : 0;

    const r1 = evalCenters(CENTERS_1D);
    const r2 = evalCenters(CENTERS_2D);
    const isTwoDigit = r2.shapeSum + twoDigitPrior >= r1.shapeSum;
    const starConf = isTwoDigit ? r2.shapeSum : r1.shapeSum;
    const ratios = isTwoDigit ? r2.brightRatios : r1.brightRatios;

    let breakLevel = 0;
    for (const ratio of ratios) {
      if (ratio >= 0.28) {
        breakLevel += 1;
      } else {
        break;
      }
    }

    return { breakLevel, starConf, isTwoDigit };
  }

  /**
   * 扫描单帧 RGBA 图像中的全部支援卡单元格
   */
  function scanRgbaImage(rgba, width, height, db, catalogByKey = {}, meta = {}) {
    const { cols, rows } = detectGridInRgba(rgba, width, height);
    if (cols.length !== 3 || rows.length === 0) {
      return { cols, rows, detections: [] };
    }

    const yOffset = Number(meta.yOffset) || 0;
    const sourceName = meta.sourceName || '';
    const detections = [];

    for (let ri = 0; ri < rows.length; ri += 1) {
      const [y1, y2] = rows[ri];
      for (let ci = 0; ci < cols.length; ci += 1) {
        const [x1, x2] = cols[ci];
        const feat = extractCardFeatureFromRgba(rgba, width, height, x1, y1, x2, y2, db.featW, db.featH);
        const detectedAttr = detectAttrFromRgba(rgba, width, height, x1, y1, x2, y2);

        const scored = new Array(db.entries.length);
        for (let i = 0; i < db.entries.length; i += 1) {
          const entry = db.entries[i];
          let maxRaw = -1;
          for (let v = 0; v < entry.variants.length; v += 1) {
            const sim = dotFloat(feat, entry.variants[v]);
            if (sim > maxRaw) maxRaw = sim;
          }
          const bonus = detectedAttr && entry.attr === detectedAttr ? 0.06 : 0;
          scored[i] = {
            key: entry.key,
            attr: entry.attr,
            rawSim: maxRaw,
            totalScore: maxRaw + bonus,
          };
        }

        scored.sort((a, b) => b.totalScore - a.totalScore);
        const top1 = scored[0];
        const top2 = scored[1] || { totalScore: top1.totalScore };
        const gap = top1.totalScore - top2.totalScore;

        const { breakLevel, starConf, isTwoDigit } = detectBreaksFromRgba(rgba, width, height, x1, y1, x2, y2);
        const attrMatch = !detectedAttr || top1.attr === detectedAttr;
        const needsReview = starConf < 0.75 || top1.rawSim < 0.65 || gap < 0.08 || !attrMatch;

        const quality = (attrMatch ? 1 : 0) + Math.min(4, Math.max(-1, starConf)) + top1.rawSim;

        detections.push({
          key: top1.key,
          breakLevel,
          rawSim: Number(top1.rawSim.toFixed(4)),
          gap: Number(gap.toFixed(4)),
          detectedAttr,
          attrMatch,
          starConf: Number(starConf.toFixed(3)),
          isTwoDigit,
          needsReview,
          quality: Number(quality.toFixed(4)),
          absY: yOffset + y1,
          cardH: y2 - y1,
          rowIndex: ri,
          colIndex: ci,
          sourceName,
          candidates: scored.slice(0, 3).map((s) => ({
            key: s.key,
            name: catalogByKey[s.key] ? catalogByKey[s.key].name : s.key,
            rawSim: Number(s.rawSim.toFixed(3)),
          })),
        });
      }
    }

    return { cols, rows, detections };
  }

  /**
   * 对普通截图或超长滚动截图执行分带切片扫描（避免超长 Canvas OOM 或尺寸限制）
   */
  function scanRgbaStrips({
    width,
    height,
    getStripRgba,
    db,
    catalogByKey = {},
    sourceName = '',
    stripHeight = STRIP_HEIGHT,
    overlap = STRIP_OVERLAP,
  }) {
    if (height <= LONG_IMAGE_SINGLE_LIMIT) {
      const rgba = getStripRgba(0, height);
      const res = scanRgbaImage(rgba, width, height, db, catalogByKey, {
        yOffset: 0,
        sourceName,
      });
      return {
        strips: 1,
        detections: res.detections,
      };
    }

    const step = Math.max(120, stripHeight - overlap);
    const allDetections = [];
    let strips = 0;

    for (let y = 0; y < height; y += step) {
      const curH = Math.min(stripHeight, height - y);
      const rgba = getStripRgba(y, curH);
      const res = scanRgbaImage(rgba, width, curH, db, catalogByKey, {
        yOffset: y,
        sourceName,
      });
      allDetections.push(...res.detections);
      strips += 1;
      if (y + curH >= height) break;
    }

    return { strips, detections: allDetections };
  }

  /**
   * 合并多张分段截图与长图分带重叠区出现的重复卡片，保留最清晰未遮挡的一帧；
   * 若同一源文件内不同网格位置命中相同卡片 key，则标记 conflict 与 needsReview
   */
  function mergeRecognizedDetections(detections, catalogByKey = {}) {
    const byKey = new Map();
    const positionsByKey = new Map();

    const isSameSourceConflict = (item, pos) => {
      if (!item.sourceName || !pos.sourceName || item.sourceName !== pos.sourceName) {
        return false;
      }
      if (Number.isFinite(item.colIndex) && Number.isFinite(pos.colIndex) && item.colIndex !== pos.colIndex) {
        return true;
      }
      if (Number.isFinite(item.absY) && Number.isFinite(pos.absY)) {
        const minCardH = Math.min(item.cardH || 120, pos.cardH || 120);
        const yDiffThreshold = Math.max(40, minCardH * 0.5);
        if (Math.abs(item.absY - pos.absY) >= yDiffThreshold) {
          return true;
        }
      }
      return false;
    };

    for (const item of detections || []) {
      if (!item || !item.key) continue;
      const posEntry = {
        sourceName: item.sourceName || '',
        colIndex: item.colIndex,
        absY: item.absY,
        cardH: item.cardH,
      };
      const prev = byKey.get(item.key);
      if (!prev) {
        positionsByKey.set(item.key, [posEntry]);
        byKey.set(item.key, { ...item, seenCount: 1 });
        continue;
      }

      const positions = positionsByKey.get(item.key) || [];
      const hasNewConflict = positions.some((pos) => isSameSourceConflict(item, pos));
      positions.push(posEntry);

      const prevClear = !prev.needsReview;
      const curClear = !item.needsReview;
      const preferCur =
        (curClear && !prevClear) ||
        (curClear === prevClear && item.quality > prev.quality);

      const winner = preferCur ? { ...item } : { ...prev };
      winner.seenCount = (prev.seenCount || 1) + 1;
      if (prev.conflict || item.conflict || hasNewConflict) {
        winner.conflict = true;
        winner.needsReview = true;
      }
      byKey.set(item.key, winner);
    }

    const items = Array.from(byKey.values());
    items.sort((a, b) => {
      if (a.needsReview !== b.needsReview) return a.needsReview ? -1 : 1;
      const ca = catalogByKey[a.key];
      const cb = catalogByKey[b.key];
      const ra = ca ? Number(ca.rarity) : 0;
      const rb = cb ? Number(cb.rarity) : 0;
      if (rb !== ra) return rb - ra;
      const na = ca ? Number(ca.number) : 0;
      const nb = cb ? Number(cb.number) : 0;
      return nb - na;
    });

    const reviewCount = items.filter((it) => it.needsReview).length;
    return {
      items,
      totalScannedCards: (detections || []).length,
      uniqueCount: items.length,
      reviewCount,
    };
  }

  /**
   * 浏览器端入口：等比缩放到 maxW=720 并分带读取 ImageData 识别
   */
  function scanImageElement(img, db, catalogByKey = {}, options = {}) {
    const srcW = img.naturalWidth || img.width || 0;
    const srcH = img.naturalHeight || img.height || 0;
    if (!srcW || !srcH) {
      throw new Error('图片尺寸无效，无法识别');
    }

    const targetW = Math.min(srcW, options.targetWidth || DEFAULT_TARGET_WIDTH);
    const scale = targetW / srcW;
    const scaledH = Math.max(1, Math.round(srcH * scale));
    const stripHeight = options.stripHeight || STRIP_HEIGHT;
    const overlap = options.overlap || STRIP_OVERLAP;

    const canvas = document.createElement('canvas');
    canvas.width = targetW;
    canvas.height = scaledH <= LONG_IMAGE_SINGLE_LIMIT ? scaledH : Math.min(scaledH, stripHeight);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'medium';

    return scanRgbaStrips({
      width: targetW,
      height: scaledH,
      sourceName: options.sourceName || '',
      stripHeight,
      overlap,
      db,
      catalogByKey,
      getStripRgba(stripY, curH) {
        if (canvas.height !== curH) {
          canvas.height = curH;
        }
        ctx.clearRect(0, 0, targetW, curH);
        const srcY = stripY / scale;
        const srcSliceH = curH / scale;
        ctx.drawImage(img, 0, srcY, srcW, srcSliceH, 0, 0, targetW, curH);
        return ctx.getImageData(0, 0, targetW, curH).data;
      },
    });
  }

  return {
    DEFAULT_TARGET_WIDTH,
    LONG_IMAGE_SINGLE_LIMIT,
    STRIP_HEIGHT,
    STRIP_OVERLAP,
    TMPL_BRIGHT,
    TMPL_DARK,
    decodeFingerprintDb,
    makeSyntheticStarTemplate,
    extractCardFeatureFromRgba,
    detectGridInRgba,
    detectAttrFromRgba,
    detectBreaksFromRgba,
    scanRgbaImage,
    scanRgbaStrips,
    mergeRecognizedDetections,
    scanImageElement,
  };
});
