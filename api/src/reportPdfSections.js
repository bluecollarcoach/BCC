'use strict';
/* ===========================================================================================
 * The new pages of the monthly report PDF, laid out from a reconciled `analysis`
 * (reportAnalysis.js). PURE LAYOUT: no arithmetic of its own beyond formatting - every figure it
 * draws was computed and tied out by the analysis, so the page and the numbers cannot disagree.
 * Returns pdfmake content only; the caller (buildReportDocDef) owns fonts, footer and fallback.
 * Everything printable goes through H.S (the Latin-1 sanitiser): Helvetica cannot draw more.
 * =========================================================================================== */

const GOLD = '#a8884a', INK = '#23262b', MUTE = '#8a8577', HAIR = '#e0ddd4', HEAD = '#f7f1e3', SOFT = '#fbf9f4';
const SEV = { action: '#c0392b', watch: '#b7791f', win: '#1f8a4c', info: '#8a8577' };
const ST = { good: '#1f8a4c', watch: '#b7791f', bad: '#c0392b', na: '#9aa0a6' };
const ST_WORD = { good: 'On track', watch: 'Watch', bad: 'Action', na: 'n/a' };
const GOOD = '#1f8a4c', BAD = '#c0392b', NEUTRAL = '#23262b';

function build(a, H, extra) {
  extra = extra || {};
  /* Helvetica text with no space in it never wraps (a pasted web address, a run of letters): it would run off the page and be cut. A
     word past 44 characters gets a space every 40 - only ever for such a token; names and sentences are untouched. */
  const S = (v) => H.S(String(v == null ? '' : v).replace(/\S{44,}/g, (m) => m.replace(/(\S{40})(?=\S)/g, '$1 ')));
  const P = a.pl || {};
  const usd = (n) => n == null || !isFinite(n) ? '-' : (n < -0.5 ? '(' + '$' + Math.round(-n).toLocaleString('en-US') + ')' : '$' + Math.round(Math.abs(n)).toLocaleString('en-US'));
  /* the whole-dollar figure that is printed (half away from zero, as usd() prints it) */
  const rnd = (x) => (x < 0 ? -1 : 1) * Math.round(Math.abs(x));
  const pct = (x) => x == null || !isFinite(x) ? '-' : Math.round(x * 100) + '%';
  const k = (v) => { if (v == null) return ''; const ab = Math.abs(v); return ab >= 1000 ? (v / 1000).toFixed(ab >= 10000 ? 0 : 1).replace(/\.0$/, '') + 'k' : String(Math.round(v)); };
  const head = (t, brk) => [Object.assign({ text: S(t), bold: true, fontSize: 13, color: INK, margin: [0, 0, 0, 3] }, brk ? { pageBreak: 'before' } : {}), H.rule()];
  const label = (t, top) => ({ __label: true, text: S(t), color: GOLD, bold: true, fontSize: 9, margin: [0, top == null ? 11 : top, 0, 5] });
  /* A heading must never be left alone at the foot of a page while the table or block it introduces starts the next one (seen on a real client's cash page): every
     heading is kept together with the node that follows it. The node loses its own `unbreakable` (nesting it would not help) and the pair becomes one. */
  const keep = (list) => {
    const out = [];
    for (let i = 0; i < list.length; i++) {
      const n = list[i];
      if (n && n.__label) {
        const lab = Object.assign({}, n); delete lab.__label;
        const nxt = list[i + 1];
        if (nxt && !nxt.__label) { const inner = Object.assign({}, nxt); delete inner.unbreakable; out.push({ unbreakable: true, stack: [lab, inner] }); i++; } else out.push(lab);
      } else out.push(n);
    }
    return out;
  };
  const note = (t, top) => ({ text: S(t), fontSize: 7.2, color: MUTE, margin: [0, top == null ? 4 : top, 0, 0] });
  const cellH = (t, al) => ({ text: S(t), bold: true, fontSize: 7.4, fillColor: HEAD, alignment: al || 'right' });
  const tbl = (widths, body, strongRows) => ({ table: { headerRows: 1, widths, body }, layout: { hLineWidth: (i) => (i === 1 ? 0.6 : 0.3), vLineWidth: () => 0, hLineColor: () => HAIR, paddingTop: () => 2.4, paddingBottom: () => 2.4, paddingLeft: () => 3, paddingRight: () => 3, fillColor: (ri) => (ri > 0 && strongRows && strongRows[ri - 1]) ? SOFT : null } });

  /* a signed change cell: "+$8,439 (7%)" coloured by whether it is good for the business */
  const chg = (cur, base, sign) => {
    if (cur == null || base == null) return { text: '-', alignment: 'right', fontSize: 7.6, color: MUTE };
    /* The difference of the figures PRINTED (whole dollars) - $43,495 against $45,766 is $2,271 even when the cents say $2,271.65 - so the
       three numbers in a row always foot, and the percent is taken from the same printed figures. */
    const rc = rnd(cur), rb = rnd(base), d = rc - rb;
    if (d === 0) return { text: '-', alignment: 'right', fontSize: 7.6, color: MUTE };
    /* a percent only when it means something: never off a zero base or across zero; under 1% is "<1%"; 300%+ is a multiple ("8x") */
    let ptxt = '';
    if (rb > 0 && rc >= 0) {
      const p = Math.round(Math.abs(d) / rb * 100);
      ptxt = p >= 300 ? ' (' + (rc / rb >= 20 ? Math.round(rc / rb) + '' : (Math.round(rc / rb * 10) / 10 + '').replace(/\.0$/, '')) + 'x)' : ' (' + (p === 0 ? '<1' : p) + '%)';
    }
    return { text: (d > 0 ? '+' : '-') + usd(Math.abs(d)) + ptxt, alignment: 'right', fontSize: 7.6, color: ((d > 0) === (sign > 0)) ? GOOD : BAD };
  };
  const pts = (cur, base) => {
    if (cur == null || base == null) return { text: '-', alignment: 'right', fontSize: 7.6, color: MUTE };
    const d = Math.round(cur * 100) - Math.round(base * 100);
    return { text: d === 0 ? '0 pts' : (d > 0 ? '+' : '-') + Math.abs(d) + ' pts', alignment: 'right', fontSize: 7.6, color: d === 0 ? MUTE : (d > 0 ? GOOD : BAD) };
  };
  const num = (v, bold) => ({ text: S(v), alignment: 'right', fontSize: 7.8, bold: !!bold });
  const lab = (t, bold, indent) => ({ text: S(t), fontSize: 7.8, bold: !!bold, margin: [indent || 0, 0, 0, 0] });

  /* ---------------------------------------------------------------- scorecard strip (cover) */
  const strip = () => (a.scorecard && a.scorecard.length) ? {
    table: { widths: a.scorecard.map(() => '*'), body: [a.scorecard.map(sc => ({ stack: [
      { canvas: [{ type: 'rect', x: 0, y: 0, w: 92, h: 3.4, color: ST[sc.status] || ST.na }], margin: [0, 0, 0, 3] },
      { text: [{ text: S(sc.title), bold: true, fontSize: 8.6 }, { text: S('  ' + (ST_WORD[sc.status] || '')), bold: true, fontSize: 6.8, color: ST[sc.status] || ST.na }] },
      { text: S(sc.line), fontSize: 6.9, color: '#555', margin: [0, 1.5, 0, 0] }
    ] }))] },
    layout: { hLineWidth: () => 0, vLineWidth: () => 0, paddingLeft: () => 3, paddingRight: () => 3, paddingTop: () => 0, paddingBottom: () => 0 }, margin: [0, 0, 0, 11]
  } : null;

  /* ---------------------------------------------------------------- charts: vector bars, one column per month */
  const barChart = (title, items, spec) => {
    const W = 44, HT = spec.height || 76, vals = [];
    items.forEach(it => { if (it.a != null) vals.push(it.a); if (it.b != null) vals.push(it.b); });
    const max = Math.max.apply(null, vals.concat([0])), min = Math.min.apply(null, vals.concat([0])), range = (max - min) || 1, scale = (HT - 4) / range, zeroY = max * scale + 2;
    const cols = items.map(it => {
      const bars = [{ type: 'rect', x: 0, y: 0, w: W, h: HT, color: '#ffffff' }];      // fixes the canvas height so every baseline lines up
      const pair = it.b != null, bw = pair ? 14 : 22, x0 = pair ? 6 : 11;
      const mk = (v, x, color) => { if (v == null) return; const h = Math.max(Math.abs(v) * scale, 0.5); bars.push({ type: 'rect', x, y: v >= 0 ? zeroY - h : zeroY, w: bw, h, color }); };
      if (pair) { mk(it.b, x0, spec.colorB); mk(it.a, x0 + bw + 2, spec.colorA); } else mk(it.a, x0, (it.a < 0 && spec.negColor) ? spec.negColor : spec.colorA);
      bars.push({ type: 'line', x1: 0, y1: zeroY, x2: W, y2: zeroY, lineWidth: 0.4, lineColor: '#b9b5a8' });
      return { width: W, stack: [{ canvas: bars }, { text: S(it.label), fontSize: 6.5, alignment: 'center', color: MUTE, margin: [0, 2, 0, 0] }, { text: S(k(it.a)), fontSize: 6.2, alignment: 'center', color: '#444' }] };
    });
    const sw = (color, t) => ({ columns: [{ canvas: [{ type: 'rect', x: 0, y: 2, w: 7, h: 7, color }], width: 10 }, { text: S(t), fontSize: 6.8, color: '#555', width: 'auto' }], columnGap: 2, width: 'auto' });
    const legend = [{ text: S(title), bold: true, fontSize: 8.4, width: '*' }].concat(spec.legend.map(l => sw(l[0], l[1])));
    return { unbreakable: true, margin: [0, 9, 0, 6], stack: [{ columns: legend, columnGap: 10, margin: [0, 0, 0, 3] }, { columns: cols, columnGap: 0 }] };
  };

  /* ---------------------------------------------------------------- Our read on the month */
  const dot = (sev) => ({ canvas: [{ type: 'ellipse', x: 4.5, y: 5.2, r1: 3.6, r2: 3.6, color: SEV[sev] || SEV.info }], width: 11, margin: [0, 1, 0, 0] });
  const insightBlock = (x) => ({ unbreakable: true, margin: [0, 0, 0, 7], columnGap: 3, columns: [dot(x.sev), { width: '*', stack: [
    { text: S(x.head), bold: true, fontSize: 9.5 },
    x.detail ? { text: S(x.detail), fontSize: 8.3, color: '#3b3e44', margin: [0, 1.5, 0, 0], lineHeight: 1.12 } : null,
    x.tip ? { text: S(x.tip), fontSize: 8.3, italics: true, color: '#7a6322', margin: [0, 2, 0, 0], lineHeight: 1.12 } : null
  ].filter(Boolean) }] });
  const shown = (a.insights || []).filter(x => x.aud !== 'coach' && x.include !== false);
  const attention = shown.filter(x => x.sev === 'action' || x.sev === 'watch'), wins = shown.filter(x => x.sev === 'win'), infos = shown.filter(x => x.sev === 'info');
  const readPage = [].concat(head('Our read on the month', true));
  if (attention.length) { readPage.push(label('WHAT NEEDS ATTENTION', 4)); attention.forEach(x => readPage.push(insightBlock(x))); }
  if (!attention.length && !wins.length && !infos.length) readPage.push({ text: 'No insights were selected for this report.', italics: true, color: MUTE, fontSize: 9 });
  if (wins.length) { readPage.push(label(attention.length ? 'WHAT IS WORKING' : 'WHAT IS WORKING', attention.length ? 11 : 4)); wins.forEach(x => readPage.push(insightBlock(x))); }
  if (infos.length) { readPage.push(label('ALSO WORTH KNOWING')); infos.forEach(x => readPage.push(insightBlock(x))); }
  const acts = (a.actions || []).filter(x => x && x.act);
  if (acts.length) {
    readPage.push(label('NEXT 30 DAYS: WHERE WE WOULD START'));
    readPage.push({ unbreakable: true, table: { widths: [14, '*'], body: acts.map((x, i) => [{ canvas: [{ type: 'rect', x: 1, y: 2, w: 8, h: 8, lineWidth: 0.9, lineColor: GOLD }], width: 14 }, { text: [{ text: (i + 1) + '.  ', bold: true, color: GOLD }, { text: S(x.act), bold: true }], fontSize: 9, margin: [0, 0, 0, 3] }]) }, layout: 'noBorders' });
  }

  /* ---------------------------------------------------------------- performance: month, year to date, trailing 12 */
  const defs = [['Revenue', 'rev', 'm', 1], ['Cost of revenue', 'cogs', 'm', -1], ['Gross profit', 'gp', 'm', 1, true], ['Gross margin', 'gm', 'p', 1], ['Overhead', 'opex', 'm', -1], ['Operating income', 'opInc', 'm', 1], ['Other income / (expense)', 'other', 'm', 1], ['Net income', 'net', 'm', 1, true], ['Net margin', 'nm', 'p', 1]];
  const defsShort = defs.filter(d => ['rev', 'cogs', 'gp', 'gm', 'opex', 'net', 'nm'].indexOf(d[1]) >= 0);
  const cmpTable = (rows, blocks) => {
    /* blocks: [{ cur, label, vs: [{ base, label }] }] - first block's first column is the anchor */
    const header = [cellH('', 'left')]; const widths = ['*']; const strong = [];
    blocks.forEach(b => { header.push(cellH(b.label)); widths.push(58); b.vs.forEach(v => { header.push(cellH(v.label)); widths.push(58); header.push(cellH('Change')); widths.push(76); }); });
    const body = [header];
    rows.forEach(r => {
      const line = [lab(r[0], r[4])]; strong.push(!!r[4]);
      blocks.forEach(b => {
        const cv = b.cur ? b.cur[r[1]] : null; line.push(num(r[2] === 'p' ? pct(cv) : usd(cv), r[4]));
        b.vs.forEach(v => { const bv = v.base ? v.base[r[1]] : null; line.push(num(r[2] === 'p' ? pct(bv) : usd(bv), r[4])); line.push(r[2] === 'p' ? pts(cv, bv) : chg(cv, bv, r[3])); });
      });
      body.push(line);
    });
    return tbl(widths, body, strong);
  };
  const monthBlocks = [{ cur: P.cur, label: P.cur ? P.cur.label : '', vs: [] }];
  if (P.prior) monthBlocks[0].vs.push({ base: P.prior, label: P.prior.label });
  if (P.py) monthBlocks[0].vs.push({ base: P.py, label: P.py.label });
  const perfPage = [].concat(head('Performance: this month, last month, last year', true));
  perfPage.push(label('THE MONTH', 4), cmpTable(defs, monthBlocks));
  if (!P.py) perfPage.push(note('No same-month comparison for last year: that month is not a fair one to compare with (no revenue yet, or the first, partial month of the business).'));
  if (P.ytd) {
    const yb = []; yb.push({ cur: P.ytd, label: P.ytd.label, vs: P.pytd ? [{ base: P.pytd, label: P.pytd.label }] : [] });
    if (P.ttm) yb.push({ cur: P.ttm, label: 'Last 12 mo.', vs: P.pttm ? [{ base: P.pttm, label: 'Prior 12 mo.' }] : [] });
    // two comparison blocks side by side get wide: drop the cents-level columns before dropping a comparison
    perfPage.push(label('YEAR TO DATE AND LAST 12 MONTHS'), cmpTable(defsShort, yb.length > 1 && yb.some(b => b.vs.length) ? [yb[0]] : yb));
    if (yb.length > 1 && yb.some(b => b.vs.length)) perfPage.push({ text: '', margin: [0, 5, 0, 0] }, cmpTable(defsShort, [yb[1]]));
    if (!P.pytd) perfPage.push(note('No year-to-date comparison for last year: the books do not go back to the start of last year.'));
  }
  if (a.trend && a.trend.length) {
    perfPage.push(label('REVENUE BY MONTH, AGAINST THE SAME MONTH LAST YEAR'));
    perfPage.push(barChart('Revenue (thousands)', a.trend.map(t => ({ label: t.label.slice(0, 3), a: t.rev, b: t.py })), { colorA: GOLD, colorB: '#d6d2c4', legend: [[GOLD, 'This year'], ['#d6d2c4', 'Same month last year']] }));
    perfPage.push(barChart('Net income (thousands)', a.trend.map(t => ({ label: t.label.slice(0, 3), a: t.net })), { colorA: GOOD, negColor: BAD, legend: [[GOOD, 'Profit'], [BAD, 'Loss']], height: 64 }));
  }
  /* what moved */
  const mv = a.movers || {};
  const moversTable = (title, arr, ca, cb) => {
    const items = (arr || []).slice(0, 7); if (!items.length) return null;
    const body = [[cellH('Account', 'left'), cellH(ca), cellH(cb), cellH('Change')]], strong = [];
    items.forEach(m => { strong.push(false); body.push([lab(m.name + (m.seasonal ? ' *' : '')), num(usd(m.cur)), num(usd(m.base)), chg(m.cur, m.base, (m.good === (m.delta > 0)) ? 1 : -1)]); });
    return { unbreakable: true, stack: [label(title, 8), tbl(['*', 62, 62, 88], body, strong)] };
  };
  const m1 = P.prior ? moversTable('WHAT MOVED VS ' + (P.prior.label || '').toUpperCase(), mv.prior, P.cur.label, P.prior.label) : null;
  const m2 = P.py ? moversTable('WHAT MOVED VS ' + (P.py.label || '').toUpperCase(), mv.py, P.cur.label, P.py.label) : null;
  const m3 = P.pytd ? moversTable('WHAT MOVED YEAR TO DATE VS LAST YEAR', mv.ytd, P.ytd.label, P.pytd.label) : null;
  [m1, m2, m3].forEach(x => { if (x) perfPage.push(x); });
  if ((mv.prior || []).some(m => m.seasonal)) perfPage.push(note('* moved the same way in the same month last year, so it looks seasonal or annual rather than new.'));
  if (a.leafOk === false) perfPage.push(note('Account-level detail is not shown: the accounts did not add up to their section totals for this period.'));

  /* ---------------------------------------------------------------- cash, collections, obligations */
  const cashPage = [].concat(head('Cash, collections and obligations', true));
  const CF = a.cash;
  if (CF) {
    const lab2 = (t, amt) => {
      if (/accounts receivable|^a\/r\b/i.test(t)) return t + (amt < 0 ? ' (customers owe you more)' : ' (customers paid down)');
      if (/accounts payable|^a\/p\b/i.test(t)) return t + (amt > 0 ? ' (bills left unpaid)' : ' (bills paid down)');
      return t;
    };
    const inclU = CF.includesUndeposited ? ' (bank accounts plus undeposited funds)' : '';
    const rows = [[lab('Cash at the start of the month' + inclU), num(usd(CF.begin))]];
    const adj = (CF.adjustments || []).slice().sort((x, y) => Math.abs(y.amount) - Math.abs(x.amount));
    const topAdj = adj.slice(0, 4), restAdj = adj.slice(4).reduce((s, x) => s + x.amount, 0);
    rows.push([lab('Cash from operations', true), num(usd(CF.ops), true)]);
    if (CF.netIncome != null) rows.push([lab('Net income', false, 10), num(usd(CF.netIncome))]);
    topAdj.forEach(x => rows.push([lab(lab2(x.label, x.amount), false, 10), num(usd(x.amount))]));
    if (Math.abs(restAdj) >= 0.5) rows.push([lab('All other adjustments', false, 10), num(usd(restAdj))]);
    rows.push([lab('Cash from investing', true), num(usd(CF.inv), true)]);
    (CF.investing || []).slice(0, 2).forEach(x => rows.push([lab(x.label, false, 10), num(usd(x.amount))]));
    rows.push([lab('Cash from financing', true), num(usd(CF.fin), true)]);
    (CF.financing || []).sort((x, y) => Math.abs(y.amount) - Math.abs(x.amount)).slice(0, 3).forEach(x => rows.push([lab(x.label, false, 10), num(usd(x.amount))]));
    rows.push([lab('Net change in cash', true), num(usd(CF.net), true)], [lab('Cash at the end of the month' + inclU, true), num(usd(CF.end), true)]);
    const body = [[cellH('Where the cash went', 'left'), cellH('')]].concat(rows);
    const strong = body.slice(1).map(r => !!(r[0].bold));
    cashPage.push(label('WHERE THE CASH WENT', 4), { unbreakable: true, table: { headerRows: 0, widths: ['*', 90], body: rows }, layout: { hLineWidth: () => 0.3, vLineWidth: () => 0, hLineColor: () => HAIR, paddingTop: () => 2.2, paddingBottom: () => 2.2, fillColor: (ri) => rows[ri] && rows[ri][0].bold ? SOFT : null }, margin: [0, 0, 0, 2] });
  }
  if (a.trend && a.trend.length) cashPage.push(barChart('Cash at month-end (thousands)', a.trend.map(t => ({ label: t.label.slice(0, 3), a: t.cash })), { colorA: '#52606d', negColor: BAD, legend: [['#52606d', 'Cash'], [BAD, 'Overdrawn']], height: 60 }));
  if (a.bs && a.bs.cur) {
    const B = a.bs, defsB = [['Cash', 'cash', 1], ['Accounts receivable', 'ar', 0], ['Accounts payable', 'ap', 0], ['Credit cards', 'cc', -1], ['Line of credit', 'loc', -1], ['Long-term debt', 'ltd', -1], ['Total debt', 'debt', -1, true], ['Working capital', 'wc', 1], ['Equity', 'equity', 1, true]];
    const hdr = [cellH('Balance sheet', 'left'), cellH(P.cur.label)]; const widths = ['*', 60];
    if (B.prior) { hdr.push(cellH(P.prior.label), cellH('Change')); widths.push(60, 76); }
    if (B.py) { hdr.push(cellH(P.py.label), cellH('Change')); widths.push(60, 76); }
    const body = [hdr], strong = [];
    defsB.forEach(r => {
      const cv = B.cur[r[1]]; if (r[1] === 'loc' && !cv && !(B.prior && B.prior.loc) && !(B.py && B.py.loc)) return;
      strong.push(!!r[3]); const line = [lab(r[0], r[3]), num(usd(cv), r[3])];
      if (B.prior) { line.push(num(usd(B.prior[r[1]]), r[3]), r[2] === 0 ? chgNeutral(cv, B.prior[r[1]]) : chg(cv, B.prior[r[1]], r[2])); }
      if (B.py) { line.push(num(usd(B.py[r[1]]), r[3]), r[2] === 0 ? chgNeutral(cv, B.py[r[1]]) : chg(cv, B.py[r[1]], r[2])); }
      body.push(line);
    });
    const cr = [lab('Current ratio'), num(B.cur.currentRatio == null ? '-' : B.cur.currentRatio.toFixed(2))];
    if (B.prior) cr.push(num(B.prior.currentRatio == null ? '-' : B.prior.currentRatio.toFixed(2)), num(''));
    if (B.py) cr.push(num(B.py.currentRatio == null ? '-' : B.py.currentRatio.toFixed(2)), num(''));
    body.push(cr); strong.push(false);
    cashPage.push(label('BALANCE SHEET AT MONTH-END'), { unbreakable: true, stack: [tbl(widths, body, strong)] });
    if (a.dso && a.dso.cur != null) cashPage.push(note('Days to collect: ' + a.dso.cur + (a.dso.prior != null ? ' (' + a.dso.prior + ' last month' + (a.dso.py != null ? ', ' + a.dso.py + ' a year ago' : '') + ')' : '') + ' - A/R divided by average daily revenue over the last 3 months.' + (a.dpo && a.dpo.cur != null ? '   Days to pay: ' + a.dpo.cur + (a.dpo.prior != null ? ' (' + a.dpo.prior + ' last month)' : '') + ' - A/P divided by average daily costs over the last 3 months.' : '')));
  }
  function chgNeutral(cur, base) {
    if (cur == null || base == null) return { text: '-', alignment: 'right', fontSize: 7.6, color: MUTE };
    const d = rnd(cur) - rnd(base);   // the difference of the figures printed in the row
    if (d === 0) return { text: '-', alignment: 'right', fontSize: 7.6, color: MUTE };
    return { text: (d > 0 ? '+' : '-') + usd(Math.abs(d)), alignment: 'right', fontSize: 7.6, color: NEUTRAL };
  }
  const agingCol = (title, g, who) => {
    if (!g) return { text: S(title + ': not available'), fontSize: 8, color: MUTE };
    const bk = [['Current', g.cur], ['1-30 days', g.d30], ['31-60 days', g.d60], ['61-90 days', g.d90], ['Over 90 days', g.d90p]];
    const body = [[cellH(title, 'left'), cellH('Amount'), cellH('%')]];
    bk.forEach(r => body.push([lab(r[0]), num(usd(r[1])), num(g.total ? pct(r[1] / g.total) : '-')]));
    body.push([lab('Total', true), num(usd(g.total), true), num('')]);
    const names = (g.topPast && g.topPast.length ? g.topPast : g.top || []).slice(0, 5);
    const nb = [[cellH(who + ' with the most past due', 'left'), cellH('Past due'), cellH('Balance')]];
    names.forEach(x => nb.push([lab(x.name), num(usd(x.past)), num(usd(x.total))]));
    return { stack: [tbl(['*', 52, 30], body, body.slice(1).map((r, i) => i === body.length - 2)), names.length ? { stack: [{ text: '', margin: [0, 4, 0, 0] }, tbl(['*', 48, 52], nb, [])] } : null].filter(Boolean) };
  };
  if (a.ar || a.ap) cashPage.push(label('WHO OWES YOU, AND WHO YOU OWE'), { unbreakable: true, columns: [agingCol('Receivables (A/R)', a.ar, 'Customers'), agingCol('Payables (A/P)', a.ap, 'Vendors')], columnGap: 14 });
  if (CF === null && a.cashOk === false) cashPage.push(note('The cash-flow statement did not agree with the rest of the books this month, so the cash story is left out.'));

  /* ---------------------------------------------------------------- looking ahead */
  const aheadPage = [];
  const be = a.breakeven, ah = a.ahead;
  if (extra.forecast || (be && be.revenue != null) || ah) {
    aheadPage.push.apply(aheadPage, head('Looking ahead', true));
    if (extra.forecast) aheadPage.push(label('90-DAY CASH FLOW FORECAST', 4), extra.forecast);
    if (be && be.revenue != null) {
      const ratio = be.curRev / be.revenue;
      aheadPage.push(label('BREAK-EVEN'), { unbreakable: true, table: { widths: ['*'], body: [[{ stack: [
        { text: S('About ' + usd(be.revenue) + ' of revenue a month covers overhead before any profit'), bold: true, fontSize: 10 },
        { text: S('Overhead has averaged ' + usd(be.overhead) + ' a month over the last 3 months at a ' + pct(be.gm) + ' gross margin. This month revenue was ' + usd(be.curRev) + ', ' + pct(ratio) + ' of break-even. (Break-even = average overhead divided by gross margin.)'), fontSize: 8.4, margin: [0, 3, 0, 0], color: '#3b3e44' },
        (a.pl && a.pl.ttm && a.pl.ttm.rev > 0) ? { text: S('Each point of gross margin is worth about ' + usd(a.pl.ttm.rev * 0.01) + ' a year at your last 12 months of revenue.'), fontSize: 8.4, margin: [0, 2, 0, 0], color: '#3b3e44' } : null
      ].filter(Boolean), margin: [8, 6, 8, 6] }]] }, layout: { hLineWidth: () => 0.8, vLineWidth: () => 0.8, hLineColor: () => '#c5a55a', vLineColor: () => '#c5a55a', fillColor: () => '#fdfbf4' } });
    }
    if (ah) {
      const up = ah.change > 0;
      aheadPage.push(label('WHAT LAST YEAR DID NEXT'), { text: S('In ' + ah.thenLabel + ' revenue was ' + usd(ah.thenRev) + ', ' + (up ? 'up ' : 'down ') + Math.round(Math.abs(ah.change) * 100) + '% from ' + usd(ah.thisRev) + ' in ' + ah.thisLabel + '. That is last year\'s pattern, not a forecast: use it to plan cash for ' + ah.nextName + '.'), fontSize: 8.8, color: '#3b3e44' });
    }
  }

  /* the cover gets the three-sentence bottom line and the five-tile scorecard, under the title */
  const coverTop = [];
  if ((a.headline || []).length) {
    coverTop.push({ text: 'THE BOTTOM LINE', color: GOLD, bold: true, fontSize: 9, margin: [0, 0, 0, 4] });
    a.headline.forEach((h, i) => coverTop.push({ text: S(h), fontSize: i === 0 ? 10 : 9.2, bold: i === 0, color: INK, margin: [0, 0, 0, 3], lineHeight: 1.14 }));
    coverTop.push({ text: '', margin: [0, 4, 0, 0] });
  }
  /* long coach notes leave no room on the one-page cover: the scorecard then leads "Our read" (nothing is dropped) */
  const st = strip();
  if (st) { if (extra.compactCover) readPage.splice(2, 0, Object.assign({}, st, { margin: [0, 4, 0, 4] })); else coverTop.push(st); }
  return { strip: st, coverTop, compactCover: !!(st && extra.compactCover), body: [].concat(keep(readPage), keep(perfPage), keep(cashPage), keep(aheadPage)), hasForecastPage: !!extra.forecast && aheadPage.length > 0 };
}

module.exports = { build };
