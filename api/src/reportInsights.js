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
    if (ni < 0) tip = 'Our tip: a loss month is a cue to look at pricing before cutting costs - check whether this month\'s work was quoted at today\'s material and labor costs.';
    else if (sev === 'watch') tip = 'Our tip: when profit swings this much, find the one or two lines that moved (see "What moved") and settle whether each is one-time or the new normal before you change anything.';
    else if (sev === 'win') tip = 'Our tip: write down what drove this month - the customers, the type of work, the pricing - so it is repeatable, and keep overhead from rising with it.';
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
    if (sev === 'action' || sev === 'watch') tip = 'Our tip: find where the gap is - "What moved" shows which customers or income lines changed. If the pipeline is thin, call past customers and get quotes out now; a revenue dip reaches cash a month or two later.';
    else if (sev === 'win') tip = 'Our tip: put numbers on what is working (customer, type of work, season) so you can do more of it, and watch that costs do not climb as fast as sales.';
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
      ? 'Our tip: look at your biggest jobs, products or services and compare what you quoted with what it actually cost. If costs moved, reprice open quotes now - margin lost on finished work is hard to win back.'
      : (sev === 'win' ? 'Our tip: find out why it improved - better pricing, cheaper materials, tighter labor - and lock it into your next quotes.' : '');
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
    const tip = sev === 'watch' ? 'Our tip: go through recurring overhead line by line - insurance, software, vehicles, phones, subscriptions. The costs that crept up quietly are usually the easiest dollars to get back.' : '';
    add({ key: 'overhead', cat: 'profit', sev, head, detail, tip, impact: pm ? Math.abs(cur.opex - pm.opex) : 0, facts: { opex: cur.opex, pm: pm && pm.opex, ytdPct: ytd && ytd.opexPct != null ? Math.round(ytd.opexPct * 100) : null, pytdPct: pytd && pytd.opexPct != null ? Math.round(pytd.opexPct * 100) : null } });
  });

  /* ------------------------------------------------------------ what moved */
  rule('movers', () => {
    const mv = A.movers || {};
    const costUp = (arr) => (arr || []).filter(m => m.side === 'cost' && m.delta > 0).slice(0, 3);
    const lines = [], facts = {};
    const cuP = costUp(mv.prior), cuY = costUp(mv.py);
    if (cuP.length) { lines.push('Versus ' + pmName + ': ' + list(cuP.map(moverText)) + '.'); facts.p = cuP.map(m => [m.name, m.delta]); }
    if (cuY.length) { lines.push('Versus ' + py.label + ': ' + list(cuY.map(moverText)) + '.'); facts.y = cuY.map(m => [m.name, m.delta]); }
    if (!lines.length) return;
    const top = cuP.length ? sumDelta(cuP.filter(m => !m.seasonal)) : sumDelta(cuY);
    const sev = top >= Math.max(2000, 0.03 * cur.rev) ? 'watch' : 'info';
    const lead = cuP.length ? cuP[0] : cuY[0];
    add({ key: 'movers_cost', cat: 'profit', sev, head: 'Costs that rose the most: ' + short(lead.name) + ' ' + signedAmt(rdelta(lead)), detail: lines.join(' '), tip: sev === 'watch' ? 'Our tip: for each one ask "one-time, or the new normal?" A one-time item can be set aside when you compare months; a new normal has to be priced into your quotes.' : '', impact: top, facts });
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
    const one = (x) => short(x.name) + ' ' + usd(x.cur) + (x.isNew ? ' (nothing like it in the previous ' + x.monthsSeen + ' months)' : ', against a typical ' + usd(x.typical) + ' a month') + (x.seasonal ? '; ' + py.label + ' was ' + usd(x.sameMonthLastYear) + ', so it may be annual or seasonal' : '');
    const real = u.filter(x => !x.seasonal);
    const head = (real.length ? 'Unusual cost to confirm: ' : 'Large cost that looks seasonal: ') + short((real[0] || u[0]).name) + ' ' + usd((real[0] || u[0]).cur);
    add({ key: 'unusual', cat: 'profit', sev: real.length ? 'watch' : 'info', head, detail: u.map(one).join('. ') + '.',
      tip: 'Our tip: confirm each is coded correctly and whether it will recur. A mis-coded or doubled entry is the cheapest problem to fix, and we would rather catch it now than at year-end.',
      impact: Math.max.apply(null, u.map(x => x.cur - x.typical)), facts: u.map(x => [x.name, x.cur, x.typical, !!x.seasonal]) });
  });

  rule('breakeven', () => {
    const be = A.breakeven; if (!be) return;
    if (be.revenue == null) {
      if (be.thin && be.curRev > 0) add({ key: 'breakeven', cat: 'profit', sev: 'action', head: 'Gross margin is too thin to cover overhead', detail: 'Over the last 3 months gross margin averaged ' + pct0(be.gm) + ' while overhead averaged ' + usd(be.overhead) + ' a month, so no level of sales at these prices covers overhead.', tip: 'Our tip: this is a pricing or job-cost problem before it is an overhead problem - start with what each type of work actually costs against what you charge.', impact: be.overhead, facts: { gm: Math.round(be.gm * 100), oh: be.overhead } });
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
      tip: 'Our tip: break-even is your floor, not your target. Decide the profit you want, add it to overhead and divide by gross margin - that is the monthly revenue to book.', impact: Math.abs(be.curRev - be.revenue), facts: { be: be.revenue, rev: be.curRev } });
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
    if (lossRun >= 2) { const tot = months.slice(idx - lossRun + 1, idx + 1).reduce((s, m) => s + m.net, 0); head = (whole(lossRun) ? 'At least ' : '') + plural(lossRun, 'month') + ' in a row with a net loss'; sentences.push('Net income has been negative ' + (whole(lossRun) ? 'for every one of the ' + lossRun + ' months we can see' : 'since ' + monthLabel(keys[idx - lossRun + 1])) + ', a combined ' + usd(tot) + '.'); sev = 'watch'; }
    else if (bestRev || bestNet) {
      head = bestRev && bestNet ? 'Best month for revenue and profit in at least a year' : (bestRev ? 'Best revenue month in at least a year' : 'Best profit month in at least a year');
      if (bestRev) { const pk = prev11.reduce((a, m) => m.rev > a.rev ? m : a, prev11[0]); sentences.push('Revenue of ' + usd(cur.rev) + ' beats every month since ' + monthLabel(keys[idx - 11]) + ' (the previous high was ' + usd(pk.rev) + ' in ' + pk.label + ').'); }
      if (bestNet) { const pk = prev11.reduce((a, m) => m.net > a.net ? m : a, prev11[0]); sentences.push('Net income of ' + usd(cur.net) + ' is the highest in that time (previous high ' + usd(pk.net) + ' in ' + pk.label + ').'); }
      sev = 'win';
    } else if (profRun >= 6) { head = (whole(profRun) ? 'At least ' : '') + plural(profRun, 'month') + ' in a row in the black'; sentences.push(whole(profRun) ? 'Every one of the ' + profRun + ' months we can see, back to ' + monthLabel(keys[idx - profRun + 1]) + ', has shown a profit.' : 'Every month since ' + monthLabel(keys[idx - profRun + 1]) + ' has shown a profit.'); sev = 'win'; }
    if (!head) return;
    add({ key: 'streak', cat: 'profit', sev, head, detail: sentences.join(' '),
      tip: sev === 'watch' ? 'Our tip: more than one losing month in a row is a trend, not a blip - decide this month what you will change (price, cost or volume) and check it again next month.' : (bestRev || bestNet ? 'Our tip: this is the month to bank the lesson - what was different, and can you repeat it?' : ''),
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
    if (sev === 'action' || sev === 'watch') tip = 'Our tip: lay every payment due in the next four weeks against every dollar you expect to collect. If there is a gap, call your largest past-due customers now and ask for deposits on new work - cash you ask for early is cash you do not have to borrow.';
    else if (sev === 'win') tip = 'Our tip: decide now what extra cash is for - debt paydown, equipment, a reserve - so it does not quietly get spent.';
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
      tip: debtDriven ? 'Our tip: paying down debt is a good use of profit - just keep enough cash behind it to cover the next month or two of overhead.'
        : (arGrew ? 'Our tip: profit is not cash until it is collected. Bill on milestones, ask for deposits and follow up on a schedule so finished work turns into cash sooner.' : 'Our tip: compare profit to cash every month. When they drift apart the reason is always receivables, payables, inventory or debt payments - and it is far easier to act on while it is small.'),
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
    if (cc >= goals.ccHighBalance) tip = 'Our tip: pay the highest-rate balance first. Interest on a carried card balance buys nothing - it is overhead you can eliminate, and clearing it is usually the best return available.';
    else if (sev === 'watch' && loc > 0.5) tip = 'Our tip: a line of credit is a bridge, not a budget. If you keep drawing on it, fix the pattern behind it - collections, pricing or overhead - before it fills.';
    else if (sev === 'watch') tip = 'Our tip: debt that is growing while cash falls deserves a plan - decide which balance comes down first, and from what cash.';
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
    const tip = (sev === 'action' || sev === 'watch') ? 'Our tip: a ratio under 1 means short-term bills are bigger than short-term assets. The fixes are collecting faster, paying down short-term debt with longer-term financing, or building cash.' : '';
    add({ key: 'liquidity', cat: 'obligations', sev, head, detail, tip, impact: Math.abs(K.workingCapital - (K.workingCapitalPrior != null ? K.workingCapitalPrior : K.workingCapital)), facts: { cr: K.currentRatio, pm: K.currentRatioPrior } });
  });

  /* ------------------------------------------------------------ collections and payables */
  rule('ar', () => {
    const r = A.ar; if (!r || r.total <= 0.5) return;
    const share60 = r.over60 / r.total;
    const head = 'Receivables ' + usd(r.total) + (r.over60 > 0.5 ? ': ' + usd(r.over60) + ' is over 60 days past due' : (r.past > 0.5 ? ': ' + usd(r.past) + ' is past due' : ': everything is current'));
    let detail = bucketText(r);
    const named = r.topOver60.length ?r.topOver60.slice(0, 3).map(x => short(x.name) + ' ' + usd(x.over60)) : r.topPast.slice(0, 3).map(x => short(x.name) + ' ' + usd(x.past));
    if (named.length) detail += (r.topOver60.length ? ' Oldest money: ' : ' Largest past-due balances: ') + list(named) + '.';
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
      tip = (t0 ? 'Our tip: call ' + short(t0.name) + ' this week - ' + usd(t0.over60) + ' of what they owe is over 60 days, and the older an invoice gets the harder it is to collect. Confirm the invoice is right, get a payment date and put it in writing. ' : 'Our tip: work the oldest invoices first - confirm each is right, get a payment date and put it in writing. ')
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
    const tip = (sev === 'action' || sev === 'watch')
      ? (r.past > 0.5 ? 'Our tip: talk to the vendors you are behind with before they call you. Most will accept a dated payment plan, and keeping your material and subcontractor suppliers current protects your terms with them.'
        : 'Our tip: payables jumped - confirm the new bills are right and when each is due, so none slips past due.') : '';
    add({ key: 'ap', cat: 'collections', sev, head, detail, tip, impact: r.over60 || r.past, facts: { total: r.total, over60: r.over60, past: r.past, pm: apPm, top: r.topPast.slice(0, 3).map(x => [x.name, x.past]) } });
  });

  rule('retainage', () => {
    if (!(K.retainage > 0.5)) return;
    const recv = (K.ar || 0) + K.retainage, share = recv > 0 ? K.retainage / recv : null;
    const head = 'Retainage held by customers ' + usd(K.retainage);
    let detail = (K.retainagePrior != null && pm) ? 'That is ' + chgText(K.retainage, K.retainagePrior, pmName) + '.' : '';
    if (share != null) detail += (detail ? ' ' : '') + 'It is ' + pct0(share) + ' of all money owed to you (A/R plus retainage).';
    add({ key: 'retainage', cat: 'collections', sev: (share != null && share >= 0.25 && K.retainage >= 10000) ? 'watch' : 'info', head, detail, tip: 'Our tip: put retainage release on each job\'s closeout checklist - it is earned money still sitting with the customer.', impact: K.retainage, facts: { ret: K.retainage, pm: K.retainagePrior } });
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
    const tip = K.equity < 0 ? 'Our tip: negative equity means the business owes more than it owns on paper. Profit, owner contributions and paying down debt are the three levers - we can walk through which fits.'
      : ((sev === 'watch' || bigLeak) ? 'Our tip: equity is the cushion under the business. Plan draws and distributions against profit and cash each month, rather than taking whatever is left.' : '');
    add({ key: 'equity', cat: 'obligations', sev, head, detail, tip, impact: Math.abs(eqPy != null ? K.equity - eqPy : K.equity), facts: { eq: K.equity, pm: K.equityPrior, py: eqPy } });
  });

  rule('ahead', () => {
    const a = A.ahead; if (!a || Math.abs(a.change) < 0.15) return;
    const hi = a.change > 0;
    add({ key: 'ahead', cat: 'outlook', sev: 'info', head: 'Heads-up for ' + a.nextName + ': last year revenue ' + (hi ? 'rose ' : 'fell ') + Math.round(Math.abs(a.change) * 100) + '%',
      detail: 'In ' + a.thenLabel + ' revenue was ' + usd(a.thenRev) + ', ' + (hi ? 'up from ' : 'down from ') + usd(a.thisRev) + ' in ' + a.thisLabel + '. That is last year\'s pattern, not a forecast.',
      tip: hi ? 'Our tip: a busier month usually means paying for materials and payroll before customers pay - line up the cash ahead of it.' : 'Our tip: plan cash for a slower month now - ease off discretionary spending and get the pipeline filled early.',
      impact: Math.abs(a.thenRev - a.thisRev), facts: { ch: Math.round(a.change * 100) } });
  });

  /* ------------------------------------------------------------ for the coach only */
  (A.books || []).forEach(b => add({ key: 'books_' + b.key, cat: 'books', aud: 'coach', sev: b.key === 'no-py' ? 'info' : 'watch', head: b.text, detail: '', tip: '', impact: 0, facts: { t: b.text } }));

  /* ------------------------------------------------------------ rank, choose what prints, summarise */
  /* a short imperative for the "next 30 days" checklist, built from the same facts the insight states */
  const ACT = {
    net_income: (o) => o.sev === 'win' ? 'Write down what drove this month so it is repeatable' : 'Find the one or two lines behind the profit swing: one-time, or the new normal?',
    revenue: () => 'Find where revenue fell, then fill the pipeline: call past customers and get quotes out',
    gross_margin: () => 'Compare quoted vs actual cost on your biggest jobs and reprice open quotes',
    overhead: () => 'Go through recurring overhead line by line',
    movers_cost: () => 'For each rising cost, decide: one-time, or the new normal?',
    unusual: (o) => { const f = (Array.isArray(o.facts) ? o.facts : []).find(x => !x[3]); return f ? 'Confirm ' + short(f[0]) + ' ' + usd(f[1]) + ' is coded correctly and whether it will recur' : ''; },
    breakeven: () => 'Close the gap to break-even: raise margin, volume or both',
    streak: () => 'Decide what to change (price, cost or volume) and recheck next month',
    cash: () => 'Match the next four weeks of payments against expected collections',
    profit_vs_cash: () => 'Bill on milestones and ask for deposits so profit turns into cash sooner',
    debt: () => 'Pay down the highest-rate balance first',
    liquidity: () => 'Rebuild working capital: collect faster and pay down short-term debt',
    ar: (o) => { const t = ((o.facts && o.facts.top) || [])[0]; return t ? 'Call ' + short(t[0]) + ' about ' + usd(t[1]) + ' over 60 days' : 'Work the oldest invoices this week'; },
    ap: (o) => { const t = ((o.facts && o.facts.top) || [])[0]; return t ? 'Talk to ' + short(t[0]) + ' about the overdue bill before they call you' : 'Confirm the new bills and set their payment dates'; },
    retainage: () => 'Put retainage release on each job\'s closeout list',
    equity: () => 'Plan draws and distributions against profit and cash each month'
  };
  out.forEach(o => { o.act = (ACT[o.key] && o.aud === 'client') ? ACT[o.key](o) : ''; });
  /* Within a severity, urgent items rank by the dollars involved. Good news and background rank by how much a client cares: profit and revenue
     before a debt paydown that happens to be a bigger number. */
  const PRIORITY = { net_income: 1, revenue: 2, debt: 3, streak: 4, gross_margin: 5, overhead: 6, cash: 7, liquidity: 8, equity: 9, breakeven: 10, retainage: 11, movers_rev: 12, movers_cost: 13, ahead: 14 };
  const pri = (o) => PRIORITY[o.key] || 50;
  /* Dollar impacts from different rules are not comparable (a break-even gap against a cash shortfall), so things that need attention rank by what a
     client must look at first - cash and solvency, then profit, then collections - and only then by their own dollars. */
  const ATTN = { cash: 1, profit_vs_cash: 2, net_income: 3, ar: 4, ap: 5, debt: 6, liquidity: 7, gross_margin: 8, revenue: 9, unusual: 10, movers_cost: 11, overhead: 12, breakeven: 13, equity: 14, streak: 15, retainage: 16 };
  const apri = (o) => ATTN[o.key] || 50;
  out.sort((a, b) => (SEV_WEIGHT[b.sev] - SEV_WEIGHT[a.sev]) || ((a.sev === 'win' || a.sev === 'info') ? (pri(a) - pri(b) || (b.impact - a.impact)) : (apri(a) - apri(b) || (b.impact - a.impact))));
  const caps = { win: 5, info: 2 }, used = { win: 0, info: 0 };
  let attn = 0;
  out.forEach((o, i) => {
    o.rank = i + 1;
    if (o.aud === 'coach') { o.include = false; return; }
    if (o.sev === 'action' || o.sev === 'watch') { attn++; o.include = attn <= 7; }
    else if (o.key === 'cash' || o.key === 'profit_vs_cash') o.include = true;   // the number every client looks for first, and what explains it when profit and cash part ways: never dropped by a cap
    else { used[o.sev]++; o.include = used[o.sev] <= caps[o.sev]; }
  });
  A.insights = out;
  A.actions = out.filter(o => o.include && o.aud === 'client' && (o.sev === 'action' || o.sev === 'watch') && o.act).slice(0, 5).map(o => ({ key: o.key, head: o.head, act: o.act, tip: o.tip.replace(/^Our tip:\s*/, '') }));

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
  const top = out.find(o => o.aud === 'client' && (o.sev === 'action' || o.sev === 'watch'));
  const checkedAll = bsOk && cashOk && !!A.ar && !!A.ap && leafOk;
  hl.push(top ? 'Top priority: ' + top.head + '.' : (checkedAll ? 'No red flags this month.' : 'No red flags in the figures we could check this month.'));
  A.headline = hl;
}

module.exports = { build };
