import { z } from 'zod'

export const MAX_CENTS = 500000

export const dollarsSchema = z
  .union([z.string(), z.number()])
  .transform((v) => String(v).replace(/^\$/, '').trim())
  .refine((v) => /^\d{1,5}(\.\d{1,2})?$/.test(v), 'Enter an amount like 64.00')
  .transform((v) => Math.round(Number(v) * 100))
  .refine((c) => c > 0 && c <= MAX_CENTS, 'Amount must be between $0.01 and $5,000')

export const toValue = (cents) => (cents / 100).toFixed(2)
export const formatUsd = (cents) => `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: cents % 100 ? 2 : 0, maximumFractionDigits: 2 })}`
