/**
 * Cloudflare Pages Functions: POST /api/binds
 * 将前端生成的 S卡/P卡 Base64 编码保存至 Cloudflare KV，并返回 9 位短码 (g########)。
 */

const SHORT_CODE_DIGITS = 8;
const MAX_PAYLOAD_BYTES = 65536;
const MAX_ALLOC_ATTEMPTS = 12;
const BIND_TTL_SECONDS = 180 * 24 * 3600; // 180 天
const POST_RATE_LIMIT = 5; // 每 IP 每分钟 5 次
const RATE_WINDOW_SECONDS = 60;
const MAX_ERROR_ITEM_CHARS = 40;

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

function truncateText(str, maxChars) {
  const chars = Array.from(String(str ?? ''));
  if (chars.length <= maxChars) return chars.join('');
  return `${chars.slice(0, maxChars).join('')}…`;
}

function getClientIp(request) {
  if (!request || !request.headers || typeof request.headers.get !== 'function') {
    return 'unknown';
  }
  const cfIp = request.headers.get('cf-connecting-ip');
  if (cfIp && cfIp.trim()) return cfIp.trim();
  const xff = request.headers.get('x-forwarded-for');
  if (xff) {
    const first = xff.split(',')[0].trim();
    if (first) return first;
  }
  return 'unknown';
}

async function checkRateLimit(request, scope, limit) {
  if (typeof caches === 'undefined' || !caches || !caches.default || !request) {
    return { allowed: true };
  }
  try {
    const ip = getClientIp(request);
    const nowSec = Math.floor(Date.now() / 1000);
    const bucket = Math.floor(nowSec / RATE_WINDOW_SECONDS);
    const retryAfter = Math.max(1, RATE_WINDOW_SECONDS - (nowSec % RATE_WINDOW_SECONDS));
    const keyReq = new Request(
      `https://rate-limit.internal/api/binds/${encodeURIComponent(scope)}/${encodeURIComponent(ip)}/${bucket}`
    );
    const hit = await caches.default.match(keyReq);
    let count = 0;
    if (hit) {
      const text = await hit.text();
      const parsed = Number.parseInt(text, 10);
      if (Number.isFinite(parsed) && parsed > 0) count = parsed;
    }
    if (count >= limit) {
      return { allowed: false, retryAfter };
    }
    await caches.default.put(
      keyReq,
      new Response(String(count + 1), {
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': `public, max-age=${RATE_WINDOW_SECONDS + 5}`,
        },
      })
    );
    return { allowed: true };
  } catch {
    return { allowed: true };
  }
}

function validateAndCount(b64, itemRe) {
  if (b64 !== undefined && b64 !== null && typeof b64 !== 'string') {
    return { ok: false, error: '字段必须为字符串' };
  }
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
      return { ok: false, error: `非法的卡片条目: ${truncateText(item, MAX_ERROR_ITEM_CHARS)}` };
    }
  }
  return { ok: true, count: items.length, clean };
}

async function computePayloadHashKey(boxClean, cidolClean) {
  const bytes = new TextEncoder().encode(JSON.stringify({ box: boxClean, cidol: cidolClean }));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const view = new Uint8Array(digest).subarray(0, 16);
  let hex = '';
  for (const b of view) {
    hex += b.toString(16).padStart(2, '0');
  }
  return `h:${hex}`;
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

  const rl = await checkRateLimit(request, 'post', POST_RATE_LIMIT);
  if (!rl.allowed) {
    return jsonResponse(
      { error: 'RATE_LIMITED', message: '生成短码过于频繁，请稍后再试' },
      429,
      {
        'Retry-After': String(rl.retryAfter || RATE_WINDOW_SECONDS),
        'Cache-Control': 'no-store',
      }
    );
  }

  const contentLengthHeader =
    request && request.headers && typeof request.headers.get === 'function'
      ? request.headers.get('content-length')
      : null;
  if (contentLengthHeader !== null && contentLengthHeader !== '') {
    const declaredLen = Number(contentLengthHeader);
    if (Number.isFinite(declaredLen) && declaredLen > MAX_PAYLOAD_BYTES) {
      return jsonResponse({ error: 'PAYLOAD_TOO_LARGE', message: '请求体积超出 64KB 限制' }, 413);
    }
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

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return jsonResponse({ error: 'INVALID_JSON', message: '请求体必须是 JSON 对象' }, 400);
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

  // 幂等去重：相同卡片快照优先复用未过期的已有短码
  const hashKey = await computePayloadHashKey(boxCheck.clean, cidolCheck.clean);
  const existingCode = await env.BOX_BINDS.get(hashKey);
  if (existingCode) {
    const existingRaw = await env.BOX_BINDS.get(existingCode);
    if (existingRaw) {
      try {
        const existingRecord = JSON.parse(existingRaw);
        if (existingRecord && typeof existingRecord === 'object' && !Array.isArray(existingRecord)) {
          return jsonResponse({ ...existingRecord, reused: true }, 200, {
            'Cache-Control': 'no-store',
          });
        }
      } catch {
        // 已损坏的旧记录继续往下重新分配
      }
    }
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

  await env.BOX_BINDS.put(allocatedCode, JSON.stringify(record), {
    expirationTtl: BIND_TTL_SECONDS,
  });
  await env.BOX_BINDS.put(hashKey, allocatedCode, {
    expirationTtl: BIND_TTL_SECONDS,
  });
  return jsonResponse(record, 201, { 'Cache-Control': 'no-store' });
}
