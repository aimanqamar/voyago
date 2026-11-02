# Voyago – Travel Ticket Booking (MySQL edition)
DecodeLabs Full Stack Development · Project 2: Backend API Development

A travel website where customers search flights, pay (demo) and get an e-ticket.
Frontend = HTML/CSS/JS. Backend = Node.js REST API. Data = **MySQL**.

---------------------------------------------------------------------

## How to run (Windows, easy steps)

### 1. Install two things (one time only)
- **Node.js** (LTS) – https://nodejs.org
- **XAMPP** (gives you MySQL) – https://www.apachefriends.org
  (you can use MySQL Installer / MySQL Workbench instead – any MySQL 5.7+, 8.x or MariaDB works)

### 2. Start MySQL
Open **XAMPP Control Panel** and click **Start** next to **MySQL**. It turns green.

### 3. Open the project folder in a terminal
Open the folder that contains `server.js`, click the address bar, type `powershell`, press Enter.

### 4. Install the one needed package (one time only)
```
npm install
```

### 5. Start the website
```
node server.js
```
You should see:
```
Added 10 starter destinations to MySQL.
Voyago running → http://localhost:3000  (MySQL database: voyago)
```
The program **creates the database `voyago` and all tables by itself** – nothing to import.

### 6. Open it
Go to **http://localhost:3000** in Chrome.

To stop: press **Ctrl + C** in the terminal.

---------------------------------------------------------------------

## If your MySQL has a password
Open `db-config.json` in Notepad and change it:
```json
{ "host": "localhost", "port": 3306, "user": "root", "password": "YOUR_PASSWORD", "database": "voyago" }
```
(XAMPP's default is user `root` with an empty password, which already works.)

## Common problems
| Message | What to do |
|---|---|
| `Cannot reach MySQL at localhost:3306` | Start MySQL in XAMPP, then run `node server.js` again. |
| `MySQL refused the login` | Put the right user/password in `db-config.json`. |
| `Cannot find module 'mysql2'` | Run `npm install` inside the project folder. |
| `Port 3000 already in use` | Run `$env:PORT=4000; node server.js` (PowerShell) and open http://localhost:4000 |

## See your data in MySQL
Open **http://localhost/phpmyadmin** → database **voyago**:
- `bookings` – every booking (price, flight, contact, card brand + last 4 digits)
- `passengers` – travellers and seat numbers
- `destinations` – cities (edit/add rows here to change the site)
- `promo_codes` – discount codes (edit here to change discounts)

---------------------------------------------------------------------

## Try the site
1. Choose cities + date → **Search flights** → **Select** a flight.
2. Fill traveller details. Optional promo: **WELCOME10** (10% off) or **FAMILY15** (3+ travellers).
3. Pay with demo card **4242 4242 4242 4242**, any future expiry (e.g. 08/29), any CVV.
   Card **4000 0000 0000 0002** simulates a declined payment.
4. You get your e-ticket. Use **Manage booking** (top right) to look it up or cancel it.

Payments are simulated. The full card number is never stored.

---------------------------------------------------------------------

## API documentation (for the Project 2 reviewer)
Slide 15 of the training kit says "If it isn't documented, it doesn't exist" – so the API is documented
here, not on the customer website.

Rules followed (from the PDF): resources are nouns, methods are verbs · JSON in / JSON out ·
validate twice (syntactic → 400, semantic → 422) · semantic HTTP status codes · never trust the client.

| Method | Endpoint | Purpose | Status codes |
|---|---|---|---|
| GET | `/api/health` | Server + database check | 200, 503 |
| GET | `/api/destinations` | Cities, cabins | 200 |
| GET | `/api/trips?from&to&date&passengers&cabin` | Search flights (live price + seats) | 200, 400, 422 |
| POST | `/api/quote` | Price breakdown + promo check | 200, 400, 422 |
| POST | `/api/bookings` | Pay and create a booking | 201, 400, 402, 404, 409, 422 |
| GET | `/api/bookings/{ref}?email=` | Retrieve a booking | 200, 400, 404 |
| DELETE | `/api/bookings/{ref}?email=` | Cancel + refund | 200, 400, 404, 409, 422 |

Other codes: 405 wrong method · 413 body too large · 415 not JSON · 429 rate limit (300/min) · 500 / 503 server or database problem.

Response shape:
```json
{ "success": true,  "data": { }, "meta": { } }
{ "success": false, "error": { "code": "VALIDATION_ERROR", "message": "...", "details": [ { "field": "title", "message": "..." } ] } }
```

Runnable example:
```bash
curl "http://localhost:3000/api/trips?from=LHE&to=DXB&date=2026-12-20&passengers=2&cabin=economy"
```

Notes
- Prices and seat counts are always calculated on the server.
- Bookings for the same flight are processed one at a time, so the last seat can never be sold twice.
- Each booking is saved in one database transaction (booking + all travellers together, or nothing).
