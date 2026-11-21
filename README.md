# Yardclub Server

**Purpose:** Express + TypeScript API for Yardclub. It serves public catalogue data, customer/owner/admin dashboards, booking requests, favorites, profiles, and analytics from MongoDB.

**Live API URL:** add the deployed URL here after deployment.

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
| `API_INTERNAL_KEY` | Shared server-only key that the Next.js server sends with dashboard requests. |

### Scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start with nodemon and tsx. |
| `npm run dev:tsx` | Start with tsx watch. |
| `npm run build` | Compile TypeScript to `dist/`. |
| `npm run start` | Run the compiled server. |
| `npm run typecheck` | Type-check without emitting files. |

The root route `GET /` returns a plain-text health message. Unknown `/api/*` paths return a JSON `404` instead of an HTML page.
