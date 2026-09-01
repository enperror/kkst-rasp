/**
 * Cloudflare Worker для мини-аппа «Расписание ККСТ».
 *
 * Задачи:
 *   GET  /key   — зайти на сайт техникума, найти ссылку «Расписание занятий
 *                 на текущую дату» и вернуть публичный ключ Яндекс.Диска
 *                 (ссылка на сайте меняется каждый день!)
 *   POST /send  — отправить PNG в чат пользователю через Bot API.
 *                 Токен бота хранится ТОЛЬКО здесь (секрет BOT_TOKEN),
 *                 в публичном коде на GitHub Pages его нет.
 *                 Подпись initData Telegram проверяется — чужой сайт
 *                 не сможет рассылать от имени бота.
 *
 * Деплой (бесплатно):
 *   1. dash.cloudflare.com → Workers & Pages → Create → Worker
 *   2. вставить этот файл, Deploy
 *   3. Settings → Variables and Secrets → Add:
 *        BOT_TOKEN  (тип Secret)  = токен из @BotFather
 *      (опционально) ALLOWED_ORIGIN = https://логин.github.io
 *   4. скопировать URL воркера (https://имя.логин.workers.dev)
 *      в docs/config.js → WORKER_URL
 */

const SITE_URL = "https://kkst.kemobl.ru/studentam/raspisanie/";
const LINK_TEXT_RE = /расписание\s+занятий\s+на\s+текущую\s+дату/i;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = env.ALLOWED_ORIGIN || "*";
    const cors = {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") return new Response(null, { headers: cors });

    try {
      if (url.pathname === "/key") {
        const key = await findPublicKey();
        return json({ ok: !!key, key }, cors, key ? 200 : 502);
      }
      if (url.pathname === "/send" && request.method === "POST") {
        return await handleSend(request, env, cors);
      }
      return json({ ok: true, service: "kkst-rasp", endpoints: ["/key", "/send"] }, cors);
    } catch (e) {
      return json({ ok: false, error: String(e && e.message || e) }, cors, 500);
    }
  },
};

function json(obj, cors, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...cors },
  });
}

/* ------------------------------ /key ------------------------------------ */

async function findPublicKey() {
  let html = null;
  for (const u of [SITE_URL, SITE_URL.replace("https://", "http://")]) {
    try {
      const r = await fetch(u, {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
        cf: { cacheTtl: 600, cacheEverything: true },
      });
      if (r.ok) { html = await r.text(); break; }
    } catch (e) { /* сайт геоблокирует зарубежные IP — пробуем дальше */ }
  }
  if (!html) return null;

  // <a href="...">Расписание занятий на текущую дату</a>
  const links = [...html.matchAll(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)];
  for (const [, href, inner] of links) {
    const text = inner.replace(/<[^>]+>/g, " ");
    if (LINK_TEXT_RE.test(text)) {
      const key = publicKeyFromUrl(href);
      if (key) return key;
    }
  }
  // запасной вариант: первая дисковая ссылка на странице
  const m = html.match(/href="(https:\/\/(?:docs|disk)\.yandex\.[a-z.]+\/[^"]+)"/i);
  return m ? publicKeyFromUrl(m[1]) : null;
}

function publicKeyFromUrl(href) {
  href = decodeHtml(href);
  let dec;
  try { dec = decodeURIComponent(href); } catch (e) { dec = href; }
  const i = dec.indexOf("ya-disk-public://");
  if (i >= 0) {
    // docs.yandex.ru/docs/view?url=ya-disk-public://<ключ>&name=...
    let tail = dec.slice(i + "ya-disk-public://".length);
    return tail.split("&")[0];
  }
  if (/disk\.yandex\./.test(dec)) return dec.split("?")[0];
  return null;
}

function decodeHtml(s) {
  return s.replace(/&amp;/g, "&").replace(/&quot;/g, '"')
          .replace(/&#0?39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

/* ------------------------------ /send ----------------------------------- */

async function handleSend(request, env, cors) {
  if (!env.BOT_TOKEN) return json({ ok: false, error: "BOT_TOKEN не настроен" }, cors, 500);

  const form = await request.formData();
  const initData = form.get("initData");
  const photo = form.get("photo");
  const caption = String(form.get("caption") || "").slice(0, 1024);

  if (!initData || !photo) return json({ ok: false, error: "нет initData или photo" }, cors, 400);
  if (photo.size > 9 * 1024 * 1024) return json({ ok: false, error: "файл слишком большой" }, cors, 400);

  // проверка подписи Telegram — chat_id берём из ПОДПИСАННЫХ данных
  const user = await validateInitData(String(initData), env.BOT_TOKEN);
  if (!user || !user.id) return json({ ok: false, error: "подпись initData неверна" }, cors, 403);

  const tgForm = new FormData();
  tgForm.append("chat_id", String(user.id));
  tgForm.append("photo", photo, "raspisanie.png");
  if (caption) tgForm.append("caption", caption);

  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendPhoto`, {
    method: "POST",
    body: tgForm,
  });
  const res = await r.json();
  return json({ ok: !!res.ok, error: res.ok ? undefined : res.description }, cors, res.ok ? 200 : 502);
}

// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
async function validateInitData(initData, botToken) {
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return null;
  params.delete("hash");
  const pairs = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort();
  const dataCheckString = pairs.join("\n");

  const enc = new TextEncoder();
  const k1 = await crypto.subtle.importKey(
    "raw", enc.encode("WebAppData"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const secret = await crypto.subtle.sign("HMAC", k1, enc.encode(botToken));
  const k2 = await crypto.subtle.importKey(
    "raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k2, enc.encode(dataCheckString));
  const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
  if (hex !== hash) return null;

  // не старше суток
  const authDate = Number(params.get("auth_date") || 0);
  if (authDate && Date.now() / 1000 - authDate > 86400) return null;

  try { return JSON.parse(params.get("user") || "null"); } catch (e) { return null; }
}
