/**
 * Cloudflare Pages Functions: POST /api/binds
 * 将前端生成的 S卡/P卡 Base64 编码保存至 Cloudflare KV，并返回 9 位短码 (g########)。
 */

const SHORT_CODE_DIGITS = 8;
const MAX_PAYLOAD_BYTES = 65536;
const MAX_ALLOC_ATTEMPTS = 12;

const BASE64_CHARS_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const SUPPORT_ITEM_RE = /^([23])-(\d{1,4})-([0-4])$/;
const CIDOL_ITEM_RE = /^([a-z0-9]+)-([123])-(\d{1,3})$/;

function jsonResponse(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      ...extraHeaders,
    },
  });
}

function validateAndCount(b64, itemRe) {
  const clean = String(b64 || '').trim();
  if (!clean) return { ok: true, count: 0, clean: '' };
  if (!BASE64_CHARS_RE.test(clean) || clean.length % 4 !== 0) {
    return { ok: false, error: '无效的 Base64 字符串' };
  }
  let raw = '';
  try {
    raw = atob(clean);
  } catch {
    return { ok: false, error: 'Base64 解码失败' };
  }
  const items = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (items.length === 0) {
    return { ok: false, error: '载荷条目为空' };
  }
  for (const item of items) {
    if (!itemRe.test(item)) {
      return { ok: false, error: `非法的卡片条目: ${item}` };
    }
  }
  return { ok: true, count: items.length, clean };
}

function allocShortCode() {
  const arr = new Uint32Array(1);
  crypto.getRandomValues(arr);
  const num = arr[0] % 10 ** SHORT_CODE_DIGITS;
  return 'g' + String(num).padStart(SHORT_CODE_DIGITS, '0');
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    },
  });
}

export async function onRequestPost(context) {
  const { request, env } = context;

  if (!env || !env.BOX_BINDS) {
    return jsonResponse(
      {
        error: 'KV_NOT_CONFIGURED',
        message: '尚未在 Cloudflare Pages 绑定 BOX_BINDS KV 命名空间，当前可先使用 Base64 长码导入/绑定',
      },
      503
    );
  }

  let bodyText = '';
  try {
    bodyText = await request.text();
  } catch {
    return jsonResponse({ error: 'INVALID_BODY', message: '读取请求体失败' }, 400);
  }

  if (new TextEncoder().encode(bodyText).length > MAX_PAYLOAD_BYTES) {
    return jsonResponse({ error: 'PAYLOAD_TOO_LARGE', message: '请求体积超出 64KB 限制' }, 413);
  }

  let body;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return jsonResponse({ error: 'INVALID_JSON', message: '请求体必须是合法 JSON' }, 400);
  }

  const boxCheck = validateAndCount(body.box, SUPPORT_ITEM_RE);
  if (!boxCheck.ok) {
    return jsonResponse({ error: 'INVALID_BOX', message: boxCheck.error }, 400);
  }

  const cidolCheck = validateAndCount(body.cidol, CIDOL_ITEM_RE);
  if (!cidolCheck.ok) {
    return jsonResponse({ error: 'INVALID_CIDOL', message: cidolCheck.error }, 400);
  }

  if (boxCheck.count === 0 && cidolCheck.count === 0) {
    return jsonResponse(
      { error: 'EMPTY_PAYLOAD', message: '支援卡与角色皮肤不能同时为空' },
      400
    );
  }

  let allocatedCode = '';
  for (let i = 0; i < MAX_ALLOC_ATTEMPTS; i += 1) {
    const candidate = allocShortCode();
    const existing = await env.BOX_BINDS.get(candidate);
    if (existing === null) {
      allocatedCode = candidate;
      break;
    }
  }

  if (!allocatedCode) {
    return jsonResponse(
      { error: 'ALLOC_FAILED', message: '短码分配碰撞重试超限，请稍后再试' },
      503
    );
  }

  const nowIso = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const record = {
    v: 1,
    code: allocatedCode,
    box: boxCheck.clean,
    cidol: cidolCheck.clean,
    box_count: boxCheck.count,
    cidol_count: cidolCheck.count,
    created_at: nowIso,
  };

  await env.BOX_BINDS.put(allocatedCode, JSON.stringify(record));
  return jsonResponse(record, 201, { 'Cache-Control': 'no-store' });
}
