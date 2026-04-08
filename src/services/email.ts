// src/services/email.ts — Resend API for magic link emails

export async function sendMagicLink(
  email: string,
  token: string,
  resendApiKey: string,
  siteUrl: string = 'https://terrain.run'
) {
  // IMPORTANT: /api/auth/verify, not /auth/verify (ASSETS would 404)
  const verifyUrl = `${siteUrl.replace(/\/$/, '')}/api/auth/verify?token=${token}`

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${resendApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: (() => {
        try {
          const host = new URL(siteUrl).hostname
          return siteUrl.includes('terrain.run') ? 'terrain.run <auth@terrain.run>' : `AEO <auth@${host}>`
        } catch {
          return 'AEO <noreply@aeo.internal>'
        }
      })(),
      to: [email],
      subject: `Your login link — ${siteUrl.includes('terrain.run') ? 'terrain.run' : 'AEO'}`,
      html: `
        <div style="font-family: monospace; background: #0a0a0a; color: #f0ebeb; padding: 40px; max-width: 480px;">
          <h2 style="color: rgb(238, 82, 24); font-size: 18px; margin-bottom: 24px;">AEO</h2>
          <p>Click below to log in. This link expires in 15 minutes.</p>
          <a href="${verifyUrl}" style="display: inline-block; margin: 24px 0; padding: 12px 24px; background: rgb(238, 82, 24); color: #0a0a0a; text-decoration: none; font-weight: bold;">Log In</a>
          <p style="color: #9f9a9a; font-size: 12px;">If you didn't request this, ignore this email.</p>
        </div>
      `,
    }),
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Resend error: ${err}`)
  }
}
