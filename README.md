# yard-club-server

Express API for the Yardclub equipment rental platform. It connects to MongoDB
and serves the dashboard routes used by the Next.js client.

## Setup

```bash
npm install
cp .env.example .env
npm run dev
```

Required environment variables:

| Name | Purpose |
| --- | --- |
| `PORT` | Express port. Defaults to `5000`. |
| `DB_USER` | MongoDB user. |
| `DB_PASSWORD` | MongoDB password. |
| `DB_HOST` | MongoDB cluster host. |
| `DB_NAME` | Database name. Defaults to `yardclubDB`. |
| `API_INTERNAL_KEY` | Shared secret used by the Next.js server when it calls dashboard routes. |

## Equipment API

Dashboard routes are under `/api` and expect the Next.js server to send
`x-internal-key` plus `x-user-id`. The browser never receives those headers.
This is a temporary bridge until JWT authentication is added.

| Method | Route | Access | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/equipment/mine?status=all` | Owner/admin | List the signed-in owner's equipment with status counts. |
| `POST` | `/api/equipment` | Owner/admin | Create a pending equipment listing. |
| `DELETE` | `/api/equipment/:id` | Owner/admin | Delete an owned listing and its saved favourites. |

The older top-level `GET` routes (`/equipment`, `/bookings`, `/users`, etc.)
remain available for exploration.
