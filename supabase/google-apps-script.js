/**
 * AOP Tracker — Google Apps Script
 *
 * Setup:
 * 1. Open your Google Sheet → Extensions → Apps Script
 * 2. Paste this entire file and set PUSH_SECRET below
 * 3. Run pushAOPData() once manually to test (check Logs for response)
 * 4. Add a trigger: Triggers → Add Trigger → pushAOPData → On change
 *
 * Cell layout assumed (Sheet9) — structure must stay fixed, numbers can change freely:
 *
 *   Row 1 : "Exit MRR Projection as per AOP Targets"
 *   Row 2 : Headers  (BU | Mar-2026 | Apr-2026 | … | Mar-2027 | Total)
 *   Row 3 : BAT BU        ← MRR values in B3:N3
 *   Row 4 : India ENT BU  ← MRR values in B4:N4
 *   Row 5 : India MM BU   ← MRR values in B5:N5
 *   Row 6 : KAM BU        ← MRR values in B6:N6
 *   Row 7 : MEA BU        ← MRR values in B7:N7
 *   Row 8 : SEA BU        ← MRR values in B8:N8
 *   Row 9 : SME BU        ← MRR values in B9:N9
 *
 *   Row 13: "NRR Projection as per AOP Targets"
 *   Row 14: Headers
 *   Row 15: BAT BU        ← NRR values in B15:N15
 *   Row 16: India ENT BU  ← NRR values in B16:N16
 *   Row 17: India MM BU   ← NRR values in B17:N17
 *   Row 18: KAM BU        ← NRR values in B18:N18
 *   Row 19: MEA BU        ← NRR values in B19:N19
 *   Row 20: SEA BU        ← NRR values in B20:N20
 *   Row 21: SME BU        ← NRR values in B21:N21
 *
 *   Columns B–N = Mar-2026 through Mar-2027 (13 months)
 */

const PUSH_SECRET = 'YOUR_AOP_PUSH_SECRET'; // ← must match AOP_PUSH_SECRET in Supabase Edge Function secrets
const ENDPOINT    = 'https://vntqszeaokcbrzuppmew.supabase.co/functions/v1/push-aop-data';

// BU names in the order they appear in rows 3–9 and 15–21
const BUS = ['BAT BU', 'India ENT BU', 'India MM BU', 'KAM BU', 'MEA BU', 'SEA BU', 'SME BU'];

// Fixed cell ranges — columns B:N = 13 months (Mar-2026 → Mar-2027)
const MRR_RANGE = 'B3:N9';   // 7 BU rows × 13 month columns
const NRR_RANGE = 'B15:N21'; // 7 BU rows × 13 month columns

function pushAOPData() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Sheet9');
  if (!sheet) { Logger.log('ERROR: Sheet9 not found'); return; }

  // Read both ranges in two API calls (faster than cell-by-cell)
  const mrrValues = sheet.getRange(MRR_RANGE).getValues(); // 7×13 array
  const nrrValues = sheet.getRange(NRR_RANGE).getValues(); // 7×13 array

  const mrr_data = {}, nrr_data = {};

  for (let i = 0; i < BUS.length; i++) {
    const bu = BUS[i];
    mrr_data[bu] = mrrValues[i].map(Number);
    nrr_data[bu] = nrrValues[i].map(Number);
  }

  const response = UrlFetchApp.fetch(ENDPOINT, {
    method:           'post',
    contentType:      'application/json',
    payload:          JSON.stringify({ mrr_data, nrr_data, secret: PUSH_SECRET }),
    muteHttpExceptions: true,
  });

  Logger.log('Status : ' + response.getResponseCode());
  Logger.log('Body   : ' + response.getContentText());
}
