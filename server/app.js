import path from 'node:path'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import express from 'express'
import { errorHandler, HttpError } from './http.js'
import { singleHousehold } from './households.js'
import { elderRoutes } from './routes/elder.js'
import { familyRoutes } from './routes/family.js'
import { judgeRoutes } from './routes/judge.js'
import { paypalRoutes } from './routes/paypal.js'

const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist')

// The role token says which household a request belongs to. A token that belongs to no household is refused.
function byRoleToken(pool, role, makeRouter) {
  const routers = new WeakMap()
  return (req, res, next) => {
    const svc = pool.byToken(req.get('x-role-token'), role)
    if (!svc) return next(new HttpError(403, `This action is for the ${role} only.`))
    if (!routers.has(svc)) routers.set(svc, makeRouter(svc))
    return routers.get(svc)(req, res, next)
  }
}

// source: a household pool (one household per visitor) or a single backend (tests, tools).
export function createApp(source) {
  const pool = typeof source.open === 'function' ? source : singleHousehold(source)
  const app = express()
  app.disable('x-powered-by')
  app.use(express.json({ limit: '100kb' }))
  app.use(express.urlencoded({ extended: false, limit: '10kb' }))

  app.get('/api/health', (_req, res) => res.json({ success: true, data: { ok: true } }))
  app.use('/api/judge', judgeRoutes(pool))
  app.use('/api/elder', byRoleToken(pool, 'elder', elderRoutes))
  app.use('/api/family', byRoleToken(pool, 'family', familyRoutes))
  app.use(paypalRoutes(pool))

  if (existsSync(DIST)) {
    app.use(express.static(DIST))
    app.get(/^\/(?!api\/|mock-paypal\/).*/, (_req, res) => res.sendFile(path.join(DIST, 'index.html')))
  }
  app.use(errorHandler)
  return app
}
