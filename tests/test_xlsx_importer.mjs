import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PLUGIN_DIR = path.join(ROOT, 'koishi-plugin');

const HifPlanner = require(path.join(PLUGIN_DIR, 'hif-planner.js'));
const Importer = require(path.join(PLUGIN_DIR, 'hif-xlsx-importer.js'));

const REAL_XLSX_PATH = 'D:\\BaiduNetdiskDownload\\chromedownload\\支援卡-11.27新卡实装.xlsx';

function buildMinimalZip(files) {
  const localChunks = [];
  const cdChunks = [];
  let offset = 0;

  for (const [name, rawContent, useDeflate = true] of files) {
    const nameBuf = Buffer.from(name, 'utf8');
    const dataBuf = Buffer.isBuffer(rawContent) ? rawContent : Buffer.from(rawContent, 'utf8');
    const compressed = useDeflate ? zlib.deflateRawSync(dataBuf) : dataBuf;
    const method = useDeflate ? 8 : 0;

    const localHdr = Buffer.alloc(30);
    localHdr.writeUInt32LE(0x04034b50, 0);
    localHdr.writeUInt16LE(20, 4);
    localHdr.writeUInt16LE(0, 6);
    localHdr.writeUInt16LE(method, 8);
    localHdr.writeUInt32LE(0, 14); // crc32 ignored by parser
    localHdr.writeUInt32LE(compressed.length, 18);
    localHdr.writeUInt32LE(dataBuf.length, 22);
    localHdr.writeUInt16LE(nameBuf.length, 26);
    localHdr.writeUInt16LE(0, 28);

    localChunks.push(localHdr, nameBuf, compressed);

    const cdHdr = Buffer.alloc(46);
    cdHdr.writeUInt32LE(0x02014b50, 0);
    cdHdr.writeUInt16LE(20, 4);
    cdHdr.writeUInt16LE(20, 6);
    cdHdr.writeUInt16LE(method, 10);
    cdHdr.writeUInt32LE(0, 16);
    cdHdr.writeUInt32LE(compressed.length, 20);
    cdHdr.writeUInt32LE(dataBuf.length, 24);
    cdHdr.writeUInt16LE(nameBuf.length, 28);
    cdHdr.writeUInt16LE(0, 30);
    cdHdr.writeUInt16LE(0, 32);
    cdHdr.writeUInt32LE(offset, 42);

    cdChunks.push(cdHdr, nameBuf);
    offset += localHdr.length + nameBuf.length + compressed.length;
  }

  const cdBuf = Buffer.concat(cdChunks);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localChunks, cdBuf, eocd]);
}

// ---------------------------------------------------------------------------
// 1. 真实 11.27 Excel 提取并与 koishi-plugin/data/hif_cards.json 逐张全量比对
// ---------------------------------------------------------------------------
test('真实 11.27 Excel 200 张卡提取与 hif_cards.json 全量一致且求值零误差', { skip: !fs.existsSync(REAL_XLSX_PATH) }, () => {
  const supportList = JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, 'data', 'support.json'), 'utf8'));
  const expectedData = JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, 'data', 'hif_cards.json'), 'utf8'));

  const extracted = Importer.extractHifCardsFromXlsx(REAL_XLSX_PATH, supportList);
  assert.equal(extracted.cardCount, 200);
  assert.equal(extracted.supportMatchCount, 200);
  assert.deepEqual(extracted.unmatchedNames, []);
  assert.equal(extracted.selfCheckPassed, expectedData.selfCheckPassed);
  assert.equal(extracted.selfCheckTotal, expectedData.selfCheckTotal);
  assert.equal(extracted.cards.length, expectedData.cards.length);

  const defaultR = {
    B11: 1200,
    B12: 700,
    B13: 200,
    B14: 4,
    B15: 4,
    B17: 2,
    B18: 2,
    ...HifPlanner.BASE_HIF_ACTIONS,
  };

  for (let i = 0; i < expectedData.cards.length; i += 1) {
    const exp = expectedData.cards[i];
    const act = extracted.cards[i];

    assert.equal(act.supportKey, exp.supportKey, `idx=${i} supportKey 不一致`);
    assert.equal(act.alias, exp.alias, `card=${exp.supportKey} alias 不一致`);
    assert.equal(act.plan, exp.plan, `card=${exp.supportKey} plan 不一致`);
    assert.equal(act.isSp, exp.isSp, `card=${exp.supportKey} isSp 不一致`);
    assert.equal(act.attr, exp.attr, `card=${exp.supportKey} attr 不一致`);
    assert.equal(act.pollution, exp.pollution, `card=${exp.supportKey} pollution 不一致`);
    assert.equal(act.hasItemBonus, exp.hasItemBonus, `card=${exp.supportKey} hasItemBonus 不一致`);
    assert.deepEqual(act.deps, exp.deps, `card=${exp.supportKey} deps 不一致`);

    for (const mode of ['noItem', 'withItem']) {
      for (const lb of ['0', '1', '2', '3', '4']) {
        for (let slot = 0; slot < 3; slot += 1) {
          const fnExp = HifPlanner.compileCardExpr(exp.exprs[mode][lb][slot]);
          const fnAct = HifPlanner.compileCardExpr(act.exprs[mode][lb][slot]);
          for (const seika of [false, true]) {
            const vExp = fnExp(defaultR, seika);
            const vAct = fnAct(defaultR, seika);
            assert.equal(vAct, vExp, `card=${exp.supportKey} ${mode} lb=${lb} slot=${slot} seika=${seika} 求值不一致`);
          }
        }
      }
    }
  }
});

// ---------------------------------------------------------------------------
// 2. ZIP + XML 解析特性（sharedStrings 富文本、实体解码、shared 公式平移）与损坏拒绝
// ---------------------------------------------------------------------------
test('parseXlsxWorkbook 支持富文本/实体/共享公式且拒绝非 ZIP 或损坏文件', () => {
  // 2a. 拒绝非 ZIP / 截断 ZIP / 空输入
  assert.throws(() => Importer.extractHifCardsFromXlsx(Buffer.from('not a zip file'), []), /非合法 ZIP/);
  assert.throws(() => Importer.extractHifCardsFromXlsx(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]), []), /非合法 ZIP/);
  assert.throws(
    () => Importer.extractHifCardsFromXlsx(Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(30)]), []),
    /损坏/
  );
  assert.throws(() => Importer.extractHifCardsFromXlsx('', []), /文件路径或 Buffer/);

  // 2b. 验证富文本、XML 实体、stored/deflate 与共享公式
  const ssXml =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<si><r><t>A&amp;B</t></r><r><t xml:space="preserve"> &#x4E2D;</t></r></si>' +
    '</sst>';
  const wbXml =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<sheets><sheet name="TestSheet" sheetId="1" r:id="rId1"/></sheets>' +
    '</workbook>';
  const relsXml =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
    '</Relationships>';
  const shXml =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
    '<row r="1">' +
    '<c r="A1" t="s"><v>0</v></c>' +
    '<c r="B1"><v>10</v></c>' +
    '<c r="C1"><f t="shared" ref="C1:C2" si="0">B1+$B$1</f><v>20</v></c>' +
    '</row>' +
    '<row r="2">' +
    '<c r="A2" t="inlineStr"><is><t>内联&lt;1&gt;</t></is></c>' +
    '<c r="B2"><v>5</v></c>' +
    '<c r="C2"><f t="shared" si="0"/><v>15</v></c>' +
    '</row>' +
    '</sheetData></worksheet>';

  const zipBuf = buildMinimalZip([
    ['xl/sharedStrings.xml', ssXml, false],
    ['xl/workbook.xml', wbXml, true],
    ['xl/_rels/workbook.xml.rels', relsXml, true],
    ['xl/worksheets/sheet1.xml', shXml, true],
  ]);

  const wb = Importer.parseXlsxWorkbook(zipBuf);
  assert.deepEqual(wb.get('TestSheet', 'A', 1), ['A&B 中', null]);
  assert.deepEqual(wb.get('TestSheet', 'A', 2), ['内联<1>', null]);
  assert.deepEqual(wb.get('TestSheet', 'C', 1), [20, 'B1+$B$1']);
  assert.deepEqual(wb.get('TestSheet', 'C', 2), [15, 'B2+$B$1']);

  assert.throws(() => Importer.extractHifCardsFromXlsx(zipBuf, []), /缺少必需工作表/);
});

// ---------------------------------------------------------------------------
// 3. fetchUpstreamCatalog 离线 Mock 验证与代理凭据脱敏
// ---------------------------------------------------------------------------
test('fetchUpstreamCatalog 解析四份 YAML 并校验代理错误脱敏', async () => {
  const mockYamls = {
    'Character.yaml': [
      '- id: shro',
      '  isPlayable: true',
      '  lastName: "篠澤"',
      '  firstName: "広"',
      '- id: npc1',
      '  isPlayable: false',
    ].join('\n'),
    'SupportCard.yaml': [
      '- id: s_card-3-0001',
      '  rarity: SupportCardRarity_Ssr',
      '  type: SupportCardType_Vocal',
      '  planType: ProducePlanType_Plan1',
      '  name: "テストS卡"',
      '  isLimited: false',
      '  order: 1999900001',
      '- id: s_card-1-0001',
      '  rarity: SupportCardRarity_R',
      '  type: SupportCardType_Assist',
      '  name: "ignored-r"',
    ].join('\n'),
    'IdolCard.yaml': [
      '- id: i_card-shro-3-000',
      '  rarity: IdolCardRarity_Ssr',
      '  planType: ProducePlanType_Plan1',
      '  name: "光景"',
      '  isLimited: false',
      '  produceVocal: 70',
      '  produceDance: 60',
      '  produceVisual: 50',
      '  produceVocalGrowthRatePermil: 215',
      '  produceDanceGrowthRatePermil: 120',
      '  produceVisualGrowthRatePermil: 100',
    ].join('\n'),
    'IdolCardSkin.yaml': [
      '- id: i_card-skin-shro-3-000',
      '  idolCardId: i_card-shro-3-000',
      '  assetId: cidol-shro-3-000',
      '  name: "光景"',
    ].join('\n'),
  };

  try {
    Importer.setUpstreamFetcher(async (filename) => {
      if (!(filename in mockYamls)) throw new Error(`unexpected file: ${filename}`);
      return mockYamls[filename];
    });

    const cat = await Importer.fetchUpstreamCatalog();
    assert.deepEqual(cat.characters, { shro: '筱泽广' });
    assert.equal(cat.support.length, 1);
    assert.equal(cat.support[0].key, '3-0001');
    assert.equal(cat.support[0].attr, 'vo');
    assert.equal(cat.support[0].plan, 'Sense');
    assert.equal(cat.cidol.length, 1);
    assert.equal(cat.cidol[0].key, 'shro-3-000');
    assert.equal(cat.cidol[0].stats.voRate, 21.5);
    assert.equal(cat.meta.counts.characters, 1);
    assert.equal(cat.meta.counts.support, 1);
    assert.equal(cat.meta.counts.supportSsr, 1);
    assert.equal(cat.meta.counts.supportSr, 0);
    assert.equal(cat.meta.counts.cidol, 1);

    // 验证异常消息中若含代理账密或 token 会被彻底脱敏
    Importer.setUpstreamFetcher(async () => {
      throw new Error('connect failed via http://alice:supersecret123@127.0.0.1:7890?token=xyz999 Proxy-Authorization: Basic YWxpY2U=');
    });
    await assert.rejects(
      Importer.fetchUpstreamCatalog({ proxyUrl: 'http://alice:supersecret123@127.0.0.1:7890' }),
      (err) => {
        assert.equal(err.message.includes('supersecret123'), false);
        assert.equal(err.message.includes('alice'), false);
        assert.equal(err.message.includes('xyz999'), false);
        assert.equal(err.message.includes('YWxpY2U='), false);
        assert.ok(err.message.includes('***'));
        return true;
      }
    );
  } finally {
    Importer.setUpstreamFetcher(null);
  }
});
