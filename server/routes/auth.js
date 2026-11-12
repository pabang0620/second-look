import { HttpError } from '../http.js'

// Demo roles. Each role has its own token, so the payer's screen cannot approve and the family's screen cannot pay.
export function requireRole(svc, role) {
  return (req, _res, next) => {
    if (req.get('x-role-token') !== svc.store.tokens()[role]) return next(new HttpError(403, `This action is for the ${role} only.`))
    return next()
  }
}
