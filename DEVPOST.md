# Second Look: Devpost draft

Claims below are limited to what VERIFY.md records as PASS, and every number has its source URL next to it. Paste into the Devpost form.

## Inspiration

The FTC's advice to older adults is "Stop and talk to someone you trust" (https://consumer.ftc.gov/consumer-alerts/2025/11/agent-told-me-stay-internet-it-scam). People 60 and older reported $7.748 billion in losses to the FBI's Internet Crime Complaint Center in 2025, up 59% from 2024 (https://www.ic3.gov/AnnualReport/Reports/2025_IC3Report.pdf). In the FTC's 2025 data, online shopping fraud drew more loss reports from older adults than any other fraud type, and debit cards and payment apps were frequently the payment method on those scams (https://www.ftc.gov/system/files/ftc_gov/pdf/2026-older-adults-report-10192026.pdf). A payment app is exactly where that advice should happen, at the moment before the money moves.

## Who it is for

The first user is a person 60 or older who already pays online with PayPal, together with the one adult child who already helps with their bills and whom they choose to look at a risky first payment (in the demo: Margaret and her daughter Sarah). How common that pair is: AARP and the National Alliance for Caregiving count 63 million US family caregivers in 2025; 58% of them help manage the care recipient's finances (figure 18) and 39% already use digital tools to do it (Caregiving in the US 2025, https://www.aarp.org/content/dam/aarp/ppi/topics/ltss/family-caregiving/caregiving-in-us-2025.doi.10.26419-2fppi.00373.001.pdf). Those numbers cover all family caregivers, not PayPal users. We did no user research of our own for this prototype.

## The problem, with its limits

- Online shopping is the most common loss: older adults filed more loss reports on online shopping fraud than on any other fraud type in 2025; when social media was the first contact, 34% of their loss reports were online shopping scams (FTC report above).
- The largest dollars are elsewhere: older adults who reported losing over $100,000 were 6% of loss reports but 70% of reported losses (FTC report above), and $4.35 billion of the $7.75 billion lost by people 60 and older carried a cryptocurrency link (about 56%, IC3 report above). Second Look cannot hold a bank transfer or a crypto payment; it holds the online shopping payment, and its value grows once the same check sits inside PayPal.

## What it does

A payment from an older adult to a first-time or risky seller stays an uncaptured PayPal authorization. Claude investigates it and shows its work: seller name against email domain, the order read back from PayPal, known scam patterns in the seller's message, the payer's usual amounts. If risk is high and the origin is unclear, Claude asks the payer one question. A trusted family member then taps Approve (capture, after an undo window) or Stop (void). Nobody answers in time: the hold voids itself. The payer's answer is shown to the family but never lowers the risk, and Claude has no capture, void or release tool. Requests outside PayPal (a gift card demand) cannot be held, so the family is told.

## How we built it

- **Claude tool loop** with ten tools, call budgets, and two segments so no model runs while the app waits for a person. Run with Claude Sonnet through a local Claude Code account (VERIFY V6): scenario 1 reached the question, scenario 2 did not ask. The hosted API path is not verified yet.
- **Recorded real runs.** Those Claude Sonnet runs (scenarios 1, 2, 4 and 5, and scenario 1 after each answer) are saved with every tool call, result and timing in `server/agent/recorded-runs/`. The public demo replays them and labels each card "Recorded run: Claude Sonnet, 2026-11-12"; when your inputs differ from the recording, the card says the scripted stand-in took over.
- **APIMatic-generated PayPal SDK** for create, authorize, capture and void, with a fixed `PayPal-Request-Id` per action. `paypal-plan.md` holds the contract sheet and a "Contract vs sandbox" table.
- **PayPal Agent Toolkit** `get_order` for the investigation of sellers with sandbox keys.
- Express, React, zod, a state machine with per-payment locks, and a local PayPal stand-in with the same response shapes.

## Challenges

- Against the sandbox, `authorizeOrder` answered 415 until we sent an explicit empty JSON body. The contract sheet matched everywhere else (V5).
- A lost answer after a timeout must not capture twice: the server reads the order back and settles the state (replay of the same Request-Id returned the same order and the same capture, V2 and V12).
- Making sure the AI cannot move money by design, not by prompt.

## Accomplishments

Sandbox run on 2026-11-12: create, authorize, capture and void passed through the SDK (V1, V2, V11, V13); a repeated `PayPal-Request-Id` returned the same capture and the same order (V2, V12); another app refused with 401 `PERMISSION_DENIED` (V14); scenario 1 end to end in sandbox demo mode (S1). 93 tests pass with every outside service faked.

## What we learned

The honest conclusion is that this belongs inside PayPal: a third-party app cannot capture another merchant's authorization, and the capture status already has a `PENDING_REVIEW` reason that could carry the family decision.

## Why this is good for PayPal

- **Merchant volume stays.** Known sellers and small payments are captured at once; only a new seller with a risk signal waits, and an approved payment is captured as usual. The checkout is not blocked, so the payment stays with PayPal instead of the family being left with "do not pay online" as the only safe advice.
- **Less loss after the fact.** A payment the family stops is never captured, so it never becomes a dispute or a refund of money that already moved. No cost figure is claimed, because none was measured.
- **A product PayPal could ship:** "Trusted Contact" in account settings, on states PayPal already documents: an uncaptured authorization, or a capture held as `PENDING` with reason `PENDING_REVIEW` ("The captured payment is pending manual review", https://developer.paypal.com/api/orders/v2/definitions/capture_status_details). It adds a second person to PayPal's own AI scam alerts for Friends and Family payments, which warn the sender (https://newsroom.paypal-corp.com/2025-7-21-Introducing-AI-Powered-Scam-Alerts-for-Friends-and-Family-Payments). A third-party app cannot do this for other merchants, and we measured it: a second sandbox app tried to read and to capture another app's authorization (5NL78904JR352810V) and the sandbox answered `401 PERMISSION_DENIED` both times (VERIFY V14; the docs name `PERMISSION_NOT_GRANTED`, https://developer.paypal.com/api/payments/v2/errors/permission_not_granted).

## What the demo proves today, and what needs PayPal

- Proven today: hold as an uncaptured authorization, capture after family approval, void on Stop, on the PayPal sandbox (V1, V2, V11); the automatic void when nobody answers runs in local mode and has no sandbox record; idempotent money calls (V2, V12); Claude investigating with tools and asking one question, recorded from the real model (V6).
- Also proven on the sandbox: another merchant's app is refused (`401 PERMISSION_DENIED` on read and capture, V14); the Agent Toolkit `get_order` reads real sandbox orders (T1); the full scenario 1 in sandbox demo mode, with the payer approving in the PayPal window, the recorded Claude run made on a sandbox order, and Stop voiding authorization 5T8904334N5048042 (S1).
- Needs PayPal or partners: the check on any PayPal checkout, a Trusted Contact setting with consent, seller handling of `PENDING_REVIEW` captures, sandbox webhooks (V4).

## What's next

Trusted Contact in PayPal account settings; several contacts in order; financial-institution contacts (FINRA 4512 and 2165: https://www.finra.org/rules-guidance/rulebooks/finra-rules/4512, https://www.finra.org/rules-guidance/rulebooks/finra-rules/2165); re-authorization after the 3 day honor period.

## Prior work

Aval (an MHacks project, https://devpost.com/software/aval) moves risky bank money into a hold account. Second Look keeps the money as an uncaptured PayPal authorization and adds an AI investigation the family can read.

## Built with

React 19, Vite, Express 5, zod, PayPal APIMatic SDK, PayPal Agent Toolkit, Anthropic Claude (Sonnet).

## AI tools used to build

Claude Code with the APIMatic Context Plugin for PayPal wrote the SDK integration (`server/paypal/sdkLive.js`) and the contract sheet (`paypal-plan.md`), following the plugin's TypeScript skills. Claude Sonnet runs the investigation inside the app.

## Testing instructions

Same numbers as README "Testing instructions for judges":

1. Open `/` (Judge mode). Margaret (payer) on the left, Sarah (family) on the right, PayPal state at the bottom.
2. Press 1 Shop scam and press "Approve in PayPal (local mode)". Local mode needs no login. Sarah's card says "Investigation: Recorded run: Claude Sonnet, 2026-11-12"; open "How Claude checked" and answer Claude's question on Margaret's side.
3. On Sarah's card press Stop. The panel goes to `VOIDED`.
4. Press 2 New real shop, approve once. No question. Sarah presses Approve, waits for the undo window (30 s), and the payment is captured.
5. Press 3 Known seller and approve once. It is captured right away.
6. Press 4 Nobody answers, approve once, and press nothing. The card counts down; after 2 minutes the hold voids itself ("Expired, no answer").
7. Press 5 Gift card request. Margaret sees what was noticed and Sarah gets an alert.
8. Open Sandbox evidence under the PayPal panel: the checks that passed against the PayPal sandbox on 2026-11-12, with ids.

Local mode needs no accounts and no login. Run it with `npm install && cp .env.example .env && npm run build && npm start` and open http://localhost:3001. The whole path takes about 3 minutes.
