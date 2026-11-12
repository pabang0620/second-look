# paypal-plan.md: Second Look on the APIMatic-generated PayPal TypeScript SDK

Scope: move the live Orders and Payments calls (create order, get order, authorize order, capture authorized payment, void authorized payment) from hand-written REST to the SDK. The mock adapter and the gateway interface stay. Sources of every fact below: `node_modules/paypal/sdk-map.md`, `map/operations/orders.md`, `map/operations/payments.md`, `api-reference.md`, `src/resources/payments.ts`, `src/core/response-decoder.ts`, and the model files named in the Type sources tables. Written before the sandbox run; results and the one difference are in the 'Contract vs sandbox' section at the end.

## 0. Survey

| Item | Finding |
| --- | --- |
| Package manager, SDK dependency | npm. `paypal` was not a dependency. Installed with `npm install git+https://github.com/context-plugins/paypal-typescript-sdk#main`; `node_modules/paypal/dist` exists (built), version 2.29.0 |
| Module format, runtime | ESM (`"type": "module"`), Node 22 (floor `>=20.3`), plain JavaScript, no `tsconfig`, so no `tsc --noEmit` gate exists. Contract mistakes are caught by the faked-fetch tests that decode through the real schemas |
| Checks | `npm test` (`node --test test/*.test.js`), `npm run build` (vite). Baseline on the untouched tree: 44 tests pass |
| Layering exemplar | `server/paypal/gateway.js` picks `live` or `mock` per payee. Both expose `createOrder, getOrder, authorizeOrder, captureAuthorization, voidAuthorization, verifyWebhook` and throw `PayPalError(status, issue, message)` from `server/paypal/errors.js` |
| Money and locks exemplar | `server/payments/lifecycle.js` (state is set to CAPTURING / VOIDING under `withLock` before the call; `PayPal-Request-Id` is `<paymentId>:<action>`) |
| Credentials | One PayPal REST app per seller (`PAYEE_<SELLER>_CLIENT_ID/_SECRET`), so one `PaypalClient` per seller, cached by client id. A seller without keys runs on the mock |
| Host | Sandbox only. See 1 |

## 1. Host decision

This SDK declares one environment and has no `ServerEnvironment`. The base URL is `serverOptions.baseUrl` (default `https://api-m.sandbox.paypal.com`).

| Decision | Where |
| --- | --- |
| The app talks to the sandbox host only. `PAYPAL_API_BASE` must have the host `api-m.sandbox.paypal.com` (https). Any other host makes the gateway throw at startup when a seller has real credentials | `assertSandboxHost` in `server/paypal/sdkClient.js`, called by `createGateway` for every `sandbox` payee |
| `baseUrl` is always passed explicitly, never inherited from the SDK default | `buildClient` in `server/paypal/sdkClient.js` |
| Credentials are checked before construction (an unset credential is not an SDK error and would only show up as a later 401) | `buildClient` throws `ConfigurationError`-like `Error` if client id or secret is empty |
| Client built once per seller and held for the process lifetime (resources and the OAuth token cache live on it) | `createSdkClients` map keyed by client id |

## 2. Operations in scope

| App operation | SDK call | Request type (from Signature bullet) | Returns | Mode |
| --- | --- | --- | --- | --- |
| createOrder | `client.orders.createOrder(request, options)` | `Orders.CreateOrderRequest` | `Order` | `await` (throws) |
| getOrder | `client.orders.getOrder(request, options)` | `Orders.GetOrderRequest` | `Order` | `await` |
| authorizeOrder | `client.orders.authorizeOrder(request, options)` | `Orders.AuthorizeOrderRequest` | `OrderAuthorizeResponse` | `await` |
| captureAuthorization | `client.payments.captureAuthorizedPayment(request, options)` | `Payments.CaptureAuthorizedPaymentRequest` | `CapturedPayment` | `await` |
| voidAuthorization | `client.payments.voidPayment(request, options)` | `Payments.VoidPaymentRequest` | `PaymentAuthorization` | `await` |
| getAuthorizedPayment (re-read after a lost void) | `client.payments.getAuthorizedPayment(request, options)` | `Payments.GetAuthorizedPaymentRequest` | `PaymentAuthorization` | `await` |

None of these resolve to `undefined` (the 11 `undefined` operations are not used). So `await` is enough and `.asApiResult()` is not needed. All five writes and reads return decoded camelCase models; the app's other code reads PayPal wire shape (`purchase_units`, `payments.authorizations`, ...), so the adapter returns `orderSchema.encode(value)` / `capturedPaymentSchema.encode(value)` / `paymentAuthorizationSchema.encode(value)`: the wire shape back, produced by the SDK's own schema, not hand mapping.

Not in the SDK, kept on REST: webhook signature verification (`POST /v1/notifications/verify-webhook-signature`). The SDK has 5 resources (orders, payments, vault, transactionSearch, subscriptions); there is no webhooks resource. It stays in `server/paypal/live.js` (`verifyWebhook`), with the same per-seller credentials.

Kept on the PayPal Agent Toolkit by the plan: the agent tool `get_order` (`server/paypal/toolkit.js`), the sponsor integration for Claude's read tool. The lifecycle's own `getOrder` (reconcile, pickup) moves to the SDK.

Not used: confirmOrder, patchOrder, tracking, reauthorizePayment, refunds, vault, transaction search, subscriptions.

## 3. Contract sheet per operation

### 3.1 createOrder

Wire: `POST /v2/checkout/orders`, auth `oauth2`, request body `application/json` (required). SDK-sent: `Idempotency-Key` header, minted per call.

| Field | Channel | Wire | Type | Req | Default |
| --- | --- | --- | --- | --- | --- |
| `payPalMockResponse` | header | `PayPal-Mock-Response` | string | no | none |
| `payPalRequestId` | header | `PayPal-Request-Id` | string | no | none |
| `payPalPartnerAttributionId` | header | `PayPal-Partner-Attribution-Id` | string | no | none |
| `payPalClientMetadataId` | header | `PayPal-Client-Metadata-Id` | string | no | none |
| `prefer` | header | `Prefer` | string | no | `"return=minimal"` (sent when omitted) |
| `payPalAuthAssertion` | header | `PayPal-Auth-Assertion` | string | no | none |
| `body` | body | none | `OrderRequest` | yes | none |

Body members that are set (from `order-request.ts`, `purchase-unit-request.ts`, `amount-with-breakdown.ts`, `pay-pal-wallet.ts`, `pay-pal-wallet-experience-context.ts`):

| Member | Wire | Required | Value |
| --- | --- | --- | --- |
| `intent` | `intent` | yes | `CheckoutPaymentIntent.Authorize` (enum member, open union) |
| `purchaseUnits[0].referenceId` | `reference_id` | optional | payment id (set, see 3.1 OPTIONAL FIELDS) |
| `purchaseUnits[0].description` | `description` | optional | memo, first 120 chars |
| `purchaseUnits[0].amount.currencyCode` / `.value` | `currency_code` / `value` | both required | `"USD"` and the server-computed decimal string from `toValue(amountCents)`; money stays a string end to end |
| `paymentSource.paypal.experienceContext.returnUrl` / `.cancelUrl` | `return_url` / `cancel_url` | optional | the app's return and cancel pages |
| `paymentSource.paypal.experienceContext.shippingPreference` | `shipping_preference` | optional, defaulted `GET_FROM_FILE` | `PayPalWalletContextShippingPreference.NoShipping` (bills have nothing to ship; this was in the REST body already) |

SDK-sent defaults inside `experienceContext` that this code does not set (read from the schema): `contact_preference=NO_CONTACT_INFO`, `landing_page=NO_PREFERENCE`, `user_action=CONTINUE`, `payment_method_preference=UNRESTRICTED`. `user_action=CONTINUE` is what the app wants (it authorizes itself after the payer returns), so it is left out and the default applies.

Return: `Order`. Members the code depends on: `id` (optional in type), `links[]` (for the `payer-action` or `approve` link). Guard: an absent `id` is an unknown outcome, not a success.

Error subclass `Orders.CreateOrderError`; arms: `"error"` 400, `"error2"` 401, `"error3"` 422, `"error4"` default, `"undeclared"`. All carry the `Error` model (`name`, `message`, `debugId` required; `details[].issue`).

OPTIONAL FIELDS (write):

| Field | What requires it | Set it? |
| --- | --- | --- |
| `payPalMockResponse` | nothing | leave out |
| `payPalRequestId` | DUPLICATE CLAIMS row "create_order": `<paymentId>:create`, the reference every caller of this payment computes the same | set |
| `payPalPartnerAttributionId`, `payPalClientMetadataId`, `payPalAuthAssertion` | nothing (each seller uses its own app credentials, no partner flow) | leave out |
| `prefer` | nothing (only `id`, status and links are read) | leave out; SDK default `return=minimal` applies |
| `body.purchaseUnits[0].referenceId` | the app matches a webhook or order back to a payment by reference; it was already in the REST body | set |
| `body.purchaseUnits[0].description` | the agent's `get_order` compares the memo with the order | set |
| `experienceContext.returnUrl`, `.cancelUrl` | the payer return flow (`/api/paypal/return`, `/api/paypal/cancel`) | set |
| `experienceContext.shippingPreference` | digital bill, no address (was in the REST body) | set `NO_SHIPPING` |
| every other optional member of `OrderRequest`, `PurchaseUnitRequest`, `PayPalWallet`, `ExperienceContext` | nothing | leave out |

Test: the request the SDK sent carries no header or body key outside this table plus the SDK's own (authorization, content type, `Idempotency-Key`, the six `X-APIMatic-*`/`User-Agent` identity headers) and the SDK defaults listed above.

### 3.2 getOrder

Wire: `GET /v2/checkout/orders/{id}`. Fields: `id` (path, required), `fields` (query, optional), `payPalMockResponse`, `payPalAuthAssertion` (headers, optional). Only `id` is set. Returns `Order`. Error subclass `Orders.GetOrderError`; arms `"error"` 401, `"error2"` 404, `"error3"` default, `"undeclared"`. It is a GET, so the SDK retry policy (default gate GET) applies and is kept: 3 retries, `retry.timeout` 15 s per attempt. This is a read, no durable write.

### 3.3 authorizeOrder

Wire: `POST /v2/checkout/orders/{id}/authorize`. Body optional; the call sends none. SDK-sent `Idempotency-Key`. Returns `OrderAuthorizeResponse` (`id`, `status`, `purchaseUnits[].payments.authorizations[]` all optional in the type).

| Field | Channel | Wire | Req | Default |
| --- | --- | --- | --- | --- |
| `id` | path | none | yes | none |
| `payPalMockResponse` | header | `PayPal-Mock-Response` | no | none |
| `payPalRequestId` | header | `PayPal-Request-Id` | no | none |
| `prefer` | header | `Prefer` | no | `"return=minimal"` |
| `payPalClientMetadataId`, `payPalAuthAssertion` | header | as named | no | none |
| `body` | body | none | no | none |

Errors `Orders.AuthorizeOrderError`: `"error"` 400, `"error2"` 401, `"error3"` 403, `"error4"` 404, `"error5"` 422, `"error6"` 500, `"error7"` default, `"undeclared"`. The 422 arm carries `ORDER_NOT_APPROVED` in `details[0].issue`, which the lifecycle handles (the payer has not approved yet).

OPTIONAL FIELDS (write):

| Field | What requires it | Set it? |
| --- | --- | --- |
| `payPalRequestId` | DUPLICATE CLAIMS row "authorize": `<paymentId>:authorize` | set |
| `prefer` | The lifecycle must read `purchase_units[0].payments.authorizations[0].id` from this response. The map does not say what `return=minimal` includes for authorize, so the response is requested in full | set `return=representation` (named by the UNKNOWN OUTCOMES row too: if the authorization is absent the adapter re-reads the order) |
| `body`, mock response, metadata, assertion | nothing | leave out |

### 3.4 captureAuthorizedPayment

Wire: `POST /v2/payments/authorizations/{authorization_id}/capture`. Body optional but a capture of the exact held amount needs one. SDK-sent `Idempotency-Key`. Returns `CapturedPayment` (`id`, `status` optional in type; `finalCapture` defaulted `false`).

| Field | Channel | Wire | Req | Default |
| --- | --- | --- | --- | --- |
| `authorizationId` | path | `authorization_id` | yes | none |
| `payPalMockResponse` | header | `PayPal-Mock-Response` | no | none |
| `payPalRequestId` | header | `PayPal-Request-Id` | no | none |
| `prefer` | header | `Prefer` | no | `"return=minimal"` |
| `payPalAuthAssertion` | header | `PayPal-Auth-Assertion` | no | none |
| `body` | body | none | no | `CaptureRequest` |

`CaptureRequest` members set: `amount` (`Money`: `currencyCode`, `value`, both required) and `finalCapture`. Others (`invoiceId`, `paymentInstruction`, `noteToPayer`, `softDescriptor`) left out.

Errors `Payments.CaptureAuthorizedPaymentError`: `"error"` 400, `"error2"` 401, `"error3"` 403, `"error4"` 404, `"error5"` 409, `"error6"` 422, `"error500"` 500 (no body), `"error7"` default, `"undeclared"`.

OPTIONAL FIELDS (write):

| Field | What requires it | Set it? |
| --- | --- | --- |
| `payPalRequestId` | DUPLICATE CLAIMS row "capture": `<paymentId>:capture` | set |
| `prefer` | the lifecycle reads only `id` and `status` | leave out; `return=minimal` default |
| `body.amount` | the app captures exactly the held amount, computed by the server from `amountCents` (the model never sets a number) | set |
| `body.finalCapture` | one capture closes the authorization; this was `final_capture: true` in the REST body and the app's rule is one capture per payment | set `true` |
| other `CaptureRequest` members, mock response, assertion | nothing | leave out |

### 3.5 voidPayment

Wire: `POST /v2/payments/authorizations/{authorization_id}/void`. Request body: none. SDK-sent `Idempotency-Key`. Returns `PaymentAuthorization` (`id`, `status` optional).

| Field | Channel | Wire | Req | Default |
| --- | --- | --- | --- | --- |
| `authorizationId` | path | `authorization_id` | yes | none |
| `payPalMockResponse` | header | `PayPal-Mock-Response` | no | none |
| `payPalAuthAssertion` | header | `PayPal-Auth-Assertion` | no | none |
| `payPalRequestId` | header | `PayPal-Request-Id` | no | none |
| `prefer` | header | `Prefer` | no | `"return=minimal"` |

Errors `Payments.VoidPaymentError`: `"error"` 401, `"error2"` 403, `"error3"` 404, `"error4"` 409, `"error5"` 422, `"error500"` 500 (no body), `"error6"` default, `"undeclared"`.

Trap found in the source: the operation decodes its success body as JSON (`success: { kind: "json", schema: paymentAuthorizationSchema }` in `src/resources/payments.ts`), and `decodeJson` runs `JSON.parse` on the body. The method's own doc says the 200 body "is returned when the Prefer header is set to return=representation". With the default `return=minimal`, a void that succeeds with an empty body would reject with `DecodeError` on a success status, which is an unknown outcome even though the void happened. So `prefer: "return=representation"` is required.

OPTIONAL FIELDS (write):

| Field | What requires it | Set it? |
| --- | --- | --- |
| `payPalRequestId` | DUPLICATE CLAIMS row "void": `<paymentId>:void` | set |
| `prefer` | The SDK decodes the success body as JSON; without a body the call fails to decode (see trap above). Named here as the requirement | set `return=representation` |
| mock response, assertion | nothing | leave out |

### 3.6 getAuthorizedPayment (re-read only)

`GET /v2/payments/authorizations/{authorization_id}`; fields `authorizationId` (path, required), `payPalMockResponse`, `payPalAuthAssertion` (optional, not set). Returns `PaymentAuthorization`; errors `Payments.GetAuthorizedPaymentError`: 401, 403, 404, `"error500"`, default, `"undeclared"`.

## 4. Durable writes (claim, then SDK call, then record)

### DUPLICATE CLAIMS

| Write | Where the claim is stored | What rejects the second one | Where that rejection is caught | Where in the code |
| --- | --- | --- | --- | --- |
| create_order | the payment row, inserted before the call (`store.insert`), state `CREATED`, no order id yet | the payment id is minted once per user-initiated request and is the `PayPal-Request-Id` (`<id>:create`), so every retry of this payment resends the same key and PayPal answers with the same order. A second user submission is a different payment by design (see Assumptions) | n/a (no store refusal; provider-side dedup on the stable key) | `createPayment` in `server/payments/lifecycle.js`; `createOrder` in `server/paypal/sdkLive.js` |
| authorize | a claim entry `claims.authorize` on the payment row, set by a conditional write (`store.claim`) before the call; refused when already set. Value is per payment, the same for every caller | `store.claim(id, 'authorize', at)` returns `false` for the second caller (also serialized by `withLock(paymentId)`). Released when PayPal refuses the call (`ORDER_NOT_APPROVED` or any definite refusal) | `ensureAuthorized`: `if (!store.claim(...)) return store.get(id)` | `ensureAuthorized` in `server/payments/lifecycle.js`; `store.claim` / `store.releaseClaim` in `server/store.js` |
| capture | the payment state `CAPTURING`, written by `store.transition(id, [APPROVED_PENDING, ...], CAPTURING)` before the call; a conditional write on the current state, same for every caller | the transition returns `null` for the second caller, because the state is no longer in the from-list; also under `withLock(paymentId)` and with `PayPal-Request-Id` `<id>:capture` | `captureDue` (`decisions.js`) returns the current payment when the transition did not happen; `ensureAuthorized` transitions `CREATED` to `CAPTURING` the same way | `captureDue` in `server/payments/decisions.js`, `captureNow` in `server/payments/lifecycle.js`, `captureAuthorization` in `server/paypal/sdkLive.js` |
| void | the payment state `VOIDING`, written by `store.transition(id, HELD_STATES + APPROVED_PENDING, VOIDING)` before the call | the transition returns `null` for the second caller; double click returns early in `stop` / `undo`; request id `<id>:void` | `stop`, `undo`, `autoVoid` in `server/payments/decisions.js` | `voidNow` in `server/payments/lifecycle.js`, `voidAuthorization` in `server/paypal/sdkLive.js` |

The claim is committed to the app's own store before the SDK call in every row (the test reads the store from inside the faked `fetch`). The SDK also sends its own `Idempotency-Key` (minted once per call, resent on its own retries). It sits beside the claim and the stable `PayPal-Request-Id`, never in place of them. The writes are POSTs and the retry gate is left at its default (`GET, HEAD, PUT, OPTIONS`), so the SDK sends each write once; resends are the lifecycle's `retry()`, which reuses the same `PayPal-Request-Id`.

### UNKNOWN OUTCOMES

| Write | The operation you re-read with | The reference you search by | Where in the code | The test that fails the connection |
| --- | --- | --- | --- | --- |
| create_order | none exists in this SDK: no operation finds an order by `reference_id` or by request id. Settled by replaying the same call with the same `PayPal-Request-Id` (`<id>:create`), which PayPal answers with the original order; if still unknown the payment is marked failed with no money moved (an order holds nothing) | request id `<paymentId>:create` | `createOrder` in `sdkLive.js` throws `PayPalError(0, 'UNKNOWN_OUTCOME')` (retryable); `retry()` in `lifecycle.js` replays | `lost_create_order_response_replays_with_the_same_request_id` |
| authorize | `client.orders.getOrder({ id })` | order id | `authorizeOrder` catch in `sdkLive.js` (`settleAuthorize`); the lifecycle keeps the payment `CREATED` when the outcome stays unknown and the scheduler pickup settles it from the order | `lost_authorize_response_is_settled_by_rereading_the_order`, `lost_authorize_response_not_found_stays_unknown_and_the_pickup_settles_it`, `never_sent_failures_do_not_reread` |
| capture | `client.orders.getOrder({ id })` (the order lists `captures`) | order id (passed with the call) | `captureAuthorization` catch in `sdkLive.js` (`settleCapture`); then `reconcile` in `lifecycle.js` | `lost_capture_response_is_settled_by_rereading_the_order`, `lost_capture_response_not_found_is_unknown_and_the_payment_stays_capturing`, `never_sent_failures_do_not_reread` |
| void | `client.payments.getAuthorizedPayment({ authorizationId })` | authorization id | `voidAuthorization` catch in `sdkLive.js` (`settleVoid`); then `reconcile` | `lost_void_response_is_settled_by_rereading_the_authorization`, `lost_void_response_not_found_stays_voiding_not_failed`, `an_empty_success_body_on_void_is_an_unknown_outcome_that_the_reread_settles`, `never_sent_failures_do_not_reread` |

Kinds that count as unknown on a write: `ConnectionError`, `TimeoutError`, and `DecodeError` on a success status (`err.status` 2xx; a declared error arm that fails to decode keeps its status and is not unknown). Kinds that never left: `AuthError` (credential not obtained) and `EncodeError`. They get a distinct outcome (`CREDENTIAL_FAILED` / `ENCODE_FAILED`, not retryable, no re-read).

### 4.x CROSS-OPERATION INVARIANTS

| Invariant | Where the legal set comes from | Enforced where | The test that proves it |
| --- | --- | --- | --- |
| An order, authorization or capture id can only be used with the seller app that owns it (one `PaypalClient` per seller) | the payment record's `payeeKey` (the app's own record); PayPal also answers `PERMISSION_NOT_GRANTED` for a foreign id | `payeeOf(p)` in `lifecycle.js` picks the client; `createSdkClients` caches per client id | existing `each_payee_has_its_own_credentials` (mock, PERMISSION_NOT_GRANTED) and `sdk_adapter_uses_each_payees_own_token_and_fixed_request_id` (SDK) |
| Capture amount equals the held amount, set by the server | `payment.amountCents` | `captureNow` passes `p.amountCents`; `toValue` formats | `capture_amount_is_computed_by_server_code` |

## 5. WHEN THE API SAYS NO

One table; all five operations use the caller's data or stored data and share the same mapping, implemented once in `toPayPalError` (`server/paypal/sdkErrors.js`) and then by the existing HTTP error handler.

| status | your app answers | the caller reads | test |
| --- | --- | --- | --- |
| a 4xx other than 401 / 403 / 429 (400, 404, 409, 422) | `PayPalError` with the same status and `issue` from `details[0].issue` (else `name`), message from the API; the lifecycle turns it into the friendly text | the API's reason is kept on the error and in the payment's call trace (`detail`) | `api_4xx_reason_is_kept_and_shown_in_the_trace` |
| 401 / 403 | `PayPalError` 502 `PROVIDER_CREDENTIALS` | fixed message: "Seller PayPal credentials were refused" (ours to fix) | `credential_refusal_maps_to_502_without_leaking_the_sdk_message` |
| 429 | `PayPalError` 503 `PROVIDER_BUSY` | fixed message | `quota_429_maps_to_503_and_5xx_maps_to_502_retryable` |
| 5xx | `PayPalError` 502 (retryable) | fixed message | `quota_429_maps_to_503_and_5xx_maps_to_502_retryable` |
| no response, on a write | per UNKNOWN OUTCOMES (re-read first), then `PayPalError(0, 'UNKNOWN_OUTCOME')` | "outcome unknown", never "failed" | the lost-response tests above |
| no response, on a read | `PayPalError(0, 'NETWORK')` | fixed message | `read_connection_failure_maps_to_network_error` |
| `DecodeError` on a success status | unknown (write) / unreadable (read) | per row above | `decode_failure_on_error_status_keeps_status_and_on_success_is_unknown` |
| `DecodeError` on an error status | the same status as the API answered, issue `UNREADABLE_ERROR_BODY` | status only | `decode_failure_on_error_status_keeps_status_and_on_success_is_unknown` |

Never put an SDK `message` into a response: `toPayPalError` builds its own message from `payload.body.message` (the API's reason) or a fixed text. `err.cause` is kept on the `PayPalError` for logs.

## 6. Resilience and logging decisions

| Topic | Decision |
| --- | --- |
| Retry policy | SDK defaults stand for reads (GET: 3 retries). Writes are POST, outside the default gate, so the SDK sends each write once. The lifecycle's `retry()` (3 tries, same `PayPal-Request-Id`) is the only write resend. `retry.timeout` 15 000 ms per attempt (set explicitly; the default 60 000 ms is too long for a family waiting on a screen) |
| Logging | `logging: { level: "off" }` set explicitly so `PAYPAL_CLIENT_LOG` cannot switch it on from outside; `logRequestBody` stays off (bodies carry the memo and amounts); no per-call level. The app's own call trace in the payment record is the log |
| Pagination, streaming | none in the SDK, none needed |
| Hooks, middleware | none exist; `ClientOptions.fetch` is the seam used only by tests |
| `Error` alias | the SDK exports a model type named `Error`; this code never imports it (JavaScript, and error bodies are read through `payload.body`) |
| Correlation id | `payload.body.debugId` is kept on the `PayPalError` as `debugId` for the trace |

## 7. Assumptions and Blockers

| Kind | Item |
| --- | --- |
| Blocker (declared, not blocking) | create_order has no read-back operation in this SDK, so its unknown outcome is settled by replay on the stable request id, which relies on PayPal deduplicating `PayPal-Request-Id`. VERIFY item covers it. Nothing is held by an order, so the worst case is an orphan order |
| Assumption | `return=representation` on authorize and void is accepted by PayPal and returns the full body (documented in the SDK method comments and `api-reference.md`). Confirmed only by the sandbox run in VERIFY |
| Assumption | A user submitting two payment requests makes two payments; there is no business key that makes them the same order, so create_order has no store-level duplicate claim beyond the per-payment id |
| Minor | No `tsc` gate (plain JavaScript project). The SDK's strict types do not protect this code; the faked-fetch tests decode through the real schemas instead |

## 8. REQUIRED READING

| Row | Pointer |
| --- | --- |
| Client construction, host, factory, long-lived client | MUST load typescript-client-initialization |
| Credential placement, token errors (`AuthError`) | MUST load typescript-authentication |
| Calls, flat request object, defaults that are still sent | MUST load typescript-calling-endpoints |
| Decoded camelCase models, `encode` back to wire, open enums | MUST load typescript-models |
| Error ladder, `err.kind`, arms, unknown outcomes | MUST load typescript-error-handling |
| Retry, timeout, logging off, host binding | MUST load typescript-configuration-resilience |
| Faked `fetch`, token request first, assert outgoing headers | MUST load typescript-testing |

All seven were read before any project file was edited.

## 9. Added beyond the sheet

| Item | Where |
| --- | --- |
| `PAYPAL_TRANSPORT=rest` switches Orders and Payments calls back to the REST adapter (`server/paypal/live.js`), the fallback if an SDK call misbehaves in the sandbox | `server/paypal/gateway.js`, test `rest_transport_switch_keeps_the_previous_adapter_for_orders_and_payments` |
| Read-only SDK smoke, run by a person only (`npm run sdk:smoke`) | `scripts/sdkSmoke.js`, VERIFY V10 |
| Host guard test | `only_the_sandbox_host_is_accepted_and_a_wrong_host_stops_startup` |

## 10. Contract vs sandbox (2026-11-12)

Run through the SDK transport against the PayPal sandbox host. IDs are from the VERIFY Status table.

| Operation | Contract sheet expects | Sandbox result | IDs | Difference |
| --- | --- | --- | --- | --- |
| `createOrder` (intent `AUTHORIZE`) | 201, order `CREATED`, `payer-action` link | As expected (V1, V11) | order 4TT06463CT4619626 | none |
| `createOrder` replay, same `PayPal-Request-Id` | Same order returned | Same order returned (V12) | order 5JU63374B9030412J | none |
| `authorizeOrder` | 201, authorization in `purchase_units[0].payments.authorizations[0]` | First try failed: HTTP 415 `UNSUPPORTED_MEDIA_TYPE`. With an empty JSON body it passed (V1, V5) | authorization 8AP761279R529210K | **One difference:** the call needs an explicit empty JSON body. Fixed in `server/paypal/sdkLive.js:108` (`body: {}`) |
| `captureAuthorizedPayment` | 201, capture `COMPLETED` | As expected (V2, V11) | order 2C5211815L633513D, capture 6KL13433BL0464433 | none |
| `captureAuthorizedPayment` replay, same Request-Id | Same capture returned | Same capture id 6KL13433BL0464433 (V2) | `pay_d1cfdba6:capture` | none |
| `voidPayment` | 204 or representation with `VOIDED` | As expected (V2, V11) | scenario 1 payment | none |
| Decoded models (V13) | Fields the lifecycle reads are present | Present, no `DecodeError` or `UNKNOWN_OUTCOME` | authorizations 8AP761279R529210K, 7LA72743CH326070C | none |

Not run against the sandbox: webhooks (V4), several seller apps (V3), a lost capture answer (V12, second half).
