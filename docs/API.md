# API reference

All routes are mounted under `/api`. Unknown `/api/*` paths return a JSON `404`. `GET /` returns a plain-text health message.

## Operational routes

These need no Better Auth session. The webhook uses a Stripe signature, and the cron endpoint may require `CRON_SECRET`.

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | JSON health check for local smoke tests and deployment monitoring. |
| `POST` | `/api/payments/webhook` | Stripe signature-verified webhook. Register `https://<api-origin>/api/payments/webhook` in Stripe and set `STRIPE_WEBHOOK_SECRET`; locally forward with `stripe listen --forward-to http://localhost:5000/api/payments/webhook`. |
| `GET` | `/api/cron/booking-sweep` | Runs the same idempotent booking status sweep as `npm run bookings:sweep`. Requires `CRON_SECRET`: send `Authorization: Bearer <secret>` (Vercel Cron) or `x-cron-secret: <secret>`. Returns `503` when cron is not configured and `401` for a bad secret. |

## Public routes

No session or internal key required.

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/api/equipment` | Approved catalogue with `q`, `category`, `location`, `rentalType`, `minPrice`, `maxPrice`, `availability`, `featured`, `sort`, `ownerId`, `ownerSlug`, `page`, and `limit`. |
| `GET` | `/api/equipment/stats` | Listing counts, availability, rate range, and rating summary. |
| `GET` | `/api/equipment/:id` | Approved listing by ObjectId or slug, including holds and owner details. |
| `GET` | `/api/categories` | Category metadata with live counts. |
| `GET` | `/api/owners` | Verified owners with listing counts. |
| `GET` | `/api/owners/:id` | Owner profile and approved listings by id or slug. |
| `GET` | `/api/reviews` | Recent reviews, optionally filtered by equipment or owner. |
| `GET` | `/api/stats` | Landing-page counters for equipment, users, bookings, categories, cities, and reviews. |

## Session routes

These routes require a short-lived Better Auth JWT in the `Authorization: Bearer <token>` header. The browser does not call them directly: Next.js server actions and route handlers read the session, mint the JWT with `auth.api.getToken()`, and forward it. No internal API key or custom internal header is used. `verifyToken` checks the JWT against `${CLIENT_URL}/api/auth/jwks` and uses the MongoDB user record as the authoritative role.

### Equipment

| Method | Route | Access | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/equipment/mine?status=all` | Owner/admin | Own listings with status counts. |
| `POST` | `/api/equipment` | Owner/admin | Create a listing with `status: "pending"`. |
| `PATCH` | `/api/equipment/:id` | Owner/admin | Edit a listing. Only admins can change `status` and `featured`. |
| `DELETE` | `/api/equipment/:id` | Owner/admin | Delete a listing, its favorites, and its reviews. Blocked while hold-status bookings exist. |

### Bookings

| Method | Route | Access | Purpose |
| --- | --- | --- | --- |
| `POST` | `/api/bookings` | Signed-in user | Create a request from dates, quantity, and delivery details. Starts as `pending` and returns the created booking so the client can start Checkout immediately. |
| `GET` | `/api/bookings/mine` | Signed-in user (`customer`) | The caller's bookings with status counts. |
| `GET` | `/api/bookings` | Owner/admin | All bookings with filters, search, and pagination. |
| `PATCH` | `/api/bookings/:id` | Owner/customer/admin | Change fulfilment status. Customers may only cancel. Only admins change payment status directly. Cancelling a paid booking refunds through Stripe. |
| `POST` | `/api/bookings/:id/checkout` | Renter (owner of booking) | Starts hosted Stripe Checkout from the stored booking total immediately after the renter submits the booking. The response contains the Checkout `url` used to redirect the browser. |

Payment is **not** gated on owner confirmation: the renter is redirected to hosted Stripe Checkout as soon as the booking is created. The signed webhook finalizes the payment record, with `/api/payments/verify` as an idempotent success-page fallback.

### Payments

| Method | Route | Access | Purpose |
| --- | --- | --- | --- |
| `POST` | `/api/payments/webhook` | Stripe signature | Raw-body webhook for completed, expired, and failed Checkout/PaymentIntent events. Also listed under operational routes because it needs no session. |
| `POST` | `/api/payments/verify` | Renter | Verify a completed Checkout session on the success page and record the payment idempotently. |

### Favorites, profile, and analytics

| Method | Route | Access | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/favorites` | Signed-in user | Saved equipment ids and item snapshots. |
| `POST` | `/api/favorites` | Signed-in user | Save an equipment id. |
| `DELETE` | `/api/favorites/:equipmentId` | Signed-in user | Remove a saved item. |
| `GET` | `/api/profile` | Signed-in user | Current user profile. |
| `PATCH` | `/api/profile` | Signed-in user | Update name, phone, address, bio, and image. |
| `GET` | `/api/analytics/admin` | Admin | Platform totals, revenue, and monthly booking series. |
| `GET` | `/api/analytics/owner` | Owner/admin | Owner-specific totals, earnings, and monthly series. |

### Admin

| Method | Route | Access | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/admin/users` | Admin | User directory with role/status filters and counts. |
| `PATCH` | `/api/admin/users/:id` | Admin | Change a user's role or account status, including promoting a signed-up customer to `owner` or `admin`. Self-demotion and self-suspension are blocked. |
| `GET` | `/api/admin/equipment` | Admin | All listings including pending and rejected, with moderation counts. |

Moderation writes use `PATCH /api/equipment/:id`; the admin listing endpoint is the discovery view.

## Roles and RBAC notes

- Self-registration creates only `customer` accounts. There is no admin self-registration and no forgot-password endpoint.
- An existing admin grants `owner`/`admin` through `PATCH /api/admin/users/:id`, or `npm run admin:promote -- email@example.com` promotes one existing account from the server project. Public registration always creates `customer` accounts.
- Guards map to stored roles: `verifyRenter` = `customer`, `verifyOwner` = `owner`, `verifyAdmin` = `admin`, `verifyOwnerOrAdmin` = `owner` or `admin`. The role in the JWT is never trusted over the stored role.
- `CLIENT_URL` must equal the client's `BETTER_AUTH_URL` / `NEXT_PUBLIC_BETTER_AUTH_URL` canonical origin so JWKS, issuer, and audience checks pass.
