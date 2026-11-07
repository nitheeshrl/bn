# Batch verification (Netlify)

Public page `/` : customer uploads a label photo, gets a result. Photo, location and result are stored.
Admin page `/admin.html` : register batches, see scans, photos, map links, failed-scan banner.

## Deploy
1. Push this folder to a GitHub repo (or `npm i -g netlify-cli && netlify deploy --prod`).
2. Netlify > Add new site > Import from Git. Build settings come from netlify.toml.
3. Site settings > Environment variables:
   - ANTHROPIC_API_KEY  (required, reads the label photo)
   - ADMIN_PASSWORD     (required, protects /admin.html)
   - ALERT_EMAIL + RESEND_API_KEY (+ ALERT_FROM verified sender) for email alerts
   - ALERT_WEBHOOK_URL  (optional Slack/Discord webhook for instant alerts)
   - MODEL              (optional, defaults to claude-sonnet-5-5)
4. Redeploy. Open /admin.html, sign in, paste batches, then test on /.

Storage uses Netlify Blobs (photos, scans, batches). Fine for thousands of scans; move to Postgres beyond that.
Serve over HTTPS (Netlify does) so phone location and camera work.
