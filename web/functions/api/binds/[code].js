/**
 * Cloudflare Pages Functions: GET /api/binds/:code
 * 按 9 位短码 (g########) 读取存入 BOX_BINDS KV 的玩家 BOX 数据。
 */

const SHORT_CODE_RE = /^g\d{8}$/i;

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
  const { params, env } = context;

  if (!env || !env.BOX_BINDS) {
    return jsonResponse(
      { error: 'KV_NOT_CONFIGURED', message: '尚未绑定 BOX_BINDS KV 存储' },
      503
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
      404
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
