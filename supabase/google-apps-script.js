function formatMonthLabel(v) {
  if (!v) return '';
  if (Object.prototype.toString.call(v) === '[object Date]') {
    const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return MONTHS[v.getMonth()] + '-' + v.getFullYear();
  }
  return String(v).trim();
}

function parseMonthOrder(label) {
  if (!label) return 0;
  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const m = label.match(/^([A-Za-z]{3})-(\d{4})$/);
  if (!m) return 0;
  const mi = MONTHS.findIndex(x => x.toLowerCase() === m[1].toLowerCase());
  if (mi < 0) return 0;
  return parseInt(m[2]) * 12 + mi;
}

function pushToSupabase() {
  const SUPABASE_URL = 'https://vntqszeaokcbrzuppmew.supabase.co';
  const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZudHFzemVhb2tjYnJ6dXBwbWV3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY4MzE1NzcsImV4cCI6MjA5MjQwNzU3N30.NIllrkxrhwrNDxWTCgRxxyvk2VbRTBaC7F8_VFWfZDY';

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('Summary - BAT & NonBAT Breakup');

  if (!sheet) {
    SpreadsheetApp.getUi().alert('Sheet "Summary - BAT & NonBAT Breakup" not found.');
    return;
  }

  const data = sheet.getDataRange().getValues();
  if (data.length < 2) {
    SpreadsheetApp.getUi().alert('Error: Sheet has insufficient data.');
    return;
  }

  const headers = data[0];
  const monthCols = [];
  for (let c = 1; c < headers.length; c++) {
    const label = formatMonthLabel(headers[c]);
    const order = parseMonthOrder(label);
    if (order > 0) monthCols.push({ col: c, month: label, order });
  }

  if (monthCols.length === 0) {
    SpreadsheetApp.getUi().alert(
      'Error: No month columns found in row 1.\n\n' +
      'First few headers: ' + headers.slice(0, 6).map(h => formatMonthLabel(h) || '(empty)').join(', ')
    );
    return;
  }

  // Row indices are 0-based array positions (sheet row = index + 1)
  // Rows 21-24 (sheet) = indices 20-23: 6-month rolling average
  // Row 25 (sheet) = index 24:          section header (skipped)
  // Rows 26-29 (sheet) = indices 25-28: 3-month rolling average
  const ROW = {
    ar_total: 1, ar_other: 2, ar_bat: 3, ar_sme_bu: 4,
    collections_total: 7, collections_other: 8, collections_bat: 9, collections_sme_bu: 10,
    pct_total: 14, pct_other: 15, pct_bat: 16, pct_sme_bu: 17,
    rolling_total: 20, rolling_other: 21, rolling_bat: 22, rolling_sme_bu: 23,
    rolling_3m_total: 25, rolling_3m_other: 26, rolling_3m_bat: 27, rolling_3m_sme_bu: 28,
  };

  function numVal(rowIdx, colIdx) {
    if (rowIdx >= data.length) return null;
    const v = data[rowIdx][colIdx];
    const n = parseFloat(v);
    return isNaN(n) ? null : n;
  }

  function pctVal(rowIdx, colIdx) {
    const v = numVal(rowIdx, colIdx);
    return v === null ? null : Math.round(v * 10000) / 100;
  }

  const records = monthCols.map(({ col, month, order }) => ({
    month, month_order: order,
    ar_total:              numVal(ROW.ar_total, col),
    ar_bat:                numVal(ROW.ar_bat, col),
    ar_sme_bu:             numVal(ROW.ar_sme_bu, col),
    ar_other:              numVal(ROW.ar_other, col),
    collections_total:     numVal(ROW.collections_total, col),
    collections_bat:       numVal(ROW.collections_bat, col),
    collections_sme_bu:    numVal(ROW.collections_sme_bu, col),
    collections_other:     numVal(ROW.collections_other, col),
    pct_total:             pctVal(ROW.pct_total, col),
    pct_bat:               pctVal(ROW.pct_bat, col),
    pct_sme_bu:            pctVal(ROW.pct_sme_bu, col),
    pct_other:             pctVal(ROW.pct_other, col),
    rolling_avg_total:     pctVal(ROW.rolling_total, col),
    rolling_avg_bat:       pctVal(ROW.rolling_bat, col),
    rolling_avg_sme_bu:    pctVal(ROW.rolling_sme_bu, col),
    rolling_avg_other:     pctVal(ROW.rolling_other, col),
    rolling_3m_avg_total:  pctVal(ROW.rolling_3m_total, col),
    rolling_3m_avg_bat:    pctVal(ROW.rolling_3m_bat, col),
    rolling_3m_avg_sme_bu: pctVal(ROW.rolling_3m_sme_bu, col),
    rolling_3m_avg_other:  pctVal(ROW.rolling_3m_other, col),
  }));

  try {
    const resp = UrlFetchApp.fetch(
      SUPABASE_URL + '/rest/v1/collections_analysis?on_conflict=month',
      {
        method: 'POST',
        headers: {
          'Content-Type':  'application/json',
          'apikey':        SUPABASE_KEY,
          'Authorization': 'Bearer ' + SUPABASE_KEY,
          'Prefer':        'resolution=merge-duplicates,return=representation',
        },
        payload: JSON.stringify(records),
        muteHttpExceptions: true,
      }
    );

    const code = resp.getResponseCode();
    if (code >= 200 && code < 300) {
      const upserted = JSON.parse(resp.getContentText());
      const months = upserted.map(r => r.month).sort().join(', ');
      SpreadsheetApp.getUi().alert(
        '✅ Success!\n\n' +
        upserted.length + ' month(s) synced:\n' + months
      );
    } else {
      SpreadsheetApp.getUi().alert(
        '❌ Upsert failed (HTTP ' + code + ')\n\n' + resp.getContentText().substring(0, 500)
      );
    }
  } catch (e) {
    SpreadsheetApp.getUi().alert('❌ Network error:\n\n' + e.message);
  }
}

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('AOP Tracker')
    .addItem('Push to Supabase', 'pushToSupabase')
    .addToUi();
}
