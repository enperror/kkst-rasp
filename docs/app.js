/* Логика приложения v2 — поддержка Яндекс.Диск + Google Drive/Docs/Sheets
 *
 * Источник файла (по порядку, пока не получится):
 *   1) свежий source со страницы техникума — его достаёт Cloudflare Worker
 *      (поддерживает как yandex, так и google ссылки);
 *   2) последний рабочий source из localStorage;
 *   3) резервный ключ из config.js (yandex);
 *   4) если всё умерло — форма «вставьте ссылку вручную» (принимает и yandex, и google).
 *
 * Скачивание:
 *   - yandex: пробуем напрямую cloud-api.yandex.net, иначе через воркер /file?key=
 *   - google: всегда через воркер /file?url= (обход CORS), при ошибке пробуем прямой export url
 */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const tg = window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.initData !== undefined ? window.Telegram.WebApp : null;
  const inTelegram = !!(tg && tg.initDataUnsafe && tg.initDataUnsafe.user);
  const WORKER = (window.CONFIG.WORKER_URL || "").replace(/\/+$/, "");
  const FALLBACK_KEY = window.CONFIG.FALLBACK_PUBLIC_KEY || "";

  if (tg) { try { tg.ready(); tg.expand(); } catch (e) {} }

  let parsed = null;
  let lastGroup = null;
  let lastBlob = null;

  function setStatus(msg, err) {
    $("status").textContent = msg || "";
    $("status").className = err ? "err" : "";
  }

  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }

  /* ------------------- утилиты для Google / Yandex ------------------- */

  function googleIdFromUrl(href) {
    try { href = decodeURIComponent(href); } catch (e) {}
    let m = href.match(/drive\.google\.com\/(?:file\/d\/|open\?id=)([a-zA-Z0-9_-]{10,})/);
    if (m) return { provider: "drive", id: m[1], type: "google" };
    m = href.match(/drive\.google\.com\/uc\?.*?[&?]id=([a-zA-Z0-9_-]{10,})/);
    if (m) return { provider: "drive", id: m[1], type: "google" };
    m = href.match(/docs\.google\.com\/(?:document|spreadsheets|presentation)\/d\/([a-zA-Z0-9_-]{10,})/);
    if (m) {
      let prov = "docs";
      if (/spreadsheets/i.test(href)) prov = "sheets";
      else if (/presentation/i.test(href)) prov = "slides";
      return { provider: prov, id: m[1], type: "google" };
    }
    // прямой export
    if (/docs\.google\.com\/.*\/export\?format=/i.test(href) || /drive\.google\.com\/uc\?export=download/i.test(href)) {
      return { provider: "drive", id: null, type: "google", url: href };
    }
    return null;
  }

  function extractSourceFromLink(href) {
    if (!href) return null;
    let dec;
    try { dec = decodeURIComponent(href); } catch (e) { dec = href; }
    // yandex: ya-disk-public://
    let i = dec.indexOf("ya-disk-public://");
    if (i >= 0) {
      let tail = dec.slice(i + "ya-disk-public://".length).split("&")[0];
      return { type: "yandex", provider: "yandex", key: tail, url: href };
    }
    if (/disk\.yandex\./i.test(dec)) {
      let key = dec.split("?")[0];
      return { type: "yandex", provider: "yandex", key, url: href };
    }
    // google
    let g = googleIdFromUrl(href);
    if (g) {
      // пытаемся построить exportUrl
      let exportUrl = href;
      if (g.id && !/export\?format=/i.test(href) && !/uc\?export=download/i.test(href)) {
        if (g.provider === "drive") exportUrl = "https://drive.google.com/uc?export=download&id=" + g.id;
        else if (g.provider === "sheets") exportUrl = "https://docs.google.com/spreadsheets/d/" + g.id + "/export?format=xlsx";
      }
      return { type: "google", provider: g.provider, id: g.id, url: href, exportUrl };
    }
    return null;
  }

  function sourceLabel(s) {
    if (!s) return "неизвестный источник";
    if (s.type === "yandex") return "Яндекс.Диск";
    if (s.type === "google") {
      if (s.provider === "drive") return "Google Drive";
      if (s.provider === "sheets") return "Google Sheets";
      return "Google Документы";
    }
    return s.type;
  }

  /* ------------------- получение свежего source с воркера ------------------- */

  async function fetchFreshSourceFromWorker() {
    if (!WORKER) return null;
    try {
      const r = await fetch(WORKER + "/key", { signal: AbortSignal.timeout(15000) });
      const j = await r.json();
      // Новый формат: j.source = {type, url, ...}
      if (j.source) return j.source;
      // Совместимость со старым: j.key — yandex ключ
      if (j.ok && j.key) return { type: "yandex", provider: "yandex", key: j.key, url: j.key };
      // Некоторые воркеры отдают type/url отдельно
      if (j.url) return j;
      return null;
    } catch (e) { return null; }
  }

  /* ------------------- скачивание файла ------------------- */

  async function tryDownload(source) {
    if (!source || !source.type) throw new Error("пустой источник");

    if (source.type === "yandex") {
      const key = source.key;
      // 1) напрямую с Яндекс.Диска
      try {
        const api = "https://cloud-api.yandex.net/v1/disk/public/resources/download?public_key=" + encodeURIComponent(key);
        const meta = await (await fetch(api)).json();
        if (!meta.href) throw new Error(meta.description || "нет ссылки");
        const resp = await fetch(meta.href);
        if (!resp.ok) throw new Error("HTTP " + resp.status);
        return await resp.arrayBuffer();
      } catch (direct) {
        // 2) через воркер
        if (!WORKER) throw direct;
        const r = await fetch(WORKER + "/file?key=" + encodeURIComponent(key));
        if (!r.ok) {
          let msg = "HTTP " + r.status;
          try { msg = (await r.json()).error || msg; } catch (e) {}
          throw new Error(msg);
        }
        return await r.arrayBuffer();
      }
    }

    if (source.type === "google") {
      // Google всегда через воркер (обход CORS)
      if (WORKER) {
        try {
          // Воркер понимает ?url=, ?id=, ?exportUrl=
          const q = source.url ? "?url=" + encodeURIComponent(source.url) : (source.exportUrl ? "?exportUrl=" + encodeURIComponent(source.exportUrl) : "?id=" + encodeURIComponent(source.id || ""));
          const r = await fetch(WORKER + "/file" + q);
          if (!r.ok) {
            let msg = "HTTP " + r.status;
            try { const j = await r.json(); msg = j.error || msg; } catch (e) {}
            throw new Error(msg);
          }
          // воркер отдаёт файл напрямую (xlsx)
          return await r.arrayBuffer();
        } catch (workerErr) {
          // fallback: пробуем прямой export (может сработать если CORS открыт, редко)
          if (source.exportUrl) {
            try {
              const resp = await fetch(source.exportUrl);
              if (resp.ok) return await resp.arrayBuffer();
            } catch (e) {}
          }
          throw workerErr;
        }
      } else {
        // без воркера — только прямой export (скорее всего CORS не даст)
        const url = source.exportUrl || source.url;
        const resp = await fetch(url);
        if (!resp.ok) throw new Error("HTTP " + resp.status);
        return await resp.arrayBuffer();
      }
    }

    throw new Error("неизвестный тип источника: " + source.type);
  }

  async function fetchXlsx() {
    const tried = new Set();
    const chain = [];

    // 1) свежий с воркера
    const fresh = await fetchFreshSourceFromWorker();
    if (fresh) chain.push(["сайт техникума (" + sourceLabel(fresh) + ")", fresh]);

    // 2) последний рабочий из localStorage (v2: JSON, v1: просто ключ)
    const lastRaw = lsGet("lastGoodSource") || lsGet("lastGoodKey");
    if (lastRaw) {
      try {
        let src;
        if (lastRaw.trim().startsWith("{")) src = JSON.parse(lastRaw);
        else src = { type: "yandex", provider: "yandex", key: lastRaw, url: lastRaw }; // миграция v1
        if (src && src.type) chain.push(["предыдущая рабочая ссылка (" + sourceLabel(src) + ")", src]);
      } catch (e) {}
    }

    // 3) резервный из config.js (yandex)
    if (FALLBACK_KEY) {
      chain.push(["резервная ссылка (Яндекс)", { type: "yandex", provider: "yandex", key: FALLBACK_KEY, url: FALLBACK_KEY }]);
    }

    let lastErr = null;
    for (const [label, src] of chain) {
      const id = src.key || src.url || src.exportUrl || JSON.stringify(src);
      if (!id || tried.has(id)) continue;
      tried.add(id);
      try {
        const buf = await tryDownload(src);
        // сохраняем как JSON для v2
        try { lsSet("lastGoodSource", JSON.stringify(src)); } catch (e) {}
        return { buf, source: label };
      } catch (e) { lastErr = e; console.warn("tryDownload failed", label, e); }
    }

    // 4) последний шанс: воркер сам найдёт и отдаст файл (/file без параметров)
    if (WORKER) {
      try {
        const r = await fetch(WORKER + "/file");
        if (r.ok && (r.headers.get("Content-Type") || "").includes("json") === false) {
          // воркер вернул файл
          return { buf: await r.arrayBuffer(), source: "воркер (авто)" };
        } else if (r.ok) {
          // воркер вернул json ошибку
          const j = await r.json().catch(() => null);
          if (j) throw new Error(j.error || "воркер не нашёл файл");
        }
      } catch (e) { lastErr = e; }
    }

    throw new Error("не удалось скачать файл ни по одной ссылке" + (lastErr ? " (" + lastErr.message + ")" : ""));
  }

  /* -------- ручной ввод ссылки (когда все автоматические пути умерли) ---- */

  async function applyManualLink() {
    const href = $("manuallink").value.trim();
    const src = extractSourceFromLink(href);
    if (!src) {
      setStatus("Не похоже на ссылку Яндекс.Диска или Google Drive/Docs. Пример: https://drive.google.com/file/d/... или https://disk.yandex.ru/d/...", true);
      return;
    }
    setStatus("Проверяю ссылку (" + sourceLabel(src) + ")…");
    try {
      const buf = await tryDownload(src);
      lsSet("lastGoodSource", JSON.stringify(src));
      // также сохраняем отдельно для совместимости
      if (src.key) lsSet("lastGoodKey", src.key);
      $("linkfix").style.display = "none";
      afterLoad(buf, "ссылка вручную (" + sourceLabel(src) + ")");
    } catch (e) {
      setStatus("По этой ссылке скачать не удалось: " + e.message, true);
    }
  }

  /* ----------------------------- загрузка -------------------------------- */

  function afterLoad(buf, source) {
    try {
      parsed = RaspParser.parseWorkbook(XLSX, buf);
    } catch (e) {
      setStatus("Файл скачан (" + source + "), но не удалось распарсить xlsx: " + e.message + ". Возможно техникум выложил Google Документ в формате HTML, а не Excel — откройте ссылку вручную и проверьте, что это .xlsx", true);
      console.error(e);
      return;
    }
    $("grouplist").innerHTML = parsed.all_groups.map((g) => `<option value="${g}">`).join("");
    const seen = {}, chips = [];
    for (const g of parsed.all_groups) {
      const p = g.split("-")[0];
      if (!seen[p]) { seen[p] = 1; chips.push(g); }
    }
    $("chips").innerHTML = chips.map((g) => `<span class="chip">${g}</span>`).join("");
    document.querySelectorAll(".chip").forEach((c) => {
      c.onclick = () => { $("group").value = c.textContent; show(); };
    });
    setStatus(`Групп: ${parsed.all_groups.length} (источник: ${source}). ` + parsed.days.map((d) => d.title).join(" • "));
  }

  async function loadData(force) {
    setStatus(force ? "Ищу свежую ссылку и скачиваю файл…" : "Загружаю расписание…");
    try {
      const { buf, source } = await fetchXlsx();
      afterLoad(buf, source);
      return true;
    } catch (e) {
      setStatus("Не удалось загрузить расписание: " + e.message, true);
      $("linkfix").style.display = "flex";
      return false;
    }
  }

  /* ------------------------------ показ ---------------------------------- */

  function show() {
    if (!parsed) { setStatus("Данные ещё не загружены", true); return; }
    const q = $("group").value.trim();
    if (!q) { setStatus("Введите группу", true); return; }
    const group = RaspParser.findGroup(parsed, q);
    if (!group) {
      setStatus(`Группа «${q}» не найдена. Проверьте название, например ВВ-241`, true);
      $("img").style.display = "none";
      $("send").style.display = "none";
      $("dl").style.display = "none";
      return;
    }
    const days = parsed.days.map((d) => ({ title: d.title, date: d.date, lessons: d.groups[group] || [] }));
    const canvas = RaspRender.render(group, days, $("cv"));
    lastGroup = group;
    canvas.toBlob((blob) => {
      lastBlob = blob;
      const url = URL.createObjectURL(blob);
      const img = $("img");
      img.src = url;
      img.style.display = "inline";
      const dl = $("dl");
      dl.href = url;
      dl.download = "raspisanie_" + group + ".png";
      dl.style.display = "inline-block";
      if (inTelegram && WORKER) $("send").style.display = "inline-block";
      setStatus("");
      lsSet("lastGroup", group);
    }, "image/png");
  }

  /* --------------------------- отправка в чат ---------------------------- */

  async function sendToChat() {
    if (!lastBlob || !inTelegram || !WORKER) return;
    const btn = $("send");
    btn.disabled = true;
    btn.textContent = "Отправляю…";
    try {
      const fd = new FormData();
      fd.append("initData", tg.initData);
      fd.append("photo", lastBlob, "raspisanie_" + lastGroup + ".png");
      fd.append("caption", "Расписание " + lastGroup);
      const r = await fetch(WORKER + "/send", { method: "POST", body: fd });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || "ошибка воркера");
      btn.textContent = "Отправлено ✓";
      try { tg.HapticFeedback.notificationOccurred("success"); } catch (e) {}
      setTimeout(() => { try { tg.close(); } catch (e) {} }, 700);
    } catch (e) {
      btn.disabled = false;
      btn.textContent = "📤 Отправить в чат";
      setStatus("Не удалось отправить: " + e.message + ". Убедитесь, что вы нажали Start у бота.", true);
    }
  }

  /* ------------------------------ события -------------------------------- */

  $("go").onclick = show;
  $("send").onclick = sendToChat;
  $("linkgo").onclick = applyManualLink;
  $("refresh").onclick = async () => {
    if (await loadData(true) && $("group").value.trim()) show();
  };
  $("group").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.target.blur(); show(); }
  });

  loadData(false).then((ok) => {
    const g = lsGet("lastGroup");
    if (ok && g && parsed) { $("group").value = g; show(); }
  });
})();
