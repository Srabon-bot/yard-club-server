# Architecture and data model

## Authentication and authorization

The browser calls same-origin Next.js route handlers and server actions; it does not call the Express API directly. The Next.js server reads the Better Auth session, mints a short-lived JWT with `auth.api.getToken()`, and forwards:

```text
Authorization: Bearer <Better Auth JWT>
```

`verifyToken` uses `jose` to validate the signature against Better Auth's remote JWKS at `${CLIENT_URL}/api/auth/jwks`. It also checks the issuer and audience against the same canonical client origin, then loads the latest user from MongoDB (creating a missing user from token claims), rejects suspended accounts, and attaches `request.user`. **The role stored in MongoDB is authoritative**, not the role claim in the token.

Role guards sit after `verifyToken`:

| Middleware | Allows |
| --- | --- |
| `verifyRenter` | `customer` |
| `verifyOwner` | `owner` |
| `verifyAdmin` | `admin` |
| `verifyOwnerOrAdmin` | `owner` or `admin` |

Owner/admin listing routes use `verifyOwnerOrAdmin`; admin routes use `verifyAdmin`; customer rental history uses `verifyRenter`; profile, favorites, and booking routes use `verifyToken` with ownership checks in the controller.

`CLIENT_URL` (API), `BETTER_AUTH_URL` and `NEXT_PUBLIC_BETTER_AUTH_URL` (client) must be the exact same canonical HTTPS origin with no trailing slash. `API_URL` on the client must be the deployed API HTTPS origin. A mismatch breaks JWKS/issuer/audience checks and shows up as 401 responses and session reload failures.

## Roles and registration

- Public registration creates **only `customer` accounts**. The client form has no role selector, and Better Auth forces `role: "customer"` for direct sign-up calls too.
- There is **no admin or owner self-registration**. An admin grants `owner` or `admin` after signup in the client's `/admin/users` view, or a one-time CLI promote-admin script promotes an existing account from this project.
- Google sign-in uses a real Better Auth social redirect and is configured only when `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are set on the client. The callback URL is `${BETTER_AUTH_URL}/api/auth/callback/google`. New Google accounts are customers.
- Forgot-password is not implemented; its route and link were removed. Password changes require an authenticated session.

## Status and inventory rules

- Equipment status: `approved`, `pending`, `rejected`. Public reads only return `approved`.
- Booking status: `pending`, `upcoming`, `active`, `completed`, `cancelled`.
- Payment status: `unpaid`, `pending`, `paid`, `refunded`, `failed`.
- `pending`, `upcoming`, and `active` bookings reserve stock. Availability subtracts overlapping hold quantities from listing quantity.
- New booking requests start as `pending` with payment not yet collected. Total = `pricePerDay × quantity × daysBetween(start, end)`.
- Submitting a booking **immediately starts hosted Stripe Checkout**: the booking is created first, then the renter is redirected to Stripe. Owners still review and fulfil bookings, but payment is not gated on owner confirmation.
- Checkout uses a dynamic `price_data` line item in BDT poisha (`Math.round(total * 100)`); no Stripe Product or Price is pre-created.
- `checkout.session.completed`, `checkout.session.expired`, and `payment_intent.payment_failed` are handled by the signed webhook. The `/payment-success` page re-verifies the session through `/api/payments/verify`; a shared idempotent writer prevents duplicate payment records. `/payment-cancelled` lets the renter retry.
- Cancelling a paid booking refunds its Stripe PaymentIntent and sets payment status to `refunded`.

## Payments and Stripe webhook

- `POST /api/bookings/:id/checkout` is called by the renter's server action right after booking creation. The amount comes from the stored booking, never from the request body.
- `POST /api/payments/webhook` is mounted before the JSON body parser so Stripe receives the raw bytes needed for signature verification using `STRIPE_WEBHOOK_SECRET`. In production register `https://<api-origin>/api/payments/webhook` and store its signing secret on the API project.
- `POST /api/payments/verify` is used by the success page as an idempotent fallback when a webhook has not yet landed. Payment records live in the `payments` collection; revenue analytics prefer that collection and fall back to legacy paid bookings.

## Image uploads

Listing and profile forms accept a direct hosted image URL, or a signed-in user can upload through the Next.js route `POST /api/uploads/imgbb`. That route keeps `IMGBB_API_KEY` server-side (never `NEXT_PUBLIC_`) and returns the hosted `i.ibb.co` URL saved in MongoDB. This API does not proxy image bytes.

## Automatic booking status sweep

When `ENABLE_BOOKING_CRON=true`, the API schedules `sweepBookingStatuses` with `node-cron` (default `0 * * * *`, UTC, no overlapping runs). The sweep uses UTC calendar-day boundaries and is idempotent:

- `upcoming` → `active` once `startDate <= today`.
- `active` → `completed` once `endDate < today`.
- `pending`, `cancelled`, and `completed` are left alone; owners still confirm pending requests manually.

A booking that missed both dates while the job was off completes both transitions in one sweep. `npm run bookings:sweep` runs the same service once for manual catch-up and smoke tests. `BOOKING_CRON_SCHEDULE` changes the frequency. The optional `/api/cron/booking-sweep` endpoint runs the same sweep for an external scheduler; it is protected by `CRON_SECRET` when configured.

## Booking completion emails

When `ENABLE_EMAIL_NOTIFICATIONS=true`, a booking that moves to `completed` — through the cron sweep or an owner/admin status change — sends two emails: one to the customer and one to the equipment owner. The trigger checks the previous status, so repeated updates to an already-completed booking do not resend. If SMTP is not configured, notices are skipped and logged instead of failing the request. `EMAIL_TRANSPORT=json` prints the messages locally for testing.

## MongoDB collections

| Collection | Contents |
| --- | --- |
| `user` | Better Auth users plus `role`, `status`, `phone`, `address`, and `bio`. |
| `equipment` | Listings, approval state, pricing, stock, owner references, and slugs. |
| `bookings` | Rental requests, delivery details, holds, totals, status, and Stripe session/reference ids. |
| `payments` | Stripe transaction records with unique session and PaymentIntent ids, amount, status, and timestamps. |
| `favorites` | User/equipment pairs with lightweight item snapshots. |
| `reviews` | Ratings and review text tied to equipment and owners. |
| `categories` | Category display metadata. |

Ids are MongoDB `ObjectId` values serialized as 24-character strings. Listing routes also accept slugs where noted.

## Deployment and operations

Two Vercel projects are expected:

- Client: root directory `yardclub_client`, Next.js preset.
- API: root directory `yardclub-server`; `api/index.ts` is the serverless entry and `vercel.json` rewrites requests to the Express app. `npm run build` emits `dist/` for local `npm run start`; Vercel invokes the handler instead.

`GET /` is a plain-text health message and `GET /api/health` is the JSON health check. Unknown `/api/*` paths return a JSON `404`. CORS origins are restricted by `CORS_ORIGINS` when set. Vercel configuration is ready, but no live URLs exist until deployment is performed; fill exact HTTPS origins into the READMEs afterwards.

## Scope notes

Stripe Checkout, webhooks, payment collection, and ImgBB uploads are implemented and live-data-backed. Intentionally out of scope: forgot-password, admin/owner self-registration, and mock catalogue data. Input validation, ownership checks, JSON 404 responses, and active-booking delete protection are implemented in the route layer.
