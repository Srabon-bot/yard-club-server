# Architecture and data model

## Authentication and authorization

The browser never calls dashboard APIs directly. The Next.js server reads the Better Auth session, mints a JWT with `auth.api.getToken()`, and forwards:

```text
Authorization: Bearer <Better Auth JWT>
```

`verifyToken` validates the signature against Better Auth's JWKS endpoint (`${CLIENT_URL}/api/auth/jwks`) and checks the issuer and audience. It then loads the latest user from the `user` collection (creating one from the token when missing), rejects suspended accounts, and attaches `request.user`. The stored role is authoritative, not the role in the token.

Role guards sit after `verifyToken`:

| Middleware | Allows |
| --- | --- |
| `verifyRenter` | `customer` |
| `verifyOwner` | `owner` |
| `verifyAdmin` | `admin` |
| `verifyOwnerOrAdmin` | `owner` or `admin` |

Owner/admin listing routes use `verifyOwnerOrAdmin`; admin routes use `verifyAdmin`; customer rental history uses `verifyRenter`; profile, favorites, and booking routes use `verifyToken` with ownership checks in the controller.

## Status and inventory rules

- Equipment status: `approved`, `pending`, `rejected`. Public reads only return `approved`.
- Booking status: `pending`, `upcoming`, `active`, `completed`, `cancelled`.
- Payment status: `unpaid`, `pending`, `paid`, `refunded`, `failed`.
- `pending`, `upcoming`, and `active` bookings reserve stock. Availability subtracts overlapping hold quantities from listing quantity.
- New booking requests are `pending` and `unpaid`. Total = `pricePerDay × quantity × daysBetween(start, end)`.
- Cancelling a paid booking automatically sets payment status to `refunded`.

## Automatic booking status sweep

When `ENABLE_BOOKING_CRON=true`, the API schedules `sweepBookingStatuses` with `node-cron` (default `0 * * * *`, UTC, no overlapping runs). The sweep uses UTC calendar-day boundaries and is idempotent:

- `upcoming` → `active` once `startDate <= today`.
- `active` → `completed` once `endDate < today`.
- `pending`, `cancelled`, and `completed` are left alone; owners still confirm pending requests manually.

A booking that missed both dates while the job was off completes both transitions in one sweep. `npm run bookings:sweep` runs the same service once for manual catch-up and smoke tests. Set `BOOKING_CRON_SCHEDULE` to change the frequency.

## Booking completion emails

When `ENABLE_EMAIL_NOTIFICATIONS=true`, a booking that moves to `completed` — through the cron sweep or an owner/admin status change — sends two emails: one to the customer and one to the equipment owner. The trigger checks the previous status, so repeated updates to an already-completed booking do not resend. If SMTP is not configured, notices are skipped and logged instead of failing the request. `EMAIL_TRANSPORT=json` prints the messages locally for testing.

## MongoDB collections

| Collection | Contents |
| --- | --- |
| `user` | Better Auth users plus `role`, `status`, `phone`, `address`, and `bio`. |
| `equipment` | Listings, approval state, pricing, stock, owner references, and slugs. |
| `bookings` | Rental requests, delivery details, holds, totals, and status. |
| `favorites` | User/equipment pairs with lightweight item snapshots. |
| `reviews` | Ratings and review text tied to equipment and owners. |
| `categories` | Category display metadata. |

Ids are MongoDB `ObjectId` values serialized as 24-character strings. Listing routes also accept slugs where noted.

## Scope notes

This API intentionally does **not** include:

- Stripe Checkout, webhooks, or payment collection. Payment status is an admin-managed field.
- ImgBB upload. Listing images are direct URLs.

JWT/JWKS verification is implemented with `verifyToken` plus `verifyRenter`, `verifyOwner`, `verifyAdmin`, and `verifyOwnerOrAdmin`.

Input validation, ownership checks, JSON 404 responses, and active-booking delete protection are implemented in the route layer.
