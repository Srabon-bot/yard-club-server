# Yardclub Server

**Purpose:** Express + TypeScript API for Yardclub. It serves public catalogue data, customer/owner/admin dashboards, booking requests and Stripe Checkout, favorites, profiles, and analytics from MongoDB.

## Deployment status

Both projects are deployed and connected to their GitHub repositories. Pushes to `main` trigger production deployments automatically.

| Vercel project | Root directory | Runtime | Live URL |
| --- | --- | --- | --- |
| Client | `yardclub_client` | Next.js | https://yardclub-client.vercel.app |
| API | `yardclub-server` | Express via `api/index.ts` + `vercel.json` rewrites | https://yardclub-server.vercel.app |

These are the canonical origins used by `CLIENT_URL`, `CORS_ORIGINS`, and the client's `API_URL`. Do not substitute preview deployment URLs.

### Assignment-demo admin (not a production feature)

The shared assignment database contains a seeded account for review only:

- Email: `admin@yardclub.test`
- Password: `Admin@123`

This is an **assignment-demo-only credential**, not a production feature and not how real admin accounts are created. Public registration always creates `customer` accounts; elevated roles are granted after signup by an existing admin in `/admin/users` or by the one-time CLI promote-admin script. Remove or rotate the demo account before any non-demo deployment.

## Documentation

- [API reference](./docs/API.md) — public, operational, session, and admin route tables.
- [Architecture and data model](./docs/ARCHITECTURE.md) — JWT/JWKS verification, stored roles, status rules, Stripe flow, collections, and deployment notes.

## Stack

- Express 5, TypeScript, MongoDB driver
- Runtime dependencies: `express`, `cors`, `dotenv`, `jose`, `mongodb`, `node-cron`, `nodemailer`, `stripe`
- Development tooling: `tsx`, `nodemon`, TypeScript and type packages

## Setup

```bash
npm install
cp .env.example .env
npm run dev
```

For local work the client runs at `http://localhost:3000` and this API at `http://localhost:5000`. Set `CLIENT_URL` to the client origin so JWKS verification succeeds.

### Environment variables

| Name | Purpose |
| --- | --- |
| `PORT` | Express port. Defaults to `5000`. |
| `MONGODB_URI` | Full MongoDB connection string. Preferred; when set it replaces the `DB_*` SRV values below. |
| `DB_USER`, `DB_PASSWORD`, `DB_HOST` | MongoDB SRV fallback components used only when `MONGODB_URI` is unset. |
| `DB_NAME` | Database name. Defaults to `yardclubDB`. |
| `CLIENT_URL` | Canonical client HTTPS origin with no trailing slash. Must exactly match the client's `BETTER_AUTH_URL` and `NEXT_PUBLIC_BETTER_AUTH_URL`. JWT signatures are verified against `${CLIENT_URL}/api/auth/jwks`; issuer and audience must also match. Mismatches cause 401s and reload failures. |
| `CORS_ORIGINS` | Optional comma-separated list of allowed browser origins. In production set it to the same canonical client origin as `CLIENT_URL`. |
| `STRIPE_SECRET_KEY` | Server-only Stripe secret key. Use `sk_test_...` for development and trials; use `sk_live_...` **only** for a real production deployment that accepts live payments. Never expose it to Next.js or the browser. |
| `STRIPE_WEBHOOK_SECRET` | Signing secret from `stripe listen` locally or from the Stripe webhook endpoint in production. Required to accept webhooks. |
| `CRON_SECRET` | Shared secret protecting `GET /api/cron/booking-sweep`. Required for Vercel Cron; Vercel sends `Authorization: Bearer $CRON_SECRET`. Keep it server-only. |
| `ADMIN_EMAIL` | Optional fallback email for `npm run admin:promote`. The explicit `--email` argument is preferred. |
| `ENABLE_BOOKING_CRON` | Set to `true` to schedule the automatic booking status sweep in-process. Disabled by default. |
| `BOOKING_CRON_SCHEDULE` | Optional five-field cron expression, default `0 * * * *`. Runs in UTC. |
| `ENABLE_EMAIL_NOTIFICATIONS` | Set to `true` to email the customer and owner when a booking completes. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE` | SMTP server for completion emails; port defaults to `587`. |
| `SMTP_USER`, `SMTP_PASS` | Optional SMTP credentials when the server requires authentication. |
| `EMAIL_FROM` | Sender address shown on completion emails. |
| `EMAIL_TRANSPORT` | Set to `json` for local preview instead of sending through SMTP. |

### Scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start with nodemon and tsx. |
| `npm run dev:tsx` | Start with tsx watch. |
| `npm run build` | Compile TypeScript and emit `dist/`. |
| `npm run start` | Run the compiled server with `node dist/app.js`. |
| `npm run typecheck` | Type-check without emitting files. |
| `npm run bookings:sweep` | Run one booking status sweep immediately without starting the API. |
| `npm run admin:promote -- email@example.com` | Promote one **existing** user to admin in a fresh database. No HTTP endpoint. |

Elevated roles can be granted in two ways: an admin changes a user's role in the client's `/admin/users` view, or the one-time CLI command above promotes an existing account from this project. Neither path creates accounts during public registration.

### Health, webhooks, and cron

- `GET /` returns a plain-text health message (`Yardclub server is running`). `GET /api/health` provides a JSON health check for deployment monitoring. Unknown `/api/*` paths return a JSON `404` instead of an HTML page.
- Stripe sends payment events to `POST /api/payments/webhook`. Locally: `stripe listen --forward-to http://localhost:5000/api/payments/webhook`. In production register `https://<api-origin>/api/payments/webhook` and copy its signing secret into `STRIPE_WEBHOOK_SECRET`. The route needs the raw request body to verify the signature.
- Booking status transitions can run in-process via `ENABLE_BOOKING_CRON`, on demand via `npm run bookings:sweep`, or through `GET /api/cron/booking-sweep`. Vercel Cron sends `Authorization: Bearer $CRON_SECRET`; `x-cron-secret` is also accepted for external schedulers. The endpoint returns `503` when `CRON_SECRET` is unset.

### Vercel serverless entry

On Vercel this project is deployed with root directory `yardclub-server`. `api/index.ts` exports the Express app as the serverless handler and `vercel.json` rewrites incoming paths to it, so Vercel does **not** use `npm run start`. Set the environment variables above on the API project, and set `CLIENT_URL`/`CORS_ORIGINS` to the deployed client origin. Deploy this project before the client so `API_URL` can be configured there.
