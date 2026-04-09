// src/services/magic-link.ts — Invalidate old links, issue token, send email (or KV fallback)

import type { Env } from '../types'
import { generateToken } from './auth'
import { sendMagicLink } from './email'

export const MAGIC_LINK_TTL_LOGIN_MIN = 15
export const MAGIC_LINK_TTL_APPROVAL_MIN = 120

export async function issueMagicLink(
  env: Pick<Env, 'DB' | 'KV' | 'RESEND_API_KEY' | 'SITE_URL'>,
  email: string,
  ttlMinutes: number
): Promise<void> {
  await env.DB.prepare(
    'UPDATE magic_links SET used = 1 WHERE email = ? AND used = 0'
  ).bind(email).run()

  const token = generateToken()
  const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000).toISOString()

  await env.DB.prepare(
    'INSERT INTO magic_links (id, email, token, expires_at) VALUES (?, ?, ?, ?)'
  ).bind(crypto.randomUUID(), email, token, expiresAt).run()

  const siteUrl = env.SITE_URL || 'https://terrain.run'
  try {
    await sendMagicLink(email, token, env.RESEND_API_KEY, siteUrl, { ttlMinutes })
  } catch (err) {
    console.error('Email send failed:', err)
    const kvTtl = Math.min(ttlMinutes * 60, 2147483647)
    try {
      await env.KV.put(`magic_link_fallback:${email}`, token, { expirationTtl: kvTtl })
    } catch (kvErr) {
      console.error('KV fallback also failed:', kvErr)
    }
  }
}
