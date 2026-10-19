// Отрисовка расписания группы в PNG на <canvas>. Порт render_png.py.
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) module.exports = factory();
  else root.RaspRender = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // Light editorial palette from the supplied visual reference; PNG drawing behavior is unchanged.
  const BG = "#EBF1F5", CARD = "#F4F7FA", ACCENT = "#E11D48", ACCENT_DARK = "#BE123C";
  const TEXT = "#1A2229", MUTED = "#627280", LINE = "#D3DFE9", ZEBRA = "#EDF2F6";
  const SUB_BADGE = "#FCE8EE", BADGE_BG = "#F4F7FA", BADGE_LN = "#E11D48";
  const WIN_BG = "#EEF3F7", WIN_TX = "#627280", WIN_LN = "#D3DFE9";

  // расписание звонков; '0' = ВД
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

  const FF = "'Geist', Arial, sans-serif";
  const DISPLAY = "'Geist', Arial, sans-serif";
  const MONO = "'Geist', Arial, sans-serif";
  const F = {
    title: "900 36px " + DISPLAY,
    day: "900 22px " + FF,
    num: "700 22px " + DISPLAY,
    time: "500 13px " + MONO,
    subj: "700 18px " + FF,
    small: "13px " + MONO,
    room: "700 16px " + DISPLAY,
    win: "13px " + MONO,
  };

  const W = 1000, PAD = 40, COL_NUM = 140, COL_ROOM = 130;
  const ROW_PAD = 20, LH_SUBJ = 28, LH_SMALL = 22, WIN_H = 52, MIN_ROW_H = 112;

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

  function buildRows(lessons) {
    const have = {};
    for (const l of lessons) have[l.number] = l;
    const present = PAIR_ORDER.filter((n) => n in have);
    if (!present.length) return [];
    const first = PAIR_ORDER.indexOf(present[0]);
    const last = PAIR_ORDER.indexOf(present[present.length - 1]);
    const rows = [];
    for (let i = first; i <= last; i++) {
      const n = PAIR_ORDER[i];
      if (n in have) rows.push(["lesson", have[n]]);
      else if (n !== "0") rows.push(["window", n]);
    }
    return rows;
  }

  function wrap(ctx, text, font, maxW) {
    ctx.font = font;
    const words = String(text).split(/\s+/).filter(Boolean);
    const lines = [];
    let cur = "";
    for (const w of words) {
      const t = (cur + " " + w).trim();
      if (ctx.measureText(t).width <= maxW || !cur) cur = t;
      else { lines.push(cur); cur = w; }
    }
    if (cur) lines.push(cur);
    return lines;
  }

  function rr(ctx, x0, y0, x1, y1, r) {
    // Square corners, matching the supplied editorial UI.
    ctx.beginPath();
    ctx.rect(x0, y0, x1 - x0, y1 - y0);
    ctx.closePath();
  }

  function tw(ctx, text, font) { ctx.font = font; return ctx.measureText(text).width; }
  function txt(ctx, x, y, text, font, color) {
    ctx.font = font; ctx.fillStyle = color; ctx.textBaseline = "top";
    ctx.fillText(text, x, y);
  }

  // The supplied light design is intentionally clean: no halftone texture.
  function halftone(ctx, x, y, w, h, step = 11, alpha = 0.12) {}

  // group: имя; days: [{title, date, lessons:[{number, entries}]}]
  // canvas: существующий canvas (будет перенастроен). Возвращает canvas.
  function render(group, days, canvas) {
    const meas = canvas.getContext("2d");
    const subjW = W - 2 * PAD - COL_NUM - COL_ROOM - 24;

    function lessonHeight(les) {
      let h = 0;
      for (const e of les.entries) {
        h += wrap(meas, e.subject, F.subj, subjW).length * LH_SUBJ;
        if (e.teacher) h += LH_SMALL;
        h += 6;
      }
      return Math.max(h + 2 * ROW_PAD, MIN_ROW_H);
    }

    const dayBlocks = [];
    let totalH = PAD + 56 + 10;
    for (const d of days) {
      const rows = buildRows(d.lessons);
      const heights = rows.map((r) => (r[0] === "lesson" ? lessonHeight(r[1]) : WIN_H));
      let blockH = 44 + heights.reduce((a, b) => a + b, 0) + 16;
      if (!rows.length) blockH = 44 + 56;
      dayBlocks.push([d, rows, heights, blockH]);
      totalH += blockH + 22;
    }
    totalH += PAD;

    canvas.width = W;
    canvas.height = totalH;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, W, totalH);

    // Шапка: тёмная плашка, красная метка и halftone только поверх неё.
    let y = PAD;
    rr(ctx, PAD - 8, y - 8, W - PAD + 8, y + 52, 8);
    ctx.fillStyle = CARD; ctx.fill(); ctx.strokeStyle = LINE; ctx.lineWidth = 1; ctx.stroke();
    ctx.fillStyle = ACCENT; ctx.fillRect(PAD - 8, y - 8, 4, 60);
    halftone(ctx, PAD - 4, y - 7, W - 2 * PAD + 8, 58, 10, 0.15);
    txt(ctx, PAD + 12, y + 2, group, F.title, TEXT);
    const label = "ККСТ // РАСПИСАНИЕ";
    txt(ctx, W - PAD - tw(ctx, label, F.small) - 12, y + 18, label, F.small, MUTED);
    y += 56 + 10;

    for (const [d, rows, heights, blockH] of dayBlocks) {
      const times = timesFor(d.date);

      rr(ctx, PAD - 8, y, W - PAD + 8, y + blockH, 8);
      ctx.fillStyle = CARD; ctx.fill();
      ctx.strokeStyle = LINE; ctx.lineWidth = 1; ctx.stroke();
      ctx.fillStyle = ACCENT; ctx.fillRect(PAD - 8, y, 3, blockH);
      halftone(ctx, PAD - 5, y + 1, W - 2 * PAD + 10, 42, 9, 0.14);
      txt(ctx, PAD + 8, y + 10, d.title, F.day, TEXT);
      let yy = y + 44;

      if (!rows.length) {
        txt(ctx, PAD + 8, yy + 14, "Занятий нет 🎉", F.subj, MUTED);
        y += blockH + 22;
        continue;
      }

      const xNum = PAD + 8, xSubj = PAD + COL_NUM + 8;

      rows.forEach(([kind, obj], i) => {
        const rh = heights[i];

        if (kind === "window") {
          rr(ctx, PAD - 2, yy + 5, W - PAD + 2, yy + rh - 5, 9);
          ctx.fillStyle = WIN_BG; ctx.fill();
          ctx.strokeStyle = WIN_LN; ctx.stroke();
          const num = obj, bw = 36;
          const bx = xNum + Math.floor((COL_NUM - bw) / 2) - 8;
          const by = yy + Math.floor((rh - 30) / 2);
          rr(ctx, bx, by, bx + bw, by + 30, 8);
          ctx.strokeStyle = WIN_TX; ctx.stroke();
          txt(ctx, bx + (bw - tw(ctx, num, F.num)) / 2, by + 2, num, F.num, WIN_TX);
          const t = times[num] || "";
          const msg = "окно — " + num + " пары нет" + (t ? "   ·   " + t : "");
          txt(ctx, xSubj, yy + Math.floor((rh - 20) / 2), msg, F.win, WIN_TX);
          yy += rh;
          return;
        }

        const les = obj;
        if (i % 2 === 1) {
          ctx.fillStyle = ZEBRA;
          ctx.fillRect(PAD - 7, yy, W - 2 * PAD + 14, rh);
          halftone(ctx, PAD - 6, yy, W - 2 * PAD + 12, rh, 9, 0.1);
        }

        // бейдж номера + время
        const num = les.number;
        const badge = num === "0" ? "ВД" : num;
        const bw = 44;
        const bx = xNum + Math.floor((COL_NUM - bw) / 2) - 8;
        const by = yy + ROW_PAD;
        rr(ctx, bx, by, bx + bw, by + 36, 10);
        ctx.fillStyle = BADGE_BG; ctx.fill();
        ctx.strokeStyle = BADGE_LN; ctx.stroke();
        txt(ctx, bx + (bw - tw(ctx, badge, F.num)) / 2, by + 5, badge, F.num, ACCENT_DARK);
        const t = times[num] || "";
        if (t) {
          const parts = t.split("–");
          parts.forEach((part, k) => {
            const ptw = tw(ctx, part, F.time);
            txt(ctx, xNum + (COL_NUM - 16 - ptw) / 2, by + 42 + k * 17, part, F.time, MUTED);
          });
        }

        let ey = yy + ROW_PAD - 2;
        for (const e of les.entries) {
          if (e.subgroup) {
            const tag = e.subgroup + " подгр.";
            const tagw = tw(ctx, tag, F.small) + 14;
            rr(ctx, xSubj, ey + 2, xSubj + tagw, ey + 24, 7);
            ctx.fillStyle = SUB_BADGE; ctx.fill();
            txt(ctx, xSubj + 7, ey + 3, tag, F.small, ACCENT_DARK);
            const lines = wrap(ctx, e.subject, F.subj, subjW - tagw - 10);
            txt(ctx, xSubj + tagw + 10, ey, lines[0], F.subj, TEXT);
            for (let li = 1; li < lines.length; li++) {
              ey += LH_SUBJ;
              txt(ctx, xSubj, ey, lines[li], F.subj, TEXT);
            }
            ey += LH_SUBJ;
          } else {
            for (const ln of wrap(ctx, e.subject, F.subj, subjW)) {
              txt(ctx, xSubj, ey, ln, F.subj, TEXT);
              ey += LH_SUBJ;
            }
          }
          if (e.teacher) {
            txt(ctx, xSubj, ey, e.teacher, F.small, MUTED);
            ey += LH_SMALL;
          }
          if (e.room) {
            const room = String(e.room);
            const rw = tw(ctx, room, F.room);
            const ry = ey - LH_SUBJ - (e.teacher ? LH_SMALL : 0);
            txt(ctx, W - PAD - 12 - rw, Math.max(yy + ROW_PAD, ry), room, F.room, ACCENT);
          }
          ey += 6;
        }

        yy += rh;
        const nxt = i + 1 < rows.length ? rows[i + 1][0] : null;
        if (nxt === "lesson") {
          ctx.strokeStyle = LINE;
          ctx.beginPath();
          ctx.moveTo(PAD + 4, yy);
          ctx.lineTo(W - PAD - 4, yy);
          ctx.stroke();
        }
      });

      y += blockH + 22;
    }

    return canvas;
  }

  return { render, buildRows, timesFor };
});
