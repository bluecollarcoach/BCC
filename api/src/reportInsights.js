'use strict';
/* ===========================================================================================
 * Insights, tips, scorecard and headline for the monthly report — built ONLY from the
 * reconciled numbers in `ctx` (see reportAnalysis.js for the accuracy contract). Every rule
 *   - states what the figures prove and nothing more (no guessed causes),
 *   - carries the evidence in its own sentence,
 *   - is skipped, never zero-filled, when the figures it needs do not exist,
 *   - gives a coach's tip that is advice conditional on the facts shown, not a claim.
 * One rule that throws is recorded in A.errors and skipped; it can never take the report down.
 * =========================================================================================== */

const SEV_WEIGHT = { action: 4, watch: 3, win: 2, info: 1 };

function build(ctx, H) {
  const { A, K, goals, months, idx, keys, P, B, bsOk, cashOk, CF, leafOk } = ctx;
  const { usd, usdUnsigned, pct0, pctChange, chgText, ptsDiff, ptsText, plural, monthLabel, monthName, sigOf, rnd } = H;
  const out = [];
  const cur = P.cur, pm = P.prior, py = P.py, ytd = P.ytd, pytd = P.pytd, ttm = P.ttm, pttm = P.pttm;
  const pmName = pm ? monthName(keys[idx - 1]) : null;
  const curName = monthName(keys[idx]);
  const add = (o) => { o.aud = o.aud || 'client'; o.facts = o.facts || {}; o.sig = sigOf(o.facts); o.impact = Math.abs(o.impact || 0); out.push(o); };
  const rule = (name, fn) => { try { fn(); } catch (e) { A.errors.push(name + ': ' + ((e && e.message) || e)); } };
  const list = (items) => items.join(', ');
  /* customer, vendor and account names come from the books and can be a whole phone number and product description: keep them readable */
  const dnum = (n) => (n === 1 ? '1 day' : String(n));      // "34 in September", but never "1 in September" for days
  const short = (n) => { n = String(n == null ? '' : n).replace(/\s+/g, ' ').trim(); return n.length > 44 ? n.slice(0, 42).trim() + '...' : n; };
  const signedAmt = (d) => (d > 0 ? '+' : '-') + usdUnsigned(d);
  /* "Insurance +$8,400 (8x; Oct 2025 was $9,600 too)". A percent above 300% is noise, so it becomes a multiple; an item
     that was just as large this month last year says so - that is the difference between an annual bill and a problem. */
  const multText = (x) => (x >= 20 ? Math.round(x) + '' : (Math.round(x * 10) / 10 + '').replace(/\.0$/, '')) + 'x';
  const rdelta = (m) => rnd(m.cur) - rnd(m.base);          // the difference of the figures as printed
  const moverText = (m) => {
    const bits = [], pr = pctChange(rnd(m.cur), rnd(m.base));
    if (pr != null) bits.push(pr >= 3 && m.mult != null ? multText(m.mult) : Math.round(Math.abs(pr) * 100) + '%');
    else if (m.mult != null && m.mult >= 3) bits.push(multText(m.mult));
    if (m.seasonal && py) bits.push(py.label + ' moved the same way, ' + usd(m.pyPrev) + ' to ' + usd(m.pyVal));
    return short(m.name) + ' ' + signedAmt(rdelta(m)) + (bits.length ? ' (' + bits.join('; ') + ')' : '');
  };
  const joinAnd = (a) => a.length <= 1 ? (a[0] || '') : a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1];
  const sentence = (a) => { const t = a.filter(Boolean).join(' '); return t.trim(); };
  const cmpPhrases = (c, getPm, getPy, f) => { const a = []; if (pm && getPm != null) a.push(chgText(c, getPm, pmName, f)); if (py && getPy != null) a.push(chgText(c, getPy, py.label, f)); return a.filter(Boolean); };

  /* ------------------------------------------------------------ profit */
  rule('net_income', () => {
    const ni = cur.net, nm = cur.nm;
    const head = ni >= 0
      ? 'Net income ' + usd(ni) + (nm != null ? ' (' + pct0(nm) + ' of revenue)' : '')
      : 'Net loss of ' + usdUnsigned(ni) + (cur.rev > 0 ? ' on ' + usd(cur.rev) + ' of revenue' : '');
    const cmp = cmpPhrases(ni, pm && pm.net, py && py.net);
    let detail = cmp.length ? 'That is ' + joinAnd(cmp) + '.' : '';
    if (ytd) detail += (detail ? ' ' : '') + 'Year to date: ' + usd(ytd.net) + (pytd ? ', ' + chgText(ytd.net, pytd.net, 'the same point last year') : '') + '.';
    const br = A.bridge && A.bridge.prior;
    if (pm && br && Math.abs(br.net) >= Math.max(1000, 0.05 * Math.max(cur.rev, pm.rev))) {
      const terms = [];
      const t = (label, d, upIsWord) => { if (Math.abs(d) >= Math.max(100, 0.01 * Math.abs(br.net))) terms.push(label + ' ' + (d > 0 ? upIsWord[0] : upIsWord[1]) + ' ' + usdUnsigned(d)); };
      const rd = (a, b) => rnd(a) - rnd(b);
      t('revenue', rd(cur.rev, pm.rev), ['up', 'down']); t('cost of revenue', -rd(cur.cogs, pm.cogs), ['down', 'up']); t('overhead', -rd(cur.opex, pm.opex), ['down', 'up']); t('other income/expense', rd(cur.other, pm.other), ['up', 'down']);
      if (terms.length) detail += ' What changed vs ' + pmName + ': ' + joinAnd(terms) + '.';
      const oth = ((A.movers && A.movers.prior) || []).filter(m => m.side === 'other').slice(0, 2);
      if (oth.length && Math.abs(br.other) >= Math.max(1000, 0.25 * Math.abs(br.net))) detail += ' Other income/expense: ' + list(oth.map(moverText)) + '.';
    }
    const dPm = pm ? ni - pm.net : null, dPy = py ? ni - py.net : null;
    let sev = 'info';
    if (ni < 0) sev = (ytd && ytd.net < 0) ? 'action' : 'watch';
    else if (dPm != null && dPm < 0 && Math.abs(dPm) >= Math.max(2500, 0.25 * Math.abs(pm.net)) && (dPy == null || dPy < 0)) sev = 'watch';
    else if (dPm != null && dPm >= Math.max(1000, 0.10 * Math.abs(pm.net)) && (dPy == null || dPy >= 0)) sev = 'win';
    else if (dPy != null && dPy >= Math.max(1000, 0.10 * Math.abs(py.net)) && (dPm == null || dPm >= -0.1 * Math.abs(pm.net))) sev = 'win';
    let tip;
    if (ni < 0) tip = 'Suggestion: check whether the work billed this month was priced at current material and labor costs.';
    else if (sev === 'watch') tip = 'Suggestion: review the lines that moved most (see "What moved") and determine whether each is one-time or ongoing.';
    else if (sev === 'win') tip = 'Suggestion: identify what drove this month (customers, type of work, pricing) and compare the growth in overhead with the growth in revenue.';
    add({ key: 'net_income', cat: 'profit', sev, head, detail, tip, impact: Math.abs(dPm != null ? dPm : ni), facts: { ni, pm: pm && pm.net, py: py && py.net, ytd: ytd && ytd.net, pytd: pytd && pytd.net } });
  });

  rule('revenue', () => {
    if (cur.rev <= 0 && !(pm && pm.rev > 0)) return;
    const head = 'Revenue ' + usd(cur.rev);
    const cmp = cmpPhrases(cur.rev, pm && pm.rev, py && py.rev);
    let detail = cmp.length ? 'That is ' + joinAnd(cmp) + '.' : '';
    if (ytd) detail += ' Year to date ' + usd(ytd.rev) + (pytd ? ', ' + chgText(ytd.rev, pytd.rev, 'the same point last year') : '') + '.';
    if (ttm) detail += ' Last 12 months ' + usd(ttm.rev) + (pttm ? ', ' + chgText(ttm.rev, pttm.rev, 'the 12 months before') : '') + '.';
    const yoy = py ? pctChange(cur.rev, py.rev) : null, ytdg = pytd ? pctChange(ytd.rev, pytd.rev) : null, mom = pm ? pctChange(cur.rev, pm.rev) : null;
    let sev = 'info';
    if (ytdg != null && ytdg <= -0.20 && (yoy == null || yoy <= -0.10)) sev = 'action';
    else if ((yoy != null && yoy <= -0.10) || (ytdg != null && ytdg <= -0.10) || (mom != null && mom <= -0.25 && cur.rev - pm.rev <= -5000)) sev = 'watch';
    else if (((yoy != null && yoy >= 0.05) || (ytdg != null && ytdg >= 0.05)) && !(mom != null && mom <= -0.20)) sev = 'win';
    let tip;
    if (sev === 'action' || sev === 'watch') tip = 'Suggestion: see "What moved" for the customers or income lines that changed, and compare open quotes and scheduled work with the previous month.';
    else if (sev === 'win') tip = 'Suggestion: identify which customers, types of work or seasons produced the increase, and compare the growth in costs with the growth in sales.';
    add({ key: 'revenue', cat: 'profit', sev, head, detail, tip, impact: Math.abs(pm ? cur.rev - pm.rev : cur.rev), facts: { rev: cur.rev, pm: pm && pm.rev, py: py && py.rev, ytd: ytd && ytd.rev, pytd: pytd && pytd.rev } });
  });

  rule('gross_margin', () => {
    if (cur.gm == null) return;
    const gm = cur.gm, dPm = pm && pm.gm != null ? ptsDiff(gm, pm.gm) : null, dPy = py && py.gm != null ? ptsDiff(gm, py.gm) : null;
    const head = 'Gross margin ' + pct0(gm);
    const parts = [];
    if (dPm != null) parts.push(ptsText(dPm) + ' from ' + pmName + ' (' + pct0(pm.gm) + ')');
    if (dPy != null) parts.push(ptsText(dPy) + ' from ' + py.label + ' (' + pct0(py.gm) + ')');
    let detail = parts.length ? 'That is ' + joinAnd(parts) + '.' : '';
    if (pm && dPm !== 0 && dPm != null) {
      const cg = pctChange(cur.cogs, pm.cogs), rg = pctChange(cur.rev, pm.rev);
      if (cg != null && rg != null && Math.abs(cg) >= 0.005 && Math.abs(rg) >= 0.005) detail += ' Versus ' + pmName + ', cost of revenue ' + (cg > 0 ? 'rose ' : 'fell ') + Math.round(Math.abs(cg) * 100) + '% while revenue ' + (rg > 0 ? 'rose ' : 'fell ') + Math.round(Math.abs(rg) * 100) + '%.';
    }
    if (ytd && pytd && ytd.gm != null && pytd.gm != null) detail += ' Year to date ' + pct0(ytd.gm) + ' (' + ptsText(ptsDiff(ytd.gm, pytd.gm)) + ' vs the same point last year).';
    if (ttm && ttm.rev > 0) detail += ' Each point of gross margin is worth about ' + usd(ttm.rev * 0.01) + ' a year at your last 12 months\' revenue.';
    let sev = 'info';
    if (gm < goals.grossMarginMin) sev = 'action';
    else if ((dPm != null && dPm <= -4) || (dPy != null && dPy <= -3) || (gm < goals.grossMargin && ((dPm != null && dPm < 0) || (dPy != null && dPy < 0)))) sev = 'watch';
    else if ((dPm != null && dPm >= 2 && (dPy == null || dPy >= 0)) || (dPy != null && dPy >= 3 && (dPm == null || dPm >= 0))) sev = 'win';
    const tip = (sev === 'action' || sev === 'watch')
      ? 'Suggestion: compare quoted cost with actual cost on the largest jobs, products or services. If costs have risen, update the pricing on open quotes.'
      : (sev === 'win' ? 'Suggestion: identify the cause of the improvement (pricing, material cost, labor) and whether it will continue before reflecting it in new quotes.' : '');
    add({ key: 'gross_margin', cat: 'profit', sev, head, detail, tip, impact: Math.abs((gm - (pm && pm.gm != null ? pm.gm : gm)) * cur.rev), facts: { gm: Math.round(gm * 100), pm: pm && pm.gm != null ? Math.round(pm.gm * 100) : null, py: py && py.gm != null ? Math.round(py.gm * 100) : null } });
  });

  rule('overhead', () => {
    if (cur.rev <= 0 || cur.opexPct == null) return;
    const head = 'Overhead ' + usd(cur.opex) + ' (' + pct0(cur.opexPct) + ' of revenue)';
    const cmp = cmpPhrases(cur.opex, pm && pm.opex, py && py.opex);
    let detail = cmp.length ? 'That is ' + joinAnd(cmp) + '.' : '';
    let d = null;
    if (ytd && pytd && ytd.opexPct != null && pytd.opexPct != null) {
      d = ptsDiff(ytd.opexPct, pytd.opexPct);
      detail += ' Year to date overhead is ' + usd(ytd.opex) + ', ' + pct0(ytd.opexPct) + ' of revenue against ' + pct0(pytd.opexPct) + ' at the same point last year.';
    }
    let sev = 'info';
    if (d != null && d >= 4 && ytd.opex > pytd.opex * 1.05) sev = 'watch';
    else if (d != null && d <= -3 && (!pm || pm.opexPct == null || cur.opexPct <= pm.opexPct + 0.02)) sev = 'win';   // better year to date AND this month not worse than last
    const tip = sev === 'watch' ? 'Suggestion: compare each recurring overhead line (insurance, software, vehicles, phones, subscriptions) with last month and with last year.' : '';
    add({ key: 'overhead', cat: 'profit', sev, head, detail, tip, impact: pm ? Math.abs(cur.opex - pm.opex) : 0, facts: { opex: cur.opex, pm: pm && pm.opex, ytdPct: ytd && ytd.opexPct != null ? Math.round(ytd.opexPct * 100) : null, pytdPct: pytd && pytd.opexPct != null ? Math.round(pytd.opexPct * 100) : null } });
  });

  /* ------------------------------------------------------------ the whole picture
     A cost that jumped means something different in a business with plenty of cash and a profitable year than in one without: the first may have planned it (repairs or purchases
     timed before year-end are common), the second needs to explain how it is being paid for. So cost increases are read against cash (the firm's months-of-cash goal), profit this
     year and the current ratio. 'strong' = all three are good; 'weak' = cash under the goal or overdrawn, no profit this year, or a current ratio under its floor; otherwise 'neutral'. */
  const picAvgRev = ttm ? ttm.rev / 12 : cur.rev;
  const picBurnOk = K.monthlyBurn > 0 && K.monthsOfCash != null && K.burnFrom3 !== false && K.monthlyBurn >= Math.max(100, 0.01 * picAvgRev);
  const picProfit = ytd ? ytd.net : cur.net, picRatio = K.currentRatio;
  const picState = !isFinite(K.cash) ? 'neutral'
    : ((K.cash < 0 || (picBurnOk && K.monthsOfCash < goals.monthsCash / 2) || (!(picProfit > 0) && !(picBurnOk && K.monthsOfCash >= goals.monthsCash)) || (picRatio != null && picRatio < goals.currentRatioMin)) ? 'weak'
      : ((picBurnOk && K.monthsOfCash >= goals.monthsCash && picProfit > 0 && (picRatio == null || picRatio >= goals.currentRatio)) ? 'strong' : 'neutral'));
  const picText = !isFinite(K.cash) ? '' : joinAnd([].concat(
    [K.cash < 0 ? 'cash is overdrawn by ' + usdUnsigned(K.cash) : 'cash is ' + usd(K.cash) + (picBurnOk ? ' (' + K.monthsOfCash + (K.monthsOfCash === 1 ? ' month' : ' months') + ' of overhead against the ' + goals.monthsCash + '-month goal)' : '')],
    [(ytd ? 'year-to-date net income is ' : 'net income this month is ') + usd(picProfit)],
    picRatio != null ? ['the current ratio is ' + picRatio.toFixed(2)] : [])).replace(/^./, (c) => c.toUpperCase()) + '.';

  /* ------------------------------------------------------------ what moved */
  rule('movers', () => {
    const mv = A.movers || {};
    const shownAsUnusual = {}; (A.unusual || []).forEach(x => { shownAsUnusual[x.name] = true; });          // already stated, with its typical amount, in the item above
    const costUp = (arr) => (arr || []).filter(m => m.side === 'cost' && m.delta > 0 && !shownAsUnusual[m.name]).slice(0, 3);
    const lines = [], facts = {};
    const cuP = costUp(mv.prior), cuY = costUp(mv.py);
    if (cuP.length) { lines.push('Versus ' + pmName + ': ' + list(cuP.map(moverText)) + '.'); facts.p = cuP.map(m => [m.name, m.delta]); }
    if (cuY.length) { lines.push('Versus ' + py.label + ': ' + list(cuY.map(moverText)) + '.'); facts.y = cuY.map(m => [m.name, m.delta]); }
    if (!lines.length) return;
    const top = cuP.length ? sumDelta(cuP.filter(m => !m.seasonal)) : sumDelta(cuY);
    const big = top >= Math.max(2000, 0.03 * cur.rev), sev = (big && picState !== 'strong') ? 'watch' : 'info';
    const lead = cuP.length ? cuP[0] : cuY[0];
    if (big) lines.push(picText);
    add({ key: 'movers_cost', cat: 'profit', sev, head: 'Costs that rose the most: ' + short(lead.name) + ' ' + signedAmt(rdelta(lead)), detail: lines.join(' '), tip: sev === 'watch' ? 'Suggestion: for each increase, determine whether it is one-time or ongoing. A one-time item can be set aside when comparing months; an ongoing one belongs in pricing.' : '', impact: top, facts });
  });
  rule('movers_rev', () => {
    const mv = A.movers || {};
    const rv = (arr) => (arr || []).filter(m => m.side === 'rev').slice(0, 3);
    const rP = rv(mv.prior), rY = rv(mv.py), lines = [], facts = {};
    if (rP.length) { lines.push('Versus ' + pmName + ': ' + list(rP.map(moverText)) + '.'); facts.p = rP.map(m => [m.name, m.delta]); }
    if (rY.length) { lines.push('Versus ' + py.label + ': ' + list(rY.map(moverText)) + '.'); facts.y = rY.map(m => [m.name, m.delta]); }
    if (!lines.length) return;
    const leadR = rP.length ? rP[0] : rY[0];
    add({ key: 'movers_rev', cat: 'profit', sev: 'info', head: 'Where revenue moved: ' + short(leadR.name) + ' ' + signedAmt(rdelta(leadR)), detail: lines.join(' '), tip: '', impact: Math.abs((rP[0] || rY[0]).delta), facts });
  });
  function sumDelta(a) { return a.reduce((s, m) => s + m.delta, 0); }
  /* "Of that, $83,714 is current, $13,000 is 1-30 days past due and $9,500 is 31-60 days past due." - only the buckets that hold money. */
  function bucketText(r) {
    /* A negative bucket is a credit (an unapplied payment or a vendor credit), not money that is "past due": it is listed apart, so no
       sentence ever reads "-$712 is over 90 days past due". The totals already include it. */
    const parts = [], credits = [];
    const put = (v, txt) => { if (v > 0.5) parts.push(usd(v) + ' ' + txt); else if (v < -0.5) credits.push(-v); };
    put(r.cur, 'is current'); put(r.d30, 'is 1-30 days past due'); put(r.d60, 'is 31-60 days past due'); put(r.d90, 'is 61-90 days past due'); put(r.d90p, 'is over 90 days past due');
    const cr = credits.length ? ' Credits of ' + usd(credits.reduce((s, v) => s + v, 0)) + ' are netted in.' : '';
    return (parts.length ? 'Of that, ' + joinAnd(parts) + '.' : '') + cr;
  }

  rule('unusual', () => {
    const u = A.unusual || []; if (!u.length) return;
    const one = (x) => short(x.name) + ' ' + usd(x.cur) + (x.isNew ? ' (no comparable amount in the previous ' + x.monthsSeen + ' months)' : ', against a typical ' + usd(x.typical) + ' a month') + (x.seasonal ? '; ' + py.label + ' was ' + usd(x.sameMonthLastYear) + ', so it may be annual or seasonal' : '');
    const real = u.filter(x => !x.seasonal);
    const excess = real.reduce((sum, x) => sum + (x.isNew ? x.cur : x.cur - x.typical), 0);
    /* calm only when the picture is strong, every item is an overhead account (the year-end example does not fit a job cost), and the extra cost is at most a quarter of this year's profit */
    const calm = real.length > 0 && picState === 'strong' && real.every(x => x.group === 'Expenses') && excess <= 0.25 * picProfit;
    const weakHere = picState === 'weak' || (isFinite(K.cash) && rnd(K.cash) < rnd(excess));       // a cost larger than the cash on hand is a question whatever else is true
    const many = u.length > 1, yearEnd = +keys[idx].slice(5, 7) >= 9;
    const head = (real.length ? (calm ? 'Cost to note: ' : 'Unusual cost to confirm: ') : 'Large cost that looks seasonal: ') + short((real[0] || u[0]).name) + ' ' + usd((real[0] || u[0]).cur);
    const tip = calm
      ? 'Suggestion: if ' + (many ? 'these were' : 'this was') + ' planned' + (yearEnd ? ' (for example repairs or purchases timed with the CPA before year-end)' : '') + ', no action is needed. If not, confirm ' + (many ? 'each is' : 'it is') + ' coded to the correct account and whether it will recur.'
      : 'Suggestion: confirm each item is coded to the correct account, whether it will recur' + (weakHere ? ', and how it is being paid for' : '') + '.';
    add({ key: 'unusual', cat: 'profit', sev: (real.length && !calm) ? 'watch' : 'info', head, detail: u.map(one).join('. ') + '. ' + picText,
      tip,
      impact: Math.max.apply(null, u.map(x => x.cur - x.typical)), facts: u.map(x => [x.name, x.cur, x.typical, !!x.seasonal]) });
  });

  rule('breakeven', () => {
    const be = A.breakeven; if (!be) return;
    if (be.revenue == null) {
      if (be.thin && be.curRev > 0) add({ key: 'breakeven', cat: 'profit', sev: 'action', head: 'Gross margin is too thin to cover overhead', detail: 'Over the last 3 months gross margin averaged ' + pct0(be.gm) + ' while overhead averaged ' + usd(be.overhead) + ' a month, so no level of sales at these prices covers overhead.', tip: 'Suggestion: gross margin is below the level overhead requires. Review the cost of each type of work against what it is billed at.', impact: be.overhead, facts: { gm: Math.round(be.gm * 100), oh: be.overhead } });
      return;
    }
    const ratio = be.curRev / be.revenue;
    let sev = 'info';
    if (ratio < 0.75) sev = 'action'; else if (ratio < 0.95) sev = 'watch'; else if (ratio >= 1.5 && cur.net >= 0) sev = 'win';     // never a "win" in a month that lost money
    let detail = 'Overhead has averaged ' + usd(be.overhead) + ' a month over the last 3 months at a ' + pct0(be.gm) + ' gross margin, so about ' + usd(be.revenue) + ' of revenue a month covers overhead before any profit. This month you booked ' + usd(be.curRev) + ', which is ' + (ratio >= 10 ? 'more than ten times that' : pct0(ratio) + ' of that') + '.';
    /* A loss is explained only by what the books show: overhead above its average WHEN operating income was negative; otherwise say where the loss came from. */
    if (cur.net < 0) {
      if (cur.opInc < 0 && ratio >= 1 && cur.opex > be.overhead * 1.1 && cur.net + (cur.opex - be.overhead) >= 0) detail += ' This month\'s overhead of ' + usd(cur.opex) + ' ran above that average, which is why it still lost money.';
      else if (cur.opInc < 0 && rnd(cur.gp) - rnd(cur.opex) < 0) detail += ' Operating income was ' + usd(rnd(cur.gp) - rnd(cur.opex)) + ': gross profit of ' + usd(cur.gp) + ' did not cover overhead of ' + usd(cur.opex) + '.' + (cur.other < -0.5 ? ' Other income/expense was ' + usd(cur.other) + '.' : '');
      else if (cur.opInc >= 0 && cur.other < 0) detail += ' Operating income was ' + usd(cur.opInc) + '; the loss came from other income/expense of ' + usd(cur.other) + '.';
    }
    add({ key: 'breakeven', cat: 'profit', sev, head: 'Break-even is about ' + usd(be.revenue) + ' of revenue a month', detail,
      tip: 'Suggestion: break-even is the minimum. For a profit target, add the target to overhead and divide by gross margin to get the monthly revenue required.', impact: Math.abs(be.curRev - be.revenue), facts: { be: be.revenue, rev: be.curRev } });
  });

  rule('streak', () => {
    const n = idx + 1; if (n < 12) return;
    const last12 = months.slice(idx - 11, idx + 1); if (!last12.every(m => m.active)) return;
    const sentences = []; let sev = 'info', head = '';
    let lossRun = 0; for (let i = idx; i >= 0 && months[i].net < 0; i--) lossRun++;
    let profRun = 0; for (let i = idx; i >= 0 && months[i].net > 0; i--) profRun++;
    const prev11 = months.slice(idx - 11, idx);
    const bestRev = cur.rev > 0 && prev11.every(m => cur.rev > m.rev), bestNet = cur.net > 0 && prev11.every(m => cur.net > m.net);
    const whole = (run) => run >= idx + 1;                       // the run reaches the start of the 24 months we can see: it may be longer
    if (lossRun >= 2) { const tot = months.slice(idx - lossRun + 1, idx + 1).reduce((s, m) => s + m.net, 0); head = (whole(lossRun) ? 'At least ' : '') + plural(lossRun, 'month') + ' in a row with a net loss'; sentences.push('Net income has been negative ' + (whole(lossRun) ? 'for every one of the ' + lossRun + ' months in the books' : 'since ' + monthLabel(keys[idx - lossRun + 1])) + ', a combined ' + usd(tot) + '.'); sev = 'watch'; }
    else if (bestRev || bestNet) {
      head = bestRev && bestNet ? 'Best month for revenue and profit in at least a year' : (bestRev ? 'Best revenue month in at least a year' : 'Best profit month in at least a year');
      if (bestRev) { const pk = prev11.reduce((a, m) => m.rev > a.rev ? m : a, prev11[0]); sentences.push('Revenue of ' + usd(cur.rev) + ' beats every month since ' + monthLabel(keys[idx - 11]) + ' (the previous high was ' + usd(pk.rev) + ' in ' + pk.label + ').'); }
      if (bestNet) { const pk = prev11.reduce((a, m) => m.net > a.net ? m : a, prev11[0]); sentences.push('Net income of ' + usd(cur.net) + ' is the highest in that time (previous high ' + usd(pk.net) + ' in ' + pk.label + ').'); }
      sev = 'win';
    } else if (profRun >= 6) { head = (whole(profRun) ? 'At least ' : '') + plural(profRun, 'month') + ' in a row in the black'; sentences.push(whole(profRun) ? 'Every one of the ' + profRun + ' months in the books, back to ' + monthLabel(keys[idx - profRun + 1]) + ', has shown a profit.' : 'Every month since ' + monthLabel(keys[idx - profRun + 1]) + ' has shown a profit.'); sev = 'win'; }
    if (!head) return;
    add({ key: 'streak', cat: 'profit', sev, head, detail: sentences.join(' '),
      tip: sev === 'watch' ? 'Suggestion: consecutive losing months indicate a pattern. Identify whether price, cost or volume is the cause.' : (bestRev || bestNet ? 'Suggestion: identify what was different this month and whether it can be repeated.' : ''),
      impact: Math.abs(cur.net), facts: { lossRun, profRun, bestRev, bestNet } });
  });

  /* ------------------------------------------------------------ cash */
  rule('cash', () => {
    if (!isFinite(K.cash)) return;
    const mo = K.monthsOfCash;
    const head = K.cash < 0 ? 'Cash is overdrawn: ' + usd(K.cash) : 'Cash ' + usd(K.cash) + (mo != null ? ' - about ' + mo + ' ' + (mo === 1 ? 'month' : 'months') + ' of overhead' : '');
    const cmp = [];
    if (K.cashPrior != null && pm) cmp.push(chgText(K.cash, K.cashPrior, pmName));
    if (bsOk && A.bs.py) cmp.push(chgText(K.cash, A.bs.py.cash, py.label));
    let detail = cmp.length ? 'That is ' + joinAnd(cmp.filter(Boolean)) + '.' : '';
    if (mo != null && mo >= 0 && K.monthlyBurn > 0) detail += ' Runway is cash divided by average monthly overhead of ' + usd(K.monthlyBurn) + (K.burnFrom3 === false ? ' (this month only - the 3-month average could not be pulled)' : ' over the last 3 months') + '. Your targets: ' + goals.monthsCash + ' months comfortable, under ' + goals.monthsCashMin + ' urgent.';
    let sev = 'info';
    if (K.cash < 0 || (mo != null && mo < goals.monthsCashMin)) sev = 'action';
    else if (mo != null && mo < goals.monthsCash) sev = 'watch';
    else if (mo != null && K.cashPrior != null && K.cash >= K.cashPrior * 1.10 && K.cash - K.cashPrior >= 1000) sev = 'win';
    let tip = '';
    const thin = sev === 'action' || K.cash < 0 || !picBurnOk || (mo != null && mo < goals.monthsCash / 2);                 // under half the goal: a near-term question. Between half and the goal: how far from the goal.
    if ((sev === 'action' || sev === 'watch') && thin) tip = 'Suggestion: compare the payments due in the next four weeks with the collections expected in the same period. If there is a shortfall, start with the largest past-due receivables.';
    else if (sev === 'watch' && picBurnOk) tip = 'Suggestion: the ' + goals.monthsCash + '-month goal is ' + usd(rnd(goals.monthsCash * rnd(K.monthlyBurn))) + ' of cash and cash is ' + usd(rnd(goals.monthsCash * rnd(K.monthlyBurn)) - rnd(K.cash)) + ' below it. Retained profit, on-time collections and the timing of discretionary purchases move it toward the goal.';
    else if (sev === 'win') tip = 'Suggestion: assign the additional cash a purpose (debt paydown, equipment purchases, reserve).';
    add({ key: 'cash', cat: 'cash', sev, head, detail, tip, impact: Math.abs(K.cashPrior != null ? K.cash - K.cashPrior : K.cash), facts: { cash: K.cash, pm: K.cashPrior, mo } });
  });

  rule('profit_vs_cash', () => {
    if (!cashOk) return;
    const ni = cur.net, ops = CF.ops, gap = ops - ni;
    const flipped = (ni > 0 && ops < 0) || (ni < 0 && ops > 0);
    const notable = (flipped && Math.abs(gap) >= Math.max(2500, 0.05 * cur.rev)) || Math.abs(gap) >= Math.max(10000, 0.15 * cur.rev);
    if (!notable) return;
    /* QuickBooks files a line of credit or a card under OPERATING adjustments when it is a current liability, so paying one down shows up as
       "cash used by operations". Say what actually happened (debt was paid down) rather than naming the account and leaving the reader to guess. */
    const DEBT_WORDS = /line of credit|\bloc\b|loan|notes? payable|credit card|mortgage|visa|mastercard|amex|american express|financ|lease/i;
    const isDebt = (L) => {
      const g = ctx.bsGroupOf ? ctx.bsGroupOf(L) : null;                     // what the balance sheet says the account IS: "Loan to Shareholder" is an asset, not debt
      if (g !== null && g !== undefined) return /creditcard|liab/i.test(g) && DEBT_WORDS.test(L);
      return DEBT_WORDS.test(L) && !/loans? (to|from)\b|due (to|from)|receivable|advance|deposit/i.test(L);
    };
    const phrase = (a) => {
      const L = a.label, v = a.amount;
      if (/accounts receivable|^a\/r\b/i.test(L)) return v < 0 ? 'customers owe you ' + usd(-v) + ' more (A/R grew)' : 'customers paid down A/R by ' + usd(v);
      if (/accounts payable|^a\/p\b/i.test(L)) return v > 0 ? 'unpaid bills grew by ' + usd(v) + ' (A/P grew)' : 'you paid down A/P by ' + usd(-v);
      if (isDebt(L)) return v < 0 ? 'you paid down ' + L + ' by ' + usd(-v) : 'you borrowed ' + usd(v) + ' more on ' + L;
      if (/inventory/i.test(L)) return v < 0 ? 'inventory grew ' + usd(-v) : 'inventory shrank ' + usd(v);
      if (/depreciation|amortization/i.test(L)) return usd(v) + ' of ' + L.toLowerCase() + ' is a non-cash cost added back';
      return L + ': ' + (v < 0 ? 'used ' : 'freed ') + usd(Math.abs(v)) + ' of cash';
    };
    const drivers = CF.adjustments.filter(a => Math.abs(a.amount) >= 1000).sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount)).slice(0, 3);
    const debtPaid = CF.adjustments.filter(a => isDebt(a.label) && a.amount < 0).reduce((s, a) => s - a.amount, 0);
    const otherUse = CF.adjustments.filter(a => !isDebt(a.label) && a.amount < 0).reduce((m, a) => Math.max(m, -a.amount), 0);   // the biggest non-debt use of cash (A/R growth, inventory, ...)
    const debtDriven = ni > 0 && ops < 0 && debtPaid >= 0.5 * (ni - ops) && debtPaid >= otherUse;   // mostly debt being paid down, and nothing else bigger - a use of profit, not a warning
    const head = debtDriven ? 'Profit went to paying down debt: ' + usd(debtPaid) + ' left through operations'
      : (ni > 0 && ops < 0) ? 'Profitable on paper, but operations used ' + usd(-ops) + ' of cash'
        : (ni < 0 && ops > 0) ? 'A loss month, yet operations brought in ' + usd(ops) + ' of cash'
          : 'Operations produced ' + usd(ops) + ' of cash against ' + usd(ni) + ' of profit';
    const detail = 'Net income was ' + usd(ni) + ' but cash from operations was ' + usd(ops) + ', a gap of ' + usdUnsigned(rnd(ops) - rnd(ni)) + '.' + (drivers.length ? ' The biggest items: ' + list(drivers.map(phrase)) + '.' : '') + (debtDriven ? ' QuickBooks counts paying down a line of credit or card as an operating use of cash.' : '');
    const arGrew = drivers.some(a => /accounts receivable|^a\/r\b/i.test(a.label) && a.amount < 0);
    add({ key: 'profit_vs_cash', cat: 'cash', sev: (ni > 0 && ops < 0 && !debtDriven) ? 'watch' : 'info', head, detail,
      tip: debtDriven ? 'Suggestion: paying down debt reduces interest cost. Compare the remaining cash with the ' + goals.monthsCash + '-month goal.'
        : (arGrew ? 'Suggestion: profit is not cash until it is collected. Billing on milestones, taking deposits and following up on a schedule shorten the time from finished work to cash.' : 'Suggestion: compare net income with cash from operations each month. Differences come from changes in receivables, payables, inventory and debt payments, and from non-cash items such as depreciation.'),
      impact: Math.abs(gap), facts: { ni, ops, drivers: drivers.map(a => [a.label, a.amount]) } });
  });

  rule('debt', () => {
    if (!bsOk) return;       // the parts come from the balance sheet series: the report's own "line of credit" KPI can also sit inside its long-term total, and counting both would double it
    const b = A.bs.cur, bp = A.bs.prior, by = A.bs.py;
    const cc = Math.max(0, b.cc), loc = Math.max(0, b.loc), ltd = Math.max(0, b.ltd), total = b.debt;
    if (total <= 0.5) return;
    const parts = []; if (cc > 0.5) parts.push('credit cards ' + usd(cc)); if (loc > 0.5) parts.push('line of credit ' + usd(loc)); if (ltd > 0.5) parts.push('long-term ' + usd(ltd));
    const head = 'Debt ' + usd(total) + ' (' + parts.join(', ') + ')';
    const priorTotal = bp ? bp.debt : null, pyDebt = by ? by.debt : null, ccPrev = bp ? Math.max(0, bp.cc) : null;
    const cmp = [];
    if (priorTotal != null && pm) cmp.push(chgText(total, priorTotal, pmName));
    if (pyDebt != null && py) cmp.push(chgText(total, pyDebt, py.label));
    let detail = cmp.length ? 'That is ' + joinAnd(cmp.filter(Boolean)) + '.' : '';
    if (cc >= goals.ccHighBalance && ccPrev != null && pm) detail += ' Credit cards alone are ' + chgText(cc, ccPrev, pmName) + '.';
    if (cc >= goals.ccHighBalance && K.ccInterestAnnual) detail += ' At an assumed ' + pct0(K.ccApr || 0.2) + ' APR the card balance costs roughly ' + usd(K.ccInterestAnnual / 12) + ' a month (' + usd(K.ccInterestAnnual) + ' a year) in interest.';
    if (loc > 0.5 && K.locInterestAnnual) detail += ' At an assumed ' + pct0(K.locApr || 0.12) + ' the line of credit costs roughly ' + usd(K.locInterestAnnual / 12) + ' a month.';
    if (K.equity > 0) detail += ' Debt is ' + (total / K.equity).toFixed(2) + ' times equity.';
    let sev = 'info';
    const upPm = priorTotal != null && total > priorTotal * 1.10 && total - priorTotal >= 1000;
    const downPm = priorTotal != null && total < priorTotal * 0.97 && priorTotal - total >= 500;
    const ccRising = ccPrev != null && cc - ccPrev >= Math.max(1000, 0.05 * cc);                  // a few dollars more on a card is not news
    if ((cc >= goals.ccHighBalance && ccRising) || (upPm && K.cashPrior != null && K.cash < K.cashPrior)) sev = 'watch';
    else if (downPm && (pyDebt == null || total <= pyDebt)) sev = 'win';
    let tip = '';
    if (cc >= goals.ccHighBalance) tip = 'Suggestion: pay down the highest-rate balance first. Interest on a carried card balance is a recurring cost.';
    else if (sev === 'watch' && loc > 0.5 && bp && loc - Math.max(0, bp.loc) >= 500) tip = 'Suggestion: the line of credit balance increased. Identify what the draw funded (collections timing, pricing or overhead) and when it will be repaid.';
    else if (sev === 'watch') tip = 'Suggestion: debt increased while cash decreased. Set the order in which balances are paid down and identify the cash that will fund it.';
    add({ key: 'debt', cat: 'obligations', sev, head, detail, tip, impact: sev === 'watch' ? Math.max(ccPrev != null ? Math.max(0, cc - ccPrev) : 0, priorTotal != null ? Math.max(0, total - priorTotal) : 0) : Math.abs(priorTotal != null ? total - priorTotal : 0), facts: { cc, loc, ltd, pm: priorTotal } });
  });

  rule('liquidity', () => {
    if (K.currentRatio == null) return;
    const head = 'Current ratio ' + K.currentRatio.toFixed(2) + ' (' + usd(rnd(K.currentAssets) - rnd(K.currentLiabilities)) + ' of working capital)';
    let detail = 'Current assets ' + usd(K.currentAssets) + ' against current liabilities ' + usd(K.currentLiabilities) + '.';
    const refs = []; if (K.currentRatioPrior != null && pm) refs.push(K.currentRatioPrior.toFixed(2) + ' in ' + pmName); if (bsOk && A.bs.py && A.bs.py.currentRatio != null) refs.push(A.bs.py.currentRatio.toFixed(2) + ' in ' + py.label);
    if (refs.length) detail += ' It was ' + joinAnd(refs) + '.';
    detail += ' Your target is ' + goals.currentRatio + ' or better.';
    let sev = 'info';
    if (K.currentRatio < goals.currentRatioMin) sev = 'action'; else if (K.currentRatio < goals.currentRatio) sev = 'watch';
    else if (K.currentRatioPrior != null && K.currentRatio > K.currentRatioPrior) sev = 'win';
    const tip = (sev === 'action' || sev === 'watch') ? (K.currentRatio < 1 ? 'Suggestion: a current ratio under 1 means short-term liabilities exceed short-term assets. The options are faster collections, refinancing short-term debt into longer terms, or increasing cash.' : 'Suggestion: the current ratio is below the ' + goals.currentRatio + ' goal. The options are faster collections, refinancing short-term debt into longer terms, or increasing cash.') : '';
    add({ key: 'liquidity', cat: 'obligations', sev, head, detail, tip, impact: Math.abs(K.workingCapital - (K.workingCapitalPrior != null ? K.workingCapitalPrior : K.workingCapital)), facts: { cr: K.currentRatio, pm: K.currentRatioPrior } });
  });

  /* ------------------------------------------------------------ collections and payables */
  rule('ar', () => {
    const r = A.ar; if (!r || r.total <= 0.5) return;
    const share60 = r.over60 / r.total;
    const head = 'Receivables ' + usd(r.total) + (r.over60 > 0.5 ? ': ' + usd(r.over60) + ' is over 60 days past due' : (r.past > 0.5 ? ': ' + usd(r.past) + ' is past due' : ': everything is current'));
    let detail = bucketText(r);
    const named = r.topOver60.length ?r.topOver60.slice(0, 3).map(x => short(x.name) + ' ' + usd(x.over60)) : r.topPast.slice(0, 3).map(x => short(x.name) + ' ' + usd(x.past));
    if (named.length) detail += (r.topOver60.length ? ' Oldest balances: ' : ' Largest past-due balances: ') + list(named) + '.';
    const top = r.top[0];
    if (top && top.share != null && top.share >= 0.4 && top.total >= 5000) detail += ' ' + short(top.name) + ' is ' + pct0(top.share) + ' of everything owed to you.';
    const dsoRefs = [(A.dso && A.dso.prior != null && pm) ? dnum(A.dso.prior) + ' in ' + pmName : '', (A.dso && A.dso.py != null && py) ? dnum(A.dso.py) + ' in ' + py.label : ''].filter(Boolean);
    if (bsOk && A.dso && A.dso.cur != null && r.total >= 1000) detail += ' Customers are taking about ' + plural(A.dso.cur, 'day') + ' to pay' + (dsoRefs.length ? ' (' + joinAnd(dsoRefs) + ')' : '') + ', measured on your last 3 months of revenue.';
    let sev = 'info';
    const dsoUp = bsOk && A.dso.cur != null && A.dso.prior != null && A.dso.cur - A.dso.prior >= 10;
    if ((share60 >= 0.25 && r.over60 >= 2000) || r.over90 >= Math.max(5000, 0.10 * r.total)) sev = 'action';
    else if ((r.over60 >= 1000 && share60 >= 0.10) || dsoUp) sev = 'watch';
    else if (r.over60 < 0.5 && bsOk && A.dso.cur != null && A.dso.py != null && A.dso.py - A.dso.cur >= 5) sev = 'win';
    let tip = '';
    if (sev === 'action' || sev === 'watch') {
      const t0 = r.topOver60[0];
      tip = (t0 ? 'Suggestion: contact ' + short(t0.name) + ' about the ' + usd(t0.over60) + ' that is over 60 days past due. Confirm the invoice is correct and obtain a committed payment date in writing. ' : 'Suggestion: work the oldest invoices first. Confirm each is correct and obtain a committed payment date in writing. ')
        + 'On new work, consider deposits or progress billing.';
    }
    add({ key: 'ar', cat: 'collections', sev, head, detail, tip, impact: r.over60 || r.past, facts: { total: r.total, over60: r.over60, past: r.past, dso: A.dso && A.dso.cur, top: r.topOver60.slice(0, 3).map(x => [x.name, x.over60]) } });
  });

  rule('ap', () => {
    const r = A.ap; if (!r || r.total <= 0.5) return;
    const head = 'Payables ' + usd(r.total) + (r.over60 > 0.5 ? ': ' + usd(r.over60) + ' is over 60 days past due' : (r.past > 0.5 ? ': ' + usd(r.past) + ' is past due' : ': nothing is past due'));
    let detail = bucketText(r);
    const named = r.topPast.slice(0, 3).map(x => short(x.name) + ' ' + usd(x.past));
    if (named.length) detail += ' Most overdue: ' + list(named) + '.';
    const apPm = bsOk && A.bs.prior ? A.bs.prior.ap : null;
    if (apPm != null && pm && (Math.abs(r.total - apPm) >= Math.max(500, 0.2 * Math.abs(apPm)))) detail += ' Payables were ' + usd(apPm) + ' in ' + pmName + '.';
    if (bsOk && A.dpo && A.dpo.cur != null && r.total >= 1000) detail += ' Payables equal about ' + plural(A.dpo.cur, 'day') + ' of your costs' + ((A.dpo.prior != null && pm) ? ' (' + dnum(A.dpo.prior) + ' in ' + pmName + ')' : '') + ', measured on your last 3 months.';
    let sev = 'info';
    const jump = apPm != null && apPm >= 0 && r.total - apPm >= 5000 && r.total >= 2 * Math.max(apPm, 1);
    if (r.over90 >= Math.max(2500, 0.10 * r.total)) sev = 'action';
    else if (r.over60 > 0.5 || (r.past / r.total >= 0.4 && r.past >= 2500) || jump) sev = 'watch';
    else if (apPm != null && apPm >= 5000 && r.total <= apPm * 0.8 && r.past < 0.5) sev = 'win';
    const rCash = rnd(K.cash || 0), rPast = rnd(r.past);
    const covered = isFinite(K.cash) && r.past > 0.5 && rCash >= rPast && (picRatio == null || picRatio >= 1);        // not when current liabilities exceed current assets
    if (r.past > 0.5 && isFinite(K.cash)) detail += ' ' + (K.cash < 0 ? 'The bank accounts are overdrawn by ' + usdUnsigned(K.cash) + ', and ' + usd(r.past) + ' is past due.' : 'Cash on hand is ' + usd(K.cash) + ', ' + (rCash > rPast ? 'more than' : (rCash === rPast ? 'equal to' : 'less than')) + ' the ' + usd(r.past) + ' past due.');
    const tip = (sev === 'action' || sev === 'watch')
      ? (r.past > 0.5 ? (covered ? 'Suggestion: cash on hand covers the past-due balances. Confirm whether each one is disputed, waiting for approval or scheduled for payment, and pay or schedule the rest.' : 'Suggestion: contact the vendors with overdue balances to confirm the amounts and agree on payment dates. Keeping supplier accounts current maintains credit terms.')
        : 'Suggestion: payables increased. Confirm the new bills are correct and note the due date of each.') : '';
    add({ key: 'ap', cat: 'collections', sev, head, detail, tip, impact: r.over60 || r.past, facts: { total: r.total, over60: r.over60, past: r.past, pm: apPm, top: r.topPast.slice(0, 3).map(x => [x.name, x.past]) } });
  });

  rule('retainage', () => {
    if (!(K.retainage > 0.5)) return;
    const recv = (K.ar || 0) + K.retainage, share = recv > 0 ? K.retainage / recv : null;
    const head = 'Retainage held by customers ' + usd(K.retainage);
    let detail = (K.retainagePrior != null && pm) ? 'That is ' + chgText(K.retainage, K.retainagePrior, pmName) + '.' : '';
    if (share != null) detail += (detail ? ' ' : '') + 'It is ' + pct0(share) + ' of all money owed to you (A/R plus retainage).';
    add({ key: 'retainage', cat: 'collections', sev: (share != null && share >= 0.25 && K.retainage >= 10000) ? 'watch' : 'info', head, detail, tip: 'Suggestion: include retainage release on each job closeout checklist. Retainage is earned revenue that has not been collected.', impact: K.retainage, facts: { ret: K.retainage, pm: K.retainagePrior } });
  });

  rule('equity', () => {
    if (!isFinite(K.equity)) return;
    const head = K.equity < 0 ? 'Equity is negative: ' + usd(K.equity) : 'Equity ' + usd(K.equity);
    const cmp = []; if (K.equityPrior != null && pm) cmp.push(chgText(K.equity, K.equityPrior, pmName));
    const eqPy = bsOk && A.bs.py ? A.bs.py.equity : null;
    if (eqPy != null) cmp.push(chgText(K.equity, eqPy, py.label));
    let detail = cmp.length ? 'That is ' + joinAnd(cmp.filter(Boolean)) + '.' : '';
    let leaked = null;
    if (eqPy != null && ttm && ttm.n === 12) {
      leaked = (ttm.net) - (K.equity - eqPy);
      if (ttm.net > 0 && leaked >= Math.max(5000, 0.25 * ttm.net)) detail += ' Over the last 12 months the business earned ' + usd(ttm.net) + ' but equity moved by ' + usd(rnd(K.equity) - rnd(eqPy)) + ', so about ' + usd(rnd(ttm.net) - (rnd(K.equity) - rnd(eqPy))) + ' went out through equity (owner draws or distributions are the usual reason).';
    }
    const bigLeak = leaked != null && ttm.net > 0 && leaked >= Math.max(5000, 0.25 * ttm.net);
    let sev = 'info';
    if (K.equity < 0) sev = 'action';
    else if (eqPy != null && K.equity < eqPy && eqPy - K.equity >= Math.max(5000, 0.10 * Math.abs(eqPy))) sev = 'watch';
    else if (bigLeak) sev = 'info';                                   // money leaving through equity is not a "win", whatever the balance did
    else if (eqPy != null && K.equity > eqPy && K.equity - eqPy >= Math.max(5000, 0.05 * Math.abs(eqPy))) sev = 'win';
    const tip = K.equity < 0 ? 'Suggestion: negative equity means liabilities exceed assets on the books. Equity increases through retained profit and owner contributions.'
      : ((sev === 'watch' || bigLeak) ? 'Suggestion: plan owner draws and distributions against profit and cash each month.' : '');
    add({ key: 'equity', cat: 'obligations', sev, head, detail, tip, impact: Math.abs(eqPy != null ? K.equity - eqPy : K.equity), facts: { eq: K.equity, pm: K.equityPrior, py: eqPy } });
  });

  rule('ahead', () => {
    const a = A.ahead; if (!a || Math.abs(a.change) < 0.15) return;
    const hi = a.change > 0;
    add({ key: 'ahead', cat: 'outlook', sev: 'info', head: 'Seasonal pattern for ' + a.nextName + ': last year revenue ' + (hi ? 'rose ' : 'fell ') + Math.round(Math.abs(a.change) * 100) + '%',
      detail: 'In ' + a.thenLabel + ' revenue was ' + usd(a.thenRev) + ', ' + (hi ? 'up from ' : 'down from ') + usd(a.thisRev) + ' in ' + a.thisLabel + '. That is last year\'s pattern, not a forecast.',
      tip: hi ? 'Suggestion: higher volume generally requires paying for materials and payroll before customers pay. Confirm cash can cover it.' : 'Suggestion: revenue fell in ' + a.nextName + ' last year. Review cash, scheduled work and discretionary spending for it.',
      impact: Math.abs(a.thenRev - a.thisRev), facts: { ch: Math.round(a.change * 100) } });
  });

  /* ------------------------------------------------------------ cash targets: a slower season ahead, cash above the target, year-end tax planning */
  /* The firm's targets are settable in Admin -> Report goals. Each of these states what the books show, the arithmetic, and one plain action. Every dollar figure is a
     whole-dollar value built from the figures printed beside it, so the sentences foot as printed. */
  const burn = K.monthlyBurn, burnR = rnd(burn || 0), avgRev12 = ttm ? ttm.rev / 12 : cur.rev;
  /* Months of overhead is a runway only when overhead is a real share of what the business spends, and only when the 3-month average could be pulled. */
  const haveRunway = isFinite(K.cash) && burn > 0 && K.monthsOfCash != null && K.burnFrom3 !== false && burn >= Math.max(100, 0.01 * avgRev12);
  /* A slower season: the three months after this point averaged at least the set fall below the LOWEST of the three before (so one large job in the earlier months is not a season;
     this also puts the average at least that far under the three-month average), and at least two of the three were each under that lowest month (so one dead month is not a season). */
  const sn = A.season, slowAhead = !!(sn && sn.broad && goals.slowSeasonDrop > 0 && sn.afterAvg <= (1 - goals.slowSeasonDrop) * sn.beforeMin);
  const targetR = rnd(goals.monthsCash * burnR), cashR = rnd(K.cash || 0), mAhead = (n) => n + (n === 1 ? ' month' : ' months');
  const cashSentence = K.cash < 0 ? 'Cash is overdrawn by ' + usdUnsigned(K.cash) + '. Overhead averages ' + usd(burnR) + ' a month.'
    : 'Cash is ' + usd(K.cash) + ', or ' + K.monthsOfCash + ' ' + (K.monthsOfCash === 1 ? 'month' : 'months') + ' of overhead at ' + usd(burnR) + ' a month.';

  rule('season', () => {
    if (!slowAhead || !haveRunway) return;
    const mo = K.monthsOfCash, target = goals.monthsCash, below = cashR < targetR;
    const down = Math.round((1 - rnd(sn.afterAvg) / rnd(sn.beforeAvg)) * 100), gap = targetR - cashR, win = sn.nextFrom + ' to ' + sn.nextTo;
    const detail = 'Last year revenue averaged ' + usd(sn.afterAvg) + ' a month from ' + sn.lastYearFrom + ' to ' + sn.lastYearTo + ', ' + down + '% below the ' + usd(sn.beforeAvg) + ' a month from ' + sn.beforeFrom + ' to ' + sn.beforeTo + '. '
      + (sn.afterNet >= 0 ? 'Net income for those three months last year totaled ' + usd(sn.afterNet) + '.' : 'Those three months last year produced a net loss of ' + usdUnsigned(sn.afterNet) + '.')
      + ' That is last year\'s pattern, not a forecast. ' + cashSentence + ' The ' + target + '-month target is ' + usd(targetR) + (below ? ', which is ' + usd(gap) + ' more than the current cash' : '') + '.';
    add({ key: 'season', cat: 'outlook', sev: below ? (mo < goals.monthsCashMin ? 'action' : 'watch') : 'win',
      head: (below ? 'Cash is below the ' : 'Cash meets the ') + target + '-month target; revenue in ' + win + ' was ' + down + '% lower last year',
      detail, tip: below ? 'Suggestion: plan cash for ' + win + ': collect receivables as they come due and schedule discretionary purchases after the slower period.' : '',
      impact: below ? gap : 0, facts: { down, mo, t: target } });
  });

  rule('invest', () => {
    if (!(goals.investMinAmount > 0) || !haveRunway || K.cash <= 0) return;
    if (!(ttm ? ttm.net > 0 : (ytd ? ytd.net > 0 : cur.net > 0)) || (ytd && ytd.net < 0)) return;      // a profitable year, not just a profitable trailing 12 months
    const target = goals.monthsCash;
    const reserve = slowAhead ? Math.max(0, -sn.afterNet) : 0;                  // last year's net loss in the slower months is cash this business used
    const er = cashR - targetR, lr = rnd(reserve), after = er - lr;
    const wcR = rnd(K.currentAssets) - rnd(K.currentLiabilities);              // cash cannot be free beyond what current assets leave after current liabilities (deposits, taxes and bills owed)
    const fr = Math.min(after, wcR);
    if (fr < goals.investMinAmount) return;
    const cc = Math.max(0, K.creditCards || 0), loc = Math.max(0, K.lineOfCredit || 0);
    const ccCounts = cc >= goals.ccHighBalance, locCounts = loc > 0.5;           // a small card balance is monthly float, as in the debt rule
    const debtR = rnd((ccCounts ? cc : 0) + (locCounts ? loc : 0)), payR = Math.min(fr, debtR), restR = fr - payR;
    const owed = ccCounts && locCounts ? 'credit card and line of credit' : (ccCounts ? 'credit card' : 'line of credit');
    let detail = cashSentence + ' ' + target + ' months of overhead is ' + usd(targetR) + ', which leaves ' + usd(er) + ' above the target.';
    if (lr > 0) detail += ' Net income for ' + sn.nextFrom + ' to ' + sn.nextTo + ' of last year was a loss of ' + usd(lr) + ', which is set aside, leaving ' + usd(after) + '.';
    if (fr < after) detail += ' Current assets exceed current liabilities by ' + usd(wcR) + ', which limits the amount to ' + usd(fr) + '.';
    if (debtR > 0) detail += ' The business carries ' + usd(debtR) + ' on ' + (ccCounts && locCounts ? 'credit cards and the line of credit' : (ccCounts ? 'credit cards' : 'the line of credit')) + '.';
    const keep = 'keep ' + usd(cashR - fr) + ' in operating accounts', hold = 'an interest-bearing account, such as a business money market account';
    const tip = debtR > 0
      ? 'Suggestion: ' + keep + ' and use ' + usd(payR) + ' to pay down ' + owed + ' balances, which normally carry higher interest rates than a deposit account earns' + (restR > 0 ? '. The remaining ' + usd(restR) + ' can be held in ' + hold + '.' : '.')
      : 'Suggestion: ' + keep + ' and consider holding the ' + usd(fr) + ' above it in ' + hold + '.';
    add({ key: 'invest', cat: 'outlook', sev: 'info', head: 'About ' + usd(fr) + ' of cash is available above the ' + target + '-month target', detail, tip, impact: fr, facts: { mo: K.monthsOfCash, t: target, f: fr } });
  });

  rule('tax', () => {
    const m = +keys[idx].slice(5, 7);
    if (!(goals.taxFromMonth >= 1) || m < goals.taxFromMonth || m > 11 || !ytd || !(ytd.net >= goals.taxMinProfit)) return;
    const left = 12 - m, mn = monthName(keys[idx]);
    let detail = 'Net income from January through ' + mn + ' is ' + usd(ytd.net) + (ytd.nm != null ? ' (' + pct0(ytd.nm) + ' of revenue)' : '');
    if (pytd) detail += ', ' + chgText(ytd.net, pytd.net, 'the same point last year');
    detail += '. ' + mAhead(left) + ' of the year ' + (left === 1 ? 'follows ' : 'follow ') + mn + '. Taxable income for the year depends on the entity type, the owners\' other income and tax elections. Some tax planning decisions, such as the timing of equipment purchases, depend on year-end dates.';
    add({ key: 'tax', cat: 'outlook', sev: m >= 10 ? 'watch' : 'info', head: 'Year-to-date profit through ' + mn + ' is ' + usd(ytd.net), detail,
      tip: 'Suggestion: send these year-to-date figures to the CPA so taxable income and estimated tax payments for the year can be projected before year-end.',
      impact: ytd.net, facts: { ytd: ytd.net, m } });
  });

  /* ------------------------------------------------------------ for the coach only */
  (A.books || []).forEach(b => add({ key: 'books_' + b.key, cat: 'books', aud: 'coach', sev: b.key === 'no-py' ? 'info' : 'watch', head: b.text, detail: '', tip: '', impact: 0, facts: { t: b.text } }));

  /* ------------------------------------------------------------ rank, choose what prints, summarise */
  /* a short imperative for the "next 30 days" checklist, built from the same facts the insight states */
  const ACT = {
    net_income: (o) => o.sev === 'win' ? 'Identify what drove this month' : 'Review the lines behind the profit change: one-time or ongoing',
    revenue: () => 'Review the customers and income lines behind the revenue decline',
    gross_margin: () => 'Compare quoted cost with actual cost on the largest jobs and update open quotes',
    overhead: () => 'Review recurring overhead lines against last month and last year',
    movers_cost: () => 'For each rising cost, determine whether it is one-time or ongoing',
    unusual: (o) => { const f = (Array.isArray(o.facts) ? o.facts : []).find(x => !x[3]); return f ? 'Confirm ' + short(f[0]) + ' ' + usd(f[1]) + ' is coded correctly and whether it will recur' : ''; },
    breakeven: () => 'Compare monthly revenue with break-even and review margin and volume',
    streak: () => 'Identify whether price, cost or volume is behind the losses',
    cash: (o) => ((o.sev !== 'action' && picBurnOk && o.facts && o.facts.cash >= 0 && o.facts.mo != null && o.facts.mo >= goals.monthsCash / 2) ? 'Build cash toward the ' + goals.monthsCash + '-month goal' : 'Compare the next four weeks of payments with expected collections'),
    season: (o) => 'Build cash toward the ' + ((o.facts && o.facts.t) || goals.monthsCash) + '-month target before the months that were slower last year',
    tax: () => 'Send the year-to-date financials to the CPA for a tax projection',
    profit_vs_cash: () => 'Review the receivables, payables and debt payments behind the gap between profit and cash',
    debt: () => 'Review the debt balances and set the order in which they are paid down',
    liquidity: () => 'Review collections and short-term debt to improve the current ratio',
    ar: (o) => { const t = ((o.facts && o.facts.top) || [])[0]; return t ? 'Contact ' + short(t[0]) + ' about ' + usd(t[1]) + ' over 60 days' : 'Work the oldest invoices'; },
    ap: (o) => { const t = ((o.facts && o.facts.top) || [])[0]; return t ? 'Contact ' + short(t[0]) + ' about the overdue balance' : 'Confirm the new bills and their due dates'; },
    retainage: () => 'Add retainage release to each job closeout checklist',
    equity: () => 'Plan draws and distributions against profit and cash each month'
  };
  out.forEach(o => { o.act = (ACT[o.key] && o.aud === 'client') ? ACT[o.key](o) : ''; });
  /* Within a severity, urgent items rank by the dollars involved. Good news and background rank by how much a client cares: profit and revenue
     before a debt paydown that happens to be a bigger number. */
  const PRIORITY = { net_income: 1, revenue: 2, season: 2.5, debt: 3, tax: 3.5, streak: 4, gross_margin: 5, overhead: 6, cash: 7, liquidity: 8, equity: 9, breakeven: 10, retainage: 11, invest: 11.5, unusual: 8.5, movers_rev: 12, movers_cost: 13, ahead: 14 };
  const pri = (o) => PRIORITY[o.key] || 50;
  /* Dollar impacts from different rules are not comparable (a break-even gap against a cash shortfall), so things that need attention rank by what a
     client must look at first - cash and solvency, then profit, then collections - and only then by their own dollars. */
  const ATTN = { cash: 1, profit_vs_cash: 2, net_income: 3, ar: 4, ap: 5, debt: 6, liquidity: 7, gross_margin: 8, revenue: 9, unusual: 10, movers_cost: 11, overhead: 12, breakeven: 13, equity: 14, streak: 15, retainage: 16, season: 1.5, tax: 17 };
  const apri = (o) => ATTN[o.key] || 50;
  out.sort((a, b) => (SEV_WEIGHT[b.sev] - SEV_WEIGHT[a.sev]) || ((a.sev === 'win' || a.sev === 'info') ? (pri(a) - pri(b) || (b.impact - a.impact)) : (apri(a) - apri(b) || (b.impact - a.impact))));
  const caps = { win: 5, info: 2 }, used = { win: 0, info: 0 };
  let attn = 0;
  out.forEach((o, i) => {
    o.rank = i + 1;
    if (o.aud === 'coach') { o.include = false; return; }
    /* never dropped by a cap: the number every client looks for first (cash), what explains it when profit and cash part ways, and the time-sensitive planning items the firm asked for */
    const pinned = o.key === 'cash' || o.key === 'profit_vs_cash' || o.key === 'season' || o.key === 'tax' || o.key === 'invest' || o.key === 'unusual';
    if (pinned) o.include = true;
    else if (o.sev === 'action' || o.sev === 'watch') { attn++; o.include = attn <= 7; }
    else { used[o.sev]++; o.include = used[o.sev] <= caps[o.sev]; }
  });
  A.insights = out;
  A.actions = out.filter(o => o.include && o.aud === 'client' && (o.sev === 'action' || o.sev === 'watch') && o.act).slice(0, 5).map(o => ({ key: o.key, head: o.head, act: o.act, tip: o.tip.replace(/^Suggestion:\s*/, '') }));

  /* scorecard */
  const sc = [];
  { // profit
    let st = 'watch'; const nm = cur.nm;
    if (cur.net < 0) st = 'bad'; else if (nm != null && nm >= goals.netMargin && (!ytd || ytd.net >= 0)) st = 'good';
    if (st === 'good' && pm && pm.net > 0 && cur.net < pm.net * 0.5 && pm.net - cur.net >= 5000) st = 'watch';   // a collapse is a watch even above the margin goal
    sc.push({ key: 'profit', title: 'Profit', status: st, line: (cur.net < 0 ? 'Loss of ' + usdUnsigned(cur.net) : usd(cur.net) + (nm != null ? ' (' + pct0(nm) + ')' : '')) + (ytd ? ', YTD ' + usd(ytd.net) : '') });
  }
  { // cash
    const mo = K.monthsOfCash; let st = 'na', line = usd(K.cash);
    if (K.cash < 0) { st = 'bad'; line = 'Overdrawn ' + usd(K.cash); }
    else if (mo != null) { st = mo >= goals.monthsCash ? 'good' : (mo < goals.monthsCashMin ? 'bad' : 'watch'); line = usd(K.cash) + ', ' + mo + (mo === 1 ? ' month' : ' months'); }
    sc.push({ key: 'cash', title: 'Cash', status: st, line });
  }
  { // collections
    const r = A.ar; let st = 'na', line = 'Aging not available';
    if (r) { if (r.total <= 0.5) { st = 'good'; line = 'No receivables'; } else { const s60 = r.over60 / r.total; const dsoUpT = bsOk && A.dso && A.dso.cur != null && A.dso.prior != null && A.dso.cur - A.dso.prior >= 10; st = (s60 >= 0.25 && r.over60 >= 2000) || r.over90 >= Math.max(5000, 0.10 * r.total) ? 'bad' : ((r.over60 >= 1000 && s60 >= 0.10) || dsoUpT ? 'watch' : 'good'); line = usd(r.total) + ', ' + (r.over60 > 0.5 ? usd(r.over60) + ' over 60 days' : 'none over 60 days'); } }
    sc.push({ key: 'collections', title: 'Collections', status: st, line });
  }
  { // obligations
    let st = 'na', line = 'Not available';
    if (K.currentRatio != null) {
      const ap60 = A.ap ? A.ap.over60 : 0, ap90 = A.ap ? A.ap.over90 : 0;
      st = (K.currentRatio < goals.currentRatioMin || ap90 >= 2500) ? 'bad' : ((K.currentRatio < goals.currentRatio || ap60 > 0.5) ? 'watch' : 'good');
      line = 'Current ratio ' + K.currentRatio.toFixed(2) + (A.ap ? (ap60 > 0.5 ? ', ' + usd(ap60) + ' of bills over 60 days' : ', no bills over 60 days') : '');
    }
    sc.push({ key: 'obligations', title: 'Bills & debt', status: st, line });
  }
  { // momentum
    let st = 'na', line = 'No prior-year data';
    const g = (ytd && pytd) ? pctChange(ytd.rev, pytd.rev) : null;
    if (g != null) { st = g >= 0.03 ? 'good' : (g <= -0.10 ? 'bad' : 'watch'); line = Math.round(Math.abs(g) * 100) === 0 ? 'Revenue YTD about the same as last year' : 'Revenue YTD ' + (g >= 0 ? 'up ' : 'down ') + Math.round(Math.abs(g) * 100) + '% on last year'; }
    else if (ytd && pytd) { line = 'Revenue YTD ' + usd(ytd.rev) + ' vs ' + usd(pytd.rev); }
    sc.push({ key: 'momentum', title: 'Momentum', status: st, line });
  }
  A.scorecard = sc;

  /* the bottom line: three sentences a client can read in ten seconds */
  const hl = [];
  {
    let s = curName + ' ' + (cur.net >= 0 ? 'net income ' + usd(cur.net) + (cur.nm != null ? ' (' + pct0(cur.nm) + ' margin)' : '') : 'net loss ' + usdUnsigned(cur.net));
    const dir = (c, b) => Math.abs(c - b) < Math.max(0.5, Math.abs(b) * 0.005) ? 'flat' : (c > b ? 'up' : 'down');
    const refs = []; if (pm) refs.push(dir(cur.net, pm.net) + ' from ' + usd(pm.net) + ' in ' + pmName); if (py) refs.push(dir(cur.net, py.net) + ' from ' + usd(py.net) + ' in ' + py.label);
    if (refs.length) s += ', ' + joinAnd(refs);
    s += '.'; if (ytd) s += ' Year to date ' + usd(ytd.net) + (pytd ? ' against ' + usd(pytd.net) + ' at the same point last year' : '') + '.';
    hl.push(s);
  }
  if (isFinite(K.cash)) {
    let s = (K.cash < 0 ? 'Cash is overdrawn at ' + usd(K.cash) : 'Cash ' + usd(K.cash) + (K.monthsOfCash != null ? ', about ' + K.monthsOfCash + (K.monthsOfCash === 1 ? ' month' : ' months') + ' of overhead' : ''));
    if (K.cashPrior != null && pm) { const raw = K.cash - K.cashPrior, d = rnd(K.cash) - rnd(K.cashPrior); s += Math.abs(raw) < 0.5 ? ', unchanged from ' + pmName : ((d === 0 || Math.abs(raw) < Math.abs(K.cashPrior) * 0.005) ? ', about the same as ' + pmName : (d > 0 ? ', up ' : ', down ') + usdUnsigned(d) + ' from ' + pmName); }
    hl.push(s + '.');
  }
  const top = out.find(o => o.aud === 'client' && (o.sev === 'action' || o.sev === 'watch') && o.key !== 'tax' && o.key !== 'invest');
  const checkedAll = bsOk && cashOk && !!A.ar && !!A.ap && leafOk;
  hl.push(top ? 'Top priority: ' + top.head + '.' : (checkedAll ? 'No red flags this month.' : 'No red flags in the figures we could check this month.'));
  A.headline = hl;
}

module.exports = { build };
