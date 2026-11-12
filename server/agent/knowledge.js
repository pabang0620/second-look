// Local reference data for the investigation tools. Sources are only the public pages cited in the plan.
const FTC_ALERT = { org: 'FTC', title: 'Consumer alert, 2025-11-20', url: 'https://consumer.ftc.gov/consumer-alerts/2025/11/agent-told-me-stay-internet-it-scam' }
const FTC_GIFT = { org: 'FTC', title: 'Avoiding and Reporting Gift Card Scams', url: 'https://consumer.ftc.gov/articles/avoiding-and-reporting-gift-card-scams' }
const IC3 = { org: 'FBI IC3', title: '2025 Internet Crime Report, elder fraud', url: 'https://www.ic3.gov/AnnualReport/Reports/2025_IC3Report.pdf' }

export const SCAM_PATTERNS = Object.freeze([
  { type: 'urgency', label: 'Pressure to act fast', regex: /(price (goes|will go) up|only today|last chance|act now|right now|hurry|expires? (today|tonight)|before it'?s too late|don'?t wait)/i, source: null, familyNote: 'This is a common sign of a scam' },
  { type: 'secrecy', label: 'Asks you to keep it secret', regex: /(don'?t tell|keep (this|it) (a )?(secret|between us|quiet)|our secret|between us|tell no one|tell anyone)/i, source: FTC_ALERT, familyNote: 'Scammers try to isolate you by saying you cannot tell anyone (FTC)' },
  { type: 'gift_card', label: 'Asks for gift cards', regex: /gift ?cards?/i, source: FTC_GIFT, familyNote: 'Only scammers will tell you to buy a gift card (FTC)' },
  { type: 'crypto', label: 'Asks for cryptocurrency', regex: /(bitcoin|crypto(currency)?|\bbtc\b|coin atm)/i, source: IC3, familyNote: 'People 60 and older reported $4.35 billion of their $7.75 billion in 2025 losses with a cryptocurrency link, about 56% (FBI IC3)' },
  { type: 'remote_access', label: 'Asks for remote access', regex: /(remote access|anydesk|teamviewer|install (this|the) (app|software)|share your screen)/i, source: null, familyNote: 'This is a common sign of a scam' },
  { type: 'family_impersonation', label: 'Pretends to be family in trouble', regex: /(\bit(?:'?s| is) me\b|\bit(?:'?s| is) (?:grand(?:ma|pa)|nana|gran)\b|\bthis is (?:your )?(?:grand(?:son|daughter|child|ma|pa)|nephew|niece)\b|\byour (?:grand(?:son|daughter|child)|nephew|niece)\b|\b(?:i'?m|i am|im) (?:in )?(?:jail|trouble|the hospital|a hospital|police custody)\b|\bi (?:got|was|have been|am being) arrested\b|\bi (?:had|was in) (?:a|an) (?:car )?accident\b|\bbail\b)/i, source: null, familyNote: 'This is a common sign of a scam' },
])

const IMPERSONATION_TERMS = ['bank', 'irs', 'medicare', 'social security', 'government', 'tax', 'postal', 'tech support', 'paypal', 'customer service', 'security department']
const GENERIC_WORDS = new Set(['direct', 'outlet', 'shop', 'store', 'the', 'and', 'company', 'official', 'online', 'nursery', 'tickets', 'sales', 'orders', 'billing'])

const tokens = (text) => text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)

export function lookalikeCheck({ displayName, domain }) {
  const name = displayName.toLowerCase()
  const impersonates = IMPERSONATION_TERMS.filter((term) => new RegExp(`\\b${term}\\b`).test(name) || domain.toLowerCase().includes(term.replace(/\s+/g, '')))
  const significant = tokens(displayName).filter((t) => t.length >= 4 && !GENERIC_WORDS.has(t))
  const label = domain.toLowerCase().replace(/\.[a-z.]+$/, '')
  const nameMatchesDomain = significant.length === 0 ? true : significant.some((t) => label.includes(t))
  return { nameMatchesDomain, impersonates, significantWords: significant }
}

export function searchPatterns(text) {
  const sentences = String(text || '').split(/(?<=[.!?])\s+/).filter(Boolean)
  const matches = []
  for (const pattern of SCAM_PATTERNS) {
    const sentence = sentences.find((s) => pattern.regex.test(s))
    if (sentence) matches.push({ type: pattern.type, label: pattern.label, quote: sentence.slice(0, 200), source: pattern.source, note: pattern.familyNote })
  }
  return matches
}

// Plain words for the person who was stopped. Built from signal kinds, never from model text.
export const ELDER_REASON_PHRASES = Object.freeze({
  urgency: 'the seller said to pay today',
  secrecy: 'it asked you to keep it secret',
  gift_card: 'it asked for gift cards',
  crypto: 'it asked for cryptocurrency',
  remote_access: 'it asked for access to your computer',
  family_impersonation: 'it pretended to be family',
  name_domain_mismatch: 'the seller name and email did not match',
  lookalike_brand: 'the name looked like a well-known organization',
  amount_above_usual: 'the amount is much more than you usually pay',
})
