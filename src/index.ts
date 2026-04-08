import { Hono } from 'hono'
import { cors } from 'hono/cors'
import type { Env } from './types'
import { sessionMiddleware } from './middleware/auth'
import { brands } from './routes/brands'
import { prompts } from './routes/prompts'
import { personas } from './routes/personas'
import { runs } from './routes/runs'
import { assistant } from './routes/assistant'
import { auth } from './routes/auth'
import { teams } from './routes/teams'
import { admin } from './routes/admin'

const app = new Hono<{ Bindings: Env }>()

// CORS for API routes
app.use('/api/*', cors())

// Session auth middleware — protects all /api/* except /api/auth/* and /api/health
app.use('/api/*', sessionMiddleware)

// Auth routes (public — handle their own session validation)
app.route('/api/auth', auth)

// Protected routes
app.route('/api/brands', brands)
app.route('/api/prompts', prompts)
app.route('/api/personas', personas)
app.route('/api/runs', runs)
app.route('/api/assistant', assistant)
app.route('/api/teams', teams)
app.route('/api/admin', admin)

app.get('/api/health', c => c.json({ ok: true, ts: Date.now() }))

// 404 for unmatched API routes
app.notFound(c => {
  if (c.req.path.startsWith('/api/')) {
    return c.json({ error: 'Not found' }, 404)
  }
  // For non-API routes, let the Assets binding serve static files
  if (c.env.ASSETS) return c.env.ASSETS.fetch(c.req.raw)
  return new Response('Not found', { status: 404 })
})

export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    try {
      // 1. Clean up expired sessions and magic links
      const sessions = await env.DB.prepare(
        'DELETE FROM sessions WHERE expires_at < datetime("now")'
      ).run()
      const links = await env.DB.prepare(
        'DELETE FROM magic_links WHERE expires_at < datetime("now")'
      ).run()
      console.log(`[cron] Cleaned ${sessions.meta.changes} sessions, ${links.meta.changes} magic links`)

      // 2. Detect stalled runs (stuck in active status for > 1 hour)
      const { results: stalled } = await env.DB.prepare(`
        SELECT id, status FROM runs
        WHERE status IN ('pending', 'querying', 'scraping', 'analyzing')
          AND created_at < datetime('now', '-1 hour')
      `).all<{ id: string; status: string }>()

      if (stalled.length > 0) {
        console.warn(`[cron] Found ${stalled.length} stalled runs: ${stalled.map(r => r.id.slice(0, 8)).join(', ')}`)
        for (const run of stalled) {
          await env.DB.prepare(
            `UPDATE runs SET status = 'failed', error = 'Stalled — timed out after 1 hour' WHERE id = ? AND status = ?`
          ).bind(run.id, run.status).run()
        }
      }
    } catch (err) {
      // Cloudflare does NOT retry failed crons. Log clearly for debugging.
      console.error('[cron] Scheduled handler failed:', err)
    }
  },
}
