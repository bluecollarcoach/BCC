'use strict';
// Flatten a QBO report (nested Header/Rows/Summary) into columns + indented rows.
// (Moved verbatim out of index.js so the report analysis tests can run the real thing.)
function flattenQboReport(rep) {
  const columns = (((rep || {}).Columns || {}).Column || []).map(c => c.ColTitle || '');
  const rows = [];
  (function walk(rs, level, grp) {
    for (const row of (rs || [])) {
      const g = row.group || grp || null;
      if (row.Header && row.Header.ColData) rows.push({ label: row.Header.ColData[0].value || '', cells: row.Header.ColData.slice(1).map(d => d.value), level, type: 'header', group: g, acctId: (row.Header.ColData[0] || {}).id || null });
      if (row.Rows && row.Rows.Row) walk(row.Rows.Row, level + 1, g);
      if (row.ColData) rows.push({ label: (row.ColData[0] || {}).value || '', cells: row.ColData.slice(1).map(d => d.value), level, type: 'data', group: g, acctId: (row.ColData[0] || {}).id || null });
      if (row.Summary && row.Summary.ColData) rows.push({ label: (row.Summary.ColData[0] || {}).value || '', cells: row.Summary.ColData.slice(1).map(d => d.value), level, type: 'summary', group: row.group || g });
    }
  })(((rep || {}).Rows || {}).Row || [], 0, null);
  return { title: ((rep || {}).Header || {}).ReportName || '', columns, rows };
}
/* Same, for a report with one column per month: also keeps each column's StartDate/EndDate
   (QuickBooks puts them in the column metadata; the Total column has neither). Kept as a SEPARATE
   function so the flattened statements that are stored and printed are byte-for-byte what they were. */
function flattenQboSeries(rep) {
  const flat = flattenQboReport(rep);
  flat.columnMeta = (((rep || {}).Columns || {}).Column || []).map(c => {
    const m = {}; (c.MetaData || []).forEach(x => { m[x.Name] = x.Value; });
    return { key: m.ColKey || '', start: m.StartDate || '', end: m.EndDate || '' };
  });
  return flat;
}
module.exports = { flattenQboReport, flattenQboSeries };
