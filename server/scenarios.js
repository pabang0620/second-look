// The five judge scenarios. Numbers match the video, the buttons in Judge mode and the Testing instructions.
export const SCENARIOS = Object.freeze([
  { n: 1, title: 'Shop scam', payeeKey: 'mobility_direct', amountCents: 64000, memo: 'scooter, today only price', message: "Price goes up tomorrow. Did you pay yet? Don't tell your son, it's a surprise.", ends: 'Family taps Stop, the authorization is voided' },
  { n: 2, title: 'New real shop', payeeKey: 'maple_lane', amountCents: 6500, memo: 'seedlings', message: '', ends: 'Family taps Approve, PayPal captures after the undo window' },
  { n: 3, title: 'Known seller', payeeKey: 'garden_shop', amountCents: 2000, memo: 'monthly garden delivery', message: '', ends: 'Captured right away' },
  { n: 4, title: 'Nobody answers', payeeKey: 'lakeside_tickets', amountCents: 12000, memo: 'concert tickets', message: '', ends: 'Leave it alone: the hold voids itself' },
  { n: 5, title: 'Gift card request', request: { text: 'Pay $500 in gift cards today and keep this between us.', amountCents: 50000 }, ends: 'Money cannot be held, family is told' },
])
