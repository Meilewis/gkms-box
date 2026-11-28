'use strict';

const fs = require('fs');
const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
const zlib = require('zlib');
const HifPlanner = require('./hif-planner');

const MAX_XLSX_BYTES = 80 * 1024 * 1024;
const DEFAULT_FETCH_TIMEOUT_MS = 20000;
const MAX_FETCH_BYTES = 20 * 1024 * 1024;
const MAX_REDIRECTS = 3;

const UPSTREAM_REPO = 'vertesan/gakumasu-diff';
const UPSTREAM_BRANCH = 'main';
const RAW_BASE = `https://raw.githubusercontent.com/${UPSTREAM_REPO}/${UPSTREAM_BRANCH}`;

const MANUAL_ALIASES = {
  'キュっと締めて': '2-0024', // support.json 中为 キュッと締めて
};

const ZH_CHAR_NAMES = {
  amao: '有村麻央',
  atbm: '雨夜燕',
  fktn: '藤田琴音',
  hkne: '冰渡香名江',
  hmsz: '秦谷美铃',
  hrnm: '姬崎莉波',
  hski: '花海咲季',
  hume: '花海佑芽',
  jsna: '十王星南',
  kcna: '仓本千奈',
  kllj: '葛城莉莉娅',
  shro: '筱泽广',
  ssmk: '紫云清夏',
  ttmr: '月村手毬',
};

const ATTR_MAP = {
  SupportCardType_Vocal: 'vo',
  SupportCardType_Dance: 'da',
  SupportCardType_Visual: 'vi',
  SupportCardType_Assist: 'as',
};

const PLAN_MAP = {
  ProducePlanType_Plan1: 'Sense',
  ProducePlanType_Plan2: 'Logic',
  ProducePlanType_Plan3: 'Anomaly',
  ProducePlanType_Common: 'Common',
};

const SUPPORT_RARITY_MAP = {
  SupportCardRarity_Ssr: '3',
  SupportCardRarity_Sr: '2',
};

const IDOL_RARITY_MAP = {
  IdolCardRarity_Ssr: '3',
  IdolCardRarity_Sr: '2',
  IdolCardRarity_R: '1',
};

let customUpstreamFetcher = null;

function setUpstreamFetcher(fn) {
  customUpstreamFetcher = typeof fn === 'function' ? fn : null;
}

function sanitizeErrorText(text) {
  return String(text || '')
    .replace(/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^/\s:@]+):([^/\s@]+)@/g, '$1***:***@')
    .replace(/([?&](?:api[_-]?key|key|token|secret|password|auth)=)[^&\s]+/gi, '$1***')
    .replace(/(Proxy-Authorization|Authorization)\s*:\s*[^\r\n]+/gi, '$1: ***');
}

// ---------------------------------------------------------------------------
// 1. 零依赖 ZIP + XML (.xlsx) 解析器
// ---------------------------------------------------------------------------

function readZipEntries(input) {
  let buf;
  if (Buffer.isBuffer(input)) {
    buf = input;
  } else if (typeof input === 'string' && input.trim()) {
    const stat = fs.statSync(input);
    if (!stat.isFile()) {
      throw new Error(`XLSX 路径不是普通文件: ${input}`);
    }
    if (stat.size > MAX_XLSX_BYTES) {
      throw new Error(`XLSX 文件超过上限 (${MAX_XLSX_BYTES} bytes)`);
    }
    buf = fs.readFileSync(input);
  } else {
    throw new Error('XLSX 输入必须是有效文件路径或 Buffer');
  }

  if (buf.length > MAX_XLSX_BYTES) {
    throw new Error(`XLSX 文件超过上限 (${MAX_XLSX_BYTES} bytes)`);
  }
  if (
    buf.length < 22 ||
    buf[0] !== 0x50 ||
    buf[1] !== 0x4b ||
    buf[2] !== 0x03 ||
    buf[3] !== 0x04
  ) {
    throw new Error('无效的 XLSX 文件：非合法 ZIP 文件（缺少 PK\\x03\\x04 魔数）');
  }

  // 从文件末尾定位 EOCD (0x06054b50)
  const minOffset = Math.max(0, buf.length - 65557);
  let eocdOffset = -1;
  for (let i = buf.length - 22; i >= minOffset; i -= 1) {
    if (
      buf[i] === 0x50 &&
      buf[i + 1] === 0x4b &&
      buf[i + 2] === 0x05 &&
      buf[i + 3] === 0x06
    ) {
      const commentLen = buf.readUInt16LE(i + 20);
      if (i + 22 + commentLen === buf.length) {
        eocdOffset = i;
        break;
      }
    }
  }
  if (eocdOffset < 0) {
    throw new Error('损坏的 XLSX 文件：无法定位 ZIP Central Directory (EOCD)');
  }

  const totalEntries = buf.readUInt16LE(eocdOffset + 10);
  const cdSize = buf.readUInt32LE(eocdOffset + 12);
  const cdOffset = buf.readUInt32LE(eocdOffset + 16);
  if (cdOffset + cdSize > eocdOffset) {
    throw new Error('损坏的 XLSX 文件：ZIP Central Directory 范围越界');
  }

  const entries = new Map();
  let ptr = cdOffset;
  for (let idx = 0; idx < totalEntries; idx += 1) {
    if (ptr + 46 > cdOffset + cdSize || buf.readUInt32LE(ptr) !== 0x02014b50) {
      throw new Error('损坏的 XLSX 文件：Central Directory 条目无效');
    }
    const method = buf.readUInt16LE(ptr + 10);
    const compressedSize = buf.readUInt32LE(ptr + 20);
    const uncompressedSize = buf.readUInt32LE(ptr + 24);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const localHeaderOffset = buf.readUInt32LE(ptr + 42);
    const nameStart = ptr + 46;
    const nameEnd = nameStart + nameLen;
    if (nameEnd + extraLen + commentLen > cdOffset + cdSize) {
      throw new Error('损坏的 XLSX 文件：Central Directory 文件名越界');
    }
    const name = buf.toString('utf8', nameStart, nameEnd);
    ptr = nameEnd + extraLen + commentLen;

    if (uncompressedSize > MAX_XLSX_BYTES) {
      throw new Error(`XLSX 条目体积超限: ${name}`);
    }
    entries.set(name, {
      name,
      method,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
    });
  }

  function readEntryBuffer(entryName) {
    const info = entries.get(entryName);
    if (!info) return null;
    const lho = info.localHeaderOffset;
    if (lho + 30 > buf.length || buf.readUInt32LE(lho) !== 0x04034b50) {
      throw new Error(`损坏的 XLSX 条目本地头无效: ${entryName}`);
    }
    const lfNameLen = buf.readUInt16LE(lho + 26);
    const lfExtraLen = buf.readUInt16LE(lho + 28);
    const dataStart = lho + 30 + lfNameLen + lfExtraLen;
    const dataEnd = dataStart + info.compressedSize;
    if (dataEnd > buf.length) {
      throw new Error(`损坏的 XLSX 条目数据越界: ${entryName}`);
    }
    const raw = buf.subarray(dataStart, dataEnd);
    if (info.method === 0) {
      return raw;
    }
    if (info.method === 8) {
      return zlib.inflateRawSync(raw, { maxOutputLength: MAX_XLSX_BYTES });
    }
    throw new Error(`不支持的 ZIP 压缩方式 (${info.method}): ${entryName}`);
  }

  return { entries, readEntryBuffer };
}

function decodeXmlEntities(str) {
  if (!str || !str.includes('&')) return String(str || '');
  return String(str).replace(
    /&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g,
    (full, entity) => {
      if (entity === 'amp') return '&';
      if (entity === 'lt') return '<';
      if (entity === 'gt') return '>';
      if (entity === 'quot') return '"';
      if (entity === 'apos') return "'";
      if (entity.startsWith('#x')) {
        const cp = parseInt(entity.slice(2), 16);
        return Number.isFinite(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : full;
      }
      if (entity.startsWith('#')) {
        const cp = parseInt(entity.slice(1), 10);
        return Number.isFinite(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : full;
      }
      return full;
    }
  );
}

function parseXmlAttrs(attrText) {
  const attrs = {};
  if (!attrText) return attrs;
  const re = /([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(attrText))) {
    const val = m[2] !== undefined ? m[2] : m[3];
    attrs[m[1]] = decodeXmlEntities(val);
  }
  return attrs;
}

function extractTextTags(xmlFragment) {
  if (!xmlFragment) return '';
  const parts = [];
  const tRe = /<(?:[A-Za-z_][\w.-]*:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?t>/g;
  let m;
  while ((m = tRe.exec(xmlFragment))) {
    parts.push(decodeXmlEntities(m[1]));
  }
  return parts.join('');
}

function parseSharedStringsXml(xmlText) {
  const shared = [];
  const siRe = /<(?:[A-Za-z_][\w.-]*:)?si(?:\s[^>]*)?(?:\/>|>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?si>)/g;
  let m;
  while ((m = siRe.exec(xmlText))) {
    shared.push(m[1] ? extractTextTags(m[1]) : '');
  }
  return shared;
}

function parseWorkbookRelsXml(xmlText) {
  const relMap = {};
  const relRe = /<(?:[A-Za-z_][\w.-]*:)?Relationship\b([^>]*)\/?\s*>/g;
  let m;
  while ((m = relRe.exec(xmlText))) {
    const attrs = parseXmlAttrs(m[1]);
    if (attrs.Id && attrs.Target) {
      relMap[attrs.Id] = attrs.Target;
    }
  }
  return relMap;
}

function parseWorkbookSheetsXml(xmlText) {
  const sheets = [];
  const shRe = /<(?:[A-Za-z_][\w.-]*:)?sheet\b([^>]*)\/?\s*>/g;
  let m;
  while ((m = shRe.exec(xmlText))) {
    const attrs = parseXmlAttrs(m[1]);
    const rid = attrs['r:id'] || attrs.id;
    if (attrs.name && rid) {
      sheets.push({ name: attrs.name, rid });
    }
  }
  return sheets;
}

function colToIdx(col) {
  let n = 0;
  for (let i = 0; i < col.length; i += 1) {
    n = n * 26 + (col.charCodeAt(i) - 64);
  }
  return n;
}

function idxToCol(idx) {
  const chars = [];
  let n = idx;
  while (n > 0) {
    const rem = (n - 1) % 26;
    n = Math.floor((n - 1) / 26);
    chars.push(String.fromCharCode(65 + rem));
  }
  return chars.reverse().join('');
}

function shiftSharedFormula(baseFormula, rowDelta, colDelta) {
  if (!baseFormula || (rowDelta === 0 && colDelta === 0)) return baseFormula;
  // 跳过字符串字面量，仅平移未锁定的相对单元格引用
  const parts = [];
  let i = 0;
  while (i < baseFormula.length) {
    if (baseFormula[i] === '"') {
      let j = i + 1;
      while (j < baseFormula.length && baseFormula[j] !== '"') j += 1;
      parts.push(baseFormula.slice(i, j + 1));
      i = j + 1;
      continue;
    }
    if (baseFormula[i] === "'") {
      let j = i + 1;
      while (j < baseFormula.length && baseFormula[j] !== "'") j += 1;
      parts.push(baseFormula.slice(i, j + 1));
      i = j + 1;
      continue;
    }
    const rest = baseFormula.slice(i);
    const m = /^(\$?)([A-Z]{1,3})(\$?)(\d+)(?!\()/.exec(rest);
    if (m && (i === 0 || !/[A-Za-z0-9_]/.test(baseFormula[i - 1]))) {
      const colAbs = m[1];
      const colStr = m[2];
      const rowAbs = m[3];
      const rowNum = Number(m[4]);
      const newCol = colAbs ? colStr : idxToCol(Math.max(1, colToIdx(colStr) + colDelta));
      const newRow = rowAbs ? rowNum : Math.max(1, rowNum + rowDelta);
      parts.push(`${colAbs}${newCol}${rowAbs}${newRow}`);
      i += m[0].length;
      continue;
    }
    parts.push(baseFormula[i]);
    i += 1;
  }
  return parts.join('');
}

function parseWorksheetXml(xmlText, sharedStrings) {
  const rows = new Map();
  const sharedFormulas = new Map();
  const cellRe = /<(?:[A-Za-z_][\w.-]*:)?c\b([^>]*)(?:\/>|>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?c>)/g;
  const fRe = /<(?:[A-Za-z_][\w.-]*:)?f\b([^>]*)(?:\/>|>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?f>)/;
  const vRe = /<(?:[A-Za-z_][\w.-]*:)?v(?:\s[^>]*)?>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?v>/;
  const isRe = /<(?:[A-Za-z_][\w.-]*:)?is(?:\s[^>]*)?>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?is>/;

  let m;
  while ((m = cellRe.exec(xmlText))) {
    const cAttrs = parseXmlAttrs(m[1]);
    const ref = cAttrs.r || '';
    const refMatch = /^([A-Z]+)(\d+)$/.exec(ref);
    if (!refMatch) continue;
    const col = refMatch[1];
    const rowIdx = Number(refMatch[2]);
    const t = cAttrs.t || '';
    const inner = m[2] || '';

    const fMatch = inner ? fRe.exec(inner) : null;
    const vMatch = inner ? vRe.exec(inner) : null;
    const isMatch = inner ? isRe.exec(inner) : null;

    let val = null;
    if (t === 's' && vMatch) {
      const sIdx = Number(vMatch[1]);
      val = Number.isInteger(sIdx) && sIdx >= 0 && sIdx < sharedStrings.length ? sharedStrings[sIdx] : vMatch[1];
    } else if (t === 'inlineStr' && isMatch) {
      val = extractTextTags(isMatch[1]);
    } else if (vMatch) {
      const raw = decodeXmlEntities(vMatch[1]);
      if (t === '' || t === 'n') {
        const fv = Number(raw);
        val = Number.isFinite(fv) && raw.trim() !== '' ? fv : raw;
      } else {
        val = raw;
      }
    }

    let formula = null;
    if (fMatch) {
      const fAttrs = parseXmlAttrs(fMatch[1]);
      const rawFormula = fMatch[2] ? decodeXmlEntities(fMatch[2]) : '';
      if (fAttrs.t === 'shared' && fAttrs.si !== undefined) {
        const siKey = String(fAttrs.si);
        if (rawFormula) {
          sharedFormulas.set(siKey, {
            colIdx: colToIdx(col),
            rowIdx,
            formula: rawFormula,
          });
          formula = rawFormula;
        } else {
          const master = sharedFormulas.get(siKey);
          if (master) {
            formula = shiftSharedFormula(
              master.formula,
              rowIdx - master.rowIdx,
              colToIdx(col) - master.colIdx
            );
          }
        }
      } else if (rawFormula) {
        formula = rawFormula;
      }
    }

    let rowMap = rows.get(rowIdx);
    if (!rowMap) {
      rowMap = new Map();
      rows.set(rowIdx, rowMap);
    }
    rowMap.set(col, [val, formula]);
  }
  return rows;
}

function parseXlsxWorkbook(xlsxInput) {
  const zip = readZipEntries(xlsxInput);
  const wbBuf = zip.readEntryBuffer('xl/workbook.xml');
  const relsBuf = zip.readEntryBuffer('xl/_rels/workbook.xml.rels');
  if (!wbBuf || !relsBuf) {
    throw new Error('损坏的 XLSX 文件：缺少 workbook.xml 或 workbook.xml.rels');
  }
  const ssBuf = zip.readEntryBuffer('xl/sharedStrings.xml');
  const sharedStrings = ssBuf ? parseSharedStringsXml(ssBuf.toString('utf8')) : [];
  const relMap = parseWorkbookRelsXml(relsBuf.toString('utf8'));
  const sheetDefs = parseWorkbookSheetsXml(wbBuf.toString('utf8'));

  const sheets = new Map();
  for (const def of sheetDefs) {
    const rawTarget = relMap[def.rid];
    if (!rawTarget) continue;
    let target = rawTarget.replace(/^\/+/, '');
    if (!target.startsWith('xl/')) {
      target = `xl/${target}`;
    }
    const shBuf = zip.readEntryBuffer(target);
    if (!shBuf) continue;
    sheets.set(def.name, parseWorksheetXml(shBuf.toString('utf8'), sharedStrings));
  }

  return {
    sheets,
    get(sheetName, col, row) {
      const sh = sheets.get(sheetName);
      if (!sh) return [null, null];
      const rowMap = sh.get(row);
      if (!rowMap) return [null, null];
      return rowMap.get(col) || [null, null];
    },
  };
}

// ---------------------------------------------------------------------------
// 2. Excel 公式词法、AST 解析与展开器（1:1 对齐 extract_excel.py）
// ---------------------------------------------------------------------------

function parseCellRef(ref) {
  const m = /^\$?([A-Z]+)\$?(\d+)$/.exec(String(ref || '').trim());
  if (!m) return null;
  return [m[1], Number(m[2])];
}

function normName(s) {
  return String(s || '')
    .replace(/[\s\u3000・･!！?？♪♡♥〜～\-—「」『』()（）[\]【】]/g, '')
    .toLowerCase();
}

const TOKEN_PATTERNS = [
  ['SPACE', /^\s+/],
  ['STRING', /^"[^"]*"/],
  ['SHEET_RANGE', /^(?:'[^']+'|[A-Za-z0-9_\u4e00-\u9fff]+)!\$?[A-Z]+\$?\d+:\$?[A-Z]+\$?\d+/],
  ['RANGE', /^\$?[A-Z]+\$?\d+:\$?[A-Z]+\$?\d+/],
  ['SHEET_CELL', /^(?:'[^']+'|[A-Za-z0-9_\u4e00-\u9fff]+)!\$?[A-Z]+\$?\d+/],
  ['CELL', /^\$?[A-Z]+\$?\d+/],
  ['FUNC', /^[A-Za-z_][A-Za-z0-9_]*\s*(?=\()/],
  ['NUMBER', /^\d+(?:\.\d+)?/],
  ['OP', /^(?:<=|>=|<>|[+\-*/=<>(),])/],
];

function tokenizeFormula(expr) {
  const tokens = [];
  let pos = 0;
  const src = String(expr || '');
  while (pos < src.length) {
    const slice = src.slice(pos);
    let matched = false;
    for (const [kind, re] of TOKEN_PATTERNS) {
      const m = re.exec(slice);
      if (m) {
        pos += m[0].length;
        if (kind !== 'SPACE') {
          tokens.push([kind, m[0].trim()]);
        }
        matched = true;
        break;
      }
    }
    if (!matched) {
      throw new Error(`无法词法解析公式位置 ${pos}: ${src.slice(pos, pos + 30)} in ${src}`);
    }
  }
  return tokens;
}

class ASTParser {
  constructor(tokens) {
    this.tokens = tokens;
    this.i = 0;
  }

  peek() {
    return this.i < this.tokens.length ? this.tokens[this.i] : null;
  }

  consume(expected) {
    const tok = this.peek();
    if (expected && (!tok || tok[1] !== expected)) {
      throw new Error(`期望 ${expected}，实际 ${tok ? tok[1] : 'EOF'}`);
    }
    this.i += 1;
    return tok;
  }

  parse() {
    const node = this.parseCmp();
    if (this.i !== this.tokens.length) {
      throw new Error(`未消费完 token: ${JSON.stringify(this.tokens.slice(this.i))}`);
    }
    return node;
  }

  parseCmp() {
    let left = this.parseAdd();
    while (
      this.peek() &&
      this.peek()[0] === 'OP' &&
      ['=', '<>', '<=', '>=', '<', '>'].includes(this.peek()[1])
    ) {
      const op = this.consume()[1];
      const right = this.parseAdd();
      left = ['cmp', op, left, right];
    }
    return left;
  }

  parseAdd() {
    let left = this.parseMul();
    while (this.peek() && this.peek()[0] === 'OP' && (this.peek()[1] === '+' || this.peek()[1] === '-')) {
      const op = this.consume()[1];
      const right = this.parseMul();
      left = ['bin', op, left, right];
    }
    return left;
  }

  parseMul() {
    let left = this.parseUnary();
    while (this.peek() && this.peek()[0] === 'OP' && (this.peek()[1] === '*' || this.peek()[1] === '/')) {
      const op = this.consume()[1];
      const right = this.parseUnary();
      left = ['bin', op, left, right];
    }
    return left;
  }

  parseUnary() {
    if (this.peek() && this.peek()[0] === 'OP' && (this.peek()[1] === '+' || this.peek()[1] === '-')) {
      const op = this.consume()[1];
      return ['unary', op, this.parseUnary()];
    }
    return this.parsePrimary();
  }

  parsePrimary() {
    const tok = this.peek();
    if (!tok) {
      throw new Error('公式意外结束');
    }
    const [kind, val] = tok;
    if (kind === 'OP' && val === '(') {
      this.consume('(');
      const node = this.parseCmp();
      this.consume(')');
      return node;
    }
    if (kind === 'FUNC') {
      const fn = this.consume()[1].toUpperCase();
      this.consume('(');
      const args = [];
      if (!(this.peek() && this.peek()[1] === ')')) {
        args.push(this.parseCmp());
        while (this.peek() && this.peek()[1] === ',') {
          this.consume(',');
          args.push(this.parseCmp());
        }
      }
      this.consume(')');
      return ['call', fn, args];
    }
    this.consume();
    if (kind === 'NUMBER') {
      return ['const', Number(val)];
    }
    if (kind === 'STRING') {
      return ['const', val.slice(1, -1)];
    }
    if (kind === 'SHEET_CELL' || kind === 'CELL' || kind === 'SHEET_RANGE' || kind === 'RANGE') {
      return [kind.toLowerCase(), val];
    }
    throw new Error(`未知 primary token: ${JSON.stringify(tok)}`);
  }
}

function splitSheetRef(raw, currentSheet) {
  const idx = raw.indexOf('!');
  if (idx >= 0) {
    const sh = raw.slice(0, idx).replace(/^'+|'+$/g, '');
    const ref = raw.slice(idx + 1).replace(/\$/g, '');
    return [sh, ref];
  }
  return [currentSheet, raw.replace(/\$/g, '')];
}

function expandRange(sheet, rng) {
  const [start, end] = rng.split(':');
  const [c1, r1] = parseCellRef(start);
  const [c2, r2] = parseCellRef(end);
  const ci1 = colToIdx(c1);
  const ci2 = colToIdx(c2);
  const cells = [];
  for (let r = r1; r <= r2; r += 1) {
    for (let ci = ci1; ci <= ci2; ci += 1) {
      cells.push([sheet, idxToCol(ci), r]);
    }
  }
  return cells;
}

function quoteSingleStr(s) {
  return `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function formatPyNumber(v) {
  if (Object.is(v, -0) || v === 0) return '0';
  if (Number.isInteger(v)) return String(Math.trunc(v));
  return String(v);
}

class Val {
  constructor(expr, isConst = false, constVal = null) {
    this.expr = expr;
    this.isConst = isConst;
    this.const = constVal;
  }

  static fromConst(v) {
    if (typeof v === 'string') {
      return new Val(quoteSingleStr(v), true, v);
    }
    if (typeof v === 'boolean') {
      return new Val(v ? 'True' : 'False', true, v);
    }
    if (v === null || v === undefined) {
      return new Val('0', true, 0);
    }
    const clean = Number.isInteger(v) ? Math.trunc(v) : v;
    return new Val(formatPyNumber(clean), true, clean);
  }
}

class FormulaExpander {
  constructor(wb, itemOn = null) {
    this.wb = wb;
    this.itemOn = itemOn;
  }

  expandCell(sheet, col, row, lb, lbCellTarget, curRowNum = 2) {
    if (lbCellTarget && sheet === lbCellTarget[0] && col === lbCellTarget[1] && row === lbCellTarget[2]) {
      return Val.fromConst(lb);
    }
    if (sheet === '路线') {
      const ref = `${col}${row}`;
      if (ref === 'C6') {
        return new Val("('计算' if calc_seika else '不计算')");
      }
      if (ref === 'B4') {
        if (this.itemOn !== null) {
          return Val.fromConst(this.itemOn ? '计算' : '不计算');
        }
        return new Val("('计算' if calc_item else '不计算')");
      }
      return new Val(`R[${quoteSingleStr(ref)}]`);
    }

    const [val, formula] = this.wb.get(sheet, col, row);
    if (formula) {
      const tokens = tokenizeFormula(formula);
      const ast = new ASTParser(tokens).parse();
      return this.evalAst(ast, sheet, lb, lbCellTarget, curRowNum);
    }
    if (val === null || val === undefined) {
      return Val.fromConst(0);
    }
    return Val.fromConst(val);
  }

  evalAst(node, sheet, lb, lbCellTarget, curRowNum) {
    const kind = node[0];
    if (kind === 'const') {
      return Val.fromConst(node[1]);
    }
    if (kind === 'sheet_cell' || kind === 'cell') {
      const [sh, ref] = splitSheetRef(node[1], sheet);
      const parsedRef = parseCellRef(ref);
      if (!parsedRef) {
        throw new Error(`无效单元格引用: ${node[1]}`);
      }
      return this.expandCell(sh, parsedRef[0], parsedRef[1], lb, lbCellTarget, curRowNum);
    }
    if (kind === 'unary') {
      const op = node[1];
      const inner = this.evalAst(node[2], sheet, lb, lbCellTarget, curRowNum);
      if (inner.isConst) {
        const num = Number(inner.const) || 0;
        return Val.fromConst(op === '-' ? -num : +num);
      }
      return new Val(`(${op}${inner.expr})`);
    }
    if (kind === 'bin') {
      const op = node[1];
      const a = this.evalAst(node[2], sheet, lb, lbCellTarget, curRowNum);
      const b = this.evalAst(node[3], sheet, lb, lbCellTarget, curRowNum);
      if (a.isConst && b.isConst) {
        const av = a.const === null || a.const === undefined ? 0 : a.const;
        const bv = b.const === null || b.const === undefined ? 0 : b.const;
        let res;
        if (op === '+') res = av + bv;
        else if (op === '-') res = av - bv;
        else if (op === '*') res = av * bv;
        else if (op === '/') res = av / bv;
        if (typeof res === 'number' && Number.isInteger(res)) {
          res = Math.trunc(res);
        }
        return Val.fromConst(res);
      }
      if (op === '*' && ((a.isConst && a.const === 0) || (b.isConst && b.const === 0))) {
        return Val.fromConst(0);
      }
      if (op === '+' && a.isConst && a.const === 0) return b;
      if (op === '+' && b.isConst && b.const === 0) return a;
      if (op === '-' && b.isConst && b.const === 0) return a;
      return new Val(`(${a.expr} ${op} ${b.expr})`);
    }
    if (kind === 'cmp') {
      const op = node[1];
      const a = this.evalAst(node[2], sheet, lb, lbCellTarget, curRowNum);
      const b = this.evalAst(node[3], sheet, lb, lbCellTarget, curRowNum);
      const pyOp = op === '=' ? '==' : op === '<>' ? '!=' : op;
      if (a.isConst && b.isConst) {
        const av = a.const;
        const bv = b.const;
        let res = false;
        if (pyOp === '==') res = av === bv;
        else if (pyOp === '!=') res = av !== bv;
        else if (pyOp === '<=') res = av <= bv;
        else if (pyOp === '>=') res = av >= bv;
        else if (pyOp === '<') res = av < bv;
        else if (pyOp === '>') res = av > bv;
        return Val.fromConst(Boolean(res));
      }
      return new Val(`(${a.expr} ${pyOp} ${b.expr})`);
    }
    if (kind === 'call') {
      const fn = node[1];
      const args = node[2];
      if (fn === 'ROW') {
        return Val.fromConst(curRowNum);
      }
      if (fn === 'INT') {
        const v = this.evalAst(args[0], sheet, lb, lbCellTarget, curRowNum);
        if (v.isConst) {
          return Val.fromConst(Math.floor(Number(v.const) + 1e-9));
        }
        return new Val(`math.floor((${v.expr}) + 1e-9)`);
      }
      if (fn === 'AND') {
        const vals = args.map((x) => this.evalAst(x, sheet, lb, lbCellTarget, curRowNum));
        if (vals.every((x) => x.isConst)) {
          return Val.fromConst(vals.every((x) => Boolean(x.const)));
        }
        return new Val(`(${vals.map((x) => x.expr).join(' and ')})`);
      }
      if (fn === 'OR') {
        const vals = args.map((x) => this.evalAst(x, sheet, lb, lbCellTarget, curRowNum));
        if (vals.every((x) => x.isConst)) {
          return Val.fromConst(vals.some((x) => Boolean(x.const)));
        }
        return new Val(`(${vals.map((x) => x.expr).join(' or ')})`);
      }
      if (fn === 'IF') {
        const cond = this.evalAst(args[0], sheet, lb, lbCellTarget, curRowNum);
        if (cond.isConst) {
          const branch = cond.const ? args[1] : args.length > 2 ? args[2] : ['const', 0];
          return this.evalAst(branch, sheet, lb, lbCellTarget, curRowNum);
        }
        const tVal = this.evalAst(args[1], sheet, lb, lbCellTarget, curRowNum);
        const fVal =
          args.length > 2 ? this.evalAst(args[2], sheet, lb, lbCellTarget, curRowNum) : Val.fromConst(0);
        return new Val(`(${tVal.expr} if ${cond.expr} else ${fVal.expr})`);
      }
      if (fn === 'CHOOSE') {
        const idxV = this.evalAst(args[0], sheet, lb, lbCellTarget, curRowNum);
        if (!idxV.isConst) {
          throw new Error(`CHOOSE 索引不是常数: ${idxV.expr}`);
        }
        const pos = Math.trunc(Number(idxV.const));
        return this.evalAst(args[pos], sheet, lb, lbCellTarget, curRowNum);
      }
      if (fn === 'INDEX') {
        const rngNode = args[0];
        if (!rngNode || (rngNode[0] !== 'sheet_range' && rngNode[0] !== 'range')) {
          throw new Error(`INDEX 首参非区域: ${JSON.stringify(rngNode)}`);
        }
        const [sh, rng] = splitSheetRef(rngNode[1], sheet);
        const cells = expandRange(sh, rng);
        const idxV = this.evalAst(args[1], sheet, lb, lbCellTarget, curRowNum);
        if (!idxV.isConst) {
          throw new Error(`INDEX 索引不是常数: ${idxV.expr}`);
        }
        const pos = Math.trunc(Number(idxV.const)) - 1;
        const [targetSh, tc, tr] = cells[pos];
        return this.expandCell(targetSh, tc, tr, lb, lbCellTarget, curRowNum);
      }
      throw new Error(`不支持的 Excel 函数: ${fn}`);
    }
    throw new Error(`未知 AST 节点: ${JSON.stringify(node)}`);
  }
}

function stripRowTiebreak(formula) {
  return String(formula || '').trim().replace(/-\s*ROW\([^)]*\)\s*\*\s*0\.0+\d+/g, '');
}

function extractLbCellFromCmpFormula(wb, formula) {
  const queue = [];
  const initRe = /'持有情况'!\$?([A-Z]+\$?\d+)/g;
  let m;
  while ((m = initRe.exec(formula))) {
    queue.push(m[1]);
  }
  const visited = new Set();
  while (queue.length > 0) {
    const ref = queue.shift().replace(/\$/g, '');
    if (visited.has(ref)) continue;
    visited.add(ref);
    const parsed = parseCellRef(ref);
    if (!parsed) continue;
    const [, f] = wb.get('持有情况', parsed[0], parsed[1]);
    if (!f) continue;
    const mIf = /IF\(\s*\$?([A-Z]+\$?\d+)\s*=\s*-1\s*,/.exec(f);
    if (mIf) {
      const target = parseCellRef(mIf[1]);
      if (target) {
        return ['持有情况', target[0], target[1]];
      }
    }
    const stripped = f.replace(/'[^']+'!\$?[A-Z]+\$?\d+(?::\$?[A-Z]+\$?\d+)?/g, '');
    const nextRe = /\$?([A-Z]+\$?\d+)/g;
    let nm;
    while ((nm = nextRe.exec(stripped))) {
      const clean = nm[1].replace(/\$/g, '');
      if (!visited.has(clean)) {
        queue.push(clean);
      }
    }
  }
  return null;
}

function evalRouteDefaults(wb) {
  const d = {};
  for (let r = 11; r <= 50; r += 1) {
    const [val] = wb.get('路线', 'B', r);
    if (val !== null && val !== undefined) {
      d[`B${r}`] = val;
    }
  }
  const d11 = wb.get('路线', 'D', 11)[0] || 90;
  const d12 = wb.get('路线', 'D', 12)[0] || 10;
  const d13 = wb.get('路线', 'D', 13)[0] || 0;
  const spSeq = [];
  for (let r = 16; r <= 23; r += 1) {
    spSeq.push(wb.get('路线', 'D', r)[0]);
  }
  const spVals1 = [60, 80, 80, 100, 100, 120, 120, 140];
  const spVals2 = [20, 50, 20, 60, 20, 70, 20, 80];

  const calcB11Or12 = (pct, slotId) => {
    let s =
      200 +
      Math.floor((80 * pct) / 100) +
      Math.floor((200 * pct) / 100) +
      Math.floor((220 * pct) / 100);
    for (let i = 0; i < spSeq.length; i += 1) {
      s += spSeq[i] === slotId ? spVals1[i] : spVals2[i];
    }
    return s;
  };

  d.B11 = calcB11Or12(d11, 1);
  d.B12 = calcB11Or12(d12, 2);
  d.B13 =
    200 +
    Math.floor((80 * d13) / 100) +
    Math.floor((200 * d13) / 100) +
    Math.floor((220 * d13) / 100);
  d.B14 = spSeq.filter((x) => x === 1).length;
  d.B15 = d.B14;
  d.B17 = spSeq.filter((x) => x === 2).length;
  d.B18 = d.B17;

  for (let r = 11; r <= 50; r += 1) {
    if (!(fKey(r) in d)) {
      d[fKey(r)] = 0;
    }
  }
  return d;
}

function fKey(r) {
  return `B${r}`;
}

function extractHifCardsFromXlsx(xlsxInput, supportList, options = {}) {
  const wb = parseXlsxWorkbook(xlsxInput);
  for (const requiredSheet of ['第一属性比较', '第二属性比较', '第三属性比较', '持有情况', '路线']) {
    if (!wb.sheets.has(requiredSheet)) {
      throw new Error(`XLSX 缺少必需工作表「${requiredSheet}」`);
    }
  }

  const supArr = Array.isArray(supportList)
    ? supportList
    : supportList && Array.isArray(supportList.items)
      ? supportList.items
      : [];
  const supByKey = {};
  const supExact = {};
  const supNorm = {};
  for (const item of supArr) {
    if (!item || !item.key) continue;
    supByKey[item.key] = item;
    if (typeof item.name === 'string') {
      supExact[item.name.trim()] = item;
      supNorm[normName(item.name)] = item;
    }
  }

  const c1 = wb.sheets.get('第一属性比较');
  const c2 = wb.sheets.get('第二属性比较');
  const c3 = wb.sheets.get('第三属性比较');

  const c2ByName = new Map();
  for (const [r, rowMap] of c2.entries()) {
    if (r <= 1) continue;
    const cellA = rowMap.get('A');
    const nameA = cellA && cellA[0];
    if (typeof nameA === 'string' && nameA.trim()) {
      c2ByName.set(nameA.trim(), r);
    }
  }
  const c3ByName = new Map();
  for (const [r, rowMap] of c3.entries()) {
    if (r <= 1) continue;
    const cellA = rowMap.get('A');
    const nameA = cellA && cellA[0];
    if (typeof nameA === 'string' && nameA.trim()) {
      c3ByName.set(nameA.trim(), r);
    }
  }

  const rTest = evalRouteDefaults(wb);
  const cards = [];
  const unmatchedNames = [];
  let matchOk = 0;
  let selfCheckPass = 0;
  let selfCheckTotal = 0;

  const sortedRows = [...c1.keys()].sort((a, b) => a - b);
  for (const r of sortedRows) {
    if (r === 1) continue;
    const rowMap = c1.get(r);
    const rawName = (rowMap.get('A') || [null, null])[0];
    const d1F = (rowMap.get('D') || [null, null])[1];
    const j1F = (rowMap.get('J') || [null, null])[1];
    if (typeof rawName !== 'string' || !rawName.trim() || (!d1F && !j1F)) {
      continue;
    }
    const cleanRawName = rawName.trim();
    const mAlias = /^(.*?)[（(]([^（）()]+)[）)]\s*$/.exec(cleanRawName);
    const jpName = mAlias ? mAlias[1].trim() : cleanRawName;
    const alias = mAlias ? mAlias[2].trim() : '';

    let matchedSup = null;
    if (supExact[jpName]) {
      matchedSup = supExact[jpName];
    } else if (supNorm[normName(jpName)]) {
      matchedSup = supNorm[normName(jpName)];
    } else if (MANUAL_ALIASES[jpName]) {
      matchedSup = supByKey[MANUAL_ALIASES[jpName]] || null;
    }
    if (matchedSup) {
      matchOk += 1;
    } else {
      unmatchedNames.push(jpName);
    }

    const plan = Math.trunc(Number((rowMap.get('E') || [0])[0]) || 0);
    const isSp = Math.trunc(Number((rowMap.get('F') || [0])[0]) || 0);
    const attr = Math.trunc(Number((rowMap.get('G') || [1])[0]) || 1);
    const pollution = Math.trunc(Number((rowMap.get('H') || [0])[0]) || 0);
    const itemNoteRaw = (rowMap.get('I') || [null])[0];
    const itemNote = itemNoteRaw !== null && itemNoteRaw !== undefined ? String(itemNoteRaw).trim() : '';

    const r2 = c2ByName.get(cleanRawName);
    const r3 = c3ByName.get(cleanRawName);
    if (!r2 || !r3) {
      throw new Error(`工作表「第二/三属性比较」缺少卡片: R${r} ${cleanRawName}`);
    }

    const dFormulas = [
      stripRowTiebreak((c1.get(r).get('D') || [null, ''])[1]),
      stripRowTiebreak((c2.get(r2).get('D') || [null, ''])[1]),
      stripRowTiebreak((c3.get(r3).get('D') || [null, ''])[1]),
    ];
    const jFormulas = [
      stripRowTiebreak((c1.get(r).get('J') || [null, ''])[1]),
      stripRowTiebreak((c2.get(r2).get('J') || [null, ''])[1]),
      stripRowTiebreak((c3.get(r3).get('J') || [null, ''])[1]),
    ];

    const lbTarget = extractLbCellFromCmpFormula(wb, dFormulas[0]);
    if (!lbTarget) {
      throw new Error(`无法识别破数单元格: R${r} ${cleanRawName} -> ${dFormulas[0]}`);
    }

    const hasItemBonus = dFormulas.some((df) => df.includes('路线') && df.includes('B4'));
    const exprsNoItem = {};
    const exprsWithItem = {};

    const cmpTargets = [
      [dFormulas[0], '第一属性比较', r],
      [dFormulas[1], '第二属性比较', r2],
      [dFormulas[2], '第三属性比较', r3],
    ];
    const parsedDAsts = cmpTargets.map(([df, cmpSh, cmpR]) => [
      new ASTParser(tokenizeFormula(df)).parse(),
      cmpSh,
      cmpR,
    ]);

    const expNo = new FormulaExpander(wb, false);
    const expYes = new FormulaExpander(wb, true);
    for (let lb = 0; lb < 5; lb += 1) {
      const slotNo = [];
      const slotYes = [];
      for (const [ast, cmpSh, cmpR] of parsedDAsts) {
        slotNo.push(expNo.evalAst(ast, cmpSh, lb, lbTarget, cmpR).expr);
        slotYes.push(expYes.evalAst(ast, cmpSh, lb, lbTarget, cmpR).expr);
      }
      exprsNoItem[String(lb)] = slotNo;
      exprsWithItem[String(lb)] = slotYes;
    }

    // 4 破对比 J 列自检（全程使用 HifPlanner.compileCardExpr，禁止 eval / new Function）
    const jTargets = [
      [jFormulas[0], '第一属性比较', r],
      [jFormulas[1], '第二属性比较', r2],
      [jFormulas[2], '第三属性比较', r3],
    ];
    for (let slotIdx = 0; slotIdx < jTargets.length; slotIdx += 1) {
      const [jf, cmpSh, cmpR] = jTargets[slotIdx];
      const astJ = new ASTParser(tokenizeFormula(jf)).parse();
      for (const itemOn of [false, true]) {
        const jExpr = new FormulaExpander(wb, itemOn).evalAst(astJ, cmpSh, 4, lbTarget, cmpR).expr;
        const dExpr = itemOn ? exprsWithItem['4'][slotIdx] : exprsNoItem['4'][slotIdx];
        const fnJ = HifPlanner.compileCardExpr(jExpr);
        const fnD = HifPlanner.compileCardExpr(dExpr);
        for (const seikaOn of [false, true]) {
          const valJ = Number(fnJ(rTest, seikaOn));
          const valD = Number(fnD(rTest, seikaOn));
          selfCheckTotal += 1;
          if (Number.isFinite(valJ) && Number.isFinite(valD) && Math.abs(valJ - valD) <= 1e-6) {
            selfCheckPass += 1;
          }
        }
      }
    }

    const depSet = new Set();
    const depRe = /R\['(B\d+)'\]/g;
    const allCode = exprsWithItem['4'].join(' ');
    let dm;
    while ((dm = depRe.exec(allCode))) {
      depSet.add(dm[1]);
    }
    const deps = [...depSet].sort();

    cards.push({
      id: r,
      rawName: cleanRawName,
      jpName,
      alias,
      supportKey: matchedSup ? matchedSup.key : null,
      rarity: matchedSup ? Number(matchedSup.rarity) : null,
      plan,
      isSp,
      attr,
      pollution,
      itemNote,
      hasItemBonus,
      isMiniDrink: jpName === 'ふわふわでワクワク',
      deps,
      exprs: {
        noItem: exprsNoItem,
        withItem: exprsWithItem,
      },
    });
  }

  if (cards.length === 0) {
    throw new Error('XLSX 提取失败：未解析到任何有效支援卡公式');
  }

  const sourceName =
    typeof options.sourceName === 'string' && options.sourceName.trim()
      ? options.sourceName.trim()
      : typeof xlsxInput === 'string'
        ? require('path').basename(xlsxInput)
        : 'uploaded.xlsx';

  return {
    source: sourceName,
    cardCount: cards.length,
    supportMatchCount: matchOk,
    unmatchedNames,
    selfCheckPassed: selfCheckPass,
    selfCheckTotal,
    cards,
  };
}

// ---------------------------------------------------------------------------
// 3. 上游 gakumasu-diff YAML 解析与拉取器（强制 IPv4 + 可选 HTTP CONNECT 代理）
// ---------------------------------------------------------------------------

function unquoteYamlScalar(raw) {
  const s = String(raw || '').trim();
  if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') {
    return s
      .slice(1, -1)
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\')
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '\t');
  }
  if (s.length >= 2 && s[0] === "'" && s[s.length - 1] === "'") {
    return s.slice(1, -1).replace(/''/g, "'");
  }
  return s;
}

function parseYamlTopItems(text) {
  const items = [];
  let current = null;
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    if (!rawLine.trim() || rawLine.trimStart().startsWith('#')) {
      continue;
    }
    if (rawLine.startsWith('- ')) {
      if (current !== null) items.push(current);
      current = {};
      const rest = rawLine.slice(2);
      const colonIdx = rest.indexOf(':');
      if (colonIdx >= 0) {
        const k = rest.slice(0, colonIdx).trim();
        const v = rest.slice(colonIdx + 1);
        current[k] = unquoteYamlScalar(v);
      }
      continue;
    }
    if (
      current !== null &&
      rawLine.startsWith('  ') &&
      !rawLine.startsWith('    ') &&
      !rawLine.startsWith('  -') &&
      rawLine.includes(':')
    ) {
      const sub = rawLine.slice(2);
      const colonIdx = sub.indexOf(':');
      const k = sub.slice(0, colonIdx).trim();
      const v = sub.slice(colonIdx + 1);
      current[k] = unquoteYamlScalar(v);
    }
  }
  if (current !== null) {
    items.push(current);
  }
  return items;
}

function toInt(val, fallback = 0) {
  if (val === undefined || val === null || val === '') return fallback;
  const num = Number(val);
  return Number.isFinite(num) ? Math.trunc(num) : fallback;
}

function buildCharacters(rawChars) {
  const result = {};
  for (const row of rawChars) {
    if (row.isPlayable !== 'true') continue;
    const cid = String(row.id || '').trim();
    if (!cid) continue;
    const fallback = `${row.lastName || ''}${row.firstName || ''}`.trim() || cid.toUpperCase();
    result[cid] = ZH_CHAR_NAMES[cid] || fallback;
  }
  const orderedKeys = [
    ...Object.keys(ZH_CHAR_NAMES).filter((k) => k in result),
    ...Object.keys(result)
      .filter((k) => !(k in ZH_CHAR_NAMES))
      .sort(),
  ];
  const out = {};
  for (const k of orderedKeys) {
    out[k] = result[k];
  }
  return out;
}

function buildSupportCards(rawSupport) {
  const cards = [];
  for (const row of rawSupport) {
    const rarity = SUPPORT_RARITY_MAP[row.rarity || ''];
    if (!rarity) continue;
    const cardId = String(row.id || '');
    const m = /^s_card-[23]-(\d{1,4})$/.exec(cardId);
    if (!m) continue;
    const number = m[1].padStart(4, '0');
    const attr = ATTR_MAP[row.type || ''] || 'vo';
    const plan = PLAN_MAP[row.planType || ''] || 'Common';
    cards.push({
      id: cardId,
      key: `${rarity}-${number}`,
      rarity,
      number,
      attr,
      plan,
      name: row.name || cardId,
      isLimited: row.isLimited === 'true',
      order: toInt(row.order, 0),
      image: `assets/cards/s_card-${rarity}-${number}.webp`,
    });
  }
  cards.sort((a, b) => Number(b.rarity) - Number(a.rarity) || Number(b.number) - Number(a.number));
  return cards;
}

function buildCidolCards(rawIdolCards, rawSkins) {
  const idolMap = new Map();
  for (const row of rawIdolCards) {
    if (row.id) idolMap.set(row.id, row);
  }
  const skins = [];
  const seenKeys = new Set();

  for (const skin of rawSkins) {
    const assetId = String(skin.assetId || '');
    const m = /^cidol-([a-z0-9]+)-([123])-(\d{1,3})$/.exec(assetId);
    if (!m) continue;
    const character = m[1];
    const rarity = m[2];
    const number = m[3].padStart(3, '0');
    const key = `${character}-${rarity}-${number}`;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);

    const card = idolMap.get(skin.idolCardId || '') || {};
    const cardRarity = IDOL_RARITY_MAP[card.rarity || ''] || rarity;
    const plan = PLAN_MAP[card.planType || ''] || 'Common';
    const skinName = String(skin.name || '').trim();
    const cardName = String(card.name || '').trim();
    const displayName = skinName || cardName || key;

    skins.push({
      key,
      id: skin.id || `i_card-skin-${key}`,
      idolCardId: skin.idolCardId || '',
      character,
      rarity: String(cardRarity),
      number,
      name: displayName,
      baseName: cardName,
      isSkinVariant: Boolean(skinName),
      isLimited: card.isLimited === 'true',
      plan,
      variants: ['0', '1'],
      images: {
        0: `assets/cidol/cidol-${key}_0.webp`,
        1: `assets/cidol/cidol-${key}_1.webp`,
      },
      stats: {
        vo: toInt(card.produceVocal, 0),
        da: toInt(card.produceDance, 0),
        vi: toInt(card.produceVisual, 0),
        voRate: Math.round((toInt(card.produceVocalGrowthRatePermil, 0) / 10.0) * 10) / 10,
        daRate: Math.round((toInt(card.produceDanceGrowthRatePermil, 0) / 10.0) * 10) / 10,
        viRate: Math.round((toInt(card.produceVisualGrowthRatePermil, 0) / 10.0) * 10) / 10,
      },
    });
  }

  skins.sort((a, b) => {
    if (a.character !== b.character) return a.character < b.character ? -1 : 1;
    const rDiff = Number(b.rarity) - Number(a.rarity);
    if (rDiff !== 0) return rDiff;
    return a.number < b.number ? -1 : a.number > b.number ? 1 : 0;
  });
  return skins;
}

function parseHttpProxy(proxyUrl) {
  const raw = String(proxyUrl || '').trim();
  if (!raw) return null;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch (_) {
    throw new Error('代理地址格式无效，请填写如 http://127.0.0.1:7890');
  }
  if (parsed.protocol !== 'http:') {
    throw new Error('仅支持 HTTP 代理（http://host:port）');
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  const port = Number(parsed.port) || 80;
  let authHeader = '';
  if (parsed.username || parsed.password) {
    const token = Buffer.from(
      `${decodeURIComponent(parsed.username)}:${decodeURIComponent(parsed.password)}`,
      'utf8'
    ).toString('base64');
    authHeader = `Basic ${token}`;
  }
  return { host, port, authHeader };
}

function performOnce(targetUrl, options = {}) {
  const urlObj = new URL(targetUrl);
  const isHttps = urlObj.protocol === 'https:';
  if (!isHttps && urlObj.protocol !== 'http:') {
    throw new Error(`不支持的请求协议: ${urlObj.protocol}`);
  }

  const proxy = parseHttpProxy(options.proxyUrl);
  const timeoutMs = Math.max(50, Number(options.timeoutMs) || DEFAULT_FETCH_TIMEOUT_MS);
  const maxBytes = Math.max(1024, Number(options.maxBytes) || MAX_FETCH_BYTES);
  const targetHost = urlObj.hostname.replace(/^\[|\]$/g, '');
  const targetPort = Number(urlObj.port) || (isHttps ? 443 : 80);
  const headers = {
    'User-Agent': 'Koishi-GkmsBox-CatalogSync/1.0',
    Accept: 'text/plain, text/yaml, */*;q=0.8',
    ...(options.headers || {}),
  };

  return new Promise((resolve, reject) => {
    let settled = false;
    let totalBytes = 0;
    const chunks = [];
    let activeReq = null;
    let activeProxyReq = null;
    let activeSocket = null;

    const cleanup = () => {
      if (activeReq && !activeReq.destroyed) activeReq.destroy();
      if (activeProxyReq && !activeProxyReq.destroyed) activeProxyReq.destroy();
      if (activeSocket && !activeSocket.destroyed) activeSocket.destroy();
    };

    const finishErr = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      const rawMsg = err && err.message ? err.message : String(err);
      reject(new Error(sanitizeErrorText(rawMsg)));
    };

    const timer = setTimeout(() => {
      finishErr(new Error(`拉取上游卡池超时（超过 ${Math.ceil(timeoutMs / 1000)} 秒）`));
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    const handleRes = (res) => {
      res.on('error', finishErr);
      const lenHdr = res.headers && res.headers['content-length'];
      if (lenHdr !== undefined && Number(lenHdr) > maxBytes) {
        res.destroy();
        return finishErr(new Error(`上游响应超过体积上限 (${maxBytes} bytes)`));
      }
      res.on('data', (chunk) => {
        if (settled) return;
        totalBytes += chunk.length;
        if (totalBytes > maxBytes) {
          chunks.length = 0;
          res.destroy();
          return finishErr(new Error(`上游响应超过体积上限 (${maxBytes} bytes)`));
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const buf = Buffer.concat(chunks, totalBytes);
        resolve({
          status: res.statusCode || 0,
          headers: res.headers || {},
          text: buf.toString('utf8'),
        });
      });
    };

    const dispatchReq = (transport, reqOpts) => {
      activeReq = transport.request(reqOpts, handleRes);
      activeReq.on('error', finishErr);
      activeReq.end();
    };

    if (!proxy) {
      const reqOpts = {
        protocol: urlObj.protocol,
        hostname: targetHost,
        port: targetPort,
        path: `${urlObj.pathname}${urlObj.search}`,
        method: 'GET',
        headers,
      };
      if (!net.isIPv6(targetHost)) {
        reqOpts.family = 4;
      }
      dispatchReq(isHttps ? https : http, reqOpts);
      return;
    }

    if (!isHttps) {
      const reqHeaders = { Host: urlObj.host, ...headers };
      if (proxy.authHeader) reqHeaders['Proxy-Authorization'] = proxy.authHeader;
      const reqOpts = {
        protocol: 'http:',
        hostname: proxy.host,
        port: proxy.port,
        path: targetUrl,
        method: 'GET',
        headers: reqHeaders,
      };
      if (!net.isIPv6(proxy.host)) reqOpts.family = 4;
      dispatchReq(http, reqOpts);
      return;
    }

    const authority = `${net.isIPv6(targetHost) ? `[${targetHost}]` : targetHost}:${targetPort}`;
    const connectHeaders = { Host: authority };
    if (proxy.authHeader) connectHeaders['Proxy-Authorization'] = proxy.authHeader;
    const connectOpts = {
      protocol: 'http:',
      hostname: proxy.host,
      port: proxy.port,
      method: 'CONNECT',
      path: authority,
      headers: connectHeaders,
    };
    if (!net.isIPv6(proxy.host)) connectOpts.family = 4;

    activeProxyReq = http.request(connectOpts);
    activeProxyReq.on('connect', (proxyRes, socket, head) => {
      activeSocket = socket;
      if (settled) {
        socket.destroy();
        return;
      }
      if (proxyRes.statusCode !== 200) {
        socket.destroy();
        return finishErr(new Error(`代理隧道建立失败（HTTP ${proxyRes.statusCode}）`));
      }
      if (head && head.length) socket.unshift(head);
      const tlsOpts = { socket };
      if (net.isIP(targetHost)) tlsOpts.host = targetHost;
      else tlsOpts.servername = targetHost;
      const tlsSocket = tls.connect(tlsOpts);
      activeSocket = tlsSocket;
      tlsSocket.on('error', finishErr);

      const reqOpts = {
        hostname: targetHost,
        port: targetPort,
        path: `${urlObj.pathname}${urlObj.search}`,
        method: 'GET',
        headers: { Host: urlObj.host, ...headers },
        createConnection: () => tlsSocket,
      };
      dispatchReq(http, reqOpts);
    });
    activeProxyReq.on('error', finishErr);
    activeProxyReq.end();
  });
}

async function fetchTextWithRedirect(url, options = {}) {
  const timeoutMs = Math.max(50, Number(options.timeoutMs) || DEFAULT_FETCH_TIMEOUT_MS);
  const deadline = Date.now() + timeoutMs;
  let currentUrl = String(url);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(`拉取上游卡池超时（超过 ${Math.ceil(timeoutMs / 1000)} 秒）`);
    }
    const res = await performOnce(currentUrl, { ...options, timeoutMs: remaining });
    if ([301, 302, 303, 307, 308].includes(res.status) && res.headers && res.headers.location && hop < MAX_REDIRECTS) {
      const prev = new URL(currentUrl);
      const next = new URL(res.headers.location, prev);
      if (prev.protocol === 'https:' && next.protocol !== 'https:') {
        throw new Error(`拒绝从 HTTPS 降级重定向到 ${next.protocol}`);
      }
      currentUrl = next.toString();
      continue;
    }
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`拉取 ${currentUrl} 失败: HTTP ${res.status}`);
    }
    return res.text;
  }
  throw new Error('拉取上游卡池重定向次数过多');
}

async function fetchUpstreamFile(filename, options = {}) {
  const baseUrl = String(options.rawBase || RAW_BASE).replace(/\/+$/, '');
  const targetUrl = `${baseUrl}/${filename}`;

  if (customUpstreamFetcher) {
    try {
      return await customUpstreamFetcher(filename, targetUrl, options);
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      throw new Error(sanitizeErrorText(msg));
    }
  }

  let lastErr;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await fetchTextWithRedirect(targetUrl, options);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

async function fetchUpstreamCatalog(options = {}) {
  const files = ['Character.yaml', 'SupportCard.yaml', 'IdolCard.yaml', 'IdolCardSkin.yaml'];
  const yamlTexts = await Promise.all(files.map((f) => fetchUpstreamFile(f, options)));

  const rawChars = parseYamlTopItems(yamlTexts[0]);
  const rawSupport = parseYamlTopItems(yamlTexts[1]);
  const rawIdol = parseYamlTopItems(yamlTexts[2]);
  const rawSkins = parseYamlTopItems(yamlTexts[3]);

  const characters = buildCharacters(rawChars);
  const support = buildSupportCards(rawSupport);
  const cidol = buildCidolCards(rawIdol, rawSkins);

  const nowIso = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const supportSsr = support.filter((c) => c.rarity === '3').length;
  const supportSr = support.filter((c) => c.rarity === '2').length;

  const meta = {
    schema: 1,
    generatedAt: nowIso,
    source: {
      repo: UPSTREAM_REPO,
      branch: UPSTREAM_BRANCH,
    },
    counts: {
      characters: Object.keys(characters).length,
      support: support.length,
      supportSsr,
      supportSr,
      cidol: cidol.length,
    },
  };

  return { characters, support, cidol, meta };
}

module.exports = {
  extractHifCardsFromXlsx,
  fetchUpstreamCatalog,
  setUpstreamFetcher,
  parseXlsxWorkbook,
  parseYamlTopItems,
  sanitizeErrorText,
};
