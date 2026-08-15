/**
 * Qoffa secure Baserow gateway for Cloudflare Workers.
 *
 * Secrets are configured with `wrangler secret put BASEROW_TOKEN`.
 * Do not put secrets in this file or in the GitHub Pages bundle.
 */

const PRODUCT_TABLE = '882093';
const CONTACT_TABLE = '908045';
const BANNER_TABLE = '887021';
const ORDERS_TABLE = '852045';
const SOLD_PRODUCTS_TABLE = '852927';

const memoryBuckets = new Map();

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...headers,
    },
  });
}

function allowedOrigin(request, env) {
  const requestOrigin = request.headers.get('Origin') || '';
  const configuredOrigin = String(env.ALLOWED_ORIGIN || '').replace(/\/$/, '');
  if (!configuredOrigin) return '';
  return requestOrigin === configuredOrigin ? requestOrigin : '';
}

function corsHeaders(request, env) {
  const origin = allowedOrigin(request, env);
  return origin
    ? {
        'access-control-allow-origin': origin,
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'Content-Type, X-Turnstile-Token',
        'vary': 'Origin',
      }
    : {};
}

function isAllowedRequest(request, env) {
  const configuredOrigin = String(env.ALLOWED_ORIGIN || '').replace(/\/$/, '');
  const origin = request.headers.get('Origin') || '';
  if (!configuredOrigin) return false;
  return origin === configuredOrigin;
}

function rateLimit(request, env) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const now = Date.now();
  const windowMs = 60_000;
  const max = Math.max(10, Number(env.MAX_REQUESTS_PER_MINUTE || 60));
  const current = memoryBuckets.get(ip);

  if (!current || now - current.startedAt >= windowMs) {
    memoryBuckets.set(ip, { startedAt: now, count: 1 });
    return true;
  }

  current.count += 1;
  return current.count <= max;
}

function tableUrl(tableId, rowId = '', query = '') {
  const base = `https://api.baserow.io/api/database/rows/table/${tableId}/`;
  return `${base}${rowId ? `${encodeURIComponent(rowId)}/` : ''}${query}`;
}

async function baserow(request, env, tableId, options = {}) {
  if (!env.BASEROW_TOKEN) return json({ error: 'Backend is not configured' }, 503);

  const response = await fetch(tableUrl(tableId, options.rowId || '', options.query || ''), {
    method: options.method || 'GET',
    headers: {
      authorization: `Token ${env.BASEROW_TOKEN}`,
      'content-type': 'application/json',
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { error: 'Invalid upstream response' };
  }

  if (!response.ok) {
    console.error('Baserow request failed', response.status);
    return json({ error: 'Upstream request failed' }, 502);
  }

  return { response, body };
}

function asText(value, max = 1000) {
  return String(value ?? '').trim().slice(0, max);
}

function asNumber(value, min = 0, max = 1_000_000) {
  const number = Number(value);
  return Number.isFinite(number) && number >= min && number <= max ? number : null;
}

function isValidPhone(value) {
  return /^[0-9+()\-\s]{8,20}$/.test(String(value || ''));
}

function isValidEmail(value) {
  if (!value) return true;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value));
}

function publicProductRow(row) {
  const fields = { ...(row || {}) };
  for (const key of Object.keys(fields)) {
    const normalized = key.toLowerCase();
    if (/(token|secret|password|api[_ -]?key|email|phone|address|customer|client)/.test(normalized)) {
      delete fields[key];
    }
  }
  return { ...fields, id: row.id };
}

async function parseBody(request) {
  const contentLength = Number(request.headers.get('content-length') || 0);
  if (contentLength > 50_000) throw new Error('Payload too large');
  const body = await request.json();
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Invalid JSON body');
  return body;
}

async function verifyTurnstile(request, env, body) {
  if (!env.TURNSTILE_SECRET) return true;
  const token = request.headers.get('X-Turnstile-Token') || body.turnstileToken;
  if (!token) return false;

  const form = new FormData();
  form.append('secret', env.TURNSTILE_SECRET);
  form.append('response', token);
  form.append('remoteip', request.headers.get('CF-Connecting-IP') || '');

  const result = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    body: form,
  });
  const data = await result.json();
  return data.success === true;
}

async function handleProducts(request, env, url) {
  const result = await baserow(request, env, PRODUCT_TABLE, {
    query: '?user_field_names=true&size=200',
  });
  if (result instanceof Response) return result;

  const rows = Array.isArray(result.body.results)
    ? result.body.results.map(publicProductRow)
    : [];
  return json({ ...result.body, results: rows }, 200, corsHeaders(request, env));
}

async function handleProduct(request, env, url, rowId) {
  if (request.method !== 'GET') {
    return json({ error: 'Inventory mutations are disabled on the public website' }, 403, corsHeaders(request, env));
  }
  const result = await baserow(request, env, PRODUCT_TABLE, {
    rowId,
    query: '?user_field_names=true',
  });
  if (result instanceof Response) return result;
  return json(publicProductRow(result.body), 200, corsHeaders(request, env));
}

async function handleWeightUpdate(request, env, rowId) {
  const body = await parseBody(request);
  if (!(await verifyTurnstile(request, env, body))) return json({ error: 'Verification required' }, 403, corsHeaders(request, env));
  const raw = body.available_weights;
  const weights = Array.isArray(raw)
    ? raw.map(Number).filter((value) => Number.isFinite(value) && value > 0 && value <= 100)
    : [];
  if (!rowId || weights.length > 100 || (raw !== undefined && !Array.isArray(raw))) {
    return json({ error: 'Invalid weight update' }, 400, corsHeaders(request, env));
  }
  const result = await baserow(request, env, PRODUCT_TABLE, {
    rowId,
    method: 'PATCH',
    body: { available_weights: JSON.stringify(weights) },
  });
  if (result instanceof Response) return result;
  return json({ success: true }, 200, corsHeaders(request, env));
}

async function handleCreateOrder(request, env) {
  const body = await parseBody(request);
  if (!(await verifyTurnstile(request, env, body))) return json({ error: 'Verification required' }, 403, corsHeaders(request, env));
  if (body._hp) return new Response(null, { status: 204, headers: corsHeaders(request, env) });

  const fullName = asText(body['الاسم الكامل'] || body.fullName, 100);
  const phone = asText(body['رقم الهاتف'] || body.phone, 30);
  const address = asText(body['العنوان'] || body.address, 300);
  const neighborhood = asText(body['الحي'] || body.neighborhood, 100);
  const products = asText(body['تفاصيل المنتجات'] || body.products, 5_000);
  const total = asNumber(body['المجموع الكلي'] ?? body.total, 0, 100_000);

  if (fullName.length < 2 || address.length < 5 || !isValidPhone(phone) || total === null) {
    return json({ error: 'Invalid order data' }, 400, corsHeaders(request, env));
  }

  const payload = {
    'الاسم الكامل': fullName,
    'رقم الهاتف': phone,
    'العنوان': address,
    'الحي': neighborhood,
    'وقت التوصيل المقترح': asText(body['وقت التوصيل المقترح'] || body.deliveryTime, 100),
    'تفاصيل المنتجات': products,
    'المجموع الفرعي': asNumber(body['المجموع الفرعي'] ?? body.subtotal) ?? 0,
    'رسوم التوصيل': asNumber(body['رسوم التوصيل'] ?? body.deliveryFee) ?? 0,
    'المجموع الكلي': total,
    'تاريخ الطلب': new Date().toISOString(),
    'UTC': new Date().toISOString(),
    'حالة الطلب': 'جديد',
    'ملاحظات': asText(body['ملاحظات'] || body.notes, 500),
  };

  const result = await baserow(request, env, ORDERS_TABLE, { method: 'POST', body: payload });
  if (result instanceof Response) return result;
  return json({ success: true, orderId: result.body.id }, 201, corsHeaders(request, env));
}

async function handleSoldProduct(request, env) {
  const body = await parseBody(request);
  if (!(await verifyTurnstile(request, env, body))) return json({ error: 'Verification required' }, 403, corsHeaders(request, env));
  const payload = {
    'اسم المنتج': asText(body['اسم المنتج'] || body.productName, 200),
    'الكمية': asNumber(body['الكمية'] ?? body.quantity, 0, 10_000) ?? 0,
    'الوحدة': asText(body['الوحدة'] || body.unit, 40),
    'السعر': asNumber(body['السعر'] ?? body.price, 0, 100_000) ?? 0,
    'تاريخ البيع': new Date().toISOString().slice(0, 10),
    'رقم الطلب': asText(body['رقم الطلب'] || body.orderReference, 100),
    'معرف العميل': asText(body['معرف العميل'] || body.clientId, 100),
  };
  if (!payload['اسم المنتج']) return json({ error: 'Invalid sold product' }, 400, corsHeaders(request, env));

  const result = await baserow(request, env, SOLD_PRODUCTS_TABLE, { method: 'POST', body: payload });
  if (result instanceof Response) return result;
  return json({ success: true, id: result.body.id }, 201, corsHeaders(request, env));
}

async function handleContactLegacy(request, env) {
  const body = await parseBody(request);
  if (!(await verifyTurnstile(request, env, body))) return json({ error: 'Verification required' }, 403, corsHeaders(request, env));
  if (body._hp) return new Response(null, { status: 204, headers: corsHeaders(request, env) });
  const name = asText(body['Nom Complet'] || body.name, 100);
  const phone = asText(body['Téléphone'] || body.phone, 30);
  const email = asText(body.Email || body.email, 160);
  const message = asText(body.Message || body.message, 3_000);
  if (name.length < 2 || message.length < 10 || !isValidEmail(email) || !isValidPhone(phone)) {
    return json({ error: 'Invalid contact data' }, 400, corsHeaders(request, env));
  }
  const payload = {
    'Nom Complet': name,
    'Téléphone': phone,
    'Email': email,
    'Sujet': asText(body.Sujet || body.subject, 160),
    'Message': message,
    'Newsletter': Boolean(body.Newsletter || body.newsletter),
    'Statut': 'جديد',
    'Date de Soumission': new Date().toISOString(),
  };
  const result = await baserow(request, env, BANNER_TABLE, { method: 'POST', body: payload });
  if (result instanceof Response) return result;
  return json({ success: true, id: result.body.id }, 201, corsHeaders(request, env));
}

async function handleContact(request, env) {
  const body = await parseBody(request);
  if (!(await verifyTurnstile(request, env, body))) return json({ error: 'Verification required' }, 403, corsHeaders(request, env));
  if (body._hp) return new Response(null, { status: 204, headers: corsHeaders(request, env) });

  const email = asText(body.Email || body.email, 160);
  const phone = asText(body['Téléphone'] || body.phone, 30);
  const message = asText(body.Message || body.message, 3_000);
  if (!asText(body['Nom Complet'] || body.name, 100) || message.length < 10 || !isValidEmail(email) || (phone && !isValidPhone(phone))) {
    return json({ error: 'Invalid contact data' }, 400, corsHeaders(request, env));
  }

  const payload = {
    'Nom Complet': asText(body['Nom Complet'] || body.name, 100),
    'Téléphone': phone,
    'Email': email,
    'Sujet': asText(body.Sujet || body.subject, 160),
    'Message': message,
    'Newsletter': Boolean(body.Newsletter || body.newsletter),
    'Statut': 'جديد',
    'Date de Soumission': new Date().toISOString(),
  };

  const result = await baserow(request, env, CONTACT_TABLE, { method: 'POST', body: payload });
  if (result instanceof Response) return result;
  return json({ success: true, id: result.body.id }, 201, corsHeaders(request, env));
}

async function handleBanners(request, env, url) {
  const result = await baserow(request, env, BANNER_TABLE, {
    query: '?user_field_names=true&size=50',
  });
  if (result instanceof Response) return result;
  return json(result.body, 200, corsHeaders(request, env));
}

async function router(request, env) {
  const url = new URL(request.url);
  if (request.method === 'OPTIONS') {
    if (!isAllowedRequest(request, env)) return json({ error: 'Origin not allowed' }, 403);
    return new Response(null, { status: 204, headers: corsHeaders(request, env) });
  }

  if (!isAllowedRequest(request, env)) return json({ error: 'Origin not allowed' }, 403);
  if (!rateLimit(request, env)) return json({ error: 'Too many requests' }, 429, corsHeaders(request, env));

  if (url.pathname === '/api/products' && request.method === 'GET') return handleProducts(request, env, url);
  if (url.pathname.startsWith('/api/products/') && request.method === 'GET') return handleProduct(request, env, url, url.pathname.split('/').pop());
  if (url.pathname === '/api/orders' && request.method === 'POST') return handleCreateOrder(request, env);
  if (url.pathname === '/api/sold-products' && request.method === 'POST') return handleSoldProduct(request, env);
  if (url.pathname === '/api/contact' && request.method === 'POST') return handleContact(request, env);
  if (url.pathname === '/api/contact-legacy' && request.method === 'POST') return handleContactLegacy(request, env);
  if (url.pathname === '/api/banners' && request.method === 'GET') return handleBanners(request, env, url);
  if (url.pathname.startsWith('/api/products/') && url.pathname.endsWith('/weights') && request.method === 'PATCH') {
    const parts = url.pathname.split('/');
    return handleWeightUpdate(request, env, parts[3]);
  }

  return json({ error: 'Not found' }, 404, corsHeaders(request, env));
}

export default {
  async fetch(request, env) {
    try {
      return await router(request, env);
    } catch (error) {
      console.error('Unhandled request error', error.message);
      return json({ error: 'Internal server error' }, 500, corsHeaders(request, env));
    }
  },
};
