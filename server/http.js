import { z } from 'zod'

export class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

export function parse(schema, data) {
  const result = schema.safeParse(data)
  if (!result.success) {
    throw new HttpError(400, result.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '))
  }
  return result.data
}

export const idSchema = z.string().regex(/^[a-z0-9_]{3,40}$/)

// Central error handler: the only place that decides status codes and the response shape.
export function errorHandler(err, _req, res, _next) {
  if (err instanceof HttpError) return res.status(err.status).json({ success: false, message: err.message })
  if (err?.type === 'entity.parse.failed') return res.status(400).json({ success: false, message: 'Invalid JSON body' })
  process.stderr.write(`unhandled: ${err?.stack || err}\n`)
  return res.status(500).json({ success: false, message: 'Something went wrong. Nothing was charged.' })
}
