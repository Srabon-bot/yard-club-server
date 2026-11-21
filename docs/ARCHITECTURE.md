# Architecture and data model

## Authorization bridge

The browser never calls dashboard APIs directly. The Next.js server reads the Better Auth session and forwards:

```text
x-internal-key: <API_INTERNAL_KEY>
x-user-id: <signed-in user id>
```

`loadUser` verifies the key, resolves the user from the `user` collection, rejects suspended accounts, and derives the role from the stored `role` field. `requireRole(...roles)` adds role checks to admin and owner routes.

This bridge is temporary: JWT/JWKS verification and the `verifyToken`/`verifyRenter`/`verifyOwner`/`verifyAdmin` middlewares are deliberately out of scope for this build.

## Status and inventory rules

- Equipment status: `approved`, `pending`, `rejected`. Public reads only return `approved`.
- Booking status: `pending`, `upcoming`, `active`, `completed`, `cancelled`.
- Payment status: `unpaid`, `pending`, `paid`, `refunded`, `failed`.
- `pending`, `upcoming`, and `active` bookings reserve stock. Availability subtracts overlapping hold quantities from listing quantity.
- New booking requests are `pending` and `unpaid`. Total = `pricePerDay × quantity × daysBetween(start, end)`.
- Cancelling a paid booking automatically sets payment status to `refunded`.

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

- JWT/JWKS verification or the assignment's named Express middleware functions. The internal session bridge above handles identity and roles.
- Stripe Checkout, webhooks, or payment collection. Payment status is an admin-managed field.
- ImgBB upload. Listing images are direct URLs.

Input validation, ownership checks, JSON 404 responses, and active-booking delete protection are implemented in the route layer.
