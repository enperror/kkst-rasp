/* KKCT schedule UI
 * Экранное расписание и список групп — HTML/CSS; canvas используется только для PNG и отправки в Telegram.
 */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const tg = window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.initData !== undefined ? window.Telegram.WebApp : null;
  const inTelegram = !!(tg && tg.initDataUnsafe && tg.initDataUnsafe.user);
  const WORKER = (window.CONFIG.WORKER_URL || "").replace(/\/+$/, "");
  const FALLBACK_KEY = window.CONFIG.FALLBACK_PUBLIC_KEY || "";
  const FALLBACK_GOOGLE = window.CONFIG.FALLBACK_GOOGLE_URL || "";

  if (tg) { try { tg.ready(); tg.expand(); } catch (e) {} }

  let parsed = null;
  let activeGroup = null;
  let activeTeacher = null;
  let viewMode = "group-picker";
  let teacherReturnContext = null;
  let activeDayIndex = 0;
  let rosterPanelOpen = false;
  let rosterEditorOpen = false;
  let currentNoteContext = null;
  let initialFavoriteRestored = false;
  let activeFamilyFilter = "*";
  let lastGroup = null;
  let lastBlob = null;
  let lastImageUrl = null;
  let canvasRequestId = 0;
  let teacherCatalogCache = null;
  let activityContext = null;

  function hideNotesPage(){
    const screen=$("notes-screen");if(screen) screen.hidden=true;
  }
  function setStatus(msg, err) {
    const el = $("status");
    if (!el) return;
    el.textContent = msg || "";
    el.className = err ? "err" : "";
  }
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function esc(s){ return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
  function readStoredObject(key){
    try{ const value=JSON.parse(lsGet(key)||"{}"); return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }
    catch(e){ return {}; }
  }
  function writeStoredObject(key,value){ lsSet(key,JSON.stringify(value)); }
  function localDateKey(date=new Date()){
    return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,"0")}-${String(date.getDate()).padStart(2,"0")}`;
  }
  function displayLocalDate(date=new Date()){
    return [String(date.getDate()).padStart(2,"0"),String(date.getMonth()+1).padStart(2,"0"),date.getFullYear()].join(".");
  }
  function getFavorite(){
    const favorite=readStoredObject("kkst-favorite-v1");
    return (favorite.type === "group" || favorite.type === "teacher") && favorite.value ? favorite : null;
  }
  function isFavorite(type,value){
    const favorite=getFavorite();
    return !!favorite && favorite.type===type && (type==="teacher" ? normalizeTeacher(favorite.value)===normalizeTeacher(value) : favorite.value===value);
  }
  function favoriteButtonHtml(type,value){
    const active=isFavorite(type,value);
    return `<button type="button" class="favorite-button${active?" is-favorite":""}" data-favorite-type="${esc(type)}" data-favorite-value="${esc(value)}" aria-pressed="${active?"true":"false"}" title="Можно сохранить только одно избранное — новое заменит прежнее"><span class="favorite-star" aria-hidden="true">${active?"★":"☆"}</span><span>${active?"В избранном":"В избранное"}</span></button>`;
  }
  function toggleFavorite(type,value){
    writeStoredObject("kkst-favorite-v1",isFavorite(type,value)?{}:{type,value});
    if(viewMode==="group"||viewMode==="teacher") renderSelectedDay();
  }
  function readRosters(){ return readStoredObject("kkst-rosters-v1"); }
  function getRoster(group){
    const list=readRosters()[group];
    return Array.isArray(list) ? list.filter((student)=>student && student.id && student.name).map((student)=>({id:String(student.id),name:String(student.name)})) : [];
  }
  function newStudentId(){
    try{ if(window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID(); }catch(e){}
    return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,10)}`;
  }
  function normalizeStudentName(name){ return String(name||"").trim().replace(/\s+/g," ").toLocaleLowerCase("ru"); }
  function rosterFromText(text,previous){
    const previousByName=new Map();
    for(const student of previous){
      const key=normalizeStudentName(student.name);
      if(!previousByName.has(key)) previousByName.set(key,[]);
      previousByName.get(key).push(student);
    }
    const result=[];
    for(const raw of String(text||"").split(/\r?\n/)){
      const name=raw.trim().replace(/\s+/g," ");
      if(!name) continue;
      const key=normalizeStudentName(name);
      const existing=previousByName.get(key)?.shift();
      result.push({id:existing?.id||newStudentId(),name});
    }
    return result;
  }
  function getDailyAttendance(){
    const stored=readStoredObject("kkst-attendance-v1");
    const today=localDateKey();
    if(stored.date!==today || !stored.groups || typeof stored.groups!=="object"){
      const fresh={date:today,groups:{}};
      writeStoredObject("kkst-attendance-v1",fresh);
      return fresh;
    }
    return stored;
  }
  function updateStudentAttendance(group,studentId,status,mayCome){
    const daily=getDailyAttendance();
    if(!daily.groups[group]) daily.groups[group]={};
    if(status==="unmarked") delete daily.groups[group][studentId];
    else daily.groups[group][studentId]={status,mayCome:status==="absent" && !!mayCome};
    writeStoredObject("kkst-attendance-v1",daily);
  }
  function scheduleAttendanceRollover(){
    const now=new Date();
    const midnight=new Date(now.getFullYear(),now.getMonth(),now.getDate()+1,0,0,1);
    setTimeout(()=>{
      getDailyAttendance();
      if(rosterPanelOpen && activeGroup) renderRosterPanel();
      scheduleAttendanceRollover();
    },Math.max(1000,midnight.getTime()-now.getTime()));
  }
  function noteKey(group,date,number){ return JSON.stringify([group,date,String(number)]); }
  function readNotes(){ return readStoredObject("kkst-notes-v1"); }
  function getNote(group,date,number){
    const note=readNotes()[noteKey(group,date,number)];
    return note && typeof note.text==="string" ? note.text : "";
  }
  function setNote(group,date,number,text){
    const notes=readNotes();
    const key=noteKey(group,date,number);
    if(String(text||"").trim()) notes[key]={group,date,number:String(number),text:String(text).trim(),updatedAt:Date.now()};
    else delete notes[key];
    writeStoredObject("kkst-notes-v1",notes);
    updateNotesCount();
  }
  function noteEntries(){
    return Object.values(readNotes()).filter((note)=>note && note.group && note.date && note.number && String(note.text||"").trim()).sort((a,b)=>{
      const dateSort=String(b.date).split(".").reverse().join("").localeCompare(String(a.date).split(".").reverse().join(""));
      return dateSort || Number(a.number)-Number(b.number) || String(a.group).localeCompare(String(b.group),"ru");
    });
  }
  function updateNotesCount(){
    const count=$("notes-count");
    if(count) count.textContent=String(noteEntries().length);
  }

  // ----- времена пар (дублируем из render.js для HTML) -----
  const TIMES_WEEKDAY = {
    "1": "8:30–10:00", "2": "10:10–11:40", "3": "12:00–13:30",
    "0": "13:35–14:05",
    "4": "14:10–15:40", "5": "16:00–17:30", "6": "17:40–19:10", "7": "19:20–20:50",
  };
  const TIMES_SATURDAY = {
    "1": "8:30–10:00", "2": "10:05–11:35", "3": "11:55–13:25",
    "4": "13:30–15:00", "5": "15:20–16:50", "6": "16:55–18:25", "7": "18:30–20:00",
  };
  const PAIR_ORDER = ["1", "2", "3", "0", "4", "5", "6", "7"];
  function timesFor(dateStr) {
    if (dateStr) {
      const m = dateStr.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
      if (m) {
        const d = new Date(+m[3], +m[2] - 1, +m[1]);
        if (d.getDay() === 6) return TIMES_SATURDAY;
      }
    }
    return TIMES_WEEKDAY;
  }
  function buildRows(lessons){
    const have={}; for(const l of lessons) have[l.number]=l;
    const present = PAIR_ORDER.filter(n=> n in have);
    if(!present.length) return [];
    const first = PAIR_ORDER.indexOf(present[0]);
    const last = PAIR_ORDER.indexOf(present[present.length-1]);
    const rows=[];
    for(let i=first;i<=last;i++){
      const n=PAIR_ORDER[i];
      if(n in have) rows.push(["lesson", have[n]]);
      else if(n!=="0") rows.push(["window", n]);
    }
    return rows;
  }

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
    if (/docs\.google\.com\/.*\/export\?format=/i.test(href) || /drive\.google\.com\/uc\?export=download/i.test(href)) {
      return { provider: "drive", id: null, type: "google", url: href };
    }
    return null;
  }
  function extractSourceFromLink(href) {
    if (!href) return null;
    let dec; try { dec = decodeURIComponent(href); } catch (e) { dec = href; }
    let i = dec.indexOf("ya-disk-public://");
    if (i >= 0) {
      let tail = dec.slice(i + "ya-disk-public://".length).split("&")[0];
      return { type: "yandex", provider: "yandex", key: tail, url: href };
    }
    if (/disk\.yandex\./i.test(dec)) {
      let key = dec.split("?")[0];
      return { type: "yandex", provider: "yandex", key, url: href };
    }
    let g = googleIdFromUrl(href);
    if (g) {
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

  async function fetchFreshSourceFromWorker() {
    if (!WORKER) return null;
    try {
      const r = await fetch(WORKER + "/key", { signal: AbortSignal.timeout(15000) });
      const j = await r.json();
      if (j.source) return j.source;
      if (j.ok && j.key) return { type: "yandex", provider: "yandex", key: j.key, url: j.key };
      if (j.url) return j;
      return null;
    } catch (e) { return null; }
  }

  async function tryDownload(source) {
    if (!source || !source.type) throw new Error("пустой источник");
    if (source.type === "yandex") {
      const key = source.key;
      try {
        const api = "https://cloud-api.yandex.net/v1/disk/public/resources/download?public_key=" + encodeURIComponent(key);
        const meta = await (await fetch(api)).json();
        if (!meta.href) throw new Error(meta.description || "нет ссылки");
        const resp = await fetch(meta.href);
        if (!resp.ok) throw new Error("HTTP " + resp.status);
        return await resp.arrayBuffer();
      } catch (direct) {
        if (!WORKER) throw direct;
        const r = await fetch(WORKER + "/file?key=" + encodeURIComponent(key));
        if (!r.ok) { let msg="HTTP "+r.status; try{msg=(await r.json()).error||msg}catch(e){} throw new Error(msg); }
        return await r.arrayBuffer();
      }
    }
    if (source.type === "google") {
      if (WORKER) {
        try {
          const q = source.url ? "?url=" + encodeURIComponent(source.url) : (source.exportUrl ? "?exportUrl=" + encodeURIComponent(source.exportUrl) : "?id=" + encodeURIComponent(source.id || ""));
          const r = await fetch(WORKER + "/file" + q);
          if (!r.ok) { let msg="HTTP "+r.status; try{const j=await r.json(); msg=j.error||msg}catch(e){} throw new Error(msg); }
          return await r.arrayBuffer();
        } catch (workerErr) {
          if (source.exportUrl) { try{const resp=await fetch(source.exportUrl); if(resp.ok) return await resp.arrayBuffer();}catch(e){} }
          throw workerErr;
        }
      } else {
        const url = source.exportUrl || source.url;
        const resp = await fetch(url);
        if (!resp.ok) throw new Error("HTTP " + resp.status);
        return await resp.arrayBuffer();
      }
    }
    throw new Error("неизвестный тип источника: " + source.type);
  }

  async function fetchXlsx() {
    const tried = new Set(); const chain = [];
    const fresh = await fetchFreshSourceFromWorker();
    if (fresh) chain.push(["сайт техникума (" + sourceLabel(fresh) + ")", fresh]);
    // При геоблоке сначала пробуем настроенный актуальный Google, а не закэшированный старый Яндекс.
    if (FALLBACK_GOOGLE) {
      const src = extractSourceFromLink(FALLBACK_GOOGLE);
      if (src) chain.push(["резервная ссылка (Google)", src]);
    }
    const lastRaw = lsGet("lastGoodSource") || lsGet("lastGoodKey");
    if (lastRaw) {
      try {
        let src; if (lastRaw.trim().startsWith("{")) src = JSON.parse(lastRaw);
        else src = { type: "yandex", provider: "yandex", key: lastRaw, url: lastRaw };
        if (src && src.type) chain.push(["предыдущая рабочая ссылка (" + sourceLabel(src) + ")", src]);
      } catch (e) {}
    }
    if (FALLBACK_KEY) chain.push(["резервная ссылка (Яндекс)", { type: "yandex", provider: "yandex", key: FALLBACK_KEY, url: FALLBACK_KEY }]);
    let lastErr = null;
    for (const [label, src] of chain) {
      const id = src.key || src.url || src.exportUrl || JSON.stringify(src);
      if (!id || tried.has(id)) continue; tried.add(id);
      try {
        const buf = await tryDownload(src);
        try { lsSet("lastGoodSource", JSON.stringify(src)); } catch (e) {}
        return { buf, source: label };
      } catch (e) { lastErr = e; console.warn("tryDownload failed", label, e); }
    }
    if (WORKER) {
      try {
        const r = await fetch(WORKER + "/file");
        if (r.ok && (r.headers.get("Content-Type") || "").includes("json") === false) {
          return { buf: await r.arrayBuffer(), source: "воркер (авто)" };
        } else if (r.ok) { const j=await r.json().catch(()=>null); if(j) throw new Error(j.error||"воркер не нашёл файл"); }
      } catch (e) { lastErr = e; }
    }
    throw new Error("не удалось скачать файл ни по одной ссылке" + (lastErr ? " (" + lastErr.message + ")" : ""));
  }

  async function applyManualLink() {
    const href = $("manuallink").value.trim();
    const src = extractSourceFromLink(href);
    if (!src) { setStatus("Не похоже на ссылку Яндекс.Диска или Google Drive/Docs.", true); return; }
    setStatus("Проверяю ссылку (" + sourceLabel(src) + ")…");
    try {
      const buf = await tryDownload(src);
      lsSet("lastGoodSource", JSON.stringify(src));
      if (src.key) lsSet("lastGoodKey", src.key);
      $("linkfix").style.display = "none";
      afterLoad(buf, "ссылка вручную (" + sourceLabel(src) + ")");
    } catch (e) { setStatus("По этой ссылке скачать не удалось: " + e.message, true); }
  }

  function applyGroupFilters() {
    const query = ($("group-filter").value || "").trim().toLocaleLowerCase("ru");
    let visible = 0;
    document.querySelectorAll(".group-family").forEach((section) => {
      let familyVisible = 0;
      section.querySelectorAll("button[data-group]").forEach((button) => {
        const matchesFamily = activeFamilyFilter === "*" || button.dataset.family === activeFamilyFilter;
        const matchesQuery = !query || button.dataset.group.toLocaleLowerCase("ru").includes(query);
        button.hidden = !(matchesFamily && matchesQuery);
        if (!button.hidden) { familyVisible++; visible++; }
      });
      section.hidden = familyVisible === 0;
    });
    $("group-empty").style.display = visible ? "none" : "block";
    $("group-count").textContent = query || activeFamilyFilter !== "*"
      ? `${visible} из ${parsed.all_groups.length} групп`
      : `${parsed.all_groups.length} групп`;
  }

  function renderGroupBubbles() {
    const host = $("group-bubbles"), nav = $("family-nav");
    if (!host || !nav || !parsed) return;
    host.innerHTML = "";
    nav.innerHTML = "";
    activeFamilyFilter = "*";
    $("group-filter").value = "";
    const collator = new Intl.Collator("ru", { numeric: true, sensitivity: "base" });
    const families = new Map();
    for (const group of parsed.all_groups) {
      const prefix = group.includes("-") ? group.split("-")[0] : "ДРУГИЕ";
      if (!families.has(prefix)) families.set(prefix, []);
      families.get(prefix).push(group);
    }
    for (const groups of families.values()) groups.sort(collator.compare);
    const sortedFamilies = [...families.entries()].sort((a, b) => collator.compare(a[0], b[0]));

    const addFilter = (label, family, count) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "family-filter" + (family === "*" ? " active" : "");
      button.dataset.family = family;
      button.setAttribute("aria-pressed", family === "*" ? "true" : "false");
      button.textContent = `${label} · ${count}`;
      nav.appendChild(button);
    };
    addFilter("ВСЕ", "*", parsed.all_groups.length);

    for (const [prefix, groups] of sortedFamilies) {
      addFilter(prefix, prefix, groups.length);
      const section = document.createElement("section");
      section.className = "group-family";
      section.dataset.family = prefix;
      const bubbles = document.createElement("div");
      bubbles.className = "bubble-grid";
      for (const group of groups) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "group-bubble";
        button.dataset.group = group;
        button.dataset.family = prefix;
        const separator = group.indexOf("-");
        const prefixPart = separator >= 0 ? group.slice(0, separator) : group;
        const coursePart = separator >= 0 ? group.slice(separator + 1) : "";
        button.innerHTML = `<span class="bubble-dot" aria-hidden="true"></span><span class="bubble-label">${esc(prefixPart)}</span><span class="bubble-course">${esc(coursePart)}</span>`;
        button.setAttribute("aria-label", `Открыть расписание группы ${group}`);
        bubbles.appendChild(button);
      }
      section.appendChild(bubbles);
      host.appendChild(section);
    }
    applyGroupFilters();
  }

  function normalizeTeacher(name){
    return String(name || "").trim().replace(/\s+/g," ").toLocaleLowerCase("ru");
  }

  function getTeacherCatalog(){
    const teachers = new Map();
    if(!parsed) return [];
    for(const day of parsed.days){
      for(const group of parsed.all_groups){
        for(const lesson of day.groups[group] || []){
          for(const entry of lesson.entries || []){
            const name = String(entry.teacher || "").trim().replace(/\s+/g," ");
            const key = normalizeTeacher(name);
            if(key && !teachers.has(key)) teachers.set(key,name);
          }
        }
      }
    }
    const collator = new Intl.Collator("ru",{sensitivity:"base"});
    return [...teachers.values()].sort(collator.compare);
  }

  function renderTeacherPicker(){
    const host = $("teacher-list");
    if(!host || !parsed) return;
    host.innerHTML = "";
    const teachers = getTeacherCatalog();
    teacherCatalogCache = teachers;
    for(const name of teachers){
      const button = document.createElement("button");
      button.type = "button";
      button.className = "teacher-option";
      button.dataset.teacher = name;
      button.innerHTML = `<span class="teacher-option-name">${esc(name)}</span><span class="teacher-option-arrow" aria-hidden="true">→</span>`;
      button.setAttribute("aria-label",`Посмотреть пары преподавателя ${name}`);
      host.appendChild(button);
    }
    $("teacher-filter").value = "";
    filterTeacherPicker();
  }

  function filterTeacherPicker(){
    const query = ($("teacher-filter").value || "").trim().toLocaleLowerCase("ru");
    let visible = 0;
    document.querySelectorAll(".teacher-option").forEach((button)=>{
      button.hidden = !!query && !button.dataset.teacher.toLocaleLowerCase("ru").includes(query);
      if(!button.hidden) visible++;
    });
    $("teacher-empty").style.display = visible ? "none" : "block";
    const total = teacherCatalogCache ? teacherCatalogCache.length : 0;
    $("teacher-count").textContent = query ? `${visible} из ${total} преподавателей` : `${total} преподавателей`;
  }

  function getTeacherDayEntries(dayIndex, teacherName){
    if(!parsed || !parsed.days[dayIndex]) return [];
    const day = parsed.days[dayIndex];
    const wanted = normalizeTeacher(teacherName);
    const records = new Map();
    const collator = new Intl.Collator("ru",{numeric:true,sensitivity:"base"});
    for(const group of parsed.all_groups){
      for(const lesson of day.groups[group] || []){
        for(const entry of lesson.entries || []){
          if(normalizeTeacher(entry.teacher) !== wanted) continue;
          const number = String(lesson.number);
          const subject = String(entry.subject || "").trim();
          const subjectKey = subject.replace(/\s+/g," ").toLocaleLowerCase("ru");
          const key = `${number}|${subjectKey}`;
          if(!records.has(key)) records.set(key,{number,subject,assignments:[]});
          const record = records.get(key);
          let assignment = record.assignments.find((item)=>item.group === group);
          if(!assignment){ assignment={group,rooms:[],subgroups:[]}; record.assignments.push(assignment); }
          const room=String(entry.room||"").trim(), subgroup=String(entry.subgroup||"").trim();
          if(room && !assignment.rooms.includes(room)) assignment.rooms.push(room);
          if(subgroup && !assignment.subgroups.includes(subgroup)) assignment.subgroups.push(subgroup);
        }
      }
    }
    return [...records.values()].map((record)=>({
      ...record,
      assignments:record.assignments.sort((a,b)=>collator.compare(a.group,b.group))
    })).sort((a,b)=>{
      const ai=PAIR_ORDER.indexOf(a.number), bi=PAIR_ORDER.indexOf(b.number);
      const pairSort=(ai<0?99:ai)-(bi<0?99:bi);
      return pairSort || collator.compare(a.subject,b.subject);
    });
  }

  function conflictingTeacherPairs(records){
    const subjectsByPair=new Map();
    for(const record of records){
      if(!subjectsByPair.has(record.number)) subjectsByPair.set(record.number,new Set());
      subjectsByPair.get(record.number).add(record.subject.replace(/\s+/g," ").toLocaleLowerCase("ru"));
    }
    return [...subjectsByPair.values()].some((subjects)=>subjects.size>1);
  }

  function afterLoad(buf, source, options={}) {
    const hadParsed=!!parsed;
    try { parsed = RaspParser.parseWorkbook(XLSX, buf); }
    catch (e) { if(!options.silent) setStatus("Файл скачан (" + source + "), но не удалось распарсить: " + e.message, true); return false; }
    teacherCatalogCache = null;
    $("open-teachers").disabled = false;
    try{ writeStoredObject("kkst-schedule-cache-v1",{version:1,cachedAt:Date.now(),parsed}); }catch(e){}
    if(options.silent && hadParsed && options.state) refreshPickerContents(options.state);
    else renderGroupBubbles();
    $("group-count").textContent = `${parsed.all_groups.length} групп`;
    if(!options.silent) setStatus(`Загружено: ${parsed.all_groups.length} групп · источник: ${source} · ` + parsed.days.map((d)=>d.title).join(" • "));
    if(!initialFavoriteRestored){
      initialFavoriteRestored=true;
      restoreSavedFavorite();
    }
    if(options.silent && options.state) restoreViewAfterSilentRefresh(options.state);
    if(!$("notes-screen").hidden) renderNotesPage();
    return true;
  }

  function restoreSavedFavorite(){
    const favorite=getFavorite();
    if(!favorite || !parsed) return;
    if(favorite.type==="group"){
      const group=RaspParser.findGroup(parsed,favorite.value);
      if(group) show(group);
      return;
    }
    const teacher=getTeacherCatalog().find((name)=>normalizeTeacher(name)===normalizeTeacher(favorite.value));
    if(teacher) openTeacher(teacher,false);
  }

  function captureUiSnapshot(){
    return {
      viewMode,group:activeGroup,teacher:activeTeacher,
      date:parsed?.days?.[activeDayIndex]?.date||null,
      returnGroup:teacherReturnContext?.group||null,
      returnDate:teacherReturnContext && parsed?.days?.[teacherReturnContext.dayIndex]?.date || null,
      groupQuery:$("group-filter").value||"",teacherQuery:$("teacher-filter").value||"",
      family:activeFamilyFilter,notesVisible:!$("notes-screen").hidden,
      rosterPanelOpen,rosterEditorOpen,rosterDraft:rosterEditorOpen?$("roster-textarea").value:""
    };
  }

  function refreshPickerContents(state){
    renderGroupBubbles();
    $("group-filter").value=state.groupQuery||"";
    const families=new Set([...document.querySelectorAll(".family-filter")].map((button)=>button.dataset.family));
    activeFamilyFilter=families.has(state.family)?state.family:"*";
    document.querySelectorAll(".family-filter").forEach((button)=>{
      const active=button.dataset.family===activeFamilyFilter;
      button.classList.toggle("active",active);button.setAttribute("aria-pressed",active?"true":"false");
    });
    applyGroupFilters();
    if(state.viewMode==="teacher-picker"){
      renderTeacherPicker();
      $("teacher-filter").value=state.teacherQuery||"";
      filterTeacherPicker();
    }
  }

  function restoreViewAfterSilentRefresh(state){
    let nextMode=state.viewMode;
    let group=null,teacher=null;
    if(nextMode==="group"){
      group=RaspParser.findGroup(parsed,state.group||"");
      if(!group) nextMode="group-picker";
    }else if(nextMode==="teacher"){
      teacher=getTeacherCatalog().find((name)=>normalizeTeacher(name)===normalizeTeacher(state.teacher||""));
      if(!teacher) nextMode="teacher-picker";
    }
    viewMode=nextMode;
    activeGroup=nextMode==="group"?group:null;
    activeTeacher=nextMode==="teacher"?teacher:null;
    const dayIndex=parsed.days.findIndex((day)=>day.date===state.date);
    activeDayIndex=dayIndex>=0?dayIndex:defaultDayIndex(parsed.days);
    teacherReturnContext=null;
    if(nextMode==="teacher" && state.returnGroup){
      const returnGroup=RaspParser.findGroup(parsed,state.returnGroup);
      if(returnGroup){
        const returnIndex=parsed.days.findIndex((day)=>day.date===state.returnDate);
        teacherReturnContext={group:returnGroup,dayIndex:returnIndex>=0?returnIndex:activeDayIndex};
      }
    }
    rosterPanelOpen=nextMode==="group" && !!state.rosterPanelOpen;
    rosterEditorOpen=rosterPanelOpen && !!state.rosterEditorOpen;
    const showNotes=!!state.notesVisible;
    $("notes-screen").hidden=!showNotes;
    $("group-screen").style.display=!showNotes && nextMode==="group-picker"?"block":"none";
    $("teacher-screen").style.display=!showNotes && nextMode==="teacher-picker"?"block":"none";
    $("schedule-screen").style.display=!showNotes && (nextMode==="group"||nextMode==="teacher")?"block":"none";
    if(nextMode==="group"){
      $("back-groups").textContent="← ВСЕ ГРУППЫ";
      renderSelectedDay();
      if(rosterEditorOpen) $("roster-textarea").value=state.rosterDraft||"";
    }else if(nextMode==="teacher"){
      $("back-groups").textContent=teacherReturnContext?"← К РАСПИСАНИЮ ГРУППЫ":"← К ПРЕПОДАВАТЕЛЯМ";
      renderSelectedDay();
    }else{
      rosterPanelOpen=false;rosterEditorOpen=false;
      if(nextMode==="teacher-picker" && state.viewMode!=="teacher-picker") renderTeacherPicker();
    }
    if(showNotes) renderNotesPage();
  }

  function showGroupDirectory(){
    if(!parsed) return;
    viewMode="group-picker";activeGroup=null;activeTeacher=null;teacherReturnContext=null;
    rosterPanelOpen=false;rosterEditorOpen=false;
    $("notes-screen").hidden=true;$("schedule-screen").style.display="none";
    $("teacher-screen").style.display="none";$("group-screen").style.display="block";
    $("roster-panel").hidden=true;
    window.scrollTo({top:0,behavior:"smooth"});
  }
  function loadCachedSchedule(){
    const cache=readStoredObject("kkst-schedule-cache-v1");
    if(cache.version!==1 || !cache.parsed || !Array.isArray(cache.parsed.days) || !Array.isArray(cache.parsed.all_groups)) return false;
    parsed=cache.parsed;teacherCatalogCache=null;
    $("open-teachers").disabled=false;
    renderGroupBubbles();
    $("group-count").textContent=`${parsed.all_groups.length} групп`;
    initialFavoriteRestored=true;
    restoreSavedFavorite();
    return true;
  }

  async function loadData(force,options={}){
    if(!options.silent) setStatus(force ? "Ищу свежую ссылку и скачиваю файл…" : "Загружаю расписание…");
    try{
      const {buf,source}=await fetchXlsx();
      return afterLoad(buf,source,options);
    }catch(e){
      if(!options.silent){setStatus("Не удалось загрузить: "+e.message,true);$("linkfix").style.display="flex";}
      return false;
    }
  }

  async function refreshScheduleSilently(){
    try{
      const {buf,source}=await fetchXlsx();
      // Capture the view after the network request so a user's navigation is never rolled back.
      const snapshot=captureUiSnapshot();
      afterLoad(buf,source,{silent:true,state:snapshot});
    }catch(e){ /* The cached schedule remains available; background failures stay quiet. */ }
  }

  function startWithCachedSchedule(){
    if(loadCachedSchedule()) refreshScheduleSilently();
    else loadData(false);
  }

  function weekdayName(day){
    const title = String(day.title || "");
    const match = title.match(/\(([^)]+)\)/);
    const raw = match ? match[1].trim() : title.replace(/расписание занятий/i, "").trim();
    return raw ? raw.charAt(0).toLocaleUpperCase("ru") + raw.slice(1) : "Занятия";
  }
  function dateObject(day){
    const m = String(day.date || "").match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
    return m ? new Date(Number(m[3]), Number(m[2])-1, Number(m[1])) : null;
  }
  function currentDateString(now = new Date()){
    return [String(now.getDate()).padStart(2,"0"),String(now.getMonth()+1).padStart(2,"0"),now.getFullYear()].join(".");
  }
  function parsePairRange(timeRange){
    const match=String(timeRange||"").match(/(\d{1,2}):(\d{2})\s*[–—-]\s*(\d{1,2}):(\d{2})/);
    if(!match) return null;
    return {start:Number(match[1])*60+Number(match[2]),end:Number(match[3])*60+Number(match[4])};
  }
  function dateOrderKey(dateStr){
    const match=String(dateStr||"").match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
    return match?`${match[3]}${match[2]}${match[1]}`:"";
  }
  function minuteOfDay(now){return now.getHours()*60+now.getMinutes()+now.getSeconds()/60;}
  function formatDuration(minutes,roundUp=false){
    const whole=Math.max(0,roundUp?Math.ceil(minutes):Math.floor(minutes));
    if(whole<1) return "меньше минуты";
    const hours=Math.floor(whole/60),rest=whole%60;
    if(hours) return `${hours} ч${rest?` ${rest} мин`:""}`;
    return `${whole} мин`;
  }
  function formatClockMinute(value){
    const minutes=((Math.round(value)%1440)+1440)%1440;
    return `${String(Math.floor(minutes/60)).padStart(2,"0")}:${String(minutes%60).padStart(2,"0")}`;
  }
  function activityRecords(date,kind,items){
    const timeMap=timesFor(date);
    return (items||[]).map((item)=>{
      const number=String(item.number),range=parsePairRange(timeMap[number]||"");
      if(!range) return null;
      const subjects=kind==="teacher"?[item.subject]:[...(new Set((item.entries||[]).map((entry)=>String(entry.subject||"").trim()).filter(Boolean)))];
      const rooms=kind==="teacher"?item.assignments.flatMap((assignment)=>assignment.rooms||[]):(item.entries||[]).map((entry)=>entry.room||"");
      const groups=kind==="teacher"?item.assignments.map((assignment)=>assignment.group):[];
      return {number,range,subjects:[...new Set(subjects.filter(Boolean))],rooms:[...new Set(rooms.filter(Boolean))],groups:[...new Set(groups.filter(Boolean))]};
    }).filter(Boolean).sort((a,b)=>a.range.start-b.range.start||PAIR_ORDER.indexOf(a.number)-PAIR_ORDER.indexOf(b.number));
  }
  function activitySummary(records){
    const unique=(items)=>[...new Set(items.filter(Boolean))];
    const numbers=unique(records.map((item)=>item.number));
    const subjects=unique(records.flatMap((item)=>item.subjects));
    const groups=unique(records.flatMap((item)=>item.groups));
    const rooms=unique(records.flatMap((item)=>item.rooms));
    const pair=numbers.map((number)=>number==="0"?"ВД":`${number}-я пара`).join(" + ");
    const pairGenitive=numbers.map((number)=>number==="0"?"ВД":`${number}-й пары`).join(" + ");
    return {numbers,pair,pairGenitive,subject:subjects.join(" · "),detail:groups.length?`Группы: ${groups.join(", ")}`:"",room:rooms.join(" · ")};
  }
  function renderActivityPanel(now=new Date()){
    const panel=$("activity-live");
    if(!panel) return;
    if(!activityContext || activityContext.date!==currentDateString(now)){
      panel.hidden=true;panel.innerHTML="";return;
    }
    const records=activityRecords(activityContext.date,activityContext.kind,activityContext.items);
    const current=minuteOfDay(now);
    if(!records.length||current<Math.min(...records.map((item)=>item.range.start))){panel.hidden=true;panel.innerHTML="";return;}
    const active=records.filter((item)=>current>=item.range.start&&current<item.range.end);
    const future=records.filter((item)=>item.range.start>current);
    const nextStart=future.length?Math.min(...future.map((item)=>item.range.start)):null;
    const next=nextStart===null?[]:future.filter((item)=>item.range.start===nextStart);
    const prior=records.filter((item)=>item.range.end<=current);
    const latestEnd=prior.length?Math.max(...prior.map((item)=>item.range.end)):null;
    const previous=latestEnd===null?[]:prior.filter((item)=>item.range.end===latestEnd);
    let nextDay=null;
    if(!next.length){
      for(const day of activityContext.followingDays||[]){
        if(dateOrderKey(day.date)<=dateOrderKey(currentDateString(now))) continue;
        const dayRecords=activityRecords(day.date,activityContext.kind,day.items);
        if(!dayRecords.length) continue;
        const firstStart=Math.min(...dayRecords.map((item)=>item.range.start));
        nextDay={date:day.date,records:dayRecords.filter((item)=>item.range.start===firstStart),start:firstStart};
        break;
      }
    }
    const clock=now.toLocaleTimeString("ru-RU",{hour:"2-digit",minute:"2-digit"});
    let state="",title="",detail="",room="",timer="",progress=0,kindClass="";
    if(active.length){
      const summary=activitySummary(active),start=Math.min(...active.map((item)=>item.range.start)),end=Math.max(...active.map((item)=>item.range.end));
      state="ИДЁТ ПАРА";title=`${summary.pair} · ${summary.subject||"Занятие"}`;detail=summary.detail;room=summary.room;
      timer=`Прошло ${formatDuration(current-start)} · осталось ${formatDuration(end-current,true)}`;
      progress=Math.max(0,Math.min(100,((current-start)/(end-start))*100));
    }else if(next.length){
      const summary=activitySummary(next),isBreak=previous.length>0;
      state=isBreak?"ПЕРЕМЕНА":"ДО НАЧАЛА ЗАНЯТИЙ";kindClass="is-break";
      title=`До ${summary.pairGenitive} · ${formatDuration(nextStart-current,true)}`;
      detail=[summary.subject,summary.detail,`Начало в ${formatClockMinute(nextStart)}`].filter(Boolean).join(" · ");room=summary.room;
      timer=isBreak?`Перерыв после ${activitySummary(previous).pairGenitive}`:"Следующая пара по расписанию";
      if(isBreak&&nextStart>latestEnd) progress=Math.max(0,Math.min(100,((current-latestEnd)/(nextStart-latestEnd))*100));
    }else if(previous.length){
      const summary=activitySummary(previous),end=latestEnd;
      state="ЗАНЯТИЯ ЗАВЕРШЕНЫ";kindClass="is-finished";
      title=`${summary.pair} завершилась в ${formatClockMinute(end)}`;
      detail=[summary.subject,summary.detail].filter(Boolean).join(" · ");room=summary.room;timer="Следующей пары сегодня нет";
    }else{
      state="СЕГОДНЯ ЗАНЯТИЙ НЕТ";kindClass="is-empty";title="В расписании на сегодня нет пар";timer="";
    }
    const nextSummary=next.length?activitySummary(next):null;
    const futureSummary=nextDay?activitySummary(nextDay.records):null;
    const roomBadge=(value)=>value?`<div class="activity-live-room"><span>КАБИНЕТ</span><strong>${esc(value)}</strong></div>`:"";
    const nextHtml=nextSummary&&active.length?`<div class="activity-next"><strong>Следующая: ${esc(nextSummary.pair)}</strong><span>${esc([nextSummary.subject,nextSummary.detail].filter(Boolean).join(" · "))}</span>${roomBadge(nextSummary.room)}<span>${formatClockMinute(nextStart)}</span></div>`:futureSummary?`<div class="activity-next"><strong>Следующая: ${esc(futureSummary.pair)} · ${esc(nextDay.date)}</strong><span>${esc([futureSummary.subject,futureSummary.detail].filter(Boolean).join(" · "))}</span>${roomBadge(futureSummary.room)}<span>${formatClockMinute(nextDay.start)}</span></div>`:"";
    panel.className=`activity-live ${kindClass}`.trim();
    panel.innerHTML=`<div class="activity-live-top"><div class="activity-live-brand"><span class="activity-live-pulse" aria-hidden="true"></span><span>Эфир активности</span></div><time class="activity-live-clock">${clock}</time></div><div class="activity-live-state">${state}</div><div class="activity-live-main-row"><div class="activity-live-copy"><div class="activity-live-title">${esc(title)}</div>${detail?`<div class="activity-live-detail">${esc(detail)}</div>`:""}</div>${roomBadge(room)}</div>${timer?`<div class="activity-live-timer">${esc(timer)}</div>`:""}${active.length||kindClass==="is-break"?`<div class="activity-progress" aria-hidden="true"><span style="width:${progress.toFixed(1)}%"></span></div>`:""}${nextHtml}`;
    panel.hidden=false;
  }
  function updateCurrentLessonHighlights(now = new Date()){
    const today=currentDateString(now),todayKey=dateOrderKey(today),current=minuteOfDay(now);
    const rows=[...document.querySelectorAll("#board .lesson[data-schedule-date],#board .teacher-lesson[data-schedule-date]")];
    const rowInfo=rows.map((row)=>({row,date:row.dataset.scheduleDate,range:parsePairRange(row.dataset.scheduleTime)}));
    const todayRows=rowInfo.filter((item)=>item.date===today&&item.range);
    const firstStart=todayRows.length?Math.min(...todayRows.map((item)=>item.range.start)):null;
    const activityStarted=firstStart!==null&&current>=firstStart;
    const upcoming=todayRows.filter((item)=>item.range.start>current);
    const nextStart=upcoming.length?Math.min(...upcoming.map((item)=>item.range.start)):null;
    rowInfo.forEach(({row,date,range})=>{
      const sameDay=date===today,dayKey=dateOrderKey(date);
      const active=!!(sameDay&&range&&current>=range.start&&current<range.end);
      const past=!!(range&&dayKey&&todayKey&&dayKey<todayKey)&&!active || !!(sameDay&&range&&current>=range.end);
      const next=!!(sameDay&&activityStarted&&range&&!active&&range.start>current&&range.start===nextStart);
      row.classList.toggle("is-current",active);row.classList.toggle("is-past",past);row.classList.toggle("is-next",next);
      const label=row.querySelector(".current-lesson-label");
      if(label){label.hidden=!(active||past||next);label.textContent=active?"Идёт сейчас":past?"Завершилась":"Следующая";label.classList.toggle("is-past",past);label.classList.toggle("is-next",next);}
    });
    renderActivityPanel(now);
  }
  function defaultDayIndex(days){
    const today = currentDateString();
    const exact = days.findIndex((day)=>day.date === today);
    if(exact >= 0) return exact;
    const todayDate = dateObject({date:today});
    if(!todayDate) return 0;
    let nextIndex = -1, nextDelta = Infinity, previousIndex = -1, previousDelta = -Infinity;
    days.forEach((day,index)=>{
      const date = dateObject(day); if(!date) return;
      const delta = date.getTime() - todayDate.getTime();
      if(delta >= 0 && delta < nextDelta){ nextDelta=delta; nextIndex=index; }
      if(delta < 0 && delta > previousDelta){ previousDelta=delta; previousIndex=index; }
    });
    return nextIndex >= 0 ? nextIndex : (previousIndex >= 0 ? previousIndex : 0);
  }

  /* ---------- HTML-рендер (CSS) ---------- */
  function updateMobileSubjectFit(){
    const compact=window.matchMedia?.("(max-width:760px)").matches;
    const rows=[...document.querySelectorAll("#board .lesson,#board .teacher-lesson")];
    rows.forEach((row)=>{
      row.classList.remove("long-subject");
      if(!compact) return;
      const subjects=[...row.querySelectorAll(".subj")];
      if(subjects.some((subject)=>subject.scrollWidth>subject.clientWidth+1)) row.classList.add("long-subject");
    });
  }
  window.addEventListener("resize",()=>requestAnimationFrame(updateMobileSubjectFit),{passive:true});

  function renderBoard(group, days){
    const board = $("board");
    if(!board) return;
    board.innerHTML = "";
    // head of board
    const head = document.createElement("div");
    head.className = "board-head";
    head.innerHTML = `<div class="board-heading-row"><div class="group-title">${esc(group)}</div>${favoriteButtonHtml("group",group)}</div>`;
    board.appendChild(head);

    const todayDate = currentDateString();
    days.forEach(d=>{
      const rows = buildRows(d.lessons);
      const dayEl = document.createElement("section");
      const isToday = d.date === todayDate;
      dayEl.className = "day" + (isToday ? " is-today" : "");
      const titleText = String(d.title || "");
      const weekday = weekdayName(d);
      const weekMatch = titleText.match(/неделя\s*(\d+)/i);
      const weekHtml = weekMatch ? `<span class="week-label">НЕДЕЛЯ ${esc(weekMatch[1])}</span>` : "";
      const todayHtml = isToday ? `<span class="today-label">СЕГОДНЯ</span>` : "";
      dayEl.innerHTML = `<div class="day-head"><div class="day-heading"><div class="day-title">${esc(weekday)}</div>${weekHtml}</div><div class="day-date">${esc(d.date||"")}${todayHtml}</div></div><div class="lessons"></div>`;
      const cont = dayEl.querySelector(".lessons");
      if(rows.length===0){
        cont.innerHTML = `<div class="empty">ЗАНЯТИЙ НЕТ — СВОБОДА // NO LESSONS</div>`;
      } else {
        rows.forEach(([kind,obj], i)=>{
          if(kind==="window"){
            const n=obj; const t = timesFor(d.date)[n]||"";
            const el = document.createElement("div");
            el.className="window";
            el.innerHTML = `<div class="num"><div class="num-badge">${esc(n)}</div><div class="time">${esc(t).replace("–","<br>")}</div></div><div class="window-msg">ОКНО — ${esc(n)} ПАРЫ НЕТ <span>${esc(t)}</span></div>`;
            cont.appendChild(el);
          } else {
            const les=obj; const t = timesFor(d.date)[les.number]||"";
            const el = document.createElement("div");
            el.className = "lesson" + (i%2===1 ? " zebra" : "");
            el.dataset.scheduleDate=d.date||"";
            el.dataset.scheduleTime=t;
            const rooms = [...new Set(les.entries.map(e=>e.room).filter(Boolean))];
            const roomContent = rooms.length ? `<div class="room">${rooms.map(r=>`<div>${esc(r)}</div>`).join("")}</div>` : `<div class="room empty-room">—</div>`;
            const roomHtml = `<div class="room-wrap"><span class="current-lesson-label" hidden>Идёт сейчас</span>${roomContent}</div>`;
            let entriesHtml = les.entries.map(e=>`
              <div class="entry">
                ${e.subgroup ? `<span class="subgroup">${esc(e.subgroup)} ПОДГР.</span>` : ``}
                <div class="subj">${esc(e.subject)}</div>
                ${e.teacher ? `<div class="teacher"><button type="button" class="teacher-link" data-teacher="${esc(e.teacher)}" aria-label="Показать пары преподавателя ${esc(e.teacher)}">${esc(e.teacher)}</button></div>` : ``}
              </div>
            `).join("");
            const savedNote=getNote(group,d.date,les.number);
            const notePreview=savedNote?`<span class="lesson-note-preview">${esc(savedNote.replace(/\s+/g," "))}</span>`:"";
            const noteButton=`<div class="lesson-note-tools"><button type="button" class="lesson-note-button${savedNote?" has-note":""}" data-note-number="${esc(les.number)}" aria-label="${savedNote?"Изменить":"Добавить"} заметку к ${esc(les.number)} паре">${savedNote?"✎ Заметка":"＋ Заметка"}</button>${notePreview}</div>`;
            el.innerHTML = `
              <div class="num"><div class="num-badge ${les.number==="0"?"vd":""}">${esc(les.number==="0"?"ВД":les.number)}</div><div class="time">${esc(t)}</div></div>
              <div class="subj-wrap">${entriesHtml}${noteButton}</div>
              ${roomHtml}
            `;
            cont.appendChild(el);
          }
        });
      }
      board.appendChild(dayEl);
    });
    updateCurrentLessonHighlights();
    requestAnimationFrame(updateMobileSubjectFit);
  }

  function renderTeacherBoard(teacherName, day, records){
    const board = $("board");
    board.innerHTML = "";
    const head = document.createElement("div");
    head.className = "board-head teacher-board-head";
    head.innerHTML = `<div class="board-overline">ПРЕПОДАВАТЕЛЬ</div><div class="board-heading-row"><div class="group-title">${esc(teacherName)}</div>${favoriteButtonHtml("teacher",teacherName)}</div>`;
    board.appendChild(head);

    const todayDate = currentDateString();
    const isToday = day.date === todayDate;
    const titleText = String(day.title || "");
    const weekMatch = titleText.match(/неделя\s*(\d+)/i);
    const weekHtml = weekMatch ? `<span class="week-label">НЕДЕЛЯ ${esc(weekMatch[1])}</span>` : "";
    const todayHtml = isToday ? `<span class="today-label">СЕГОДНЯ</span>` : "";
    const section = document.createElement("section");
    section.className = "day teacher-day" + (isToday ? " is-today" : "");
    section.innerHTML = `<div class="day-head"><div class="day-heading"><div class="day-title">${esc(weekdayName(day))}</div>${weekHtml}</div><div class="day-date">${esc(day.date||"")}${todayHtml}</div></div><div class="teacher-schedule-list"></div>`;
    const list = section.querySelector(".teacher-schedule-list");
    if(conflictingTeacherPairs(records)){
      const note=document.createElement("div");
      note.className="teacher-conflict-note";
      note.textContent="В исходном расписании на одной паре указаны разные предметы для разных групп. Такие записи показаны отдельно.";
      section.insertBefore(note,list);
    }
    if(!records.length){
      list.innerHTML = `<div class="empty">НА ЭТОТ ДЕНЬ ПАР НЕТ</div>`;
    } else {
      records.forEach((record)=>{
        const row = document.createElement("article");
        row.className = "teacher-lesson";
        const time = timesFor(day.date)[record.number] || "";
        const groupsHtml=record.assignments.map((assignment)=>{
          const subgroupHtml=assignment.subgroups.map((subgroup)=>`<span class="teacher-subgroup">${esc(subgroup)}</span>`).join("");
          return `<span class="teacher-assignment"><span class="teacher-class">${esc(assignment.group)}</span>${subgroupHtml}</span>`;
        }).join("");
        row.dataset.scheduleDate=day.date||"";
        row.dataset.scheduleTime=time;
        const rooms=[...new Set(record.assignments.flatMap((assignment)=>assignment.rooms))];
        const roomContent=rooms.length ? `<div class="teacher-room">${rooms.map(esc).join(" · ")}</div>` : `<div class="teacher-room">—</div>`;
        const roomHtml=`<div class="teacher-room-wrap"><span class="current-lesson-label" hidden>Идёт сейчас</span>${roomContent}</div>`;
        row.innerHTML = `<div class="num"><div class="num-badge">${esc(record.number === "0" ? "ВД" : record.number)}</div><div class="time">${esc(time)}</div></div><div class="teacher-lesson-details"><div class="teacher-groups">${groupsHtml}</div><div class="subj">${esc(record.subject)}</div></div>${roomHtml}`;
        list.appendChild(row);
      });
    }
    board.appendChild(section);
    updateCurrentLessonHighlights();
    requestAnimationFrame(updateMobileSubjectFit);
  }

  function updateRosterCopyAvailability(){
    if(!activeGroup) return;
    const roster=getRoster(activeGroup);
    const marks=getDailyAttendance().groups[activeGroup]||{};
    const count=roster.filter((student)=>["present","absent"].includes(marks[student.id]?.status)).length;
    $("roster-copy").disabled=count===0;
    $("roster-copy-status").textContent=count?`Копируются только отмеченные · ${count}`:(roster.length?"Отметьте присутствующих или отсутствующих":"Сначала добавьте учеников");
  }

  function renderRosterPanel(){
    if(!activeGroup) return;
    const roster=getRoster(activeGroup);
    const daily=getDailyAttendance();
    const marks=daily.groups[activeGroup]||{};
    $("roster-date-label").textContent=`Отметки на сегодня · ${displayLocalDate()}`;
    $("roster-count").textContent=`${roster.length} учеников`;
    $("roster-editor").hidden=!rosterEditorOpen;
    $("roster-textarea").value=roster.map((student)=>student.name).join("\n");
    $("roster-edit").textContent=rosterEditorOpen?"Отменить изменения":"Изменить список";
    const list=$("roster-list");
    if(!roster.length){
      list.innerHTML=`<div class="empty">ДОБАВЬТЕ ФАМИЛИИ УЧЕНИКОВ В СПИСОК</div>`;
    }else{
      list.innerHTML=roster.map((student,index)=>{
        const mark=marks[student.id]||{};
        const status=["present","absent"].includes(mark.status)?mark.status:"unmarked";
        const present=status==="present",absent=status==="absent";
        return `<div class="student-row" data-student-row="${esc(student.id)}"><div class="student-name">${index+1}. ${esc(student.name)}</div><div class="student-controls"><button type="button" class="attendance-pill${present?" is-present":""}" data-student-id="${esc(student.id)}" data-attendance-status="present" aria-pressed="${present?"true":"false"}" aria-label="${esc(student.name)}: присутствует"><span class="attendance-mark">✓</span><span>Присутствует</span></button><button type="button" class="attendance-pill${absent?" is-absent":""}" data-student-id="${esc(student.id)}" data-attendance-status="absent" aria-pressed="${absent?"true":"false"}" aria-label="${esc(student.name)}: отсутствует"><span class="attendance-mark">✕</span><span>Отсутствует</span></button><label class="maybe-arrive"${absent?"":" hidden"}><input type="checkbox" data-may-come="${esc(student.id)}"${absent&&mark.mayCome?" checked":""}>Возможно придёт</label></div></div>`;
      }).join("");
    }
    updateRosterCopyAvailability();
  }

  function renderNotesPage(){
    const allNotes=noteEntries();
    const query=($("notes-search")?.value||"").trim().toLocaleLowerCase("ru");
    const notes=allNotes.filter((note)=>{
      if(!query) return true;
      const haystack=[note.group,note.date,note.number,note.text].join(" ").toLocaleLowerCase("ru");
      return haystack.includes(query);
    });
    $("notes-list").innerHTML=notes.map((note)=>{
      const key=encodeURIComponent(noteKey(note.group,note.date,note.number));
      const day=parsed?.days?.find((item)=>item.date===note.date);
      const groupData=day?.groups?.[note.group]||[];
      const lesson=groupData.find((item)=>String(item.number)===String(note.number));
      const subject=lesson?.entries?.[0]?.subject||"";
      const canOpen=!!day && !!parsed?.all_groups?.includes(note.group);
      return `<article class="note-card"><div><div class="note-card-context">${esc(note.group)} · ${esc(note.date)} · ${esc(note.number==="0"?"ВД":note.number)}-я пара${subject?` · ${esc(subject)}`:""}</div><div class="note-card-text">${esc(note.text)}</div></div><div class="note-card-actions"><button type="button" data-note-action="edit" data-note-key="${key}">Изменить</button><button type="button" data-note-action="open" data-note-key="${key}"${canOpen?"":" disabled title=\"Этой даты нет в загруженном расписании\""}>Открыть</button></div></article>`;
    }).join("");
    $("notes-empty").hidden=allNotes.length>0;
    $("notes-no-results").hidden=allNotes.length===0||notes.length>0;
    $("notes-list").hidden=!notes.length;
    $("notes-filter-count").textContent=query?`${notes.length} из ${allNotes.length}`:`${allNotes.length} заметок`;
    updateNotesCount();
    refreshIcsExportPicker();
  }

  function buildNotesBackup(){
    return JSON.stringify({format:"kkst-notes",version:1,exportedAt:new Date().toISOString(),notes:readNotes()},null,2);
  }
  function prepareNotesBackup(){
    $("notes-json").value=buildNotesBackup();
    $("notes-backup-status").textContent=`Подготовлено заметок: ${noteEntries().length}`;
  }
  async function copyNotesBackup(){
    const field=$("notes-json");
    if(!field.value.trim()) prepareNotesBackup();
    field.focus();field.select();
    try{
      if(navigator.clipboard?.writeText){await navigator.clipboard.writeText(field.value);$("notes-backup-status").textContent="JSON скопирован";return;}
    }catch(e){}
    const copied=document.execCommand&&document.execCommand("copy");
    $("notes-backup-status").textContent=copied?"JSON скопирован":"JSON выделен — скопируйте его вручную";
  }
  function importNotesBackup(){
    let payload;
    try{payload=JSON.parse($("notes-json").value);}catch(e){$("notes-backup-status").textContent="Не удалось прочитать JSON — проверьте текст";return;}
    if(!payload||payload.format!=="kkst-notes"||payload.version!==1||!payload.notes||typeof payload.notes!=="object"||Array.isArray(payload.notes)){
      $("notes-backup-status").textContent="Формат не распознан. Подготовьте резервную копию на этом сайте.";return;
    }
    const imported={};
    Object.values(payload.notes).forEach((note)=>{
      if(!note||typeof note!=="object") return;
      const group=String(note.group||"").trim(),date=String(note.date||""),number=String(note.number??""),text=String(note.text||"").trim();
      if(!group||!/^\d{2}\.\d{2}\.\d{4}$/.test(date)||!/^([0-7])$/.test(number)||!text) return;
      imported[noteKey(group,date,number)]={group,date,number,text,updatedAt:Number(note.updatedAt)||Date.now()};
    });
    if(Object.keys(payload.notes).length&&!Object.keys(imported).length){$("notes-backup-status").textContent="В JSON не найдено заметок подходящего формата";return;}
    const count=Object.keys(imported).length;
    if(!window.confirm(`Объединить ${count} заметок с текущими? Совпадающие заметки будут заменены импортированными.`)) return;
    const merged=readNotes();Object.assign(merged,imported);writeStoredObject("kkst-notes-v1",merged);
    renderNotesPage();prepareNotesBackup();
    $("notes-backup-status").textContent=`Импортировано: ${count}. Всего заметок: ${noteEntries().length}`;
  }

  function refreshIcsExportPicker(){
    const select=$("ics-export-source"),button=$("ics-export-button");
    if(!select||!button) return;
    if(!parsed){select.disabled=true;button.disabled=true;return;}
    const previous=select.value;
    const groups=parsed.all_groups||[],teachers=getTeacherCatalog();
    const groupOptions=groups.map((group)=>`<option value="g:${encodeURIComponent(group)}">${esc(group)}</option>`).join("");
    const teacherOptions=teachers.map((teacher)=>`<option value="t:${encodeURIComponent(teacher)}">${esc(teacher)}</option>`).join("");
    select.innerHTML=`<option value="">Выберите группу или преподавателя</option><optgroup label="Группы">${groupOptions}</optgroup><optgroup label="Преподаватели">${teacherOptions}</optgroup>`;
    const contextValue=activeGroup?`g:${encodeURIComponent(activeGroup)}`:activeTeacher?`t:${encodeURIComponent(activeTeacher)}`:"";
    const preferred=previous||lsGet("kkst-ics-export-target")||contextValue;
    select.value=preferred;if(!select.value&&contextValue) select.value=contextValue;
    select.disabled=false;button.disabled=!select.value;
  }
  function icsEscape(value){return String(value??"").replace(/\\/g,"\\\\").replace(/\r\n|\n|\r/g,"\\n").replace(/,/g,"\\,").replace(/;/g,"\\;");}
  function foldIcsLine(line){
    const parts=[];let current="",bytes=0;
    for(const character of String(line)){
      const size=new TextEncoder().encode(character).length;
      if(bytes+size>75){parts.push(current);current=" "+character;bytes=1+size;}
      else{current+=character;bytes+=size;}
    }
    parts.push(current);return parts.join("\r\n");
  }
  function icsDateTime(date,minute){
    const match=String(date||"").match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
    if(!match) return "";
    return `${match[3]}${match[2]}${match[1]}T${String(Math.floor(minute/60)).padStart(2,"0")}${String(minute%60).padStart(2,"0")}00`;
  }
  function makeIcsUid(value){
    const bytes=new TextEncoder().encode(value),hex=Array.from(bytes,(byte)=>byte.toString(16).padStart(2,"0")).join("");
    return `kkst-${hex}@schedule.local`;
  }
  function downloadScheduleIcs(){
    if(!parsed){$("ics-export-status").textContent="Расписание ещё не загружено";return;}
    const choice=$("ics-export-source").value,[kind,...encodedParts]=choice.split(":");
    let entity="";try{entity=decodeURIComponent(encodedParts.join(":"));}catch(e){}
    const valid=kind==="g"?parsed.all_groups.includes(entity):kind==="t"?getTeacherCatalog().includes(entity):false;
    if(!valid){$("ics-export-status").textContent="Сначала выберите группу или преподавателя";return;}
    const events=[];
    parsed.days.forEach((day,dayIndex)=>{
      const lessons=kind==="g"?(day.groups?.[entity]||[]):getTeacherDayEntries(dayIndex,entity);
      lessons.forEach((lesson)=>{
        const number=String(lesson.number),range=parsePairRange(timesFor(day.date)[number]||"");
        if(!range||!icsDateTime(day.date,range.start)||!icsDateTime(day.date,range.end)) return;
        const entries=lesson.entries||[];
        const subjects=kind==="g"?[...new Set(entries.map((entry)=>String(entry.subject||"").trim()).filter(Boolean))]:[String(lesson.subject||"").trim()].filter(Boolean);
        const groups=kind==="g"?[entity]:[...new Set((lesson.assignments||[]).map((assignment)=>assignment.group))];
        const rooms=kind==="g"?[...new Set(entries.map((entry)=>entry.room||"").filter(Boolean))]:[...new Set((lesson.assignments||[]).flatMap((assignment)=>assignment.rooms||[]))];
        const teachers=kind==="g"?[...new Set(entries.map((entry)=>entry.teacher||"").filter(Boolean))]:[entity];
        const pair=number==="0"?"ВД":`${number}-я пара`;
        const subject=subjects.join(" / ")||"Занятие";
        const title=`${entity} · ${pair} · ${subject}`;
        const description=[`Расписание ККСТ`,`Тип: ${kind==="g"?"группа":"преподаватель"}`,`Объект: ${entity}`,`Пара: ${pair}`,`Время: ${formatClockMinute(range.start)}–${formatClockMinute(range.end)}`,groups.length?`Группы: ${groups.join(", ")}`:"",teachers.length?`Преподаватели: ${teachers.join(", ")}`:"",rooms.length?`Кабинет: ${rooms.join(", ")}`:""].filter(Boolean).join("\n");
        const uid=makeIcsUid([kind,entity,day.date,number,title,groups.join(",")].join("|"));
        events.push({date:day.date,number,range,uid,title,description,location:rooms.join(", ")});
      });
    });
    if(!events.length){$("ics-export-status").textContent="В выбранном расписании нет занятий с распознанным временем";return;}
    events.sort((a,b)=>dateOrderKey(a.date).localeCompare(dateOrderKey(b.date))||a.range.start-b.range.start);
    const stamp=new Date().toISOString().replace(/[-:]/g,"").replace(/\.\d{3}Z$/,"Z");
    const lines=["BEGIN:VCALENDAR","VERSION:2.0","PRODID:-//KKST//Schedule Export//RU","CALSCALE:GREGORIAN","METHOD:PUBLISH",`X-WR-CALNAME:${icsEscape(`ККСТ · ${entity}`)}`];
    for(const event of events){
      lines.push("BEGIN:VEVENT",`UID:${event.uid}`,`DTSTAMP:${stamp}`,`DTSTART:${icsDateTime(event.date,event.range.start)}`,`DTEND:${icsDateTime(event.date,event.range.end)}`,`SUMMARY:${icsEscape(event.title)}`,`DESCRIPTION:${icsEscape(event.description)}`);
      if(event.location) lines.push(`LOCATION:${icsEscape(event.location)}`);
      lines.push("STATUS:CONFIRMED","TRANSP:OPAQUE");
      if($("ics-export-alarm").checked) lines.push("BEGIN:VALARM","ACTION:DISPLAY","TRIGGER;RELATED=START:PT0M",`DESCRIPTION:${icsEscape(`Началась пара ${event.number==="0"?"ВД":`${event.number}-я`}: ${entity}`)}`,"END:VALARM");
      lines.push("END:VEVENT");
    }
    lines.push("END:VCALENDAR");
    const content=lines.map(foldIcsLine).join("\r\n")+"\r\n";
    const blob=new Blob([content],{type:"text/calendar;charset=utf-8"}),url=URL.createObjectURL(blob),link=document.createElement("a");
    const safe=String(entity).replace(/[^\p{L}\p{N}._-]+/gu,"_");
    link.href=url;link.download=`kkst_${safe}.ics`;document.body.appendChild(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
    lsSet("kkst-ics-export-target",choice);
    $("ics-export-status").textContent=`Скачано событий: ${events.length}. Файл содержит только даты текущего загруженного расписания.`;
  }

  function openNotesPage(){
    $("group-screen").style.display="none";
    $("teacher-screen").style.display="none";
    $("schedule-screen").style.display="none";
    $("notes-screen").hidden=false;
    renderNotesPage();
    window.scrollTo({top:0,behavior:"smooth"});
  }

  function closeNotesPage(){
    $("notes-screen").hidden=true;
    $("group-screen").style.display=viewMode==="group-picker"?"block":"none";
    $("teacher-screen").style.display=viewMode==="teacher-picker"?"block":"none";
    $("schedule-screen").style.display=(viewMode==="group"||viewMode==="teacher")?"block":"none";
    window.scrollTo({top:0,behavior:"smooth"});
  }

  function openNoteTarget(note){
    const dayIndex=parsed?.days?.findIndex((day)=>day.date===note.date)??-1;
    const group=parsed ? RaspParser.findGroup(parsed,note.group) : null;
    if(!group || dayIndex<0) return;
    $("notes-screen").hidden=true;
    $("group-screen").style.display="none";
    $("teacher-screen").style.display="none";
    $("schedule-screen").style.display="block";
    activeGroup=group;activeTeacher=null;teacherReturnContext=null;viewMode="group";activeDayIndex=dayIndex;rosterPanelOpen=false;rosterEditorOpen=false;
    $("roster-panel").hidden=true;$("roster-open").setAttribute("aria-expanded","false");
    $("back-groups").textContent="← ВСЕ ГРУППЫ";
    renderSelectedDay();
    window.scrollTo({top:0,behavior:"smooth"});
  }

  function openNoteEditor(group,date,number){
    currentNoteContext={group,date,number:String(number)};
    const oldText=getNote(group,date,number);
    $("note-modal-context").textContent=`${group} · ${date} · ${number==="0"?"ВД":number}-я пара`;
    $("note-textarea").value=oldText;
    $("note-delete").hidden=!oldText;
    $("note-modal").hidden=false;
    setTimeout(()=>$("note-textarea").focus(),0);
  }

  function closeNoteEditor(){
    $("note-modal").hidden=true;
    currentNoteContext=null;
  }

  function saveNoteEditor(remove=false){
    if(!currentNoteContext) return;
    const context={...currentNoteContext};
    setNote(context.group,context.date,context.number,remove?"":$("note-textarea").value);
    closeNoteEditor();
    if(activeGroup===context.group && parsed?.days?.[activeDayIndex]?.date===context.date) renderSelectedDay();
    if(!$("notes-screen").hidden) renderNotesPage();
  }

  function renderDayNavigation(){
    const nav = $("day-nav");
    nav.innerHTML = "";
    parsed.days.forEach((day,index)=>{
      const date = dateObject(day);
      const weekday = weekdayName(day);
      const weekdayShort = date
        ? new Intl.DateTimeFormat("ru-RU",{weekday:"short"}).format(date).replace(/\./g,"").toLocaleUpperCase("ru")
        : weekday.slice(0,3).toLocaleUpperCase("ru");
      const isToday = day.date === currentDateString();
      const button = document.createElement("button");
      button.type = "button";
      button.className = "day-tab" + (index === activeDayIndex ? " active" : "");
      button.dataset.dayIndex = String(index);
      button.setAttribute("aria-pressed", index === activeDayIndex ? "true" : "false");
      button.setAttribute("aria-label", `${weekday}, ${day.date || "дата не указана"}${isToday ? ", сегодня" : ""}`);
      button.innerHTML = `<span class="day-tab-main"><span class="day-tab-weekday">${esc(weekdayShort)}</span><span class="day-tab-date">${esc(day.date || "")}</span></span>${isToday ? `<span class="day-tab-today">СЕГОДНЯ</span>` : ""}`;
      nav.appendChild(button);
    });
  }

  function renderSelectedDay(){
    if(!parsed || !parsed.days[activeDayIndex]) return;
    const sourceDay = parsed.days[activeDayIndex];
    const day = { title:sourceDay.title, date:sourceDay.date, lessons:activeGroup ? sourceDay.groups[activeGroup] || [] : [] };
    const days = [day];
    renderDayNavigation();
    lastBlob = null;
    const requestId = ++canvasRequestId;
    const dl = $("dl"), send = $("send");
    const rosterButton=$("roster-open"), rosterPanel=$("roster-panel");
    if(activeGroup){
      rosterButton.style.display="inline-block";
      rosterButton.setAttribute("aria-expanded",rosterPanelOpen?"true":"false");
      rosterPanel.hidden=!rosterPanelOpen;
      if(rosterPanelOpen) renderRosterPanel();
    }else{
      rosterButton.style.display="none";
      rosterPanel.hidden=true;
      rosterPanelOpen=false;
      rosterEditorOpen=false;
    }
    dl.style.display = "none";
    if(lastImageUrl){ URL.revokeObjectURL(lastImageUrl); lastImageUrl = null; }
    send.style.display = "none";
    send.disabled = true;
    if(viewMode === "teacher" && activeTeacher){
      const teacherRecords=getTeacherDayEntries(activeDayIndex,activeTeacher);
      const todayKey=dateOrderKey(day.date);
      const followingDays=parsed.days.filter((item)=>dateOrderKey(item.date)>todayKey).map((item)=>({date:item.date,items:getTeacherDayEntries(parsed.days.indexOf(item),activeTeacher)}));
      activityContext={date:day.date,kind:"teacher",items:teacherRecords,followingDays};
      renderTeacherBoard(activeTeacher, day, teacherRecords);
      const img=$("img"); if(img) img.style.display="none";
      return;
    }
    if(!activeGroup){activityContext=null;renderActivityPanel();return;}
    const todayKey=dateOrderKey(day.date);
    const followingDays=parsed.days.filter((item)=>dateOrderKey(item.date)>todayKey).map((item)=>({date:item.date,items:item.groups[activeGroup]||[]}));
    activityContext={date:day.date,kind:"group",items:day.lessons,followingDays};
    renderBoard(activeGroup, days);
    lastGroup = activeGroup;
    send.style.display = inTelegram && WORKER ? "inline-block" : "none";
    const canvas = RaspRender.render(activeGroup, days, $("cv"));
    canvas.toBlob((blob)=>{
      if(requestId !== canvasRequestId || !blob) return;
      lastBlob = blob;
      lastImageUrl = URL.createObjectURL(blob);
      dl.href = lastImageUrl;
      dl.download = `raspisanie_${activeGroup}_${String(day.date||"").replace(/\./g,"-")}.png`;
      dl.style.display = "inline-block";
      send.disabled = false;
    }, "image/png");
    const img=$("img"); if(img) img.style.display="none";
  }

  function setDay(index){
    if(!parsed || index < 0 || index >= parsed.days.length || index === activeDayIndex) return;
    activeDayIndex = index;
    renderSelectedDay();
  }

  function show(groupChoice){
    if(!parsed){ setStatus("Данные ещё загружаются", true); return; }
    const group = RaspParser.findGroup(parsed, groupChoice || "");
    if(!group){ setStatus("Не удалось открыть расписание этой группы", true); return; }
    hideNotesPage();
    viewMode = "group";
    teacherReturnContext = null;
    activeTeacher = null;
    activeGroup = group;
    activeDayIndex = defaultDayIndex(parsed.days);
    rosterPanelOpen=false;rosterEditorOpen=false;
    $("roster-panel").hidden=true;
    $("roster-open").setAttribute("aria-expanded","false");
    $("group-screen").style.display = "none";
    $("teacher-screen").style.display = "none";
    $("schedule-screen").style.display = "block";
    $("back-groups").textContent = "← ВСЕ ГРУППЫ";
    renderSelectedDay();
    lsSet("lastGroup", group);
    window.scrollTo({top:0, behavior:"smooth"});
  }

  function openTeacherPicker(){
    if(!parsed) return;
    hideNotesPage();
    viewMode = "teacher-picker";
    teacherReturnContext = null;
    activeGroup = null;
    activeTeacher = null;
    renderTeacherPicker();
    $("group-screen").style.display = "none";
    $("schedule-screen").style.display = "none";
    $("teacher-screen").style.display = "block";
    window.scrollTo({top:0, behavior:"smooth"});
  }

  function openTeacher(teacherName, fromGroupSchedule){
    if(!parsed || !teacherName) return;
    hideNotesPage();
    teacherReturnContext = fromGroupSchedule && viewMode === "group" && activeGroup
      ? { group:activeGroup, dayIndex:activeDayIndex }
      : null;
    activeTeacher = teacherName;
    activeGroup = null;
    viewMode = "teacher";
    activeDayIndex = teacherReturnContext ? teacherReturnContext.dayIndex : defaultDayIndex(parsed.days);
    $("group-screen").style.display = "none";
    $("teacher-screen").style.display = "none";
    $("schedule-screen").style.display = "block";
    $("back-groups").textContent = teacherReturnContext ? "← К РАСПИСАНИЮ ГРУППЫ" : "← К ПРЕПОДАВАТЕЛЯМ";
    renderSelectedDay();
    window.scrollTo({top:0, behavior:"smooth"});
  }

  function backToGroups(){
    hideNotesPage();
    if(viewMode === "teacher" && teacherReturnContext){
      activeGroup = teacherReturnContext.group;
      activeDayIndex = teacherReturnContext.dayIndex;
      activeTeacher = null;
      teacherReturnContext = null;
      viewMode = "group";
      $("teacher-screen").style.display = "none";
      $("group-screen").style.display = "none";
      $("schedule-screen").style.display = "block";
      $("back-groups").textContent = "← ВСЕ ГРУППЫ";
      renderSelectedDay();
      window.scrollTo({top:0, behavior:"smooth"});
      return;
    }
    if(viewMode === "teacher"){
      activeTeacher = null;
      activeGroup = null;
      viewMode = "teacher-picker";
      $("schedule-screen").style.display = "none";
      $("teacher-screen").style.display = "block";
      renderTeacherPicker();
      window.scrollTo({top:0, behavior:"smooth"});
      return;
    }
    activeGroup = null;
    activeTeacher = null;
    viewMode = "group-picker";
    $("schedule-screen").style.display = "none";
    $("teacher-screen").style.display = "none";
    $("group-screen").style.display = "block";
    $("send").style.display = "none";
    $("dl").style.display = "none";
    setStatus(`${parsed ? parsed.all_groups.length : 0} групп доступно.`);
    window.scrollTo({top:0, behavior:"smooth"});
  }

  function backFromTeacherPicker(){
    hideNotesPage();
    viewMode = "group-picker";
    $("teacher-screen").style.display = "none";
    $("group-screen").style.display = "block";
    window.scrollTo({top:0, behavior:"smooth"});
  }

  async function sendToChat(){
    if(!lastBlob || !inTelegram || !WORKER) return;
    const btn=$("send"); btn.disabled=true; btn.textContent="Отправляю…";
    try{
      const selectedDate = parsed?.days?.[activeDayIndex]?.date || "";
      const filename = `raspisanie_${lastGroup}_${String(selectedDate).replace(/\./g,"-")}.png`;
      const fd=new FormData(); fd.append("initData", tg.initData); fd.append("photo", lastBlob, filename); fd.append("caption", `Расписание ${lastGroup}${selectedDate ? " · "+selectedDate : ""}`);
      const r=await fetch(WORKER+"/send",{method:"POST", body:fd}); const j=await r.json();
      if(!j.ok) throw new Error(j.error||"ошибка воркера");
      btn.textContent="Отправлено ✓";
      try{tg.HapticFeedback.notificationOccurred("success")}catch(e){}
      setTimeout(()=>{ try{tg.close()}catch(e){} },700);
    }catch(e){
      btn.disabled=false; btn.textContent="📤 ОТПРАВИТЬ В ЧАТ";
      setStatus("Не удалось отправить: "+e.message, true);
    }
  }

  function saveRosterEditor(){
    if(!activeGroup) return;
    const previous=getRoster(activeGroup);
    const students=rosterFromText($("roster-textarea").value,previous);
    const rosters=readRosters();
    rosters[activeGroup]=students;
    writeStoredObject("kkst-rosters-v1",rosters);
    const daily=getDailyAttendance();
    const validIds=new Set(students.map((student)=>student.id));
    const marks=daily.groups[activeGroup]||{};
    for(const id of Object.keys(marks)) if(!validIds.has(id)) delete marks[id];
    daily.groups[activeGroup]=marks;
    writeStoredObject("kkst-attendance-v1",daily);
    rosterEditorOpen=false;
    renderRosterPanel();
  }

  function legacyCopyText(text){
    try{
      const area=document.createElement("textarea");
      area.value=text;area.setAttribute("readonly","");
      area.style.position="fixed";area.style.left="-9999px";area.style.top="0";area.style.fontSize="16px";
      document.body.appendChild(area);area.focus();area.select();area.setSelectionRange(0,area.value.length);
      const copied=!!document.execCommand("copy");area.remove();return copied;
    }catch(e){ return false; }
  }

  async function copyRoster(){
    if(!activeGroup) return;
    const roster=getRoster(activeGroup);
    const marks=getDailyAttendance().groups[activeGroup]||{};
    const present=roster.filter((student)=>marks[student.id]?.status==="present");
    const absent=roster.filter((student)=>marks[student.id]?.status==="absent");
    if(!present.length && !absent.length){updateRosterCopyAvailability();return;}
    const lines=[`Посещаемость · ${activeGroup} · ${displayLocalDate()}`];
    if(present.length) lines.push("Присутствуют:",...present.map((student,index)=>`${index+1}. ${student.name}`));
    if(absent.length) lines.push("Отсутствуют:",...absent.map((student,index)=>`${index+1}. ${student.name}${marks[student.id]?.mayCome?" (возможно придёт)":""}`));
    const text=lines.join("\n");
    let modernPromise=null;
    try{ if(navigator.clipboard && navigator.clipboard.writeText) modernPromise=navigator.clipboard.writeText(text); }catch(e){}
    let copied=legacyCopyText(text);
    if(modernPromise){try{await modernPromise;copied=true;}catch(e){}}
    const fallback=$("roster-copy-fallback");
    if(copied){
      fallback.hidden=true;
      $("roster-copy-status").textContent="Список скопирован";
    }else{
      $("roster-copy-text").value=text;
      fallback.hidden=false;
      $("roster-copy-text").focus();$("roster-copy-text").select();
      $("roster-copy-status").textContent="Автокопирование заблокировано — скопируйте выделенный текст";
    }
  }


  $("open-notes").addEventListener("click",openNotesPage);
  $("notes-close").addEventListener("click",closeNotesPage);
  $("notes-search").addEventListener("input",renderNotesPage);
  $("notes-json-export").addEventListener("click",prepareNotesBackup);
  $("notes-json-copy").addEventListener("click",copyNotesBackup);
  $("notes-json-import").addEventListener("click",importNotesBackup);
  $("ics-export-source").addEventListener("change",(event)=>{$("ics-export-button").disabled=!event.target.value;lsSet("kkst-ics-export-target",event.target.value);});
  $("ics-export-button").addEventListener("click",downloadScheduleIcs);
  $("notes-list").addEventListener("click",(event)=>{
    const button=event.target.closest("button[data-note-action]");
    if(!button) return;
    let key,note;
    try{ key=decodeURIComponent(button.dataset.noteKey);note=readNotes()[key]; }catch(e){ return; }
    if(!note) return;
    if(button.dataset.noteAction==="edit") openNoteEditor(note.group,note.date,note.number);
    if(button.dataset.noteAction==="open") openNoteTarget(note);
  });
  $("note-save").addEventListener("click",()=>saveNoteEditor(false));
  $("note-delete").addEventListener("click",()=>saveNoteEditor(true));
  $("note-cancel").addEventListener("click",closeNoteEditor);
  $("note-modal").addEventListener("click",(event)=>{ if(event.target === $("note-modal")) closeNoteEditor(); });
  document.addEventListener("keydown",(event)=>{ if(event.key==="Escape" && !$("note-modal").hidden) closeNoteEditor(); });

  $("roster-open").addEventListener("click",()=>{
    if(!activeGroup) return;
    rosterPanelOpen=!rosterPanelOpen;
    if(rosterPanelOpen && !getRoster(activeGroup).length) rosterEditorOpen=true;
    $("roster-panel").hidden=!rosterPanelOpen;
    $("roster-open").setAttribute("aria-expanded",rosterPanelOpen?"true":"false");
    if(rosterPanelOpen){renderRosterPanel();$("roster-panel").scrollIntoView({behavior:"smooth",block:"nearest"});}
  });
  $("roster-edit").addEventListener("click",()=>{ rosterEditorOpen=!rosterEditorOpen;renderRosterPanel();if(rosterEditorOpen) $("roster-textarea").focus(); });
  $("roster-save").addEventListener("click",saveRosterEditor);
  $("roster-cancel").addEventListener("click",()=>{rosterEditorOpen=false;renderRosterPanel();});
  $("roster-copy").addEventListener("click",copyRoster);
  $("roster-list").addEventListener("click",(event)=>{
    const button=event.target.closest("button[data-attendance-status]");
    if(!button || !activeGroup) return;
    const row=button.closest(".student-row");
    const studentId=button.dataset.studentId;
    const nextStatus=button.getAttribute("aria-pressed")==="true"?"unmarked":button.dataset.attendanceStatus;
    updateStudentAttendance(activeGroup,studentId,nextStatus,false);
    row.querySelectorAll("button[data-attendance-status]").forEach((item)=>{
      const selected=nextStatus!=="unmarked" && item.dataset.attendanceStatus===nextStatus;
      item.classList.toggle("is-present",selected && nextStatus==="present");
      item.classList.toggle("is-absent",selected && nextStatus==="absent");
      item.setAttribute("aria-pressed",selected?"true":"false");
    });
    const maybe=row.querySelector(".maybe-arrive");
    const checkbox=maybe.querySelector("input");
    maybe.hidden=nextStatus!=="absent";
    if(nextStatus!=="absent"){checkbox.checked=false;maybe.classList.remove("is-checked");}
    updateRosterCopyAvailability();
  });
  $("roster-list").addEventListener("change",(event)=>{
    const checkbox=event.target.closest("input[data-may-come]");
    if(!checkbox || !activeGroup) return;
    checkbox.closest(".maybe-arrive").classList.toggle("is-checked",checkbox.checked);
    updateStudentAttendance(activeGroup,checkbox.dataset.mayCome,"absent",checkbox.checked);
  });

  $("group-bubbles").addEventListener("click", (event)=>{
    const button = event.target.closest("button[data-group]");
    if(button) show(button.dataset.group);
  });
  $("open-teachers").onclick=openTeacherPicker;
  $("teacher-back-groups").onclick=backFromTeacherPicker;
  $("teacher-list").addEventListener("click",(event)=>{
    const button = event.target.closest("button[data-teacher]");
    if(button) openTeacher(button.dataset.teacher,false);
  });
  $("teacher-filter").addEventListener("input",filterTeacherPicker);
  $("clear-teacher-filter").onclick=()=>{ $("teacher-filter").value=""; filterTeacherPicker(); };
  $("board").addEventListener("click",(event)=>{
    const favorite=event.target.closest("button[data-favorite-type]");
    if(favorite){toggleFavorite(favorite.dataset.favoriteType,favorite.dataset.favoriteValue);return;}
    const note=event.target.closest("button[data-note-number]");
    if(note && viewMode==="group" && activeGroup){
      const date=parsed?.days?.[activeDayIndex]?.date;
      if(date) openNoteEditor(activeGroup,date,note.dataset.noteNumber);
      return;
    }
    const teacher=event.target.closest("button[data-teacher]");
    if(teacher && viewMode === "group") openTeacher(teacher.dataset.teacher,true);
  });
  const familyNav=$("family-nav");
  let familyNavMouseDown=false,familyNavDragMoved=false,familyNavStartX=0,familyNavStartScroll=0,suppressFamilyClick=false;
  familyNav.addEventListener("mousedown",(event)=>{
    if(event.button!==0) return;
    familyNavMouseDown=true;familyNavDragMoved=false;familyNavStartX=event.pageX;familyNavStartScroll=familyNav.scrollLeft;
  });
  document.addEventListener("mousemove",(event)=>{
    if(!familyNavMouseDown) return;
    const delta=event.pageX-familyNavStartX;
    if(Math.abs(delta)>5){familyNavDragMoved=true;familyNav.classList.add("is-dragging");event.preventDefault();}
    if(familyNavDragMoved) familyNav.scrollLeft=familyNavStartScroll-delta;
  });
  document.addEventListener("mouseup",()=>{
    if(!familyNavMouseDown) return;
    familyNavMouseDown=false;familyNav.classList.remove("is-dragging");
    if(familyNavDragMoved){suppressFamilyClick=true;setTimeout(()=>{suppressFamilyClick=false;},0);}
  });
  window.addEventListener("blur",()=>{familyNavMouseDown=false;familyNav.classList.remove("is-dragging");});
  familyNav.addEventListener("click", (event)=>{
    if(suppressFamilyClick){event.preventDefault();return;}
    const button = event.target.closest("button[data-family]");
    if(!button) return;
    activeFamilyFilter = button.dataset.family;
    document.querySelectorAll(".family-filter").forEach((item)=>{
      const active = item === button;
      item.classList.toggle("active", active);
      item.setAttribute("aria-pressed", active ? "true" : "false");
    });
    applyGroupFilters();
  });
  $("group-filter").addEventListener("input", applyGroupFilters);
  $("clear-filter").onclick=()=>{
    $("group-filter").value = "";
    activeFamilyFilter = "*";
    document.querySelectorAll(".family-filter").forEach((item)=>{
      const active = item.dataset.family === "*";
      item.classList.toggle("active", active);
      item.setAttribute("aria-pressed", active ? "true" : "false");
    });
    applyGroupFilters();
  };
  $("day-nav").addEventListener("click",(event)=>{
    const button = event.target.closest("button[data-day-index]");
    if(button) setDay(Number(button.dataset.dayIndex));
  });
  $("back-groups").onclick=backToGroups;
  $("send").onclick=sendToChat;
  $("linkgo").onclick=applyManualLink;
  $("refresh").onclick=async()=>{
    const keepGroup = activeGroup;
    const keepTeacher = activeTeacher;
    const keepMode = viewMode;
    const keepContext = teacherReturnContext ? {...teacherReturnContext} : null;
    const keepDate = parsed?.days?.[activeDayIndex]?.date;
    if(await loadData(true)){
      if(keepMode === "teacher" && keepTeacher){
        activeGroup = null;
        activeTeacher = keepTeacher;
        viewMode = "teacher";
        const idx = parsed.days.findIndex((day)=>day.date === keepDate);
        activeDayIndex = idx >= 0 ? idx : defaultDayIndex(parsed.days);
        if(keepContext && parsed.all_groups.includes(keepContext.group)){
          const contextDay = parsed.days.findIndex((day)=>day.date === keepDate);
          teacherReturnContext = {group:keepContext.group,dayIndex:contextDay >= 0 ? contextDay : defaultDayIndex(parsed.days)};
        } else teacherReturnContext = null;
        $("group-screen").style.display="none";
        $("teacher-screen").style.display="none";
        $("schedule-screen").style.display="block";
        $("back-groups").textContent = teacherReturnContext ? "← К РАСПИСАНИЮ ГРУППЫ" : "← К ПРЕПОДАВАТЕЛЯМ";
        renderSelectedDay();
      } else if(keepGroup) show(keepGroup);
    }
  };

  document.addEventListener("visibilitychange",()=>{
    getDailyAttendance();
    if(rosterPanelOpen && activeGroup) renderRosterPanel();
  });
  window.addEventListener("focus",()=>{
    getDailyAttendance();
    if(rosterPanelOpen && activeGroup) renderRosterPanel();
  });
  updateNotesCount();
  getDailyAttendance();
  scheduleAttendanceRollover();
  updateCurrentLessonHighlights();
  setInterval(()=>updateCurrentLessonHighlights(),15*1000);
  document.addEventListener("visibilitychange",()=>{if(!document.hidden) updateCurrentLessonHighlights();});

  // Сначала синхронно открываем локальную копию, если она есть; обновление идёт в фоне без индикатора.
  startWithCachedSchedule();
})();
