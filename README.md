# Yardclub Server

**Purpose:** Express + TypeScript API for Yardclub. It serves public catalogue data, customer/owner/admin dashboards, booking requests, favorites, profiles, and analytics from MongoDB.

**Live API URL:** add the deployed URL here after deployment.

### Demo admin

The shared assignment database includes `admin@yardclub.test` / `Admin@123` with the `admin` role for review. It is a demo credential, not suitable for production.

## Documentation

- [API reference](./docs/API.md) — public, session, and admin route tables.
- [Architecture and data model](./docs/ARCHITECTURE.md) — auth bridge, status rules, collections, and scope notes.

## Stack

- Express 5, TypeScript, MongoDB driver
- cors and dotenv
- Development tooling: tsx, nodemon, TypeScript

## Setup

```bash
npm install
cp .env.example .env
npm run dev
```

### Environment variables

| Name | Purpose |
| --- | --- |
| `PORT` | Express port. Defaults to `5000`. |
| `DB_USER` | MongoDB username when building the SRV URI. |
| `DB_PASSWORD` | MongoDB password when building the SRV URI. |
| `DB_HOST` | MongoDB cluster host when building the SRV URI. |
| `DB_NAME` | Database name. Defaults to `yardclubDB`. |
| `MONGODB_URI` | Optional full connection string. When set, it replaces the `DB_*` SRV values. |
| `CLIENT_URL` | Better Auth origin and Checkout redirect base. JWT signatures are verified against `${CLIENT_URL}/api/auth/jwks`. Defaults to `http://localhost:3000`. |
| `STRIPE_SECRET_KEY` | Stripe test-mode secret key. Required for Checkout, verification, and refunds. Never expose it to the browser. |
| `STRIPE_WEBHOOK_SECRET` | Signing secret from `stripe listen` locally or the Stripe dashboard in production. Required to accept webhooks. |
| `ENABLE_BOOKING_CRON` | Set to `true` to schedule the automatic booking status sweep. Disabled by default. |
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
| `npm run build` | Compile TypeScript to `dist/`. |
| `npm run start` | Run the compiled server. |
| `npm run typecheck` | Type-check without emitting files. |
| `npm run bookings:sweep` | Run one booking status sweep immediately without starting the API. |

The root route `GET /` returns a plain-text health message. Unknown `/api/*` paths return a JSON `404` instead of an HTML page.
