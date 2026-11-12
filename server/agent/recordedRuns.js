import { readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'

// Recorded runs of the real model, written by scripts/recordRuns.js. Checked into the repository so judges
// without a model login see what Claude did, labelled as a recording.
export const RECORDED_DIR = join(dirname(fileURLToPath(import.meta.url)), 'recorded-runs')

const call = z.object({ name: z.string(), input: z.record(z.string(), z.unknown()), result: z.string().optional() })
const turn = z.object({ ms: z.number().nonnegative(), text: z.string().optional(), calls: z.array(call).min(1) })
const runSchema = z.object({
  key: z.string(),
  scenario: z.number().int(),
  title: z.string(),
  model: z.string(),
  modelName: z.string(),
  backend: z.string(),
  recordedAt: z.string(),
  segment1: z.array(turn).min(1),
  afterAnswer: z.record(z.string(), z.array(turn)).optional(),
  outcome: z.record(z.string(), z.unknown()).optional(),
})

export function loadRecordedRuns(dir = RECORDED_DIR) {
  let files = []
  try { files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort() } catch { return [] }
  return files.map((f) => {
    const parsed = runSchema.safeParse(JSON.parse(readFileSync(join(dir, f), 'utf8')))
    if (!parsed.success) throw new Error(`Recorded run ${f} does not match the expected shape`)
    return parsed.data
  })
}
