// What the PayPal sandbox run of 2026-11-12 showed (VERIFY.md, Status). Only PASS items; open items are listed as open.
export const SANDBOX_RUN_DATE = '2026-11-12'

export const SANDBOX_EVIDENCE = Object.freeze({
  date: SANDBOX_RUN_DATE,
  passed: [
    { id: 'V1', text: 'create_order and authorize on the sandbox: order 4TT06463CT4619626, authorization 8AP761279R529210K, AUTHORIZED' },
    { id: 'V2', text: 'capture 6KL13433BL0464433 COMPLETED; void ended VOIDED; the same PayPal-Request-Id returned the same capture' },
    { id: 'V5', text: 'contract sheet matched the sandbox except one point: authorizeOrder needs an empty JSON body (415 otherwise)' },
    { id: 'V6', text: 'Claude Sonnet through a local Claude Code account (not the hosted API): scenario 1 asked its question, scenario 2 did not' },
    { id: 'V10', text: 'SDK smoke: token fetched, error bodies decoded (404 INVALID_RESOURCE_ID)' },
    { id: 'V11', text: 'create, authorize, capture and void through the APIMatic SDK' },
    { id: 'V12', text: 'create_order replay: the same PayPal-Request-Id twice returned the same order 5JU63374B9030412J (lost-answer capture not run)' },
    { id: 'V13', text: 'decoded SDK models carry the authorization and capture ids' },
  ],
  open: ['V3 separate app per seller', 'V4 sandbox webhooks (needs a public URL)', 'V7 seller refund', 'V8 return window', 'V9 closed window', 'V14 another app refused'],
})
