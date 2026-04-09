// src/routes/join-requests.ts — Public POST to request access (owner approves in admin)

import { Hono } from 'hono'
import type { Env } from '../types'
import { checkRateLimitJoinRequest } from '../services/auth'

const MAX_MESSAGE_LEN = 2000

const joinRequests = new Hono<{ Bindings: Env }>()

const successPayload = {
  ok: true as const,
  message: "Thanks — we'll email you if your request is approved.",
}

// POST /api/join-requests
joinRequests.post('/', async c => {
  const body = await c.req
    .json<{
      email?: string
      message?: string
      website?: string
      page_loaded_at?: number
    }>()
    .catch(() => ({} as Record<string, unknown>))

  if (body.website != null && String(body.website).trim() !== '') {
    return c.json({ error: 'Bad request' }, 400)
  }

  const pageLoadedAt = body.page_loaded_at
  if (typeof pageLoadedAt === 'number' && Number.isFinite(pageLoadedAt)) {
    const delta = Date.now() - pageLoadedAt
    if (delta < 2000 || delta > 3600000) {
      return c.json({ error: 'Please try again' }, 400)
    }
  }

  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return c.json({ error: 'Valid email is required' }, 400)
  }

  const allowed = await checkRateLimitJoinRequest(email, c.env.KV)
  if (!allowed) {
    return c.json({ error: 'Too many requests. Try again in a few minutes.' }, 429)
  }

  const existingAccount = await c.env.DB.prepare(
    'SELECT id FROM accounts WHERE email = ?'
  ).bind(email).first<{ id: string }>()
  if (existingAccount) {
    return c.json(
      { error: 'An account already exists for this email. Use “Send Login Link” to sign in.' },
      409
    )
  }

  const pending = await c.env.DB.prepare(
    `SELECT id FROM join_requests WHERE email = ? AND status = 'pending'`
  ).bind(email).first<{ id: string }>()
  if (pending) {
    return c.json(successPayload)
  }

  let msg: string | null = null
  if (typeof body.message === 'string' && body.message.trim()) {
    msg = body.message.trim().slice(0, MAX_MESSAGE_LEN)
  }

  const id = crypto.randomUUID()
  try {
    await c.env.DB.prepare(
      `INSERT INTO join_requests (id, email, status, message) VALUES (?, ?, 'pending', ?)`
    )
      .bind(id, email, msg)
      .run()
  } catch (e) {
    const msgErr = e instanceof Error ? e.message : String(e)
    if (/UNIQUE|unique/i.test(msgErr)) {
      return c.json(successPayload)
    }
    console.error('join_requests insert failed:', e)
    return c.json({ error: 'Could not submit request' }, 500)
  }

  return c.json(successPayload)
})

export { joinRequests }
