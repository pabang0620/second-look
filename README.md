# Second Look

> The FTC's advice is "Stop and talk to someone you trust." Second Look builds that step into the payment: a payment to a first-time or risky seller stays an uncaptured PayPal authorization while Claude investigates it and shows its work, and a trusted family member taps Approve (capture) or Stop (void). The money never moves to a holding account; it simply is not captured until someone says yes.

Entry for the PayPal AI Hackathon 2026, aimed at Most Impactful and Best Use of APIMatic.

## Why it matters

- **Big losses, concentrated in few reports.** The FBI IC3 2025 report counts about $7.7 billion lost by people 60 and older, up 59% (https://www.ic3.gov/AnnualReport/Reports/2025_IC3Report.pdf).
- **Few large payments carry most of the harm.** In the FTC's older-adult data, reports of losses over $10,000 are about 6% of reports and about 70% of dollars lost (https://www.ftc.gov/system/files/ftc_gov/pdf/2026-older-adults-report-10192026.pdf). The design stops one large first-time payment at a time, which is the part that matters most.
- **Online shopping is where it starts.** Among older adults' losses that began on social media, online shopping scams were the most reported (https://consumer.ftc.gov/consumer-alerts/2025/11/agent-told-me-stay-internet-it-scam). A held authorization is the one moment where a family can still say no.

## Read this first: what this prototype is and is not

- **Coverage:** payments made in Second Look. Built into PayPal, the same check would cover any PayPal checkout.
- **1st-party credentials, by design.** The design gives each seller its own sandbox business account and REST app; the code keeps one client per seller, and the prototype holds those credentials to play the role PayPal would play internally. The sandbox run so far used one app for all sellers (VERIFY V3 is still open). A third-party app cannot capture another merchant's authorization (PayPal documents a `PERMISSION_NOT_GRANTED` error for this; showing it live is VERIFY V14, not yet run), so the honest conclusion is that this feature has to live inside PayPal.
- **What we propose to PayPal (a proposal, not an existing feature):** PayPal's capture API already defines a `PENDING` status with a `PENDING_REVIEW` reason ("The captured payment is pending manual review"). We suggest reusing that state for family confirmation, with the family decision moving it to `COMPLETED` or `DENIED`. How many seller integrations handle this state today is not known to us.
- **Seller impact, stated plainly:** only a new seller combined with a risk signal is held, for at most 70 hours. The seller sees an unconfirmed payment during that time. If the family stops it, the seller sees a declined payment, which is what PayPal already does for payments it detects as highly risky.
- **What it cannot stop:** FBI IC3 reports that 56 percent of 60+ losses involved cryptocurrency, and the FTC reports bank transfers and crypto as the top loss channels. Second Look cannot hold those. It targets online shopping scams paid through a payment app, and for requests outside PayPal (gift cards, coin ATMs, transfers) it only checks the text and tells the family ("Check a request").
- **Prior work:** bank-side prototypes such as Aval (MHacks 2026) move risky money into a hold account. Second Look keeps it as an uncaptured PayPal authorization and adds an AI investigation the family can read.

## Who it is for

A person 60 or older who already pays with PayPal online, and one family member who is willing to look at risky payments. The family member sets it up; the older person chooses the contact and agrees. There was no user research for this prototype and none is claimed.

## What happens

| Step | What the code does |
|---|---|
| Pay | The payer creates an order (intent `AUTHORIZE`) on the seller's own PayPal app and approves it in PayPal. |
| Hold | After `authorize`, plain code decides: new seller, amount above the limit, or a second request means hold. A known seller under the limit is captured at once. The model never decides this. |
| Investigate | Claude investigates with tools and the family reads every step ("How Claude checked"). It may ask the payer one question. Its risk can only go up. |
| Decide | Family taps Approve (capture after an undo window, always before the 3 day honor period ends), Stop (void), or nobody answers and the hold voids itself at 70 hours. |
| Confirm | The state follows PayPal's API responses first and is then checked against webhooks, each verified with `verify-webhook-signature` for the seller's own app. Webhook verification is exercised against the local stand-in; sandbox webhook delivery needs a public URL and is VERIFY V4. A webhook can only move a payment forward. Duplicates are ignored, and an event id is remembered only after it was processed. An approved order whose return and webhook never arrived is found by the server by reading the order. |

## Scenarios (same numbers in Judge mode, the video and the testing steps)

| # | Button | Seller | Ends |
|---|---|---|---|
| 1 | Shop scam | new, name and email do not match, message with pressure and secrecy | Claude asks one question, family taps Stop, `VOIDED` |
| 2 | New real shop | new, nothing unusual, no message | no question, family taps Approve, undo window, `CAPTURED` |
| 3 | Known seller | on the family allowlist | captured right away |
| 4 | Nobody answers | new | nobody presses anything, the hold voids itself |
| 5 | Gift card request | none (no money) | text is checked and the family is alerted |

Same agent, different path:

| Step | Scenario 1 (scam, $640 scooter) | Scenario 2 (real new shop, $65 seedlings) |
|---|---|---|
| 1 | `get_payment_request`: new seller, pasted message | `get_payment_request`: new seller, no message |
| 2 | `get_order`: amount matches | `get_order`: amount matches |
| 3 | `check_lookalike`: name and email domain do not match | `check_lookalike`: consistent, so the message search is skipped |
| 4 | `record_finding`, then `search_scam_patterns`: pressure, secrecy | `get_elder_context`: within her usual range |
| 5 | `record_finding` x2, `raise_risk(high)` | `write_report(low)` |
| 6 | `ask_elder`: "How did you first hear about this seller?" | no question |

## What the AI does and does not do

- In local mode the investigation is a scripted stand-in that follows the same tool loop (the Judge page says "Model: scripted stand-in"). Set `ANTHROPIC_API_KEY` for live Claude; that path has not been run against the real API yet (VERIFY.md V6). The PayPal Agent Toolkit `get_order` is used only for sellers with sandbox credentials; the local stand-in answers `get_order` otherwise.
- Claude **investigates and explains** with ten tools. There is no capture, void or release tool.
- Investigation tools are capped (6 before the question, 2 after the answer). Recording tools (`record_finding`, `raise_risk`) have their own caps, so a risky payment still reaches its question. There is also a hard cap of 16 calls per segment, and after 13 calls (from the 14th call on) only `ask_elder` or `write_report` is allowed.
- The payer's answer is shown to the family but never lowers the risk (scammers coach victims).
- While the app waits for the payer, no model runs, so no time limit runs. Limits: 45 s before the question, 30 s after the answer.
- A rule card is shown immediately; Claude's findings are added to it. A call that is still running when the segment time is up is not an API failure: the investigation ends with what it found and says so. "Checked by safety rules only" appears only when the Claude API itself fails (after one retry), and a new seller is still held.
- Amounts, sellers and every PayPal call are decided by server code. The family cannot change a seller or an amount either.

## PayPal APIs used

Orders v2 (create with intent `AUTHORIZE`, get, authorize) and Payments v2 (capture, void, get authorization) through the APIMatic SDK, Webhooks (`CHECKOUT.ORDER.APPROVED`, `PAYMENT.AUTHORIZATION.CREATED`, `PAYMENT.AUTHORIZATION.VOIDED`, `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.DENIED`, `PAYMENT.CAPTURE.REFUNDED`), `verify-webhook-signature`, and the PayPal Agent Toolkit `get_order` for the investigation (sellers with sandbox keys; not yet recorded in a sandbox run). Every money call carries a fixed `PayPal-Request-Id` of the form `paymentId:action`, so a retry can never capture or void twice. A lost answer after a 5xx is reconciled by reading the order.

## Run it

```bash
npm install
cp .env.example .env      # optional: with no keys the app runs in local mode
npm run build
npm start                 # http://localhost:3001
```

Development: `npm run dev:server` and `npm run dev:client` (Vite on 5173 proxies to 3001). Tests: `npm test` (runs with `FORCE_MOCK=1`, so it never reaches PayPal or a model). Video timing preset: `npm run demo:video` (75 s auto void, 10 s undo). Real model through your Claude Code login, no API key: `LLM_BACKEND=account npm start`, and `npm run v6:account` for the scripted check (VERIFY V6).

**Local mode** needs no accounts and makes no outside calls. A stand-in PayPal with the same response shapes (and the same ownership rule: an app can only touch its own authorizations) delivers signed webhooks to the app's own webhook endpoint, and a scripted model follows the same tool loop. Judge mode shows a "local mode" label whenever it is in use.

## Testing instructions for judges

1. Open `/` (Judge mode). The payer (Margaret) is on the left, the family member (Sarah) on the right, PayPal's state at the bottom.
2. Press **1 Shop scam**. In local mode press "Approve in PayPal (local mode)". With sandbox credentials a PayPal window opens: log in with the sandbox buyer account listed in the Devpost submission's testing instructions and approve. Sarah's card fills in step by step; open "How Claude checked". Answer Claude's question on Margaret's side.
3. On Sarah's card press **Stop**. The bottom panel goes to `VOIDED` and shows the verified webhooks.
4. Press **2 New real shop**, approve once. No question this time. Sarah presses Approve, waits for the undo window (30 s in demo mode), and the payment is captured.
5. Press **3 Known seller** and approve once in PayPal (local mode). There is no family step: it is captured right away and Margaret's phone shows "Paid".
6. Press **4 Nobody answers**, approve once, and press nothing for 2 minutes. The hold voids itself.
7. Press **5 Gift card request**. The sentence is typed into Margaret's own "Someone asked me for money without PayPal" screen and checked; Margaret sees what was noticed and Sarah gets an alert.

Good to know while testing: if two payments overlap (for example 1 is waiting for Margaret's answer and you press 4), Margaret's phone keeps the payment with the open question in front and lists the other under "Your other payments"; the PayPal panel follows the payment shown on her phone. Every visitor gets a household of their own (separate tokens and state), and Reset only clears yours.

## How this entry differs from #5 CartPilot and #9 group buying

The same author also submitted #5 and #9. All three use `authorize` and `capture` because those are the primitives PayPal offers; what differs is who pays, who decides the capture, what the AI does and who it is for.

| | #5 CartPilot | #9 group buying | #8 Second Look (this entry) |
|---|---|---|---|
| Payers | one shopper | N buyers, each hold is one authorization | one payer (a person 60 or older) |
| Who decides the capture | delivery events from the order | a quorum rule: when enough buyers have joined, all holds are captured together | a trusted third person, the family member, taps Approve or Stop |
| What the AI does | shops for the user; it does not decide a capture | none in the money path | investigates risk with tools, shows every step, can only raise the risk, cannot capture or void |
| Who it is for | online shoppers | groups buying together | older adults and their family, against payment scams |
| What a void means | order cancelled | group did not fill, holds released | a suspected scam was stopped before any money moved |

## Value for PayPal

A payment the family stops is never captured, so it never becomes a dispute or a refund of money that already moved. No cost figure is claimed, because none was measured.

## Roadmap

1. **Built into PayPal as a Trusted Contact in account settings** (PayPal ships it, free protection for buyers): a new seller combined with a risk signal keeps the capture in `PENDING_REVIEW`, and the family decision moves it to `COMPLETED` or `DENIED`. This reuses a documented capture state and is a proposal, not an existing feature. It would cover goods checkout and also friends-and-family sends, where PayPal's own AI alert already exists.
2. Several contacts in order (the second is asked when the first does not answer) and amount tiers.
3. Link to financial institutions: brokers must already collect a trusted contact (FINRA 4512) and may place a temporary hold when exploitation is suspected (FINRA 2165). The same contact could become a payment approver in a shared standard.
4. Re-authorization after the 3 day honor period, so a family member can choose "I will call tomorrow" and extend the hold. Not in this version because a sandbox cannot wait three days.

This repository is not meant to become a product by itself: it holds seller credentials to play the role PayPal would play, which a third-party service cannot do. Its value is a design that PayPal could ship.

## Environment variables

| Name | Meaning | Default |
|---|---|---|
| `PORT`, `PUBLIC_URL` | server port and the public URL used for PayPal return links and webhooks | 3001, `http://localhost:3001` |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` | live Claude; empty means the scripted stand-in | empty, `claude-sonnet-5-5` |
| `DEMO_TIMERS` | 1 = short waits (2 min void, 30 s undo, 3 min question), 0 = real (70 h, 15 min, 2 h) | 1 |
| `AUTO_VOID_MS`, `UNDO_MS`, `ASK_TIMEOUT_MS` | demo timer overrides | see above |
| `PAYEE_<SELLER>_CLIENT_ID`, `_CLIENT_SECRET`, `_WEBHOOK_ID` | one sandbox app per seller (`POWER_COMPANY`, `GARDEN_SHOP`, `MOBILITY_DIRECT`, `MAPLE_LANE`, `LAKESIDE_TICKETS`) | empty, local stand-in |
| `PAYPAL_API_BASE` | PayPal host; must be `https://api-m.sandbox.paypal.com` when any seller has keys, otherwise startup stops | `https://api-m.sandbox.paypal.com` |
| `PAYPAL_TRANSPORT` | `sdk` (APIMatic SDK) or `rest` (earlier REST adapter) for Orders and Payments calls | `sdk` |
| `FORCE_MOCK` | 1 = ignore the Anthropic key, `LLM_BACKEND` and every seller's PayPal keys, run fully local (`npm test` sets it) | unset |
| `LLM_BACKEND` | `account` = run Claude through your local Claude Code login (shown as "Claude Sonnet (local account)"); no API key is read or sent. Local development only | unset |

## What is not in this version

Real text messages or push (alerts are on screen), voice call analysis (the Call button is a `tel:` link), several family contacts, re-authorization after the 3 day honor period (the hold voids itself first), disputes, persistence (state is in memory and resets on restart). Roles are demo tokens that show the separation of the payer and family views; they are not real authentication.

## Built with the APIMatic Context Plugin

The live PayPal calls were moved to the APIMatic-generated PayPal TypeScript SDK (package `paypal`, client `PaypalClient`, installed from `github:context-plugins/paypal-typescript-sdk#main`; it is not on npm and is built on install) by following the plugin's skills: `typescript-integrate-paypal`, `typescript-getting-started`, `typescript-error-handling`, `typescript-client-initialization`, `typescript-authentication`, `typescript-calling-endpoints`, `typescript-models`, `typescript-configuration-resilience` and `typescript-testing`.

| Operation | Goes through |
|---|---|
| Create order (intent `AUTHORIZE`), get order, authorize order | SDK, `client.orders` |
| Capture authorized payment, void authorized payment, read an authorization after a lost answer | SDK, `client.payments` |
| `verify-webhook-signature` | not in the SDK, kept on REST (`server/paypal/live.js`) |
| The agent's `get_order` read tool | PayPal Agent Toolkit, kept by design |

One `PaypalClient` per seller app is built at startup, and startup stops if the host is not `api-m.sandbox.paypal.com`. The SDK adapter is `server/paypal/sdkLive.js`; the contract sheet (every field with its channel, the claim and lost-answer rules, the error mapping) is `paypal-plan.md`. With no keys the app still runs on the local stand-in, and `PAYPAL_TRANSPORT=rest` switches the Orders and Payments calls back to the earlier REST adapter. Run against the PayPal sandbox on 2026-11-12 through the SDK: create, authorize, capture and void passed (VERIFY V1, V2, V11, V13); a repeated `PayPal-Request-Id` returned the same capture and the same order (V2, V12). The contract sheet matched except one point: `authorizeOrder` needs an empty JSON body, otherwise PayPal answers 415 (V5). The side-by-side table is at the end of `paypal-plan.md`. The adapter is also covered by tests against a faked `fetch`.

## Sources used for the problem statement

- FBI IC3 2025 Internet Crime Report, elder fraud section: https://www.ic3.gov/AnnualReport/Reports/2025_IC3Report.pdf
- FTC consumer alert of 2025-11-20: https://consumer.ftc.gov/consumer-alerts/2025/11/agent-told-me-stay-internet-it-scam
- FTC, Avoiding and Reporting Gift Card Scams: https://consumer.ftc.gov/articles/avoiding-and-reporting-gift-card-scams
- FTC, Protecting Older Consumers 2025-2026: https://www.ftc.gov/system/files/ftc_gov/pdf/2026-older-adults-report-10192026.pdf
- PayPal newsroom post on AI scam alerts (2025-07-21) and PayPal developer documentation for errors and capture status details
- FINRA rules 2165 and 4512 (roadmap): https://www.finra.org/rules-guidance/rulebooks/finra-rules/2165 and https://www.finra.org/rules-guidance/rulebooks/finra-rules/4512

The product claims above are limited to what those sources say.

## License

MIT, see `LICENSE`.
