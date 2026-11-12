# Second Look: video script (2:48)

## Start the app in the recording state

```bash
npm install
npm run demo:video        # builds, then starts on http://localhost:3001
```

`npm run demo:video` sets `LOCAL_ONLY=1` (PayPal stand-in, no API key, no account model, keys in `.env` ignored), the recorded Claude Sonnet runs, a 75 s auto void and a 10 s undo window. Open http://localhost:3001 at 1440x900, press Reset once, and record in one take. Scenario numbers and names are the same as in README "Testing instructions for judges" and DEVPOST "Testing instructions".

Only screens the app shows today are used. Nothing in this script needs the PayPal sandbox, a webhook URL or a live model; the sandbox results are shown through the in-app "Sandbox evidence" list (VERIFY.md PASS items only).

## Scenes

| Time | On screen (action) | Narration / caption (English) | Criterion |
|---|---|---|---|
| 0:00-0:12 | Judge mode after Reset: Margaret on the left, Sarah on the right, the five scenario buttons on top | "People 60 and older reported $7.7 billion in losses to the FBI's internet crime center in 2025, up 59%. The FTC's advice is simple: stop and talk to someone you trust." Caption: "FBI IC3 2025: $7.748B, +59% (60+)" | Impact (problem), Presentation |
| 0:12-0:25 | Press **1 Shop scam**. Seller message appears ("Price goes up tomorrow. Don't tell your son"). Press "Approve in PayPal (local mode)". Bottom panel: `create_order ok`, `authorize ok`, `AUTHORIZED` | "Margaret pays a seller she has never used. Second Look keeps it an uncaptured PayPal authorization. Nothing is charged." | Technology (PayPal), Impact |
| 0:25-0:32 | Press **4 Nobody answers**, approve once. Sarah's card: "Voids itself in 1:14" and the judge hint | "We leave this second payment alone and come back to it." | Technology (timers) |
| 0:32-0:58 | Back to scenario 1 on Sarah's side: High risk, findings fill in. Open "How Claude checked" (5 checks). Zoom on "Investigation: Recorded run: Claude Sonnet, 2026-11-12" | "This is a recorded run of Claude Sonnet. In one turn it read the order, checked the seller name against the email, searched the message and looked up the seller's history. Name and email don't match, and the message pushes urgency and secrecy, so it asks Margaret one question." | Technology (AI), Innovation |
| 0:58-1:08 | Margaret taps **An ad or post**. Sarah's card: "Mom said: An ad or post (shown to you, never used to clear the payment)" and Claude's report | "Her answer goes to Sarah. It can never lower the risk, because scammers coach their victims." | Innovation |
| 1:08-1:25 | Sarah taps **Stop**. Bottom panel: `void ok`, `VOIDED`, webhooks with `verify-webhook-signature: SUCCESS` (local stand-in). Margaret's phone: "Sarah stopped this payment", "Nothing was charged" | "Sarah taps Stop. The authorization is voided. The money never moved, so there is nothing to dispute or refund." | Impact (solves the problem), Presentation |
| 1:25-1:45 | Press **2 New real shop**, approve once. Low risk, no question, recorded report. Sarah taps Approve, the 10 s undo card, then `CAPTURED` | "Same agent, different path: a real new shop gets no question. Sarah approves, and after a short undo window PayPal captures it." | Technology (AI depth) |
| 1:45-1:55 | Scenario 4 card reaches 0:00: activity "Expired, no answer", panel `VOIDED` (click the Lakeside Tickets payment on Margaret's phone if needed) | "Nobody answered the other one, so the hold voided itself, well before PayPal's three-day honor period ends." | Technology (state machine) |
| 1:55-2:02 | Press **3 Known seller**, approve once. Margaret: "Paid" | "Known sellers go straight through. Only new sellers with a risk signal wait." | Impact (PayPal value: volume) |
| 2:02-2:12 | Press **5 Gift card request**. Margaret sees what was noticed; Sarah gets the alert "Claude noticed: gift card, secrecy, urgency" | "A gift card request can't be held, but the family still hears about it." | Impact (limits stated) |
| 2:12-2:20 | Sarah's summary line: "Stopped before charge: $640 / Paid after a check: $65 / Released, no answer: $120" | "Every number here comes from stored payments, not estimates." | Impact |
| 2:20-2:35 | Open **Sandbox evidence** under the PayPal panel: V1, V2, V11, V13 lines with sandbox ids | "The same calls ran on the PayPal sandbox through the APIMatic-generated SDK: authorize, capture and void, with a fixed request id so a retry can never charge twice." | Technology (PayPal, APIMatic) |
| 2:35-2:48 | Zoom on the top line "Coverage: payments made in Second Look. Built into PayPal, the same check would cover any PayPal checkout." | "A third-party app can't capture another merchant's payment. PayPal can, and its capture status already has a pending-review state. Second Look is a Trusted Contact that PayPal could ship." | Impact (PayPal value), Innovation |

## Numbers used on screen

- $7.748 billion, up 59%, people 60 and older, 2025: FBI IC3 2025 Internet Crime Report, elder fraud section, https://www.ic3.gov/AnnualReport/Reports/2025_IC3Report.pdf
- "Stop and talk to someone you trust": FTC consumer alert 2025-11-20, https://consumer.ftc.gov/consumer-alerts/2025/11/agent-told-me-stay-internet-it-scam
- `PENDING_REVIEW` ("The captured payment is pending manual review"): https://developer.paypal.com/api/orders/v2/definitions/capture_status_details
- `PERMISSION_NOT_GRANTED` for another payee's authorization: https://developer.paypal.com/api/payments/v2/errors/permission_not_granted (live check VERIFY V14 not run; the narration states PayPal's documented rule only)

## Do not show

- A PayPal sandbox approval window or sandbox webhooks: V4 is not run and this script records in local mode.
- Any claim that the hosted Claude API was used: the recording came from a local Claude Code account (VERIFY V6).
