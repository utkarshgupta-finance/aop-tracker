/**
 * AOP Tracker — Google Apps Script
 *
 * Setup:
 * 1. Open your Google Sheet → Extensions → Apps Script
 * 2. Paste this entire file, replacing the placeholder values:
 *    - PUSH_SECRET: the secret you set as AOP_PUSH_SECRET in Supabase Edge Function env
 * 3. Run pushAOPData() once manually to test
 * 4. Add a trigger: Triggers → Add Trigger → pushAOPData → On change (or time-based)
 *
 * Sheet format expected (Sheet9):
 *   - A row whose first cell contains "Exit MRR"
 *   - Two rows below that: 7 BU rows with 13 monthly values in columns B–N
 *   - A row whose first cell contains "NRR Projection"
 *   - Two rows below that: same structure for NRR
 */

const PUSH_SECRET = 'YOUR_AOP_PUSH_SECRET'; // ← replace with your secret
const ENDPOINT    = 'https://vntqszeaokcbrzuppmew.supabase.co/functions/v1/push-aop-data';

const BUS = ['BAT BU', 'India ENT BU', 'India MM BU', 'KAM BU', 'MEA BU', 'SEA BU', 'SME BU'];

function pushAOPData() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Sheet9');
  if (!sheet) { Logger.log('Sheet9 not found'); return; }

  const data = sheet.getDataRange().getValues();

  let mrrStart = -1, nrrStart = -1;
  for (let i = 0; i < data.length; i++) {
    const cell = String(data[i][0] || '');
    if (cell.includes('Exit MRR'))       mrrStart = i;
    if (cell.includes('NRR Projection')) nrrStart = i;
  }

  if (mrrStart < 0 || nrrStart < 0) {
    Logger.log('Could not find "Exit MRR" or "NRR Projection" header rows in Sheet9');
    return;
  }

  function parseNum(v) {
    return parseFloat(String(v).replace(/,/g, '').replace(/[^0-9.\-]/g, '')) || 0;
  }

  function parseSection(startRow) {
    const result = {};
    for (let i = startRow + 2; i <= startRow + 8; i++) {
      const row = data[i];
      if (!row || !row[0] || row[0] === 'Total') continue;
      const bu = String(row[0]).trim();
      if (BUS.includes(bu)) {
        result[bu] = [];
        for (let c = 1; c <= 13; c++) result[bu].push(parseNum(row[c]));
      }
    }
    return result;
  }

  const mrrData = parseSection(mrrStart);
  const nrrData = parseSection(nrrStart);

  const valid = BUS.every(
    bu => mrrData[bu] && mrrData[bu].length === 13 &&
          nrrData[bu] && nrrData[bu].length === 13
  );
  if (!valid) {
    Logger.log('Validation failed — check BU names and 13-column count in Sheet9');
    return;
  }

  const response = UrlFetchApp.fetch(ENDPOINT, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ mrr_data: mrrData, nrr_data: nrrData, secret: PUSH_SECRET }),
    muteHttpExceptions: true,
  });

  Logger.log('Status: ' + response.getResponseCode());
  Logger.log('Body:   ' + response.getContentText());
}
