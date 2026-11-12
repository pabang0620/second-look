# Second Look: Devpost draft

Claims below are limited to what VERIFY.md records as PASS. Paste into the Devpost form; replace the bracketed items with real values.

## Inspiration

The FTC's advice to older adults is "Stop and talk to someone you trust." FBI IC3 counts about $7.7 billion lost by people 60 and older in its 2025 report, up 59%, and the FTC finds that the few large losses carry most of the dollars. Online shopping scams are the most reported start. A payment app is exactly where that advice should happen, at the moment before the money moves.

## What it does

A payment from an older adult to a first-time or risky seller stays an uncaptured PayPal authorization. Claude investigates it and shows its work: seller name against email domain, the order read back from PayPal, known scam patterns in the seller's message, the payer's usual amounts. If risk is high and the origin is unclear, Claude asks the payer one question. A trusted family member then taps Approve (capture, after an undo window) or Stop (void). Nobody answers in time: the hold voids itself. The payer's answer is shown to the family but never lowers the risk, and Claude has no capture, void or release tool. Requests outside PayPal (a gift card demand) cannot be held, so the family is told.

## How we built it

- **Claude tool loop** with ten tools, call budgets, and two segments so no model runs while the app waits for a person. Verified with Claude Sonnet through a local Claude Code account (VERIFY V6): scenario 1 reached the question, scenario 2 did not ask. The hosted API path is not verified yet.
- **APIMatic-generated PayPal SDK** for create, authorize, capture and void, with a fixed `PayPal-Request-Id` per action. `paypal-plan.md` holds the contract sheet and a "Contract vs sandbox" table.
- **PayPal Agent Toolkit** `get_order` for the investigation of sellers with sandbox keys.
- Express, React, zod, a state machine with per-payment locks, and a local PayPal stand-in with the same response shapes.

## Challenges

- Against the sandbox, `authorizeOrder` answered 415 until we sent an explicit empty JSON body. The contract sheet matched everywhere else (V5).
- A lost answer after a timeout must not capture twice: the server reads the order back and settles the state (replay of the same Request-Id returned the same order and the same capture, V2 and V12).
- Making sure the AI cannot move money by design, not by prompt.

## Accomplishments

Sandbox run on 2026-11-12: create, authorize, capture and void passed through the SDK (V1, V2, V11, V13). 79 tests pass with every outside service faked.

## What we learned

The honest conclusion is that this belongs inside PayPal: a third-party app cannot capture another merchant's authorization, and the capture status already has a `PENDING_REVIEW` reason that could carry the family decision.

## What's next

Trusted Contact in PayPal account settings; several contacts in order; financial-institution contacts (FINRA 4512 and 2165); re-authorization after the 3 day honor period.

## Built with

React 19, Vite, Express 5, zod, PayPal APIMatic SDK, PayPal Agent Toolkit, Anthropic Claude (Sonnet).

## AI tools used to build

[Fill in: Claude Code and the APIMatic Context Plugin, as used.]

## Testing instructions

Same numbers as README "Testing instructions for judges":

1. Open `/` (Judge mode). Margaret (payer) on the left, Sarah (family) on the right, PayPal state at the bottom.
2. Press 1 Shop scam and approve (local mode button, or the PayPal sandbox window with the buyer account [sandbox buyer email and password]). Open "How Claude checked" and answer Claude's question on Margaret's side.
3. On Sarah's card press Stop. The panel goes to `VOIDED`.
4. Press 2 New real shop, approve once. No question. Sarah presses Approve, waits for the undo window, and the payment is captured.
5. Press 3 Known seller and approve once. It is captured right away.
6. Press 4 Nobody answers, approve once, wait 2 minutes. The hold voids itself.
7. Press 5 Gift card request. Margaret sees what was noticed and Sarah gets an alert.

Local mode needs no accounts. Run it with `npm install && npm run build && npm start`.
