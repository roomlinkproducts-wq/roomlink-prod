# Onboarding a New Hotel

How to take a new hotel client from nothing to live on RoomLink. It has two parts: the **Super Admin** creates the hotel in `apps/super-admin`, and the hotel's **Hotel Admin (GM)** sets it up and makes it live in `apps/hotel-admin`.

---

## Phase 1: Create the hotel (Super Admin)

**Where:** Super Admin portal → **Hotels → New** (`/hotels/new`)

Gather this from the client first:

- Hotel name, a unique hotel code (letters, numbers and hyphens only), and brand (optional)
- Time zone, check-in time, check-out time (HH:MM, 24h)
- Address, city, state, country, pincode
- Contact person, phone, email
- **Reception contact number** (required)
- **Room service contact number** (required)
- Subscription plan and trial length (0–90 days)
- Hotel Admin's full name, email (required) and phone (optional)

### Steps

1. **Basic Information:** enter the name, hotel code, brand, time zone, and check-in/check-out times.
2. **Contact Details:** enter the address and contact details, including the required reception and room service numbers.
3. **Subscription Plan:** choose an active plan and set the trial days.
4. **Create Hotel Admin:** enter the GM's name, email and phone.
5. **Review & Create:** check everything and submit.

### What the system does on submit

All of these happen in one transaction (`createHotel()` in `apps/super-admin/src/server/services/hotels.service.ts`):

- Creates the hotel with status **`onboarding`**
- Creates a **Hotel Admin** role and an **active** admin user with a temporary password
- Creates the 11-step onboarding checklist, with **Hotel Profile** already marked complete
- Creates a **trial** subscription for the selected plan
- Writes a `hotel.created` audit log entry
- Emails the admin the login URL (`HOTEL_ADMIN_APP_URL/login`), their email and the temporary password

### After creation

6. **Note the temporary password** shown on the success screen. If the invite email doesn't arrive, send the credentials to the GM yourself.
7. Track progress at **Onboarding** (`/onboarding`) in the Super Admin portal. Hotels with no activity for 48 hours or more are flagged as **stalled** and should be followed up.

---

## Phase 2: Set up the hotel (Hotel Admin / GM)

**Where:** Hotel Admin app → sign in → **Onboarding** (`/hotel/onboarding`)

Each checklist item links to its page. A step is marked complete **automatically** when real data is saved on that page; there is nothing to tick by hand. The GM can save and come back at any time.

Work through the steps in this order. Later steps depend on earlier ones: for example, QR codes need rooms and staff need departments.

| # | Step | Page | What to do | Marked complete when |
|---|------|------|------------|----------------------|
| 1 | Hotel Profile | `/hotel/profile` | Check and finish the hotel details | Already complete at creation; saving also marks it |
| 2 | Legal & GST | `/hotel/legal` | Enter legal entity and GST details | Legal details saved |
| 3 | Departments | `/hotel/departments` | Turn on the departments the hotel uses | At least one department enabled |
| 4 | Rooms | `/hotel/rooms` | Add rooms one at a time or bulk-import them | A room is created or imported |
| 5 | QR Codes | `/hotel/qr-codes` | Generate room QR codes; download a ZIP per floor and print | A QR code is generated |
| 6 | Staff | `/hotel/staff` | Create Department Staff accounts and assign departments | A staff user is created |
| 7 | Department Managers | `/hotel/managers` | Assign a manager to each department | A manager is assigned to any department |
| 8 | Guest Services | `/hotel/services` | Set up the services guests can request | A service is created |
| 9 | Restaurant Menu | `/hotel/menu` | Add menu items | A menu item is created |
| 10 | Notifications & Settings | `/hotel/settings` | Set up notification and hotel settings | Settings saved |
| 11 | Review | `/hotel/onboarding` | Check the setup end to end | **Go Live** is clicked |

### Also recommended before go-live

- **Reception accounts:** create front-desk users at `/hotel/reception`. This isn't a checklist step, but reception needs it to handle guest requests.
- **Print and place QR cards** in every room.
- **Test as a guest:** scan a room QR code, place a request or order, and check that it reaches the right department and reception.

---

## Phase 3: Go Live (Hotel Admin / GM)

1. Open `/hotel/onboarding`.
2. Click **Go Live** and confirm.

**What happens:** the hotel's status changes from `onboarding` to **`trial`**, the **Review** step is marked complete, a `hotel.go_live` audit entry is written, and RoomLink starts routing guest requests. Go Live is **not** blocked by unfinished checklist items, so check readiness before clicking.

---

## Phase 4: After go-live (Super Admin)

- The hotel drops off the **Onboarding** list (which shows only `pending` and `onboarding` hotels) and no longer triggers "stalled" alerts.
- Check the hotel on its detail page (`/hotels/:hotelId`): overview, rooms, departments, users, subscription.
- Watch the trial end date under **Subscriptions**. Activate, extend the trial or change the plan as needed.

---

## Known gaps

- **Department Managers is optional but tracked.** A hotel that chooses to have no department managers will show that step as pending. Go Live still works.
- **No forced password change.** The admin account is active from the start with a temporary password. Ask the GM to change it after first login.
- **Adding another admin to an existing hotel** uses `packages/db/scripts/add-hotel-admin.cjs`. The hotel code and admin details are hardcoded, so edit the script before running `node packages/db/scripts/add-hotel-admin.cjs` from the repo root.
