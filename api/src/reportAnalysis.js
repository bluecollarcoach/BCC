'use strict';
/* ===========================================================================================
 * Monthly-report ANALYSIS ENGINE  (pure — no I/O, no Azure, no QuickBooks calls)
 *
 * Turns the QuickBooks reports a monthly report already pulls, plus a 24-month P&L and a
 * 24-month balance sheet, into: period comparisons (this month / last month / same month last
 * year / YTD / trailing 12), what moved and why, the cash story, collections and payables
 * with the customers and vendors NAMED, and a ranked list of insights with a coach's tip each.
 *
 * ACCURACY CONTRACT (this is a client deliverable; bookkeepers will check every figure):
 *   1. Everything is DETERMINISTIC from the books. No model, no guessing, no inferred causes —
 *      a sentence only states what the numbers prove, and its evidence travels with it.
 *   2. Nothing is printed unless it RECONCILES. Before any insight is built the 24-month
 *      series is tied back to the figures the report already shows (this month, last month,
 *      YTD, cash, equity, current assets/liabilities) and its own identities (gross profit =
 *      revenue - cost of revenue, section totals = the sum of their accounts, cash flow =
 *      beginning + change). If a fatal check fails the analysis reports ok:false and the
 *      report simply prints without it — a missing section is honest, a wrong one is not.
 *   3. A comparison that has no honest basis is OMITTED, never zero-filled: a company that did
 *      not exist a year ago has no "vs last year", and a part-year is never compared with a
 *      full year.
 *   4. Money is shown to the dollar, percentages to the whole percent, and every direction and
 *      percentage point difference is computed from the SAME rounded figures that are printed,
 *      so a line can never read "39%, down 4 points from 43%" over 40% and 43%.
 *   5. Output text is ASCII + Latin-1 only (the PDF font is Helvetica/WinAnsi).
 * =========================================================================================== */

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const TOL = 1.0;                      // dollars: how far two figures that should be equal may differ (cents of rounding across many accounts)
const SEV_WEIGHT = { action: 4, watch: 3, win: 2, info: 1 };

/* ------------------------------------------------------------------ small helpers */
const num = (s) => { const n = parseFloat(String(s == null ? '' : s).replace(/,/g, '')); return isNaN(n) ? 0 : n; };
const r2 = (n) => Math.round(n * 100) / 100;
/* The whole-dollar figure that is PRINTED: half away from zero, exactly as usd() prints it (Math.round alone rounds -51,605.5 up to -51,605 while the page shows -$51,606). */
const rnd = (x) => (x < 0 ? -1 : 1) * Math.round(Math.abs(x));
const isNum = (n) => typeof n === 'number' && isFinite(n);
const usd = (n) => { const a = Math.round(Math.abs(n || 0)); const s = '$' + a.toLocaleString('en-US'); return (n < 0 && a > 0) ? '-' + s : s; };
const usdUnsigned = (n) => '$' + Math.round(Math.abs(n || 0)).toLocaleString('en-US');
const pct0 = (x) => Math.round(x * 100) + '%';
const monthLabel = (key) => MONTH_ABBR[+key.slice(5, 7) - 1] + ' ' + key.slice(0, 4);
const monthName = (key) => MONTH_FULL[+key.slice(5, 7) - 1];
const addMonthsKey = (key, n) => { const y = +key.slice(0, 4), m = +key.slice(5, 7) - 1 + n; const yy = y + Math.floor(m / 12), mm = ((m % 12) + 12) % 12; return yy + '-' + String(mm + 1).padStart(2, '0'); };
const daysInMonthKey = (key) => new Date(Date.UTC(+key.slice(0, 4), +key.slice(5, 7), 0)).getUTCDate();
const sum = (a) => a.reduce((s, v) => s + v, 0);
const mean = (a) => a.length ? sum(a) / a.length : 0;
const plural = (n, one, many) => n + ' ' + (n === 1 ? one : (many || one + 's'));
const sigOf = (o) => { const s = JSON.stringify(o); let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); };

/* A relative change that is only reported when it means something. */
function pctChange(cur, base) {
  if (!isNum(cur) || !isNum(base)) return null;
  if (base <= 0.005 || cur < 0) return null;       // a percent of nothing, or across zero, is not a number anyone should read
  return (cur - base) / base;
}
/* "up $877 (1%) from April ($107,569)" / "unchanged from April ($x)" — the one place a comparison is phrased. */
function chgText(cur, base, baseLabel, fmt) {
  fmt = fmt || usd;
  if (!isNum(cur) || !isNum(base)) return '';
  const raw = cur - base;
  if (Math.abs(raw) < 0.5) return 'unchanged from ' + baseLabel + ' (' + fmt(base) + ')';
  /* The difference is taken between the figures AS PRINTED (whole dollars): a bookkeeper foots these, and $43,495 against $45,766 is $2,271 even when the cents
     say $2,272. The percent is taken from the same printed figures. */
  const rc = rnd(cur), rb = rnd(base), d = rc - rb;
  if (d === 0 || Math.abs(raw) < Math.abs(base) * 0.005) return 'about the same as ' + baseLabel + ' (' + fmt(base) + ')';   // never "unchanged" over a move big enough to see
  const p = pctChange(rc, rb);
  return (d > 0 ? 'up ' : 'down ') + usdUnsigned(d) + (p != null ? ' (' + (Math.round(Math.abs(p) * 100) === 0 ? '<1' : Math.round(Math.abs(p) * 100)) + '%)' : '') + ' from ' + baseLabel + ' (' + fmt(base) + ')';
}
/* Percentage-point difference computed on the rounded percents that are printed. */
function ptsDiff(curFrac, baseFrac) {
  if (!isNum(curFrac) || !isNum(baseFrac)) return null;
  return Math.round(curFrac * 100) - Math.round(baseFrac * 100);
}
const ptsText = (d) => (d === 0 ? 'unchanged' : (d > 0 ? 'up ' : 'down ') + plural(Math.abs(d), 'point'));

/* ------------------------------------------------------------------ report parsing */
function lastSummary(rows, group) {
  let r = null;
  for (const x of rows) if (x.group === group && x.type === 'summary') r = x;
  return r;
}
function hasAmount(cells) { return (cells || []).some(v => v !== '' && v != null && isNaN(parseFloat(String(v).replace(/,/g, ''))) === false); }

/* The month columns of a monthly-columns report, with the month each one ends. QuickBooks
   puts StartDate/EndDate in every column's metadata (verified against live books); the
   title ("Oct 2026") is only a fallback. The Total column has neither and is skipped. */
function monthColumns(flat) {
  const meta = flat.columnMeta || [], out = [];
  for (let i = 1; i < (flat.columns || []).length; i++) {
    let end = (meta[i] && meta[i].end) || '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(end)) {
      const mm = /^([A-Za-z]{3}) (\d{4})$/.exec(String(flat.columns[i] || ''));
      const mi = mm ? MONTH_ABBR.indexOf(mm[1]) : -1;
      end = mi >= 0 ? mm[2] + '-' + String(mi + 1).padStart(2, '0') + '-01' : '';
    }
    if (end) out.push({ cell: i - 1, key: end.slice(0, 7), end: end });
  }
  return out;
}

/* Every ACCOUNT line of a P&L, one entry per account, with its value in each month. An account
   is a `data` row, OR a `header` row that carries its own amount — a parent account with
   postings of its own shows them on its header line (live books: omitting these was off by
   up to $2.9M on one client). The section's own totals are `summary` rows and are never
   counted here. `parent` is the nearest enclosing header so two accounts that share a name
   can be told apart. */
function leavesOf(flat, cols) {
  const leaves = [], stack = [];
  for (const r of flat.rows || []) {
    if (r.type === 'header') {
      stack.length = r.level; stack[r.level] = r.label;
      if (hasAmount(r.cells)) leaves.push(mkLeaf(r, cols, stack.slice(0, r.level)));
    } else if (r.type === 'data') {
      leaves.push(mkLeaf(r, cols, stack.slice(0, r.level)));
    }
  }
  return leaves;
}
function mkLeaf(r, cols, parents) {
  return { label: String(r.label || '').trim(), parent: String(parents[parents.length - 1] || '').trim(), group: r.group || null, vals: cols.map(c => r2(num((r.cells || [])[c.cell]))) };
}
function sectionTotals(flat, cols, group) {
  const r = lastSummary(flat.rows || [], group);
  return r ? cols.map(c => r2(num((r.cells || [])[c.cell]))) : null;
}

/* ---- balance-sheet lookups. SAME precedence as the report's own KPI code (group code first,
   then the label), so a figure here can never disagree with the KPI box beside it. */
function bsRowByGroup(flat, group) {
  /* findByGroup's rule: the section total is the LAST summary row of the group; a section with no summary falls back to its last data row. */
  const rows = (flat.rows || []).filter(x => x.group === group);
  const sums = rows.filter(x => x.type === 'summary');
  return sums.length ? sums[sums.length - 1] : (rows.filter(x => x.type === 'data').slice(-1)[0] || null);
}
function bsRowByLabel(flat, rx) { return (flat.rows || []).find(x => rx.test(String(x.label || ''))) || null; }
function bsPick(flat, groups, labels) {
  for (const g of groups) { const r = bsRowByGroup(flat, g); if (r) return r; }
  for (const rx of labels) { const r = bsRowByLabel(flat, rx); if (r) return r; }
  return null;
}
function bsSumDataByLabel(flat, rx, cell, exclGroupRx) {
  return (flat.rows || []).filter(x => x.type === 'data' && rx.test(String(x.label || '')) && !(exclGroupRx && exclGroupRx.test(String(x.group || '')))).reduce((s, x) => s + num((x.cells || [])[cell]), 0);
}
function bsLongTermLines(flat, cell, limit) {
  const out = [];
  for (const x of flat.rows || []) {
    if (x.type !== 'data' || !/longtermliab/i.test(String(x.group || ''))) continue;
    const a = num((x.cells || [])[cell]); if (Math.abs(a) < 0.005) continue;
    out.push({ label: String(x.label || '').trim(), amount: a }); if (limit && out.length >= limit) break;
  }
  return out;
}
function bsAt(flat, cell) {
  const v = (row) => row ? r2(num((row.cells || [])[cell])) : 0;
  const cash = bsPick(flat, [], [/total bank accounts?/i, /bank accounts?/i, /checking|savings|cash on hand|^cash$/i]);
  const ar = bsPick(flat, ['AR'], [/total accounts receivable/i, /accounts receivable \(a\/r\)/i]);
  const ap = bsPick(flat, ['AP'], [/total accounts payable/i, /accounts payable \(a\/p\)/i]);
  const cc = bsPick(flat, ['CreditCard', 'CreditCards'], [/total credit cards?/i]);
  const ca = bsPick(flat, ['TotalCurrentAssets', 'CurrentAssets'], [/total current assets/i]);
  const cl = bsPick(flat, ['TotalCurrentLiabilities', 'CurrentLiabilities'], [/total current liabilities/i]);
  const ltl = bsPick(flat, ['TotalLongTermLiabilities', 'LongTermLiabilities'], [/total long.?term liabilities/i]);
  const eq = bsPick(flat, ['TotalEquity', 'Equity'], [/^total equity$/i]);
  const inv = bsRowByLabel(flat, /total inventory|^inventory$|inventory asset/i);
  const ta = bsPick(flat, ['TotalAssets'], [/^total assets$/i]);
  const o = {
    cash: v(cash), ar: v(ar), ap: v(ap), cc: v(cc), ca: v(ca), cl: v(cl), ltd: v(ltl), equity: v(eq), inventory: v(inv), assets: v(ta),
    loc: r2(bsSumDataByLabel(flat, /line of credit/i, cell, /longtermliab/i))   // a line of credit filed under long-term liabilities is already inside `ltd`
  };
  o.wc = r2(o.ca - o.cl);
  o.currentRatio = o.cl > 0 ? Math.round((o.ca / o.cl) * 100) / 100 : null;
  o.debt = r2(Math.max(0, o.cc) + Math.max(0, o.loc) + Math.max(0, o.ltd));   // only balances OWED count: a card in credit is not negative debt
  return o;
}

/* Cash-flow statement -> beginning / operations / investing / financing / ending, and the lines behind them. */
function parseCashFlow(flat) {
  if (!flat || !(flat.rows || []).length) return null;
  const last = (r) => r ? r2(num((r.cells || [])[r.cells.length - 1])) : null;
  const rows = flat.rows;
  const sumOf = (g) => last(lastSummary(rows, g));
  const beg = rows.find(x => x.group === 'BeginningCash' && x.type !== 'header');
  const ni = rows.find(x => x.group === 'NetIncome' && x.type !== 'summary');
  const lines = (g) => rows.filter(x => x.group === g && (x.type === 'data' || (x.type === 'header' && hasAmount(x.cells))))
    .map(x => ({ label: String(x.label || '').trim(), amount: r2(num((x.cells || [])[x.cells.length - 1])) })).filter(l => Math.abs(l.amount) >= 0.005);
  const cf = {
    begin: beg ? last(beg) : null, ops: sumOf('OperatingActivities'), inv: sumOf('InvestingActivities'), fin: sumOf('FinancingActivities'),
    net: sumOf('CashIncrease'), end: sumOf('EndingCash'), netIncome: ni ? last(ni) : null,
    adjustments: lines('OperatingAdjustments'), investing: lines('InvestingActivities'), financing: lines('FinancingActivities')
  };
  if (cf.net == null || cf.end == null || cf.begin == null) return null;
  if (cf.ops == null) cf.ops = 0; if (cf.inv == null) cf.inv = 0; if (cf.fin == null) cf.fin = 0;
  return cf;
}

/* Aged receivables / payables SUMMARY -> bucket totals + each customer/vendor's own buckets. */
function parseAging(flat) {
  if (!flat) return null;
  const cols = flat.columns || [];
  const ix = { cur: -1, b1: -1, b2: -1, b3: -1, b4: -1, total: -1 };
  cols.forEach((t, i) => {
    if (i === 0) return; const s = String(t || '');
    if (/^current$/i.test(s)) ix.cur = i - 1; else if (/^1\s*-\s*30/.test(s)) ix.b1 = i - 1; else if (/^31\s*-\s*60/.test(s)) ix.b2 = i - 1;
    else if (/^61\s*-\s*90/.test(s)) ix.b3 = i - 1; else if (/^91/.test(s)) ix.b4 = i - 1; else if (/^total$/i.test(s)) ix.total = i - 1;
  });
  if (ix.cur < 0 || ix.b1 < 0 || ix.b2 < 0 || ix.b3 < 0 || ix.b4 < 0 || ix.total < 0) return null;
  if (!(flat.rows || []).length) return { total: { name: 'TOTAL', cur: 0, d30: 0, d60: 0, d90: 0, d90p: 0, total: 0 }, items: [], ok: true, empty: true };   // no open invoices / bills at all
  const rec = (r, name) => ({ name: String(name != null ? name : r.label || '').trim(), cur: r2(num(r.cells[ix.cur])), d30: r2(num(r.cells[ix.b1])), d60: r2(num(r.cells[ix.b2])), d90: r2(num(r.cells[ix.b3])), d90p: r2(num(r.cells[ix.b4])), total: r2(num(r.cells[ix.total])) });
  const gt = (flat.rows || []).filter(x => x.group === 'GrandTotal' && x.type === 'summary').slice(-1)[0] || (flat.rows || []).filter(x => x.type === 'summary' && x.level === 0).slice(-1)[0];
  /* ONE ENTRY PER CUSTOMER / VENDOR. A customer with jobs under it is a section: a header (which carries the customer's OWN balance - live books,
     Central Ag), its jobs, and a "Total <customer>" line that already includes both. The customer's total is that summary line, not the sum of its job
     rows, and the customer - not the job - is who anyone would call. A customer with no jobs is a plain row. */
  const items = []; let section = '';
  for (const r of flat.rows || []) {
    if (r.group === 'GrandTotal') continue;
    if (r.type === 'header' && r.level === 0) section = String(r.label || '').trim();
    else if (r.type === 'summary' && r.level === 0) { const nm = section || String(r.label || '').replace(/^Total\s+/i, ''); if (nm.trim()) items.push(rec(r, nm)); section = ''; }
    else if (r.type === 'data' && r.level === 0 && String(r.label || '').trim()) items.push(rec(r));
  }
  if (!gt) return null;
  const tot = rec(gt);
  return { total: tot, items, ok: Math.abs(sum([tot.cur, tot.d30, tot.d60, tot.d90, tot.d90p]) - tot.total) <= TOL && Math.abs(sum(items.map(i => i.total)) - tot.total) <= TOL };
}

/* ------------------------------------------------------------------ the analysis */
/* Firm-wide targets (Admin -> Report goals). monthsCash is the cash the firm wants a client to keep, in months of overhead; investMinAmount is the smallest amount of
   cash above that target worth a suggestion (0 = never); slowSeasonDrop is the fall in revenue, last year, from the three months up to this point to the next three
   that counts as a slower season (0 = off); taxFromMonth is the first report month that carries year-end tax planning (0 = off) and taxMinProfit the year-to-date
   profit it needs. api/src/index.js REPORT_GOAL_DEFAULTS must hold the same values (a test compares them). */
const GOAL_DEFAULTS = { monthsCash: 6, monthsCashMin: 1, currentRatio: 1.5, currentRatioMin: 1, grossMargin: 0.30, grossMarginMin: 0.15, netMargin: 0.05, netMarginMin: 0, ccHighBalance: 10000, investMinAmount: 10000, slowSeasonDrop: 0.25, taxFromMonth: 8, taxMinProfit: 25000 };
const ANALYSIS_VERSION = 3;

function buildReportAnalysis(input) {
  input = input || {};
  const K = input.kpis || {}, goals = Object.assign({}, GOAL_DEFAULTS, input.goals || {});
  const A = { version: ANALYSIS_VERSION, ok: false, period: input.period || '', method: input.method || 'Accrual', integrity: { checks: [], failed: [] }, errors: [] };
  const check = (name, diff, fatal, note) => { const ok = isNum(diff) ? Math.abs(diff) <= TOL : false; A.integrity.checks.push({ name, ok, diff: isNum(diff) ? r2(diff) : null, fatal: !!fatal }); if (!ok && fatal) A.integrity.failed.push(name + (note ? ' (' + note + ')' : '')); return ok; };
  const fail = (name) => { A.integrity.checks.push({ name, ok: false, diff: null, fatal: true }); A.integrity.failed.push(name); };

  /* ---- 1. the P&L series ---- */
  const plS = input.plSeries;
  const cols = plS ? monthColumns(plS) : [];
  if (!plS || !cols.length) { fail('profit & loss by month is unavailable'); A.unavailable = true; return finish(A); }
  const keys = cols.map(c => c.key);
  if (keys.some((k, i) => i > 0 && k !== addMonthsKey(keys[i - 1], 1))) fail('month columns are not consecutive');
  const idx = keys.length - 1;
  if (keys[idx] !== A.period) fail('last month column (' + keys[idx] + ') is not the report month');
  const inc = sectionTotals(plS, cols, 'Income'), cogsT = sectionTotals(plS, cols, 'COGS'), gpT = sectionTotals(plS, cols, 'GrossProfit'),
    expT = sectionTotals(plS, cols, 'Expenses'), noiT = sectionTotals(plS, cols, 'NetOperatingIncome'), niT = sectionTotals(plS, cols, 'NetIncome');
  if (!inc) fail('P&L has no Income section'); if (!niT) fail('P&L has no Net Income row');
  if (A.integrity.failed.length) return finish(A);
  const z = keys.map(() => 0);
  const months = keys.map((k, i) => {
    const rev = inc[i], cogs = (cogsT || z)[i], opex = (expT || z)[i], net = niT[i];
    const gp = gpT ? gpT[i] : r2(rev - cogs), opInc = noiT ? noiT[i] : r2(gp - opex);
    return { key: k, label: monthLabel(k), rev, cogs, gp, opex, opInc, other: r2(net - opInc), net,
      /* "The business existed this month": real revenue, or real costs. A stray $25 bank fee in the first column of the window does not make a company a year old. */
      active: rev >= 1 || (cogs + opex) >= 250 };
  });
  let worst = (f) => months.reduce((w, m) => Math.max(w, Math.abs(f(m))), 0);
  check('gross profit = revenue - cost of revenue', worst(m => m.gp - (m.rev - m.cogs)), true);
  check('operating income = gross profit - overhead', worst(m => m.opInc - (m.gp - m.opex)), true);
  const nothT = sectionTotals(plS, cols, 'NetOtherIncome');
  if (nothT) check('net income = operating income + other income', worst2(months, (m, i) => m.net - (m.opInc + nothT[i])), true);

  /* The series must be the SAME numbers the report already shows. Tied to the cent against
     the single-month, prior-month and YTD pulls the KPI box is built from. */
  const cur = months[idx], prior = idx >= 1 ? months[idx - 1] : null;
  const ytdStart = idx - (+A.period.slice(5, 7) - 1);
  const ytdM = months.slice(Math.max(0, ytdStart), idx + 1);
  if (isNum(K.revenue)) check('revenue ties to the report', cur.rev - K.revenue, true);
  if (isNum(K.cogs)) check('cost of revenue ties to the report', cur.cogs - K.cogs, true);
  if (isNum(K.opex)) check('overhead ties to the report', cur.opex - K.opex, true);
  if (isNum(K.netIncome)) check('net income ties to the report', cur.net - K.netIncome, true);
  if (prior && isNum(K.revenuePrior)) check('last month revenue ties to the report', prior.rev - K.revenuePrior, true);
  if (prior && isNum(K.netIncomePrior)) check('last month net income ties to the report', prior.net - K.netIncomePrior, true);
  if (isNum(K.revenueYtd) && ytdStart >= 0) check('YTD revenue ties to the report', sum(ytdM.map(m => m.rev)) - K.revenueYtd, true);
  if (isNum(K.netIncomeYtd) && ytdStart >= 0) check('YTD net income ties to the report', sum(ytdM.map(m => m.net)) - K.netIncomeYtd, true);

  /* Account-level detail is only used if the accounts add up to their section totals in every month. */
  const leaves = leavesOf(plS, cols);
  let leafOk = true;
  [['Income', inc], ['COGS', cogsT], ['Expenses', expT], ['OtherIncome', sectionTotals(plS, cols, 'OtherIncome')], ['OtherExpenses', sectionTotals(plS, cols, 'OtherExpenses')]].forEach(([g, tot]) => {
    const mine = leaves.filter(l => l.group === g);
    if (!tot && !mine.length) return;
    const d = tot ? worst2(months, (m, i) => sum(mine.map(l => l.vals[i])) - tot[i]) : 99999;
    if (!check('accounts add up to ' + g, d, false)) leafOk = false;
  });

  /* ---- 2. the balance-sheet series ---- */
  const bsS = input.bsSeries; let bsCols = [], bsOk = false, B = null;
  if (bsS) {
    bsCols = monthColumns(bsS);
    const bk = bsCols.map(c => c.key);
    const aligned = bk.length === keys.length && bk.every((k, i) => k === keys[i]);
    if (!aligned) A.integrity.checks.push({ name: 'balance sheet months line up with the P&L', ok: false, diff: null, fatal: false });
    else {
      B = bsCols.map(c => bsAt(bsS, c.cell));
      let ok = true;
      const tie = (name, a, b) => { if (isNum(b) && !check(name, a - b, false)) ok = false; };
      tie('cash ties to the report', B[idx].cash, K.cash); tie('current assets tie to the report', B[idx].ca, K.currentAssets);
      tie('current liabilities tie to the report', B[idx].cl, K.currentLiabilities); tie('equity ties to the report', B[idx].equity, K.equity);
      if (idx >= 1) { tie('last month cash ties to the report', B[idx - 1].cash, K.cashPrior); tie('last month equity ties to the report', B[idx - 1].equity, K.equityPrior); }
      bsOk = ok;
    }
  }

  /* ---- 3. cash flow, aging ---- */
  const CF = input.cashFlow ? parseCashFlow(input.cashFlow) : null;
  let cashOk = false, cfProblem = null;
  if (CF) {
    const okA = check('cash flow: operations + investing + financing = change in cash', CF.ops + CF.inv + CF.fin - CF.net, false);
    const okB = check('cash flow: beginning cash + change = ending cash', CF.begin + CF.net - CF.end, false);
    const okD = CF.netIncome != null ? check('cash flow starts from the P&L net income', CF.netIncome - cur.net, false) : true;
    /* QuickBooks' cash-flow statement counts UNDEPOSITED FUNDS as cash (live books: bank $271,556.59 + undeposited $981.10 = the statement's
       $272,537.69). Its ending cash must tie to the report's cash either exactly, or with the undeposited funds the balance sheet shows;
       in the second case the story is kept and labelled, so it never contradicts the cash on the cover without saying why. */
    let okC = true;
    if (isNum(K.cash)) {
      const undep = (B && bsS) ? r2(bsS.rows.filter(x => x.type === 'data' && /undeposited funds/i.test(String(x.label || ''))).reduce((s, x) => s + num((x.cells || [])[bsCols[idx].cell]), 0)) : 0;
      const exact = Math.abs(CF.end - K.cash) <= TOL;
      if (!exact && undep && Math.abs(CF.end - (K.cash + undep)) <= TOL) { CF.includesUndeposited = undep; okC = check('cash flow ending cash = bank accounts + undeposited funds', CF.end - (K.cash + undep), false); }
      else okC = check('cash flow ending cash ties to the report', CF.end - K.cash, false);
    }
    cashOk = okA && okB && okC && okD;
    if (!cashOk) cfProblem = (okA && okB && okD && !okC && isNum(K.cash)) ? { kind: 'bank', end: CF.end, cash: K.cash } : ((okA && okB && okC && !okD) ? { kind: 'ni', cf: CF.netIncome, pl: cur.net } : { kind: 'broken' });
  }
  const AR = input.arSummary ? parseAging(input.arSummary) : null, AP = input.apSummary ? parseAging(input.apSummary) : null;
  A.agingParsed = { ar: !!(AR && AR.ok), ap: !!(AP && AP.ok) };       // both reports came back and read cleanly (an empty one counts) - whether the balance sheet agrees is a separate question
  const emptyOk = (g, bal) => !(g && g.empty) || (!!B && Math.abs(bal) <= TOL);       // "no rows" is only believed when the balance sheet shows nothing owed either
  const arOk = !!(AR && AR.ok) && emptyOk(AR, B ? B[idx].ar : 0), apOk = !!(AP && AP.ok) && emptyOk(AP, B ? B[idx].ap : 0);
  if (A.integrity.failed.length) return finish(A);

  /* ---- 4. period aggregates ---- */
  const firstActive = months.findIndex(m => m.active);
  /* The month the business genuinely STARTED: its first active month, but only when an inactive month precedes it. An active month at the very start of the window
     proves nothing (the books may go back years before it), so it is not treated as a start-up month. */
  const startIdx = firstActive > 0 ? firstActive : -1;
  const agg = (a, b) => {
    const ms = months.slice(a, b + 1);
    const o = { rev: r2(sum(ms.map(m => m.rev))), cogs: r2(sum(ms.map(m => m.cogs))), opex: r2(sum(ms.map(m => m.opex))), other: r2(sum(ms.map(m => m.other))), net: r2(sum(ms.map(m => m.net))), n: ms.length };
    o.gp = r2(o.rev - o.cogs); o.opInc = r2(o.gp - o.opex);
    o.gm = o.rev > 0 ? o.gp / o.rev : null; o.nm = o.rev > 0 ? o.net / o.rev : null; o.opexPct = o.rev > 0 ? o.opex / o.rev : null;
    return o;
  };
  const moNum = +A.period.slice(5, 7);                      // 1..12
  /* The company's FIRST month is often partial, so it is never a baseline: last year's month must come after it, and must itself have revenue. */
  const pyIdx = idx - 12, pyOk = pyIdx >= 0 && firstActive >= 0 && pyIdx > startIdx && months[pyIdx].active && months[pyIdx].rev > 0;
  const pytdA = idx - 12 - (moNum - 1), pytdOk = pytdA >= 0 && firstActive >= 0 && startIdx < pytdA;   // every month of last year's YTD window is inside the company's life, and the first (partial) month is not the first month of it
  const ttmOk = idx >= 11 && firstActive >= 0 && firstActive <= idx - 11;
  const pttmOk = idx >= 23 && firstActive >= 0 && startIdx < idx - 23;
  const P = {
    cur: Object.assign(agg(idx, idx), { label: monthLabel(keys[idx]) }),
    prior: (prior && prior.active) ? Object.assign(agg(idx - 1, idx - 1), { label: monthLabel(keys[idx - 1]) }) : null,
    py: pyOk ? Object.assign(agg(pyIdx, pyIdx), { label: monthLabel(keys[pyIdx]) }) : null,
    ytd: ytdStart >= 0 ? Object.assign(agg(ytdStart, idx), { label: 'YTD ' + keys[idx].slice(0, 4) }) : null,
    pytd: pytdOk ? Object.assign(agg(pytdA, pyIdx), { label: 'YTD ' + keys[pyIdx].slice(0, 4) }) : null,
    ttm: ttmOk ? Object.assign(agg(idx - 11, idx), { label: 'Last 12 months' }) : null,
    pttm: pttmOk ? Object.assign(agg(idx - 23, idx - 12), { label: 'Prior 12 months' }) : null
  };
  /* a comparison against a period that had no revenue is a percent of nothing: leave it out */
  ['pytd', 'ttm', 'pttm'].forEach(k => { if (P[k] && !(P[k].rev > 0)) P[k] = null; });
  A.asOf = input.periodEnd || ''; A.months = months.map(m => ({ key: m.key, label: m.label, rev: m.rev, cogs: m.cogs, gp: m.gp, opex: m.opex, net: m.net, active: m.active }));
  A.pl = P; A.plOk = true; A.leafOk = leafOk;
  A.labels = { cur: P.cur.label, prior: P.prior ? P.prior.label : null, py: P.py ? P.py.label : null, ytd: P.ytd ? P.ytd.label : null, pytd: P.pytd ? P.pytd.label : null };

  /* balance sheet at the three dates that matter */
  A.bsOk = bsOk;
  if (bsOk) {
    A.bs = { cur: B[idx], prior: idx >= 1 ? B[idx - 1] : null, py: pyOk ? B[pyIdx] : null };
    A.bs.cur.ltLines = bsLongTermLines(bsS, bsCols[idx].cell, 6);
    A.trend = months.slice(Math.max(0, idx - 11)).map((m, j) => { const i = Math.max(0, idx - 11) + j; return { key: m.key, label: m.label, rev: m.rev, py: (i - 12 >= 0 && firstActive >= 0 && i - 12 > startIdx && months[i - 12].active && months[i - 12].rev > 0) ? months[i - 12].rev : null, net: m.net, cash: B[i].cash, ar: B[i].ar, ap: B[i].ap }; });
    /* days to collect / to pay, on the average daily revenue (cost) of the three months to that date */
    const t3 = (i, f) => { if (i < 2 || !months[i - 2].active) return null; const d = daysInMonthKey(keys[i]) + daysInMonthKey(keys[i - 1]) + daysInMonthKey(keys[i - 2]); const s = f(months[i]) + f(months[i - 1]) + f(months[i - 2]); return s > 0 ? { s, d } : null; };
    const arBasisOk = !isNum(K.ar) || Math.abs(K.ar - B[idx].ar) <= TOL;      // the balance-sheet A/R group can include a retainage account the report's A/R removes: the two would not be comparable
    const dso = (i) => { if (!arBasisOk) return null; const t = t3(i, m => m.rev); return t && B[i].ar > 0 ? Math.round(B[i].ar / (t.s / t.d)) : null; };
    const dpo = (i) => { const t = t3(i, m => m.cogs + m.opex); return t && B[i].ap > 0 ? Math.round(B[i].ap / (t.s / t.d)) : null; };
    A.dso = { cur: dso(idx), prior: idx >= 1 ? dso(idx - 1) : null, py: pyOk ? dso(pyIdx) : null };
    A.dpo = { cur: dpo(idx), prior: idx >= 1 ? dpo(idx - 1) : null, py: pyOk ? dpo(pyIdx) : null };
  }
  A.cash = cashOk ? CF : null;
  A.cashOk = cashOk;
  const agingOut = (g) => {
    if (!g) return null;
    const t = g.total, past = r2(t.d30 + t.d60 + t.d90 + t.d90p), over60 = r2(t.d90 + t.d90p);
    const rank = (f) => g.items.filter(i => f(i) > 0.5).sort((a, b) => f(b) - f(a)).slice(0, 5).map(i => ({ name: i.name, total: i.total, past: r2(i.d30 + i.d60 + i.d90 + i.d90p), over60: r2(i.d90 + i.d90p), over90: i.d90p, share: t.total > 0 ? i.total / t.total : null }));
    return { total: t.total, cur: t.cur, d30: t.d30, d60: t.d60, d90: t.d90, d90p: t.d90p, past, over60, over90: t.d90p, top: rank(i => i.total), topPast: rank(i => i.d30 + i.d60 + i.d90 + i.d90p), topOver60: rank(i => i.d90 + i.d90p), count: g.items.filter(i => Math.abs(i.total) > 0.5).length };
  };
  A.ar = arOk ? agingOut(AR) : null; A.ap = apOk ? agingOut(AP) : null;

  /* ---- 5. what moved: account-level drivers (only when the accounts reconcile) ---- */
  const dupe = {}; leaves.forEach(l => { dupe[l.label] = (dupe[l.label] || 0) + 1; });
  const nameOf = (l) => (dupe[l.label] > 1 && l.parent) ? l.parent + ': ' + l.label : l.label;
  const isRev = (l) => l.group === 'Income' || l.group === 'OtherIncome';
  const sumVals = (l, a, b) => r2(sum(l.vals.slice(a, b + 1)));
  const moversFor = (a0, a1, b0, b1, withPy) => {
    const T = Math.max(250, 0.005 * Math.max(sum(months.slice(a0, a1 + 1).map(m => m.rev)), sum(months.slice(b0, b1 + 1).map(m => m.rev))));
    const out = [];
    leaves.forEach(l => {
      const c = sumVals(l, a0, a1), b = sumVals(l, b0, b1), d = r2(c - b);
      if (Math.abs(d) < T) return;
      /* "Seasonal" means THE MOVE recurred: last year's same month jumped the same way, by at least 60% as much, from the month before it.
         Being a similar size is not enough - a steady monthly cost is always a similar size to itself. */
      const pyV = (withPy && pyOk) ? l.vals[pyIdx] : null, pyP = (withPy && pyOk && pyIdx >= 1) ? l.vals[pyIdx - 1] : null;
      const pyJump = (pyV != null && pyP != null) ? pyV - pyP : null;
      const side = l.group === 'Income' ? 'rev' : ((l.group === 'OtherIncome' || l.group === 'OtherExpenses') ? 'other' : 'cost');   // a gain on the sale of equipment is not revenue
      out.push({ name: nameOf(l), side, section: l.group, cur: c, base: b, delta: d, pct: pctChange(c, b), mult: b > 0.5 ? c / b : null, good: isRev(l) ? d > 0 : d < 0,
        pyVal: pyV, pyPrev: pyP, seasonal: pyJump != null && Math.abs(d) >= 1000 && (pyJump > 0) === (d > 0) && Math.abs(pyJump) >= 0.6 * Math.abs(d) });
    });
    out.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));
    return out.slice(0, 10);
  };
  A.movers = { prior: null, py: null, ytd: null };
  if (leafOk) {
    if (P.prior) A.movers.prior = moversFor(idx, idx, idx - 1, idx - 1, true);
    if (P.py) A.movers.py = moversFor(idx, idx, pyIdx, pyIdx);
    if (P.pytd) A.movers.ytd = moversFor(ytdStart, idx, pytdA, pyIdx);
  }
  /* net income bridge: the change in profit, exactly accounted for */
  const bridge = (c, b) => b ? { rev: r2(c.rev - b.rev), cogs: r2(-(c.cogs - b.cogs)), opex: r2(-(c.opex - b.opex)), other: r2(c.other - b.other), net: r2(c.net - b.net) } : null;
  A.bridge = { prior: bridge(P.cur, P.prior), py: bridge(P.cur, P.py), ytd: bridge(P.ytd || P.cur, P.pytd) };

  /* unusual items: a cost far above that account's own recent norm */
  A.unusual = [];
  if (leafOk && idx >= 6) {
    const avgRev = Math.max(P.cur.rev, P.ttm ? P.ttm.rev / 12 : 0);
    const minAbs = Math.max(1000, 0.02 * avgRev);
    leaves.filter(l => !isRev(l) && !/depreciation|amortization/i.test(l.label)).forEach(l => {
      const c = l.vals[idx]; if (c < minAbs) return;
      const from = Math.max(0, idx - 12, firstActive);                     // only months the company existed
      const hist = l.vals.slice(from, idx); if (hist.length < 6) return;
      /* The "typical month" is the ACCOUNT's own since it began: an account that started 5 months ago and has run a steady $7,000 since is not "unusual
         against a typical $2,333". An account with no postings at all in those months is new this month; one that is younger than 6 months has no norm yet. */
      const firstNz = hist.findIndex(v => Math.abs(v) > 0.005);
      let base = 0, isNew = false;
      if (firstNz < 0) isNew = true;
      else { if (hist.length - firstNz < 6) return; base = mean(hist.slice(firstNz)); }
      if (!isNew && (c < 2 * base || c - base < minAbs)) return;
      const pyV = pyOk ? l.vals[pyIdx] : null;
      A.unusual.push({ name: nameOf(l), group: l.group, cur: c, typical: r2(base), sameMonthLastYear: pyV, seasonal: pyV != null && pyV >= 0.6 * c, isNew, monthsSeen: hist.length });
    });
    A.unusual.sort((x, y) => (y.cur - y.typical) - (x.cur - x.typical)); A.unusual = A.unusual.slice(0, 4);
  }

  /* break-even: the monthly revenue that covers overhead at the last three months' margin */
  if (idx >= 2 && months[idx - 2].active) {
    const m3 = months.slice(idx - 2); const rev3 = sum(m3.map(m => m.rev)), gp3 = sum(m3.map(m => m.gp)), oh = mean(m3.map(m => m.opex));
    const gm3 = rev3 > 0 ? gp3 / rev3 : null;
    const avgRev3 = rev3 / 3, thin = gm3 != null && gm3 <= 0.005, tiny = oh < Math.max(100, 0.01 * avgRev3);   // overhead too small for "revenue to cover it" to mean anything
    A.breakeven = { overhead: r2(oh), gm: gm3, thin, tiny, revenue: (gm3 != null && !thin && !tiny) ? Math.round(oh / gm3) : null, curRev: cur.rev };
  } else A.breakeven = null;

  /* what last year did next: a pattern from the books, offered only when both months are real */
  A.ahead = null;
  if (pyOk && idx - 12 + 1 <= idx - 1 && months[pyIdx + 1] && months[pyIdx + 1].active && months[pyIdx].rev > 0 && months[pyIdx + 1].rev > 0) {
    const ch = months[pyIdx + 1].rev / months[pyIdx].rev - 1;
    A.ahead = { nextLabel: monthLabel(addMonthsKey(keys[idx], 1)), nextName: monthName(addMonthsKey(keys[idx], 1)), thenLabel: monthLabel(keys[pyIdx + 1]), thisLabel: monthLabel(keys[pyIdx]), change: ch, thenRev: months[pyIdx + 1].rev, thisRev: months[pyIdx].rev };
  }

  /* the seasonal pattern: what the three months AFTER this point did last year, against the three months up to it. Offered only when all six months are real (after the
     business started, with revenue), so a start-up ramp is never read as a season. The insights decide whether it is a slower season (goals.slowSeasonDrop). */
  A.season = null;
  if (idx >= 14) {
    const six = [idx - 14, idx - 13, idx - 12, idx - 11, idx - 10, idx - 9];
    if (six.every(i => i > startIdx && months[i].active && months[i].rev > 0)) {
      const bef = months.slice(idx - 14, idx - 11), aft = months.slice(idx - 11, idx - 8);
      const beforeAvg = r2(mean(bef.map(m => m.rev))), afterAvg = r2(mean(aft.map(m => m.rev)));
      A.season = { nextFrom: monthName(addMonthsKey(keys[idx], 1)), nextTo: monthName(addMonthsKey(keys[idx], 3)), lastYearFrom: monthLabel(aft[0].key), lastYearTo: monthLabel(aft[2].key),
        beforeFrom: monthLabel(bef[0].key), beforeTo: monthLabel(bef[2].key), beforeAvg, afterAvg, beforeMin: Math.min.apply(null, bef.map(b => b.rev)), change: afterAvg / beforeAvg - 1, afterNet: r2(sum(aft.map(m => m.net))),
        /* broad = at least two of the three months were each lower than the lowest of the three before: one large job in the earlier months is not a season */
        broad: aft.filter(m => m.rev < Math.min.apply(null, bef.map(b => b.rev))).length >= 2 };
    }
  }

  /* ---- 6. books to check (coach-only): facts about the ledger, not opinions ---- */
  const books = [];
  if (bsS && bsOk) {
    const c = bsCols[idx].cell;
    const sumRows = (rx, onlyData) => (bsS.rows || []).filter(x => (onlyData ? x.type === 'data' : x.type !== 'summary') && rx.test(String(x.label || '')) && Math.abs(num((x.cells || [])[c])) > 0.005).map(x => ({ label: String(x.label).trim(), amount: r2(num(x.cells[c])) }));
    const uncatBs = sumRows(/uncategorized|ask my accountant|suspense|ask accountant/i, true);
    const uncatPl = leaves.filter(l => /uncategorized|ask my accountant|suspense/i.test(l.label) && Math.abs(l.vals[idx]) > 0.005).map(l => ({ label: l.label, amount: l.vals[idx] }));
    if (uncatBs.length || uncatPl.length) books.push({ key: 'uncategorized', text: 'Uncategorized / Ask My Accountant / suspense: ' + uncatBs.concat(uncatPl).map(x => x.label + ' ' + usd(x.amount)).join('; ') + ' - recode before the report goes out.' });
    const undep = sumRows(/undeposited funds/i, true);
    if (undep.length && Math.abs(undep[0].amount) >= 1) books.push({ key: 'undeposited', text: 'Undeposited Funds holds ' + usd(undep[0].amount) + ' at month-end - match it to bank deposits.' });
    const obe = sumRows(/opening balance equity/i, true);
    if (obe.length && Math.abs(obe[0].amount) >= 1) books.push({ key: 'obe', text: 'Opening Balance Equity is ' + usd(obe[0].amount) + ' - it should be zero once the opening entries are settled.' });
    if (B[idx].cash < -0.5) books.push({ key: 'neg-cash', text: 'Bank accounts total ' + usd(B[idx].cash) + ' (overdrawn) - check for an unrecorded deposit or a mis-coded transfer.' });
    if (B[idx].ar < -0.5) books.push({ key: 'neg-ar', text: 'Accounts receivable is ' + usd(B[idx].ar) + ' (a credit balance) - an unapplied payment or credit.' });
    if (B[idx].ap < -0.5) books.push({ key: 'neg-ap', text: 'Accounts payable is ' + usd(B[idx].ap) + ' (a debit balance) - an unapplied bill payment or vendor credit.' });
    if (A.method !== 'Cash' && arOk && Math.abs(AR.total.total - B[idx].ar) > TOL) books.push({ key: 'ar-aging-diff', text: 'A/R aging totals ' + usd(AR.total.total) + ' but the balance sheet shows ' + usd(B[idx].ar) + ' (difference ' + usd(B[idx].ar - AR.total.total) + ') - often retainage or a manual journal entry to A/R.' });
    if (A.method !== 'Cash' && apOk && Math.abs(AP.total.total - B[idx].ap) > TOL) books.push({ key: 'ap-aging-diff', text: 'A/P aging totals ' + usd(AP.total.total) + ' but the balance sheet shows ' + usd(B[idx].ap) + ' (difference ' + usd(B[idx].ap - AP.total.total) + ') - usually a manual journal entry to A/P.' });
  }
  /* the cash story is left out when the cash-flow statement and the balance sheet disagree - the coach should know QuickBooks' own reports do not agree */
  if (cfProblem && cfProblem.kind === 'bank') books.push({ key: 'cf-bank-diff', text: 'The statement of cash flows ends at ' + usd(cfProblem.end) + ' but the bank accounts on the balance sheet total ' + usd(cfProblem.cash) + ' (difference ' + usd(cfProblem.end - cfProblem.cash) + ') - the cash story is left out of the report until they agree.' });
  else if (cfProblem && cfProblem.kind === 'ni') books.push({ key: 'cf-ni-diff', text: 'The statement of cash flows starts from net income of ' + usd(cfProblem.cf) + ' but the profit and loss shows ' + usd(cfProblem.pl) + ' - the cash story is left out of the report until they agree.' });
  else if (cfProblem) books.push({ key: 'cf-broken', text: 'The statement of cash flows does not add up (operations + investing + financing against the change in cash, or beginning cash + the change against ending cash) - the cash story is left out of the report.' });
  if (!pyOk) books.push({ key: 'no-py', text: 'No prior-year comparison: ' + monthLabel(addMonthsKey(keys[idx], -12)) + ' is not a fair month to compare with (no revenue yet, or the first, partial month of the business). The client may be new, or last year was not entered.' });
  if (!bsOk) books.push({ key: 'bs-missing', text: 'The balance-sheet comparisons (debt, days to collect, days to pay, the cash trend) are left out: ' + (bsS ? 'the balance-sheet history did not line up with the report' : 'QuickBooks did not return the balance-sheet history') + '. Open the report again in a few minutes; if it stays this way, check the balance sheet.' });
  A.books = books;

  A.ok = true;
  /* ---- 7. insights, scorecard, headline ---- */
  const groupByLabel = {};
  if (bsS) (bsS.rows || []).forEach(r => { if (r.type === 'data') groupByLabel[String(r.label || '').trim().toLowerCase()] = String(r.group || ''); });
  /* the balance-sheet section an account sits in (cash-flow lines are named "Notes Payable:PU27-TD Auto Finance"; the balance sheet row is the part after the colon) */
  const bsGroupOf = (label) => { const k = String(label || '').trim().toLowerCase(); if (k in groupByLabel) return groupByLabel[k]; const seg = k.split(':').pop().trim(); return (seg in groupByLabel) ? groupByLabel[seg] : null; };
  const ctx = { A, K, goals, months, idx, keys, P, B, bsOk, cashOk, CF, AR: A.ar, AP: A.ap, pyOk, leafOk, bsGroupOf };
  try { require('./reportInsights').build(ctx, module.exports.helpers); } catch (e) { A.errors.push('insights: ' + (e && e.message || e)); A.insights = A.insights || []; }
  return finish(A);
}
function worst2(arr, f) { let w = 0; arr.forEach((m, i) => { w = Math.max(w, Math.abs(f(m, i))); }); return w; }
function finish(A) { if (!A.insights) A.insights = []; return A; }

module.exports = { buildReportAnalysis, GOAL_DEFAULTS, ANALYSIS_VERSION, SEV_WEIGHT,
  helpers: { num, r2, rnd, usd, usdUnsigned, pct0, pctChange, chgText, ptsDiff, ptsText, plural, sigOf, monthLabel, monthName, addMonthsKey, monthColumns, leavesOf, sectionTotals, bsAt, parseCashFlow, parseAging, mean, sum, isNum } };
