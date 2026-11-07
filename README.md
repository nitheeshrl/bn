# Batch verification (plain Node.js)

1. Install Node.js 20.6 or newer.
2. `npm install`
3. Copy `.env.example` to `.env` and fill it in.
4. `npm start`
5. Customer page: http://localhost:3000   Admin: http://localhost:3000/admin.html

Data is stored in the `data/` folder (batches.json, scans.json, photos/). Back it up.
Camera and location need HTTPS on phones, so put the app behind HTTPS (Caddy, nginx, or a host that provides it).
