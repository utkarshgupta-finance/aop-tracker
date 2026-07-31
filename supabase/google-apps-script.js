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
  if (!sheet) { Logger.log('ERROR: Sheet not found'); return; }

  const data = sheet.getDataRange().getValues();
  Logger.log('Rows: ' + data.length + '  Cols: ' + (data[0] ? data[0].length : 0));

  const headers = data[0];
  const monthCols = [];
  for (let c = 1; c < headers.length; c++) {
    const label = formatMonthLabel(headers[c]);
    const order = parseMonthOrder(label);
    if (order > 0) monthCols.push({ col: c, month: label, order });
  }
  Logger.log('Months found: ' + monthCols.length);
  if (!monthCols.length) { Logger.log('ERROR: No month columns found'); return; }

  // Row indices are 0-based (sheet row = index + 1)
  // Rows 21-24 (sheet) = indices 20-23 : 6-month rolling average
  // Rows 25-28 (sheet) = indices 24-27 : 3-month rolling average  ← add these rows to the sheet
  // Row 29     (sheet) = index  28     : GBP to INR (unrelated — not read)
  const ROW = {
    ar_total: 1, ar_other: 2, ar_bat: 3, ar_sme_bu: 4,
    collections_total: 7, collections_other: 8, collections_bat: 9, collections_sme_bu: 10,
    pct_total: 14, pct_other: 15, pct_bat: 16, pct_sme_bu: 17,
    rolling_total: 20, rolling_other: 21, rolling_bat: 22, rolling_sme_bu: 23,
    rolling_3m_total: 24, rolling_3m_other: 25, rolling_3m_bat: 26, rolling_3m_sme_bu: 27,
  };

  function numVal(ri, ci) {
    if (ri >= data.length) return null;
    const n = parseFloat(data[ri][ci]);
    return isNaN(n) ? null : n;
  }
  function pctVal(ri, ci) {
    const v = numVal(ri, ci);
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
      Logger.log('SUCCESS: ' + upserted.length + ' month(s) synced → ' + upserted.map(r => r.month).sort().join(', '));
    } else {
      Logger.log('ERROR HTTP ' + code + ': ' + resp.getContentText().substring(0, 500));
    }
  } catch (e) {
    Logger.log('NETWORK ERROR: ' + e.message);
  }
}

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('AOP Tracker')
    .addItem('Push to Supabase', 'pushToSupabase')
    .addToUi();
}
