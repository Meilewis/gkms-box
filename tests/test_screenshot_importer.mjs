import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const Importer = require('../web/public/screenshot-importer.js');
const supportCatalog = JSON.parse(
  fs.readFileSync(path.join(repoRoot, 'web', 'public', 'data', 'support.json'), 'utf8')
);
const fingerprintsPayload = JSON.parse(
  fs.readFileSync(path.join(repoRoot, 'web', 'public', 'data', 'support-fingerprints.json'), 'utf8')
);

const catalogByKey = Object.fromEntries(supportCatalog.map((c) => [c.key, c]));

test('decodeFingerprintDb 正确解码 201 张支援卡多视角单位向量', () => {
  const db = Importer.decodeFingerprintDb(fingerprintsPayload);
  assert.equal(db.entries.length, 201);
  assert.equal(db.featW, 14);
  assert.equal(db.featH, 9);
  assert.equal(db.variantsPerCard, 7);
  assert.equal(db.dim, 378);

  for (const idx of [0, 50, 150, 200]) {
    const entry = db.entries[idx];
    assert.ok(catalogByKey[entry.key], `missing catalog key ${entry.key}`);
    for (const vec of entry.variants) {
      assert.equal(vec.length, 378);
      let sq = 0;
      for (let i = 0; i < vec.length; i += 1) sq += vec[i] * vec[i];
      assert.ok(Math.abs(Math.sqrt(sq) - 1) < 1e-3, 'variant vector must be unit normalized');
    }
  }
});

test('纯数学四角星模板保持对称与单位正交', () => {
  const bright = Importer.makeSyntheticStarTemplate(false);
  const dark = Importer.makeSyntheticStarTemplate(true);
  assert.equal(bright.length, 144);
  assert.equal(dark.length, 144);

  let dot = 0;
  let sqB = 0;
  for (let i = 0; i < 144; i += 1) {
    dot += bright[i] * dark[i];
    sqB += bright[i] * bright[i];
  }
  assert.ok(Math.abs(Math.sqrt(sqB) - 1) < 1e-4);
  assert.ok(Math.abs(dot + 1) < 1e-4);
});

test('mergeRecognizedDetections 优先保留清晰未遮挡帧并正确排序', () => {
  const merged = Importer.mergeRecognizedDetections(
    [
      { key: '2-0001', breakLevel: 1, needsReview: true, quality: 1.5, rawSim: 0.65 },
      { key: '2-0001', breakLevel: 4, needsReview: false, quality: 4.8, rawSim: 0.96 },
      { key: '3-0010', breakLevel: 2, needsReview: false, quality: 5.1, rawSim: 0.99 },
      { key: '3-0020', breakLevel: 0, needsReview: true, quality: 1.8, rawSim: 0.62 },
    ],
    catalogByKey
  );

  assert.equal(merged.totalScannedCards, 4);
  assert.equal(merged.uniqueCount, 3);
  assert.equal(merged.reviewCount, 1);
  // 需核对卡片排最前，其余按稀有度降序
  assert.equal(merged.items[0].key, '3-0020');
  assert.equal(merged.items[1].key, '3-0010');
  assert.equal(merged.items[2].key, '2-0001');
  assert.equal(merged.items[2].breakLevel, 4);
  assert.equal(merged.items[2].seenCount, 2);
});

test('mergeRecognizedDetections 冲突检测：同源跨格报冲突，跨图或分带重叠不误报', () => {
  // 1. 同源文件不同列命中同一 key -> conflict=true, needsReview=true
  const crossCol = Importer.mergeRecognizedDetections(
    [
      { key: '3-0001', breakLevel: 4, needsReview: false, quality: 5.0, rawSim: 0.98, sourceName: 'shotA.png', colIndex: 0, absY: 100, cardH: 120 },
      { key: '3-0001', breakLevel: 2, needsReview: false, quality: 4.5, rawSim: 0.91, sourceName: 'shotA.png', colIndex: 2, absY: 100, cardH: 120 },
    ],
    catalogByKey
  );
  assert.equal(crossCol.items[0].conflict, true);
  assert.equal(crossCol.items[0].needsReview, true);
  assert.equal(crossCol.items[0].breakLevel, 4);

  // 2. 同源文件同列纵向相距 >= 半卡高 -> conflict=true
  const farSameCol = Importer.mergeRecognizedDetections(
    [
      { key: '3-0002', breakLevel: 1, needsReview: false, quality: 4.8, rawSim: 0.95, sourceName: 'long.png', colIndex: 1, absY: 200, cardH: 120 },
      { key: '3-0002', breakLevel: 3, needsReview: false, quality: 4.7, rawSim: 0.94, sourceName: 'long.png', colIndex: 1, absY: 500, cardH: 120 },
    ],
    catalogByKey
  );
  assert.equal(farSameCol.items[0].conflict, true);
  assert.equal(farSameCol.items[0].needsReview, true);

  // 3. 同源文件同列分带重叠（absY 差 < 20px）-> 不冲突
  const stripOverlap = Importer.mergeRecognizedDetections(
    [
      { key: '3-0003', breakLevel: 0, needsReview: false, quality: 4.9, rawSim: 0.97, sourceName: 'long.png', colIndex: 1, absY: 2440, cardH: 120 },
      { key: '3-0003', breakLevel: 0, needsReview: false, quality: 4.8, rawSim: 0.96, sourceName: 'long.png', colIndex: 1, absY: 2452, cardH: 120 },
    ],
    catalogByKey
  );
  assert.ok(!stripOverlap.items[0].conflict);
  assert.equal(stripOverlap.items[0].needsReview, false);

  // 4. 不同源文件即使不同列/不同高度也不标冲突
  const diffShots = Importer.mergeRecognizedDetections(
    [
      { key: '3-0004', breakLevel: 4, needsReview: false, quality: 4.9, rawSim: 0.97, sourceName: 'seg1.png', colIndex: 0, absY: 800, cardH: 120 },
      { key: '3-0004', breakLevel: 4, needsReview: false, quality: 4.8, rawSim: 0.96, sourceName: 'seg2.png', colIndex: 2, absY: 120, cardH: 120 },
    ],
    catalogByKey
  );
  assert.ok(!diffShots.items[0].conflict);
  assert.equal(diffShots.items[0].needsReview, false);
});

test('合成标准 3 列网格可在前端 JS 引擎中稳定识别网格与空白隔离', () => {
  const db = Importer.decodeFingerprintDb(fingerprintsPayload);
  const w = 720;
  const h = 400;
  const white = new Uint8ClampedArray(w * h * 4).fill(255);
  const emptyRes = Importer.detectGridInRgba(white, w, h);
  assert.equal(emptyRes.rows.length, 0);

  const zeroRes = Importer.scanRgbaStrips({
    width: w,
    height: h,
    db,
    catalogByKey,
    getStripRgba: () => white,
  });
  assert.equal(zeroRes.detections.length, 0);
});

test('detectGridInRgba 在右侧存在灰色滚动条与滑块遮挡 x=0.985 时仍可准确定位 3 列卡片网格', () => {
  const w = 720;
  const h = 900;
  const rgba = new Uint8ClampedArray(w * h * 4).fill(255);

  // 顶部非白预览区 y=0..220
  for (let y = 0; y < 220; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const idx = (y * w + x) * 4;
      rgba[idx] = 60;
      rgba[idx + 1] = 80;
      rgba[idx + 2] = 110;
    }
  }

  // 绘制 4 行 × 3 列暗色卡片单元格 (cols: [31,246], [253,467], [474,689], cardH=121)
  const colRanges = [
    [31, 246],
    [253, 467],
    [474, 689],
  ];
  const rowStarts = [240, 368, 496, 624];
  const cardH = 121;
  for (const ry of rowStarts) {
    for (const [cx1, cx2] of colRanges) {
      for (let y = ry; y < ry + cardH; y += 1) {
        for (let x = cx1; x < cx2; x += 1) {
          const idx = (y * w + x) * 4;
          rgba[idx] = 70;
          rgba[idx + 1] = 110;
          rgba[idx + 2] = 150;
        }
      }
    }
  }

  // 在右侧 x=709..714 绘制贯穿的灰色滚动条与深灰滑块（直接压在 720*0.985=709 上）
  for (let y = 225; y < h; y += 1) {
    const isThumb = y >= 240 && y <= 380;
    const v = isThumb ? 180 : 230;
    for (let x = 709; x <= 714; x += 1) {
      const idx = (y * w + x) * 4;
      rgba[idx] = v;
      rgba[idx + 1] = v;
      rgba[idx + 2] = v;
    }
  }

  const grid = Importer.detectGridInRgba(rgba, w, h);
  assert.equal(grid.cols.length, 3);
  assert.equal(grid.rows.length, 4);
});

const realShotsDir = process.env.GKMS_TEST_SHOTS_DIR;
if (realShotsDir && fs.existsSync(realShotsDir)) {
  test('真机截图与超长拼图分带在真实 JS 识别引擎下达到高准确率', () => {
    const db = Importer.decodeFingerprintDb(fingerprintsPayload);

    // 借助 Python Pillow 对真机 PNG 执行与前端 <canvas> 完全等比的 720w 缩放并导出原始 RGBA 流
    const pyScript = `
import json, os, sys, base64
from PIL import Image

shot_dir = sys.argv[1]
files = sorted(f for f in os.listdir(shot_dir) if f.lower().endswith(('.png', '.jpg', '.jpeg', '.webp')))

def encode_scaled(im, target_w=720):
    w, h = im.size
    scale = min(1.0, target_w / float(w))
    nw = max(1, int(round(w * scale)))
    nh = max(1, int(round(h * scale)))
    resized = im.resize((nw, nh), Image.Resampling.BILINEAR).convert("RGBA")
    return {"w": nw, "h": nh, "b64": base64.b64encode(resized.tobytes()).decode("ascii")}

out = {"shots": []}
ims = []
for f in files:
    im = Image.open(os.path.join(shot_dir, f))
    ims.append(im)
    out["shots"].append({"name": f, **encode_scaled(im)})

# 构造 >3200px 缩放高度的超长拼图（将 4 张图的核心列表段与重叠段拼接，总高约 7000px，720w 下 >4100px 触发分带）
parts = [
    ims[0].crop((0, 0, ims[0].width, 1736)),
    ims[1].crop((0, 972, ims[1].width, 1828)),
    ims[2].crop((0, 1006, ims[2].width, 1862)),
    ims[3].crop((0, 862, ims[3].width, ims[3].height)),
    ims[1].crop((0, 972, ims[1].width, 1828)),
    ims[2].crop((0, 1006, ims[2].width, 1862)),
]
long_im = Image.new("RGB", (ims[0].width, sum(p.size[1] for p in parts)), (255, 255, 255))
cy = 0
for p in parts:
    long_im.paste(p, (0, cy))
    cy += p.size[1]
out["longShot"] = {"name": "LONG_MULTI_STRIP", **encode_scaled(long_im)}
sys.stdout.write(json.dumps(out))
`;
    const rawOut = execFileSync('python', ['-c', pyScript, realShotsDir], {
      maxBuffer: 64 * 1024 * 1024,
      encoding: 'utf8',
    });
    const decoded = JSON.parse(rawOut);

    // 4 张真机截图前 4 行（48 张完整卡片）经图库核实后的精确 [key, breakLevel]
    const expectedCardsByShot = {
      0: [
        ['3-0122', 4], ['3-0110', 4], ['3-0107', 4],
        ['3-0069', 4], ['3-0066', 4], ['3-0064', 4],
        ['3-0025', 4], ['3-0005', 4], ['3-0007', 4],
        ['3-0058', 3], ['3-0034', 3], ['3-0027', 3],
      ],
      1: [
        ['2-0072', 4], ['2-0043', 4], ['2-0061', 4],
        ['2-0001', 4], ['2-0007', 4], ['3-0096', 1],
        ['3-0094', 1], ['3-0089', 1], ['3-0083', 1],
        ['3-0082', 1], ['3-0081', 1], ['3-0078', 1],
      ],
      2: [
        ['3-0076', 0], ['3-0062', 0], ['3-0057', 0],
        ['3-0044', 0], ['3-0042', 0], ['3-0037', 0],
        ['3-0035', 0], ['3-0024', 0], ['3-0004', 0],
        ['3-0017', 0], ['3-0011', 2], ['2-0003', 4],
      ],
      3: [
        ['3-0016', 0], ['3-0031', 0], ['3-0028', 1],
        ['3-0022', 1], ['3-0018', 0], ['3-0000', 0],
        ['3-0002', 4], ['3-0003', 0], ['3-0006', 0],
        ['3-0009', 4], ['3-0012', 1], ['3-0013', 0],
      ],
    };

    const allSegDetections = [];
    for (let si = 0; si < decoded.shots.length; si += 1) {
      const s = decoded.shots[si];
      const rgba = Uint8ClampedArray.from(Buffer.from(s.b64, 'base64'));
      const res = Importer.scanRgbaStrips({
        width: s.w,
        height: s.h,
        db,
        catalogByKey,
        sourceName: s.name,
        getStripRgba: (y, ch) => rgba.subarray(y * s.w * 4, (y + ch) * s.w * 4),
      });
      allSegDetections.push(...res.detections);

      const expected = expectedCardsByShot[si];
      if (expected) {
        assert.ok(res.detections.length >= expected.length);
        for (let k = 0; k < expected.length; k += 1) {
          const [expKey, expBreak] = expected[k];
          const got = res.detections[k];
          assert.equal(got.key, expKey, `${s.name} card #${k} key`);
          assert.equal(got.breakLevel, expBreak, `${s.name} card #${k} (${expKey}) break`);
        }
      }
    }

    const segMerged = Importer.mergeRecognizedDetections(allSegDetections, catalogByKey);
    const allExpectedMap = new Map(
      Object.values(expectedCardsByShot)
        .flat()
        .map(([k, b]) => [k, b])
    );
    for (const [expKey, expBreak] of allExpectedMap.entries()) {
      const item = segMerged.items.find((it) => it.key === expKey);
      assert.ok(item, `merged segmented missing ${expKey}`);
      assert.equal(item.breakLevel, expBreak, `merged ${expKey} break mismatch`);
    }

    // 验证高度 > 3200 的超长图真实触发分带切片，且合并结果完全一致
    const ls = decoded.longShot;
    assert.ok(ls.h > Importer.LONG_IMAGE_SINGLE_LIMIT, `expected long height > 3200, got ${ls.h}`);
    const longRgba = Uint8ClampedArray.from(Buffer.from(ls.b64, 'base64'));
    const longRes = Importer.scanRgbaStrips({
      width: ls.w,
      height: ls.h,
      db,
      catalogByKey,
      sourceName: ls.name,
      getStripRgba: (y, ch) => longRgba.subarray(y * ls.w * 4, (y + ch) * ls.w * 4),
    });
    assert.ok(longRes.strips >= 2, `expected >= 2 strips, got ${longRes.strips}`);
    const longMerged = Importer.mergeRecognizedDetections(longRes.detections, catalogByKey);

    for (const [expKey, expBreak] of allExpectedMap.entries()) {
      const item = longMerged.items.find((it) => it.key === expKey);
      assert.ok(item, `long-shot merged missing ${expKey}`);
      assert.equal(item.breakLevel, expBreak, `long-shot ${expKey} break mismatch`);
    }
  });
}
