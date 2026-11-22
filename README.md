<div align="center">

# Yardclub — API

REST API for the Yardclub industrial equipment rental marketplace, built with Express 5, TypeScript, MongoDB Atlas, and Stripe.

[![Live API](https://img.shields.io/badge/Live%20API-yardclub--server.vercel.app-060605?style=for-the-badge&logo=vercel&logoColor=white)](https://yardclub-server.vercel.app)
&nbsp;
[![Live Site](https://img.shields.io/badge/Live%20Site-yardclub--client.vercel.app-a9d800?style=for-the-badge&logo=nextdotjs&logoColor=black)](https://yardclub-client.vercel.app)
&nbsp;
[![Client Repo](https://img.shields.io/badge/Client%20Repo-yard--club--client-181717?style=for-the-badge&logo=github&logoColor=white)](https://github.com/Srabon-bot/yard-club-client)

</div>

---

## Overview

REST API for the Yardclub marketplace — equipment listings, search aggregations, bookings, Stripe checkout, role-based workflows, and analytics.

- **Live API:** <https://yardclub-server.vercel.app>

## Key Features

- **Public surface:** health, categories, reviews, owners, equipment search/detail/featured.
- **Protected surface:** profile, bookings, favorites, equipment CRUD, analytics, admin moderation.
- **Payments:** Stripe webhook (`/api/payments/webhook`) is the authoritative payment-completion handler.
- **Ops:** `/api/cron/booking-sweep` (secret bearer) auto-sweeps booking statuses.

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 20+ |
| Framework | Express 5 |
| Language | TypeScript — strict |
| Database | MongoDB Atlas — native driver & aggregations |
| Auth | JWT via `jose` with remote JWKS, role middlewares |
| Payments | Stripe SDK — Checkout Sessions + raw webhooks |
| Scheduled | node-cron — booking status sweeper |
| Hosting | Vercel — serverless function |

## Endpoints

### Public

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/health` | Deployment health check |
| `GET` | `/api/categories` | Categories + counts |
| `GET` | `/api/reviews` | Reviews |
| `GET` | `/api/owners` | Owners |
| `GET` | `/api/equipment` | Search / filter / sort / paginate |
| `GET` | `/api/equipment/featured` | Featured listings |

### Protected

| Method | Path | Role Required | Description |
|---|---|---|---|
| `GET` | `/api/profile` | Customer / Owner / Admin | Current user profile |
| `PATCH` | `/api/profile` | Customer / Owner / Admin | Update profile |
| `GET` | `/api/bookings/mine` | Customer | Personal bookings |
| `POST` | `/api/bookings` | Customer | Create booking & session |
| `GET` | `/api/favorites` | Customer | Saved equipment |
| `GET` | `/api/bookings` | Owner | Owner bookings |
| `GET` | `/api/analytics/owner` | Owner | Owner earnings |
| `POST` | `/api/equipment` | Owner / Admin | Add listing |
| `PATCH` | `/api/equipment/:id` | Owner / Admin | Update listing |
| `DELETE` | `/api/equipment/:id` | Owner / Admin | Remove listing |
| `GET` | `/api/admin/users` | Admin | User management |
| `PATCH` | `/api/admin/users/:id` | Admin | Update user role |
| `GET` | `/api/admin/equipment` | Admin | Equipment moderation |
| `PATCH` | `/api/admin/equipment/:id/status` | Admin | Moderate listing |
| `GET` | `/api/admin/rentals` | Admin | Rental ledger |
| `GET` | `/api/analytics/admin` | Admin | Platform analytics |
| `POST` | `/api/payments/webhook` | Public (Stripe signature) | Payment completion |

---

## Authentication & Security

JWTs are signed via Better Auth and verified server-side by the Express API against the client's JWKS endpoint; role middlewares enforce customer / owner / admin permissions.
