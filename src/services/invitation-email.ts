// src/services/invitation-email.ts — Resend email for team invitations

export async function sendInvitationEmail(
  email: string,
  token: string,
  teamName: string,
  inviterEmail: string,
  resendApiKey: string,
  siteUrl: string = 'https://terrain.run',
): Promise<void> {
  const acceptUrl = `${siteUrl.replace(/\/$/, '')}/invite.html?token=${token}`
  const brand = siteUrl.includes('terrain.run') ? 'terrain.run' : 'AEO'
  const from = (() => {
    try {
      const host = new URL(siteUrl).hostname
      return siteUrl.includes('terrain.run') ? 'terrain.run <auth@terrain.run>' : `AEO <auth@${host}>`
    } catch {
      return 'AEO <noreply@aeo.internal>'
    }
  })()

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${resendApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to: [email],
      subject: `You've been invited to ${teamName} — ${brand}`,
      html: `
        <div style="font-family: monospace; background: #0a0a0a; color: #f0ebeb; padding: 40px; max-width: 480px;">
          <h2 style="color: rgb(238, 82, 24); font-size: 18px; margin-bottom: 24px;">${brand}</h2>
          <p><strong>${escapeHtml(inviterEmail)}</strong> invited you to join the team
          "<strong>${escapeHtml(teamName)}</strong>".</p>
          <p>Click below to accept. This link expires in 7 days.</p>
          <a href="${acceptUrl}" style="display: inline-block; margin: 24px 0; padding: 12px 24px; background: rgb(238, 82, 24); color: #0a0a0a; text-decoration: none; font-weight: bold;">Accept invitation</a>
          <p style="color: #9f9a9a; font-size: 12px;">If you weren't expecting this, you can ignore this email.</p>
        </div>
      `,
    }),
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Resend error: ${err}`)
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[ch] as string)
}
