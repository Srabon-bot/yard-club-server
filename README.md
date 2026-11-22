<div align="center">

# Yardclub — API

REST API for the Yardclub industrial equipment rental platform, built with Express 5, TypeScript, MongoDB Atlas, and Stripe.

[![Live API](https://img.shields.io/badge/Live%20API-yardclub--server.vercel.app-060605?style=for-the-badge&logo=vercel&logoColor=white)](https://yardclub-server.vercel.app)
&nbsp;
[![Live Site](https://img.shields.io/badge/Live%20Site-yardclub--client.vercel.app-a9d800?style=for-the-badge&logo=nextdotjs&logoColor=black)](https://yardclub-client.vercel.app)
&nbsp;
[![Client Repo](https://img.shields.io/badge/Client%20Repo-yard--club--client-181717?style=for-the-badge&logo=github&logoColor=white)](https://github.com/Srabon-bot/yard-club-client)

</div>

---

## Overview

The Yardclub API coordinates equipment listings, search aggregations, customer bookings, Stripe checkout sessions, role-based workflows, and analytics reporting. Every protected endpoint requires an authenticated Better Auth JWT:

```http
Authorization: Bearer <token>
```

The API cryptographically verifies tokens against the client's public JWKS endpoint (`${CLIENT_URL}/api/auth/jwks`) with an 8-second timeout duration and 15-minute key caching. Identity and authorized roles (`customer`, `owner`, `admin`) are strictly verified against the underlying MongoDB database, ensuring that token claims can never forge elevated roles.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | ![Node.js](https://img.shields.io/badge/Node.js%2022-339933?style=flat-square&logo=nodedotjs&logoColor=white) |
| Framework | ![Express](https://img.shields.io/badge/Express%205-000000?style=flat-square&logo=express&logoColor=white) |
| Language | ![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white) Strict Type-Checking |
| Database | ![MongoDB](https://img.shields.io/badge/MongoDB%20Atlas-47A248?style=flat-square&logo=mongodb&logoColor=white) Native Driver & Pipelines |
| Authentication | ![JWT](https://img.shields.io/badge/JWT-D63AFF?style=flat-square&logo=jsonwebtokens&logoColor=white) `jose` with remote JWKS key set & role middlewares |
| Payments | ![Stripe](https://img.shields.io/badge/Stripe%20SDK-635BFF?style=flat-square&logo=stripe&logoColor=white) Checkout Sessions & Raw Webhooks |
| Scheduled Tasks | ![node-cron](https://img.shields.io/badge/node--cron-00D4B2?style=flat-square&logo=data:image/svg%2bxml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0id2hpdGUiPjxwYXRoIGQ9Ik0xMiAyQTEwIDEwIDAgMSAwIDIyIDEyQTEwIDEwIDAgMCAwIDEyIDJ6bTAgMThhOCA4IDAgMSAxIDgtOGE4IDggMCAwIDEtOCA4em0xLTExaC0ydi1lNWgyem0wIDhoLTJ2LTJoMnptMCAwIi8+PC9zdmc+) Automated Booking Status Sweeper |
| Email Notifications | ![Nodemailer](https://img.shields.io/badge/Nodemailer-007ACC?style=flat-square&logo=gmail&logoColor=white) Booking Completion Notices |
| Hosting | ![Vercel](https://img.shields.io/badge/Vercel-000000?style=flat-square&logo=vercel&logoColor=white) Serverless Function Handler |

---

## Endpoints

### Public Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/` | Operational plain-text health ping |
| `GET` | `/api/health` | Structured JSON deployment health check |
| `GET` | `/api/categories` | List 6 equipment categories and inventory counts |
| `GET` | `/api/reviews` | List customer reviews and equipment feedback |
| `GET` | `/api/owners` | List verified equipment fleet owners |
| `GET` | `/api/equipment` | Search and filter equipment listings with pagination |
| `GET` | `/api/equipment/:id` | Retrieve comprehensive equipment detail by ID |
| `GET` | `/api/equipment/featured` | Retrieve top 6 featured equipment items |

**Query parameters for `GET /api/equipment`**

| Parameter | Type | Default | Description |
|---|---|---|---|
| `q` | string | — | Case-insensitive search on title, brand, model, description |
| `category` | string | — | Filter by category (`construction`, `photography`, `vehicles`, etc.) |
| `rentalType` | string | — | Filter by duration (`daily`, `weekly`, `monthly`) |
| `minPrice` | number | — | Minimum daily rental rate |
| `maxPrice` | number | — | Maximum daily rental rate |
| `availability` | string | `all` | Filter by `available` or `rented` status |
| `sort` | string | `newest` | `price-asc`, `price-desc`, `newest`, or `rating` |
| `page` | number | `1` | Pagination page number |
| `limit` | number | `9` | Number of items per page |

### Protected Endpoints (JWT Required)

| Method | Path | Role Required | Description |
|---|---|---|---|
| `GET` | `/api/profile` | Customer / Owner / Admin | Retrieve current signed-in user profile |
| `PATCH` | `/api/profile` | Customer / Owner / Admin | Update profile information |
| `GET` | `/api/bookings/mine` | Customer | Retrieve personal rental booking history |
| `POST` | `/api/bookings` | Customer | Create rental booking & initialize Stripe session |
| `GET` | `/api/favorites` | Customer | Retrieve customer's saved equipment shortlist |
| `POST` | `/api/favorites` | Customer | Add equipment item to favorites |
| `DELETE` | `/api/favorites/:id` | Customer | Remove equipment item from favorites |
| `GET` | `/api/bookings` | Owner | Retrieve rental requests on owner's machinery |
| `GET` | `/api/analytics/owner` | Owner | Retrieve owner's fleet earnings and stats |
| `POST` | `/api/equipment` | Owner / Admin | Add new equipment listing (`pending` status) |
| `PATCH` | `/api/equipment/:id` | Owner / Admin | Update listing specifications and pricing |
| `DELETE` | `/api/equipment/:id` | Owner / Admin | Remove equipment listing |
| `GET` | `/api/admin/users` | Admin | Master registered user management table |
| `PATCH` | `/api/admin/users/:id` | Admin | Update user role (`customer`, `owner`, `admin`) |
| `GET` | `/api/admin/equipment` | Admin | Review equipment listings across all yards |
| `PATCH` | `/api/admin/equipment/:id/status`| Admin | Moderate listing (`approved`, `rejected`, `pending`) |
| `GET` | `/api/admin/rentals` | Admin | Master ledger of all platform bookings |
| `GET` | `/api/analytics/admin` | Admin | Platform-wide volume, user, and revenue metrics |
| `POST` | `/api/payments/webhook` | Public (Stripe Signature) | Authoritative Stripe payment completion webhook |
| `GET` | `/api/cron/booking-sweep` | Secret Bearer Token | Automated booking completion sweeper |

---

## Security & Architecture

- **Cryptographic JWT Verification:** Every write and role-gated route verifies RSA/EdDSA signatures against the client JWKS endpoint, checking `iss` and `aud`.
- **Authoritative Database Roles:** User roles are loaded directly from MongoDB on token presentation, preventing client-side claims forgery.
- **Strict Role-Based Middlewares:** Standardized Express middleware checks (`verifyToken`, `verifyRenter`, `verifyOwner`, `verifyAdmin`, `verifyOwnerOrAdmin`).
- **CORS Whitelist Protection:** Strict origin filtering accepting requests only from the canonical client deployment.
- **Webhook Authenticity:** Raw request body verification using Stripe cryptographic signatures (`stripe-signature`).
- **Input Sanitization & Injection Defense:** Input type-checking and ObjectId casting prevents NoSQL injection attempts; pagination parameters are strictly clamped.

---

## Local Development

**Prerequisites:** Node.js 20+ and a MongoDB Atlas cluster.

```bash
npm install
cp .env.example .env
npm run dev
```

### Environment Configuration (`.env`)

```env
PORT=5000
NODE_ENV=development

# Canonical client origin (no trailing slash)
CLIENT_URL=http://localhost:3000

MONGODB_URI=mongodb+srv://<user>:<password>@cluster.mongodb.net
DB_NAME=yardclubDB

# Stripe Keys
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...

# Cron & Operational Secrets
CRON_SECRET=your_random_cron_secret
```

### Production Deployment (Vercel)

The server deployment uses root directory `yardclub-server` with `api/index.ts` exporting the Express application to Vercel's serverless runtime. Pushes to `main` trigger automated builds.
