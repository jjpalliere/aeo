# Internal / Debranded Deployment

This branch (`internal`) is a debranded version of AEO for internal circulation. It removes terrain.run branding so it can be shared without implying a separate company.

## What's different

- **Branding:** All "terrain.run" references replaced with "AEO"
- **Homepage:** Strategy Brief section removed. The page shows only the URL input, Predict, and Quick Run panels.
- **Logo:** No TR logo in corner; sidebar shows "AEO" instead of "terrain.run"
- **Configurable base URL:** Magic links use `SITE_URL` so they work when deployed to a different domain

## Deploying to aeo.jjpalier.dev (or similar)

1. **Deploy the worker** to Cloudflare:
   ```bash
   wrangler deploy
   ```

2. **Add custom domain** in Cloudflare:
   - Workers & Pages → your worker → Settings → Domains & Routes
   - Add custom domain: `aeo.jjpalier.dev` (or your domain)

3. **Set SITE_URL** so magic links point to the deployed domain:
   ```bash
   wrangler secret put SITE_URL
   # Enter: https://aeo.jjpalier.dev
   ```

4. **Email (optional):** If you want magic links to work, you'll need to:
   - Add the domain in Resend
   - Verify DNS (SPF/DKIM)
   - Update the "from" address in `src/services/email.ts` if needed (it uses `auth@<your-domain>` when SITE_URL is set)

## Forking to a separate repo

To push this branch to a new repo:

```bash
git remote add internal https://github.com/your-org/aeo-internal.git
git push internal internal:main
```

Then deploy from that repo.
