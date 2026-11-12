<img src="client/public/logo-512.png" width="128" alt="logo" />

# Second Look

**Demo video:** https://youtu.be/1MYANH17GtQ | **Hosted demo:** https://second-look.35-216-2-121.sslip.io | **Devpost:** https://devpost.com/software/second-look-0ur1yl

**Try it:** https://second-look.35-216-2-121.sslip.io (hosted demo: live Claude Sonnet (`claude-sonnet-5-5`) with per-visitor-hour and per-day caps, PayPal on the local stand-in, demo timers; no login). When the Claude API fails or a cap is hit, the card says so and the investigation continues on a labelled recorded run or the rule-based stand-in.

> The FTC's advice is "Stop and talk to someone you trust." Second Look builds that step into the payment: a payment to a first-time or risky seller stays an uncaptured PayPal authorization while Claude investigates it and shows its work, and a trusted family member taps Approve (capture) or Stop (void). The money never moves to a holding account; it simply is not captured until someone says yes.

Entry for the PayPal AI Hackathon 2026, aimed at Most Impactful and Best Use of APIMatic.

## Why it matters

- **Big and growing losses.** People 60 and older reported $7.748 billion in losses to the FBI's Internet Crime Complaint Center in 2025, up 59% from 2024, across 201,266 complaints (FBI IC3 2025 Internet Crime Report, elder fraud section: https://www.ic3.gov/AnnualReport/Reports/2025_IC3Report.pdf).
- **Online shopping is the most common loss.** The number of loss reports filed by older adults on online shopping fraud exceeded every other fraud type in 2025, and debit cards and payment apps were frequently reported as the payment method on those scams. When social media was the first contact, online shopping scams were the most reported loss (34%) (FTC, Protecting Older Consumers 2025-2026: https://www.ftc.gov/system/files/ftc_gov/pdf/2026-older-adults-report-10192026.pdf). This is the payment Second Look holds.
- **The largest losses are elsewhere, and we say so.** In the same FTC report, older adults who reported losing over $100,000 were 6% of loss reports but 70% of reported dollars. Second Look holds one large first-time payment at a time; the largest losses mostly move by bank transfer and crypto, which it cannot hold (see below), so its value grows once the same check sits inside PayPal.

## Read this first: what this prototype is and is not

- **Coverage:** payments made in Second Look. Built into PayPal, the same check would cover any PayPal checkout.
- **First-party credentials, by design.** The design gives each seller its own sandbox business account and REST app; the code keeps one client per seller, and the prototype holds those credentials to play the role PayPal would play internally. A third-party app cannot capture another merchant's authorization: on 2026-11-12 a second sandbox REST app (another business account) tried to read and to capture authorization 5NL78904JR352810V, which the first app had created, and the sandbox answered `401 PERMISSION_DENIED` both times, while the owning app read it and later voided it (VERIFY V14). So the honest conclusion is that this feature has to live inside PayPal. Running all five sellers on separate apps in one server (VERIFY V3) is still open.
- **What we propose to PayPal (a proposal, not an existing feature):** PayPal's capture API already defines a `PENDING` status with a `PENDING_REVIEW` reason ("The captured payment is pending manual review", https://developer.paypal.com/api/orders/v2/definitions/capture_status_details). We suggest reusing that state for family confirmation, with the family decision moving it to `COMPLETED` or `DENIED`. How many seller integrations handle this state today is not known to us.
- **Seller impact, stated plainly:** only a new seller combined with a risk signal is held, for at most 70 hours. The seller sees an unconfirmed payment during that time. If the family stops it, the seller sees a declined payment, which is what PayPal already does for payments it detects as highly risky.
- **What it cannot stop:** in the FBI IC3 2025 report, $4.35 billion of the $7.75 billion lost by people 60 and older carried a cryptocurrency link (about 56%), and the FTC reports bank transfers and cryptocurrency as the payment methods with the highest reported losses. Second Look cannot hold those. It targets online shopping scams paid through a payment app, and for requests outside PayPal (gift cards, coin ATMs, transfers) it only checks the text and tells the family ("Check a request").
- **Prior work:** bank-side prototypes such as Aval (an MHacks project, https://devpost.com/software/aval) move risky money into a hold account. Second Look keeps it as an uncaptured PayPal authorization and adds an AI investigation the family can read.

## Who it is for

A person 60 or older who already pays with PayPal online, and one family member who is willing to look at risky payments. The family member sets it up; the older person chooses the contact and agrees. How common that pair is: AARP and the National Alliance for Caregiving count 63 million US family caregivers in 2025; 58% of them help manage the care recipient's finances (figure 18) and 39% already use digital tools to do it (Caregiving in the US 2025, https://www.aarp.org/content/dam/aarp/ppi/topics/ltss/family-caregiving/caregiving-in-us-2025.doi.10.26419-2fppi.00373.001.pdf). Those numbers cover all family caregivers, not PayPal users. We did no user research of our own for this prototype.

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

Same agent, different path. This is what Claude Sonnet actually did in the recorded runs (2026-11-12); each row is one model turn, and calls in one turn ran together:

| Turn | Scenario 1 (scam, $640 scooter) | Scenario 2 (real new shop, $65 seedlings) |
|---|---|---|
| 1 | `get_payment_request`: new seller, pasted message | `get_payment_request`: new seller, no message |
| 2 | `get_order`, `check_lookalike`, `search_scam_patterns`, `get_payee_profile`: amount matches, name and email domain do not match, pressure and secrecy found, first payment | `get_order`: amount and memo match |
| 3 | `record_finding` x3 (name and domain, urgency, secrecy), `raise_risk(high)`, `ask_elder`: "How did you first hear about this seller?" | `get_elder_context`, `get_payee_profile`, `check_lookalike`: usual range, first payment, name consistent |
| 4 | after the answer: `write_report(high)` (for "An ad or post" it first records `social_media_origin`) | `write_report(low)`, no question |

Scenario 4 took the same first three turns as scenario 2 and then recorded `amount_above_usual` ($120 against a usual $20 to $84) with `raise_risk(medium)`. Scenario 5 (a request, no payment) ran `get_payment_request` and `search_scam_patterns` together, recorded gift card, secrecy and urgency, and wrote a high-risk report.

## What the AI does and does not do

- **What you see in local mode is a recording of the real model.** Claude Sonnet (`claude-sonnet-5-5`, through a local Claude Code login, no API key) was run once on scenarios 1, 2, 4 and 5 on 2026-11-12, and scenario 1 once more after each answer button and after "No answer" (`npm run record:runs`). The tool calls in order, their results and the timings are in `server/agent/recorded-runs/`. In local mode the app replays a recorded turn only while every earlier tool result is the same as in the recording; anything else (another answer, a typed request, a second payment to the same seller) continues with the scripted stand-in. Every card says which: "Investigation: Recorded run: Claude Sonnet, 2026-11-12", or "Scripted stand-in", or both with the point where it changed.
- Live model: `LLM_BACKEND=account` (your Claude Code login) or `ANTHROPIC_API_KEY` (hosted API; this is what the hosted demo runs, with the caps below). The PayPal Agent Toolkit `get_order` is used only for sellers with sandbox credentials (it read real sandbox orders, VERIFY T1); the local stand-in answers `get_order` otherwise.
- Claude **investigates and explains** with ten tools. There is no capture, void or release tool.
- Investigation tools are capped (6 before the question, 2 after the answer). Recording tools (`record_finding`, `raise_risk`) have their own caps, so a risky payment still reaches its question. There is also a hard cap of 16 calls per segment, and after 13 calls (from the 14th call on) only `ask_elder` or `write_report` is allowed.
- The payer's answer is shown to the family but never lowers the risk (scammers coach victims).
- While the app waits for the payer, no model runs, so no time limit runs. Limits: 45 s before the question, 30 s after the answer.
- A rule card is shown immediately; Claude's findings are added to it. A call that is still running when the segment time is up is not an API failure: the investigation ends with what it found and says so. "Checked by safety rules only" appears only when the Claude API itself fails (after one retry), and a new seller is still held.
- Amounts, sellers and every PayPal call are decided by server code. The family cannot change a seller or an amount either.

## PayPal APIs used

Orders v2 (create with intent `AUTHORIZE`, get, authorize) and Payments v2 (capture, void, get authorization) through the APIMatic SDK, Webhooks (`CHECKOUT.ORDER.APPROVED`, `PAYMENT.AUTHORIZATION.CREATED`, `PAYMENT.AUTHORIZATION.VOIDED`, `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.DENIED`, `PAYMENT.CAPTURE.REFUNDED`), `verify-webhook-signature`, and the PayPal Agent Toolkit `get_order` for the investigation (sellers with sandbox keys; read real sandbox orders, VERIFY T1). Every money call carries a fixed `PayPal-Request-Id` of the form `paymentId:action`, so a retry can never capture or void twice. A lost answer after a 5xx is reconciled by reading the order.

## Run it

```bash
npm install
cp .env.example .env      # optional: with no keys the app runs in local mode
npm run build
npm start                 # http://localhost:3001
```

Development: `npm run dev:server` and `npm run dev:client` (Vite on 5173 proxies to 3001). Tests: `npm test` (runs with `FORCE_MOCK=1`, so it never reaches PayPal or a model). Video script: `docs/VIDEO_SCRIPT.md`.

| Mode | Command | PayPal | Model |
|---|---|---|---|
| Local (default) | `npm start` | Local stand-in with real response shapes; no outside calls (with no API key) | Recorded Claude Sonnet runs, then the scripted stand-in |
| Video recording | `npm run demo:video` | Local stand-in (keys in `.env` ignored); 75 s auto void, 10 s undo | Recorded runs |
| Sandbox demo | `npm run build && npm run start:sandbox` | PayPal sandbox for sellers that have keys in `.env` (payer approves in the PayPal window); the others stay on the stand-in. `SANDBOX_SELLERS=mobility_direct` limits it to scenario 1's seller | Recorded runs only (no API key or login is read) |
| Live model | `LLM_BACKEND=account npm start` | Local stand-in, or sandbox sellers if keys are set | Real Claude Sonnet through your Claude Code login, no API key |

In sandbox demo mode the header says which sellers are live, for example "PayPal: sandbox for 1 of 5 sellers", and the PayPal panel shows the real order and authorization ids. Scenario 1 has its own recording made on a sandbox order (`recorded-runs/scenario-1-sandbox.json`, `npm run record:sandbox`), replayed for the answer "An ad or post"; other answers continue with the scripted stand-in and the card says so. Other commands: `npm run v6:account` (scripted live-model check, VERIFY V6) and `npm run record:runs` (record the runs again).

**Local mode** needs no accounts and makes no outside calls. A stand-in PayPal with the same response shapes (and the same ownership rule: an app can only touch its own authorizations) delivers signed webhooks to the app's own webhook endpoint, and the investigation replays the recorded Claude runs (see above). Judge mode shows a "local mode" label whenever it is in use.

## Testing instructions for judges

1. Open `/` (Judge mode). The payer (Margaret) is on the left, the family member (Sarah) on the right, PayPal's state at the bottom.
2. Press **1 Shop scam**. In local mode press "Approve in PayPal (local mode)". Local mode needs no login. Only if you add your own sandbox credentials does a PayPal window open; then log in with your own sandbox buyer account and approve. Sarah's card fills in step by step and says "Investigation: Recorded run: Claude Sonnet, 2026-11-12"; open "How Claude checked". Answer Claude's question on Margaret's side (Sarah's card shows how long Claude waits for it).
3. On Sarah's card press **Stop**. The bottom panel goes to `VOIDED` and shows the verified webhooks.
4. Press **2 New real shop**, approve once. No question this time. Sarah presses Approve, waits for the undo window (30 s in demo mode), and the payment is captured.
5. Press **3 Known seller** and approve once in PayPal (local mode). There is no family step: it is captured right away and Margaret's phone shows "Paid".
6. Press **4 Nobody answers**, approve once, and press nothing. The card counts down ("Voids itself in 1:59"); after 2 minutes the hold voids itself and the activity list shows "Expired, no answer".
7. Press **5 Gift card request**. The sentence is typed into Margaret's own "Someone asked me for money without PayPal" screen and checked; Margaret sees what was noticed and Sarah gets an alert.
8. Open **Sandbox evidence** under the PayPal panel: the checks that passed against the PayPal sandbox on 2026-11-12, with ids.

The whole path takes about 3 minutes with the default `.env.example` (checked headless on 2026-11-12: every step finished, no failed request, no console error).

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

## Who uses it first

The first user is a person 60 or older who already pays online with PayPal, together with the one adult child who already helps with their bills and whom they choose to look at a risky first payment (in the demo: Margaret and her daughter Sarah).

## Why this is good for PayPal

- **Merchant volume stays.** Known sellers and payments under the limit are captured at once; only a new seller with a risk signal waits, and an approved payment is captured as usual. The checkout is not blocked, so the payment volume stays with PayPal instead of the family being left with "do not pay online" as the only safe advice.
- **Less loss after the fact.** A payment the family stops is never captured, so it never becomes a dispute, a chargeback or a refund of money that already moved. No cost figure is claimed, because none was measured.
- **A product PayPal could ship.** "Trusted Contact" in PayPal account settings, built on states PayPal already has: an uncaptured authorization, or a capture held as `PENDING` with reason `PENDING_REVIEW`. It extends PayPal's own AI scam alerts for Friends and Family payments (https://newsroom.paypal-corp.com/2025-7-21-Introducing-AI-Powered-Scam-Alerts-for-Friends-and-Family-Payments), which warn the sender, by adding a second person before the money moves.

## What the demo proves today, and what needs PayPal

| Proven today | Needs PayPal or partners |
|---|---|
| Hold as an uncaptured authorization, capture after family approval, void on Stop or no answer, on the PayPal sandbox (VERIFY V1, V2, V11) | Running the check for any PayPal checkout, not only payments made in Second Look |
| Idempotent money calls with a fixed `PayPal-Request-Id` (V2, V12 create replay) | A Trusted Contact setting in the PayPal account and consent flow |
| Claude investigating with tools and asking one question, recorded from the real model (V6, `server/agent/recorded-runs/`) | Seller-side handling of `PENDING_REVIEW` captures at scale (unknown today) |
| Signed webhooks moving state forward only, against the local stand-in | Sandbox webhook delivery (V4), which needs a public URL |
| Another merchant's app refused on the sandbox: `401 PERMISSION_DENIED` for read and capture (V14) | The same check inside PayPal for any checkout |

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
| `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` | live Claude through the hosted API; empty means recorded runs plus the scripted stand-in | empty, `claude-sonnet-5-5` |
| `LLM_LIVE_PER_IP_HOUR`, `LLM_LIVE_PER_DAY` | caps for the live model: model runs per visitor address per hour, and per host per day (one run = one investigation or one pasted request check, not one tool turn). A reached cap or a failed live call (network, 4xx/5xx, timeout, no credit) never shows an error: the investigation finishes on the recorded run where one matches, otherwise the rule-based stand-in, and the screen says which and why (for example "live limit reached"). A held payment is never captured because the model failed | 10, 150 |
| `TRUST_PROXY` | reverse proxy hops in front of the server, used to read the visitor address for the hourly cap (0 = none) | 1 |
| `DEMO_TIMERS` | 1 = short waits (2 min void, 30 s undo, 3 min question), 0 = real (70 h, 15 min, 2 h) | 1 |
| `AUTO_VOID_MS`, `UNDO_MS`, `ASK_TIMEOUT_MS` | demo timer overrides | see above |
| `PAYEE_<SELLER>_CLIENT_ID`, `_CLIENT_SECRET`, `_WEBHOOK_ID` | one sandbox app per seller (`POWER_COMPANY`, `GARDEN_SHOP`, `MOBILITY_DIRECT`, `MAPLE_LANE`, `LAKESIDE_TICKETS`) | empty, local stand-in |
| `PAYPAL_API_BASE` | PayPal host; must be `https://api-m.sandbox.paypal.com` when any seller has keys, otherwise startup stops | `https://api-m.sandbox.paypal.com` |
| `PAYPAL_TRANSPORT` | `sdk` (APIMatic SDK) or `rest` (earlier REST adapter) for Orders and Payments calls | `sdk` |
| `FORCE_MOCK` | 1 = ignore the Anthropic key, `LLM_BACKEND` and every seller's PayPal keys, and use only the scripted stand-in (`npm test` sets it) | unset |
| `LLM_BACKEND` | `account` = run Claude through your local Claude Code login (shown as "Claude Sonnet (local account)"); no API key is read or sent. Local development only. `scripted` = the scripted stand-in only, no recordings. `replay` = recorded runs only, never the API key, while PayPal keys stay live (`npm run start:sandbox` sets it) | unset |
| `SANDBOX_SELLERS` | comma list of seller keys that may use the sandbox; the others use the local stand-in even with keys | unset (all sellers with keys) |
| `LOCAL_ONLY` | 1 = ignore PayPal keys, the API key and `LLM_BACKEND`, but keep replaying recorded runs (`npm run demo:video` sets it) | unset |

## What is not in this version

Real text messages or push (alerts are on screen), voice call analysis (the Call button is a `tel:` link), several family contacts, re-authorization after the 3 day honor period (the hold voids itself first), disputes, persistence (state is in memory and resets on restart). Roles are demo tokens that show the separation of the payer and family views; they are not real authentication.

## Sandbox evidence (VERIFY.md, 2026-11-12)

Passed against the PayPal sandbox or, for V6, the real model: **V1** create and authorize, **V2** capture, void and Request-Id replay, **V5** contract sheet matched except the empty authorize body, **V6** Claude Sonnet through a local Claude Code account, **V10** SDK smoke, **V11** create, authorize, capture and void through the SDK, **V12** create_order replay (the lost-answer half was not run), **V13** SDK models carry the ids, **V14** another merchant's app refused (`401 PERMISSION_DENIED` on read and capture), **T1** Agent Toolkit `get_order` read real sandbox orders, **S1** sandbox mode: scenario 1 on a fresh sandbox order (order 6WX23438R12863229, authorization 5T8904334N5048042, `VOIDED`) with the recorded Claude run that was made on a sandbox order. Not run: V3, V4, V7, V8, V9. The same list is in the app under the PayPal panel.

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

- FBI IC3 2025 Internet Crime Report, elder fraud section ($7.748 billion, 59%, 201,266 complaints; cryptocurrency $4,347,081,557 in the 60+ loss table): https://www.ic3.gov/AnnualReport/Reports/2025_IC3Report.pdf
- FTC consumer alert of 2025-11-20 ("Stop and talk to someone you trust", "They try to isolate you by saying you can't tell anyone"): https://consumer.ftc.gov/consumer-alerts/2025/11/agent-told-me-stay-internet-it-scam
- FTC, Avoiding and Reporting Gift Card Scams: https://consumer.ftc.gov/articles/avoiding-and-reporting-gift-card-scams
- FTC, Protecting Older Consumers 2025-2026 (losses over $100,000: 6% of reports, 70% of losses; online shopping the most reported loss type; social media contact 34% online shopping; bank transfers and cryptocurrency the highest losses): https://www.ftc.gov/system/files/ftc_gov/pdf/2026-older-adults-report-10192026.pdf
- PayPal newsroom, AI-powered scam alerts for Friends and Family payments (2025-07-21): https://newsroom.paypal-corp.com/2025-7-21-Introducing-AI-Powered-Scam-Alerts-for-Friends-and-Family-Payments
- PayPal developer documentation: https://developer.paypal.com/api/payments/v2/errors/permission_not_granted and https://developer.paypal.com/api/orders/v2/definitions/capture_status_details
- Aval on Devpost: https://devpost.com/software/aval
- FINRA rules 2165 and 4512 (roadmap): https://www.finra.org/rules-guidance/rulebooks/finra-rules/2165 and https://www.finra.org/rules-guidance/rulebooks/finra-rules/4512

The product claims above are limited to what those sources say.

## License

MIT, see `LICENSE`.
