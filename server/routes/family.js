import { Router } from 'express'
import { z } from 'zod'
import { HttpError, parse, idSchema } from '../http.js'
import { requireRole } from './auth.js'
import { familyState } from './state.js'
import { familyView } from '../views.js'

const idParam = z.object({ id: z.string().regex(/^pay_[0-9a-f]{8}$/) })
const stopBody = z.object({ note: z.string().max(200).optional() })
const payeeParam = z.object({ key: idSchema })

// The family can approve or stop. There is no route to change a payee, an amount or to take money.
export function familyRoutes(svc) {
  const router = Router()
  router.use(requireRole(svc, 'family'))
  const view = (p) => familyView(p, { registry: svc.registry, now: svc.clock.now(), household: svc.store.household() })

  router.get('/state', (_req, res) => res.json({ success: true, data: familyState(svc) }))

  router.post('/payments/:id/approve', async (req, res) => {
    const { id } = parse(idParam, req.params)
    res.json({ success: true, data: view(await svc.decisions.approve(id)) })
  })
  router.post('/payments/:id/stop', async (req, res) => {
    const { id } = parse(idParam, req.params)
    const { note } = parse(stopBody, req.body || {})
    res.json({ success: true, data: view(await svc.decisions.stop(id, note || '')) })
  })
  router.post('/payments/:id/undo', async (req, res) => {
    const { id } = parse(idParam, req.params)
    res.json({ success: true, data: view(await svc.decisions.undo(id)) })
  })
  router.post('/payees/:key/trust', (req, res) => {
    const { key } = parse(payeeParam, req.params)
    if (!svc.registry.get(key)) throw new HttpError(404, 'Unknown seller')
    svc.decisions.trustPayee(key)
    res.json({ success: true, data: familyState(svc).household })
  })
  router.post('/rules/resume', (_req, res) => {
    svc.decisions.resumeRules()
    res.json({ success: true, data: familyState(svc).household })
  })

  return router
}
