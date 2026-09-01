/* Логика приложения.
 *
 * Откуда берётся файл расписания (по порядку, пока не получится):
 *   1) свежий ключ со страницы техникума — его достаёт Cloudflare Worker
 *      (ссылка на сайте ККСТ меняется каждый день!);
 *   2) последний рабочий ключ из localStorage;
 *   3) резервный ключ из config.js;
 *   4) если всё умерло — форма «вставьте ссылку вручную».
 *
 * Отправка в чат идёт через воркер: токен бота в браузер не попадает.
 */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const tg = window.Telegram && window.Telegram.WebApp &&
             window.Telegram.WebApp.initData !== undefined ? window.Telegram.WebApp : null;
  const inTelegram = !!(tg && tg.initDataUnsafe && tg.initDataUnsafe.user);
  const WORKER = (window.CONFIG.WORKER_URL || "").replace(/\/+$/, "");

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

  /* ------------------- получение файла: цепочка ключей ------------------- */

  async function fetchFreshKeyFromWorker() {
    if (!WORKER) return null;
    try {
      const r = await fetch(WORKER + "/key", { signal: AbortSignal.timeout(15000) });
      const j = await r.json();
      return j.ok && j.key ? j.key : null;
    } catch (e) { return null; }
  }

  async function tryDownload(key) {
    // 1) пробуем напрямую с Яндекс.Диска (быстрее)
    try {
      const api = "https://cloud-api.yandex.net/v1/disk/public/resources/download?public_key=" +
                  encodeURIComponent(key);
      const meta = await (await fetch(api)).json();
      if (!meta.href) throw new Error(meta.description || "нет ссылки");
      const resp = await fetch(meta.href);
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      return await resp.arrayBuffer();
    } catch (direct) {
      // 2) не вышло (webview/антивирус режет запросы к Яндексу) —
      //    качаем через воркер
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

  async function fetchXlsx() {
    const tried = new Set();
    const chain = [];
    const fresh = await fetchFreshKeyFromWorker();
    if (fresh) chain.push(["сайт техникума", fresh]);
    const last = lsGet("lastGoodKey");
    if (last) chain.push(["предыдущая рабочая ссылка", last]);
    chain.push(["резервная ссылка", window.CONFIG.FALLBACK_PUBLIC_KEY]);

    let lastErr = null;
    for (const [label, key] of chain) {
      if (!key || tried.has(key)) continue;
      tried.add(key);
      try {
        const buf = await tryDownload(key);
        lsSet("lastGoodKey", key);
        return { buf, source: label };
      } catch (e) { lastErr = e; }
    }
    // 3) последний автоматический шанс: воркер сам найдёт ключ и отдаст файл
    if (WORKER) {
      try {
        const r = await fetch(WORKER + "/file");
        if (r.ok) return { buf: await r.arrayBuffer(), source: "воркер" };
      } catch (e) { lastErr = e; }
    }
    throw new Error("не удалось скачать файл ни по одной ссылке" +
                    (lastErr ? " (" + lastErr.message + ")" : ""));
  }

  /* -------- ручной ввод ссылки (когда все автоматические пути умерли) ---- */

  function extractKeyFromLink(href) {
    let dec;
    try { dec = decodeURIComponent(href); } catch (e) { dec = href; }
    const i = dec.indexOf("ya-disk-public://");
    if (i >= 0) return dec.slice(i + "ya-disk-public://".length).split("&")[0];
    if (/disk\.yandex\./.test(dec)) return dec.split("?")[0];
    return null;
  }

  async function applyManualLink() {
    const href = $("manuallink").value.trim();
    const key = extractKeyFromLink(href);
    if (!key) { setStatus("Не похоже на ссылку Яндекс.Диска/Доков", true); return; }
    setStatus("Проверяю ссылку…");
    try {
      const buf = await tryDownload(key);
      lsSet("lastGoodKey", key);
      $("linkfix").style.display = "none";
      afterLoad(buf, "ссылка вручную");
    } catch (e) {
      setStatus("По этой ссылке скачать не удалось: " + e.message, true);
    }
  }

  /* ----------------------------- загрузка -------------------------------- */

  function afterLoad(buf, source) {
    parsed = RaspParser.parseWorkbook(XLSX, buf);
    $("grouplist").innerHTML = parsed.all_groups
      .map((g) => `<option value="${g}">`).join("");
    const seen = {}, chips = [];
    for (const g of parsed.all_groups) {
      const p = g.split("-")[0];
      if (!seen[p]) { seen[p] = 1; chips.push(g); }
    }
    $("chips").innerHTML = chips.map((g) => `<span class="chip">${g}</span>`).join("");
    document.querySelectorAll(".chip").forEach((c) => {
      c.onclick = () => { $("group").value = c.textContent; show(); };
    });
    setStatus(`Групп: ${parsed.all_groups.length} (источник: ${source}). ` +
              parsed.days.map((d) => d.title).join(" • "));
  }

  async function loadData(force) {
    setStatus(force ? "Ищу свежую ссылку и скачиваю файл…" : "Загружаю расписание…");
    try {
      const { buf, source } = await fetchXlsx();
      afterLoad(buf, source);
      return true;
    } catch (e) {
      setStatus("Не удалось загрузить расписание: " + e.message, true);
      $("linkfix").style.display = "flex";   // последний шанс — ручная ссылка
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
    const days = parsed.days.map((d) => ({
      title: d.title, date: d.date, lessons: d.groups[group] || [],
    }));
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
      fd.append("initData", tg.initData);   // подпись проверит воркер
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
      setStatus("Не удалось отправить: " + e.message +
        ". Убедитесь, что вы нажали Start у бота.", true);
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
