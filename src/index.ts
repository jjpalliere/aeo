import { Hono } from 'hono'
import { cors } from 'hono/cors'
import type { Env } from './types'
import { brands } from './routes/brands'
import { prompts } from './routes/prompts'
import { personas } from './routes/personas'
import { runs } from './routes/runs'
import { assistant } from './routes/assistant'

const AUTH_COOKIE = 'aeo_auth'
const AUTH_TOKEN  = 'aeo_ok'
const PASSWORD    = ':blob_with_it:'

function getCookie(header: string | undefined, name: string): string | null {
  if (!header) return null
  const match = header.split(';').map(s => s.trim()).find(s => s.startsWith(name + '='))
  return match ? match.slice(name.length + 1) : null
}

const app = new Hono<{ Bindings: Env }>()

// Auth gate — protects all API routes; HTML pages are gated client-side via /assets/auth.js
app.use('/api/*', async (c, next) => {
  if (c.req.path === '/api/auth') return next()
  if (getCookie(c.req.header('Cookie'), AUTH_COOKIE) === AUTH_TOKEN) return next()
  return c.json({ error: 'Unauthorized' }, 401)
})

// Login endpoint — sets session cookie on correct password
app.post('/api/auth', async c => {
  const body = await c.req.json<{ password: string }>().catch(() => ({ password: '' }))
  if (body.password === PASSWORD) {
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Set-Cookie': `${AUTH_COOKIE}=${AUTH_TOKEN}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000`,
      },
    })
  }
  return c.json({ error: 'Unauthorized' }, 401)
})

app.use('/api/*', cors())

app.route('/api/brands', brands)
app.route('/api/prompts', prompts)
app.route('/api/personas', personas)
app.route('/api/runs', runs)
app.route('/api/assistant', assistant)

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

export default app
