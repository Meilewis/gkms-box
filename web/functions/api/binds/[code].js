/**
 * Cloudflare Pages Functions: GET /api/binds/:code
 * 按 9 位短码 (g########) 读取存入 BOX_BINDS KV 的玩家 BOX 数据。
 */

const SHORT_CODE_RE = /^g\d{8}$/i;
const GET_RATE_LIMIT = 30; // 每 IP 每分钟 30 次
const RATE_WINDOW_SECONDS = 60;

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

export async function onRequestGet(context) {
  const { request, params, env } = context;

  if (!env || !env.BOX_BINDS) {
    return jsonResponse(
      { error: 'KV_NOT_CONFIGURED', message: '尚未绑定 BOX_BINDS KV 存储' },
      503
    );
  }

  const rl = await checkRateLimit(request, 'get', GET_RATE_LIMIT);
  if (!rl.allowed) {
    return jsonResponse(
      { error: 'RATE_LIMITED', message: '查询短码过于频繁，请稍后再试' },
      429,
      {
        'Retry-After': String(rl.retryAfter || RATE_WINDOW_SECONDS),
        'Cache-Control': 'no-store',
      }
    );
  }

  const rawCode = String((params && params.code) || '').trim();
  if (!SHORT_CODE_RE.test(rawCode)) {
    return jsonResponse(
      { error: 'INVALID_CODE', message: '短码格式不正确，应为 g 加 8 位数字' },
      400
    );
  }

  const code = rawCode.toLowerCase();
  const value = await env.BOX_BINDS.get(code);
  if (value === null) {
    return jsonResponse(
      { error: 'NOT_FOUND', message: `未找到短码 ${code} 对应的 BOX 数据` },
      404,
      { 'Cache-Control': 'public, max-age=60' }
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    return jsonResponse({ error: 'CORRUPT_RECORD', message: '存储记录损坏' }, 500);
  }

  return jsonResponse(parsed, 200, {
    'Cache-Control': 'public, max-age=60',
  });
}
