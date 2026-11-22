# API reference

All routes are mounted under `/api`. Unknown `/api/*` paths return a JSON `404`.

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

These routes require the internal headers described in [ARCHITECTURE.md](./ARCHITECTURE.md).

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
| `POST` | `/api/bookings` | Signed-in user | Create a request from dates, quantity, and delivery details. |
| `GET` | `/api/bookings/mine` | Signed-in user | The caller's bookings with status counts. |
| `GET` | `/api/bookings` | Owner/admin | All bookings with filters, search, and pagination. |
| `PATCH` | `/api/bookings/:id` | Owner/customer/admin | Change fulfilment status. Customers may only cancel. Only admins change payment status. Cancelling a paid booking refunds through Stripe. |
| `POST` | `/api/bookings/:id/checkout` | Renter (owner of booking) | Create a hosted Stripe Checkout session from the stored booking total. Allowed once the booking is `upcoming`. |

### Payments

| Method | Route | Access | Purpose |
| --- | --- | --- | --- |
| `POST` | `/api/payments/webhook` | Stripe signature | Raw-body webhook for completed, expired, and failed Checkout/PaymentIntent events. |
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
| `PATCH` | `/api/admin/users/:id` | Admin | Change a user's role or account status. Self-demotion and self-suspension are blocked. |
| `GET` | `/api/admin/equipment` | Admin | All listings including pending and rejected, with moderation counts. |

Moderation writes use `PATCH /api/equipment/:id`; the admin listing endpoint is the discovery view.
