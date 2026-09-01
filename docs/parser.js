// Парсер xlsx-расписания ГПОУ ККСТ. Портирован с Python-версии.
// Работает и в браузере (window.RaspParser), и в Node (module.exports).
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) module.exports = factory();
  else root.RaspParser = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const GROUP_RE = /^[А-ЯЁA-Z]{1,6}-\d{2,4}$/;
  const DATE_RE = /(\d{2}\.\d{2}\.\d{4})/;

  function norm(v) {
    if (v === null || v === undefined) return "";
    return String(v).replace(/\s+/g, " ").trim();
  }

  // XLSX — объект библиотеки SheetJS, data — ArrayBuffer/Uint8Array/Buffer
  function parseWorkbook(XLSX, data) {
    const wb = XLSX.read(data, { type: data instanceof ArrayBuffer ? "array" : "buffer" });
    // рабочий лист — самый большой
    let ws = null, best = -1;
    for (const name of wb.SheetNames) {
      const s = wb.Sheets[name];
      if (!s["!ref"]) continue;
      const r = XLSX.utils.decode_range(s["!ref"]);
      if (r.e.r > best) { best = r.e.r; ws = s; }
    }
    if (!ws) throw new Error("В файле нет данных");

    const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });
    const maxRow = aoa.length;
    let maxCol = 0;
    for (const row of aoa) maxCol = Math.max(maxCol, row ? row.length : 0);
    maxCol = Math.min(maxCol, 60);

    // grid[r][c], 1-базовая индексация
    function cell(r, c) {
      const row = aoa[r - 1];
      if (!row) return "";
      return norm(row[c - 1]);
    }

    // --- 1. строки-шапки
    const headers = [];
    for (let r = 1; r <= maxRow; r++) {
      if (cell(r, 1).toLowerCase() === "пара") {
        const discCols = [], audCols = [];
        for (let c = 2; c <= maxCol; c++) {
          const v = cell(r, c).toLowerCase();
          if (v.startsWith("дисциплина")) discCols.push(c);
          else if (v.startsWith("ауд")) audCols.push(c);
        }
        if (discCols.length && audCols.length) headers.push([r, discCols, audCols]);
      }
    }

    const days = [];
    headers.forEach(([hrow, discCols, audCols], hi) => {
      // --- заголовок секции (дата) — до 8 строк выше шапки
      const titleParts = [];
      let date = null;
      for (let r = Math.max(1, hrow - 8); r < hrow; r++) {
        const t = cell(r, 1);
        if (!t) continue;
        if (t.toLowerCase().includes("расписание") || DATE_RE.test(t)) {
          titleParts.push(t);
          const m = t.match(DATE_RE);
          if (m) date = m[1];
        }
      }
      const title = titleParts.length ? titleParts.join(" ") : "Расписание";

      // --- блоки групп: [start, aud, end]
      const blocks = [];
      discCols.forEach((dc, i) => {
        const aud = audCols.find((a) => a > dc);
        if (aud === undefined) return;
        const end = i + 1 < discCols.length ? discCols[i + 1] - 1 : Math.min(aud + 1, maxCol);
        blocks.push([dc, aud, end]);
      });

      let secEnd = hi + 1 < headers.length ? headers[hi + 1][0] - 1 : maxRow;
      if (hi + 1 < headers.length) {
        const nh = headers[hi + 1][0];
        for (let r = Math.max(1, nh - 8); r < nh; r++) {
          const t = cell(r, 1);
          if (t && (t.toLowerCase().includes("расписание") || DATE_RE.test(t))) {
            secEnd = Math.min(secEnd, r - 1);
            break;
          }
        }
      }

      // --- строки с названиями групп
      const groupRows = [];
      for (let r = hrow + 1; r <= secEnd; r++) {
        const names = {};
        let found = false;
        for (const [start] of blocks) {
          const v = cell(r, start);
          if (GROUP_RE.test(v)) { names[start] = v; found = true; }
        }
        if (found) groupRows.push([r, names]);
      }

      const groups = {};
      groupRows.forEach(([grow, names], gi) => {
        const gend = gi + 1 < groupRows.length ? groupRows[gi + 1][0] - 1 : secEnd;
        const pairRows = [];
        for (let r = grow + 1; r <= gend; r++)
          if (/^\d+$/.test(cell(r, 1))) pairRows.push(r);
        for (const [start, aud, end] of blocks) {
          const gname = names[start];
          if (!gname) continue;
          const lessons = [];
          pairRows.forEach((pr, pi) => {
            const prEnd = pi + 1 < pairRows.length ? pairRows[pi + 1] - 1 : gend;
            const entries = parsePair(cell, pr, prEnd, start, aud, end);
            if (entries) lessons.push({ number: cell(pr, 1), entries });
          });
          groups[gname] = lessons;
        }
      });

      days.push({ title, date, groups });
    });

    const set = new Set();
    for (const d of days) for (const g of Object.keys(d.groups)) set.add(g);
    return { days, all_groups: Array.from(set).sort() };
  }

  function parsePair(cell, r0, r1, start, aud, end) {
    const discCols = [], audCols = [];
    for (let c = start; c < aud; c++) discCols.push(c);
    for (let c = aud; c <= end; c++) audCols.push(c);

    const subjByCol = {}, teachByCol = {};
    let subjRow = null;
    for (let r = r0; r <= r1; r++) {
      const vals = {};
      let any = false;
      for (const c of discCols) {
        const v = cell(r, c);
        if (v) { vals[c] = v; any = true; }
      }
      if (any && subjRow === null) {
        Object.assign(subjByCol, vals);
        subjRow = r;
      } else if (any && subjRow !== null && r > subjRow) {
        for (const c of Object.keys(vals))
          if (!(c in teachByCol)) teachByCol[c] = vals[c];
      }
    }
    if (!Object.keys(subjByCol).length) return null;

    const rooms = [];
    for (let r = r0; r <= r1; r++)
      for (const c of audCols) {
        const v = cell(r, c);
        if (v && !rooms.includes(v)) rooms.push(v);
      }

    const cols = Object.keys(subjByCol).map(Number).sort((a, b) => a - b);
    const many = cols.length > 1;
    return cols.map((c, i) => {
      let teacher = teachByCol[c] || "";
      if (!teacher && !many) {
        const tv = Object.values(teachByCol);
        if (tv.length) teacher = tv[0];
      }
      const room = i < rooms.length ? rooms[i] : (rooms.length ? rooms[rooms.length - 1] : "");
      return { subject: subjByCol[c], teacher, room, subgroup: many ? i + 1 : null };
    });
  }

  // --- нечёткий поиск группы
  const LAT = "ABCEHKMOPTXY", CYR = "АВСЕНКМОРТХУ";
  function canon(s) {
    s = String(s).replace(/[\s\-–—_]+/g, "").toUpperCase();
    let out = "";
    for (const ch of s) {
      const i = LAT.indexOf(ch);
      out += i >= 0 ? CYR[i] : ch;
    }
    return out;
  }

  function findGroup(parsed, query) {
    const q = canon(query);
    for (const g of parsed.all_groups) if (canon(g) === q) return g;
    const m = parsed.all_groups.filter((g) => canon(g).includes(q));
    return m.length === 1 ? m[0] : null;
  }

  return { parseWorkbook, findGroup, canon };
});
