'use strict';
/**
 * Voyago – travel booking site (DecodeLabs Project 2: Backend API Development)
 * Node.js REST API + static frontend, data stored in MySQL.
 *
 * Principles: RESTful naming · never trust the client (syntactic 400 + semantic 422 validation)
 * · semantic HTTP status codes · JSON in, JSON out · prices are always computed on the server.
 * Payments are SIMULATED – card numbers are validated but never stored (only brand + last 4).
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

const MAX_BODY = 20 * 1024;
const RATE_LIMIT = { windowMs: 60_000, max: 300 };
const CAPACITY = 60;
const MAX_PAX = 6;
const TAX_RATE = 0.12;
const SERVICE_FEE = 4;
const CABINS = { economy: { label: 'Economy', mult: 1 }, premium: { label: 'Premium Economy', mult: 1.5 }, business: { label: 'Business', mult: 2.4 } };
const DEPARTS = ['06:15', '13:40', '21:05'];
const AIRLINES = ['SkyBridge', 'Aero Pearl', 'Nomad Air', 'BlueJet', 'Horizon Wings'];

/* Starter data. It is copied into MySQL the first time the app runs; after that MySQL is the source of truth. */
const SEED_CITIES = [
  ['LHE', 'Lahore', 'Pakistan', 31.52, 74.36, '🕌', 'Food, forts and Mughal glory', '#f59e6b', '#c2410c'],
  ['ISB', 'Islamabad', 'Pakistan', 33.68, 73.05, '⛰️', 'Green hills at the Margalla foot', '#34d399', '#047857'],
  ['KHI', 'Karachi', 'Pakistan', 24.86, 67.01, '🌊', 'City of lights by the sea', '#38bdf8', '#0369a1'],
  ['DXB', 'Dubai', 'UAE', 25.2, 55.27, '🏙️', 'Skyline, souks and desert sunsets', '#fbbf24', '#b45309'],
  ['IST', 'Istanbul', 'Türkiye', 41.01, 28.98, '🕍', 'Where two continents meet', '#fb7185', '#9f1239'],
  ['LHR', 'London', 'United Kingdom', 51.47, -0.45, '🎡', 'Royal parks and rainy romance', '#818cf8', '#3730a3'],
  ['CDG', 'Paris', 'France', 49.01, 2.55, '🗼', 'Cafés, art and golden light', '#f0abfc', '#86198f'],
  ['KUL', 'Kuala Lumpur', 'Malaysia', 3.14, 101.69, '🌆', 'Twin towers and street food', '#2dd4bf', '#0f766e'],
  ['BKK', 'Bangkok', 'Thailand', 13.69, 100.75, '🛺', 'Temples, tuk-tuks and night markets', '#fcd34d', '#a16207'],
  ['MLE', 'Malé', 'Maldives', 4.19, 73.51, '🏝️', 'Turquoise lagoons and overwater villas', '#67e8f9', '#0e7490'],
];
const SEED_PROMOS = [
  ['WELCOME10', 10, 1, '10% off your fare'],
  ['FAMILY15', 15, 3, '15% off for 3+ travellers'],
];

let CITIES = [];
let byCode = {};
let PROMOS = {};

const pool = () => db.pool;
const rows = async (sql, params = [], conn = pool()) => (await conn.query(sql, params))[0];

async function loadReferenceData() {
  const [{ n }] = await rows('SELECT COUNT(*) AS n FROM destinations');
  if (Number(n) === 0) {
    for (const c of SEED_CITIES) await rows('INSERT INTO destinations (code, name, country, latitude, longitude, emoji, tagline, color1, color2) VALUES (?,?,?,?,?,?,?,?,?)', c);
    console.log(`Added ${SEED_CITIES.length} starter destinations to MySQL.`);
  }
  const [{ p }] = await rows('SELECT COUNT(*) AS p FROM promo_codes');
  if (Number(p) === 0) {
    for (const c of SEED_PROMOS) await rows('INSERT INTO promo_codes (code, percent_off, min_pax, description) VALUES (?,?,?,?)', c);
  }
  const cityRows = await rows('SELECT * FROM destinations ORDER BY name');
  CITIES = cityRows.map((r) => ({
    code: r.code, name: r.name, country: r.country, lat: Number(r.latitude), lon: Number(r.longitude),
    emoji: r.emoji, tagline: r.tagline, colors: [r.color1, r.color2],
  }));
  byCode = Object.fromEntries(CITIES.map((c) => [c.code, c]));
  const promoRows = await rows('SELECT * FROM promo_codes');
  PROMOS = Object.fromEntries(promoRows.map((r) => [r.code, { pct: Number(r.percent_off), minPax: Number(r.min_pax), desc: r.description }]));
}

/* -------------------------------- Helpers -------------------------------- */
const pad = (n) => String(n).padStart(2, '0');
const fmtDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayStr = () => fmtDate(new Date());
const parseDate = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && fmtDate(parseDate(s)) === s;
const hash = (s) => { let h = 5381; for (const c of s) h = ((h << 5) + h + c.charCodeAt(0)) >>> 0; return h; };
const round2 = (n) => Math.round(n * 100) / 100;
const hhmm = (m) => { const t = ((m % 1440) + 1440) % 1440; return `${pad(Math.floor(t / 60))}:${pad(t % 60)}`; };
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const NAME_RE = /^[\p{L}][\p{L}'’ .-]{1,39}$/u;
const str = (v) => (typeof v === 'string' ? v.trim() : v);

function distanceKm(a, b) {
  const R = 6371, rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)));
}

/** One booking at a time per flight+date, so two people can never take the same last seat. */
const locks = new Map();
function withLock(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  const run = prev.then(fn);
  const tail = run.then(() => {}, () => {});
  locks.set(key, tail);
  tail.then(() => { if (locks.get(key) === tail) locks.delete(key); });
  return run;
}

/* --------------------------------- Trips --------------------------------- */
function makeTrip(from, to, slot) {
  const a = byCode[from], b = byCode[to];
  const dist = distanceKm(a, b);
  const stops = dist > 5500 ? 1 : 0;
  const mins = Math.round((dist / 780 * 60 + 35 + stops * 95) / 5) * 5;
  const [h, m] = DEPARTS[slot].split(':').map(Number);
  const arrAbs = h * 60 + m + mins;
  const h2 = hash(from + to + slot);
  return {
    id: `${from}-${to}-${slot + 1}`,
    from: { code: a.code, city: a.name, country: a.country },
    to: { code: b.code, city: b.name, country: b.country },
    departs: DEPARTS[slot], arrives: hhmm(arrAbs), arrivalDayOffset: Math.floor(arrAbs / 1440),
    durationMin: mins, distanceKm: dist, stops,
    airline: AIRLINES[h2 % AIRLINES.length], flightNo: `VG${100 + (h2 % 900)}`,
    basePrice: Math.round((38 + dist * 0.085) * [1, 0.9, 1.1][slot]),
  };
}
function findTrip(id) {
  const m = /^([A-Z]{3})-([A-Z]{3})-([1-3])$/.exec(id || '');
  if (!m || !byCode[m[1]] || !byCode[m[2]] || m[1] === m[2]) return null;
  return makeTrip(m[1], m[2], Number(m[3]) - 1);
}

/* ------------------------- Seats, prices & booking rows ------------------------ */
const baseSold = (tripId, date) => 5 + (hash(tripId + date) % 30); // seats "already sold" before our own bookings

async function soldFor(tripId, date) {
  const [{ n }] = await rows(
    "SELECT COALESCE(SUM(passengers_count), 0) AS n FROM bookings WHERE trip_id = ? AND travel_date = ? AND status = 'confirmed'",
    [tripId, date]);
  return baseSold(tripId, date) + Number(n);
}
const farePerPerson = (trip, cabin, sold) => Math.round(trip.basePrice * (1 + (sold / CAPACITY) * 0.35) * CABINS[cabin].mult);

function quote(trip, cabin, pax, promo, sold) {
  const fare = farePerPerson(trip, cabin, sold);
  const subtotal = fare * pax;
  let discount = 0, promoApplied = null;
  if (promo) {
    const p = PROMOS[promo];
    if (!p) return { error: { field: 'promoCode', message: 'This promo code is not valid.' } };
    if (pax < p.minPax) return { error: { field: 'promoCode', message: `${promo} needs at least ${p.minPax} travellers.` } };
    discount = round2((subtotal * p.pct) / 100);
    promoApplied = { code: promo, description: p.desc };
  }
  const taxable = subtotal - discount;
  const taxes = round2(taxable * TAX_RATE);
  const fees = SERVICE_FEE * pax;
  return { quote: { currency: 'USD', cabin, passengers: pax, farePerPerson: fare, subtotal, discount, promo: promoApplied, taxes, fees, total: round2(taxable + taxes + fees) } };
}

async function newReference() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (;;) {
    let r = 'VG-';
    for (const x of crypto.randomBytes(6)) r += chars[x % chars.length];
    const found = await rows('SELECT 1 AS x FROM bookings WHERE reference = ?', [r]);
    if (!found.length) return r;
  }
}
async function assignSeats(tripId, date, pax) {
  const taken = new Set((await rows(
    "SELECT p.seat FROM passengers p JOIN bookings b ON b.reference = p.booking_ref WHERE b.trip_id = ? AND b.travel_date = ? AND b.status = 'confirmed'",
    [tripId, date])).map((r) => r.seat));
  const seats = [];
  for (let n = baseSold(tripId, date); seats.length < pax; n++) {
    const s = `${Math.floor(n / 6) + 1}${'ABCDEF'[n % 6]}`;
    if (!taken.has(s)) seats.push(s);
  }
  return seats;
}

/** Turn database rows into the JSON the website uses. */
function toBooking(r, pax) {
  const city = (code) => ({ code, city: (byCode[code] || {}).name || code, country: (byCode[code] || {}).country || '' });
  const out = {
    reference: r.reference, status: r.status, tripId: r.trip_id, date: String(r.travel_date).slice(0, 10), cabin: r.cabin,
    trip: {
      from: city(r.from_code), to: city(r.to_code), departs: r.departs, arrives: r.arrives,
      arrivalDayOffset: Number(r.arrival_day_offset), durationMin: Number(r.duration_min), stops: Number(r.stops),
      airline: r.airline, flightNo: r.flight_no,
    },
    passengers: pax.map((p) => ({ firstName: p.first_name, lastName: p.last_name, dob: String(p.dob).slice(0, 10), passport: p.passport, seat: p.seat })),
    contact: { email: r.contact_email, phone: r.contact_phone },
    payment: { brand: r.card_brand, last4: r.card_last4 },
    pricing: {
      currency: 'USD', cabin: r.cabin, passengers: Number(r.passengers_count), farePerPerson: Number(r.fare_per_person),
      subtotal: Number(r.subtotal), discount: Number(r.discount),
      promo: r.promo_code ? { code: r.promo_code, description: (PROMOS[r.promo_code] || {}).desc || '' } : null,
      taxes: Number(r.taxes), fees: Number(r.fees), total: Number(r.total),
    },
    createdAt: r.created_at,
  };
  if (r.status === 'cancelled') {
    out.cancelledAt = r.cancelled_at;
    out.refund = { percent: Number(r.refund_percent), amount: Number(r.refund_amount), currency: 'USD' };
  }
  return out;
}
async function loadBooking(ref, email) {
  const [r] = await rows('SELECT * FROM bookings WHERE reference = ? AND contact_email = ?', [ref, email]);
  if (!r) return null;
  const pax = await rows('SELECT first_name, last_name, dob, passport, seat FROM passengers WHERE booking_ref = ? ORDER BY id', [ref]);
  return toBooking(r, pax);
}

/* ------------------------------- Responses ------------------------------- */
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer',
  'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type',
};
function send(res, status, body, headers = {}) {
  const isJson = typeof body === 'object' && body !== null;
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': isJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8', ...headers });
  res.end(status === 204 ? undefined : isJson ? JSON.stringify(body) : String(body ?? ''));
}
const ok = (res, status, data, meta) => send(res, status, { success: true, data, ...(meta ? { meta } : {}) });
const fail = (res, status, code, message, details, headers) =>
  send(res, status, { success: false, error: { code, message, ...(details ? { details } : {}) } }, headers);

function readJson(req) {
  return new Promise((resolve, reject) => {
    const type = (req.headers['content-type'] || '').split(';')[0].trim();
    if (type !== 'application/json') return reject({ status: 415, code: 'UNSUPPORTED_MEDIA_TYPE', message: 'Content-Type must be application/json.' });
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject({ status: 413, code: 'PAYLOAD_TOO_LARGE', message: 'Request body is too large.' }); req.destroy(); } else chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return reject({ status: 400, code: 'EMPTY_BODY', message: 'Request body is empty.' });
      try { resolve(JSON.parse(raw)); } catch { reject({ status: 400, code: 'INVALID_JSON', message: 'Request body is not valid JSON.' }); }
    });
    req.on('error', () => reject({ status: 400, code: 'BAD_REQUEST', message: 'Could not read request body.' }));
  });
}

const hits = new Map();
function rateLimit(ip) {
  const now = Date.now();
  let rec = hits.get(ip);
  if (!rec || now > rec.reset) { rec = { count: 0, reset: now + RATE_LIMIT.windowMs }; hits.set(ip, rec); }
  rec.count++;
  return { limited: rec.count > RATE_LIMIT.max, retryAfter: Math.ceil((rec.reset - now) / 1000) };
}
setInterval(() => { const n = Date.now(); for (const [k, v] of hits) if (n > v.reset) hits.delete(k); }, 60_000).unref();

/* ------------------------------- Validation ------------------------------ */
function checkTripQuery(p) {
  const errors = [];
  const from = (p.from || '').toUpperCase(), to = (p.to || '').toUpperCase();
  if (!byCode[from]) errors.push({ field: 'from', message: 'Choose a valid departure city.' });
  if (!byCode[to]) errors.push({ field: 'to', message: 'Choose a valid destination.' });
  if (byCode[from] && from === to) errors.push({ field: 'to', message: 'Destination must differ from departure.' });
  if (!isDate(p.date)) errors.push({ field: 'date', message: 'Date must be a valid YYYY-MM-DD.' });
  const pax = Number(p.passengers ?? 1);
  if (!Number.isInteger(pax) || pax < 1 || pax > MAX_PAX) errors.push({ field: 'passengers', message: `Travellers must be 1–${MAX_PAX}.` });
  const cabin = p.cabin || 'economy';
  if (!CABINS[cabin]) errors.push({ field: 'cabin', message: `Cabin must be one of: ${Object.keys(CABINS).join(', ')}.` });
  return { errors, from, to, pax, cabin };
}
function checkTravelDate(date) {
  const today = todayStr();
  if (date < today) return { field: 'date', message: 'Travel date cannot be in the past.' };
  const max = fmtDate(new Date(parseDate(today).getTime() + 365 * 86400000));
  if (date > max) return { field: 'date', message: 'Bookings open up to 12 months ahead.' };
  return null;
}
function luhn(num) {
  let sum = 0, alt = false;
  for (let i = num.length - 1; i >= 0; i--) { let n = +num[i]; if (alt) { n *= 2; if (n > 9) n -= 9; } sum += n; alt = !alt; }
  return sum % 10 === 0;
}
const brandOf = (n) => (n[0] === '4' ? 'Visa' : /^5[1-5]/.test(n) ? 'Mastercard' : /^3[47]/.test(n) ? 'Amex' : 'Card');

/** Syntactic validation of a booking body (format → 400). */
function validateBookingSyntax(b) {
  const e = [];
  const add = (field, message) => e.push({ field, message });
  if (typeof b !== 'object' || b === null || Array.isArray(b)) return [{ field: 'body', message: 'Body must be a JSON object.' }];

  if (typeof b.tripId !== 'string' || !/^[A-Z]{3}-[A-Z]{3}-[1-3]$/.test(b.tripId)) add('tripId', 'tripId is missing or malformed.');
  if (!isDate(b.date)) add('date', 'Date must be a valid YYYY-MM-DD.');
  if (!CABINS[b.cabin]) add('cabin', `Cabin must be one of: ${Object.keys(CABINS).join(', ')}.`);
  if (b.promoCode !== undefined && b.promoCode !== null && typeof b.promoCode !== 'string') add('promoCode', 'Promo code must be text.');

  if (!Array.isArray(b.passengers) || b.passengers.length < 1 || b.passengers.length > MAX_PAX) {
    add('passengers', `Provide 1–${MAX_PAX} travellers.`);
  } else {
    b.passengers.forEach((p, i) => {
      const f = (k) => `passengers[${i}].${k}`;
      if (typeof p !== 'object' || p === null) return add(`passengers[${i}]`, 'Traveller must be an object.');
      if (!NAME_RE.test(str(p.firstName) || '')) add(f('firstName'), 'Enter a valid first name (letters only).');
      if (!NAME_RE.test(str(p.lastName) || '')) add(f('lastName'), 'Enter a valid last name (letters only).');
      if (!isDate(p.dob)) add(f('dob'), 'Enter date of birth as YYYY-MM-DD.');
      if (!/^[A-Za-z0-9]{6,9}$/.test(str(p.passport) || '')) add(f('passport'), 'Passport / ID must be 6–9 letters or digits.');
    });
  }
  const c = b.contact;
  if (typeof c !== 'object' || c === null) { add('contact.email', 'Email is required.'); add('contact.phone', 'Phone is required.'); }
  else {
    if (!EMAIL_RE.test(str(c.email) || '') || str(c.email).length > 160) add('contact.email', 'Enter a valid email address.');
    if (!/^\+?[0-9 ()-]{7,20}$/.test(str(c.phone) || '')) add('contact.phone', 'Enter a valid phone number.');
  }
  const p = b.payment;
  if (typeof p !== 'object' || p === null) add('payment.cardNumber', 'Payment details are required.');
  else {
    if (!NAME_RE.test(str(p.cardName) || '')) add('payment.cardName', 'Enter the name on the card.');
    const num = String(p.cardNumber || '').replace(/[\s-]/g, '');
    if (!/^\d{13,19}$/.test(num) || !luhn(num)) add('payment.cardNumber', 'Card number is not valid.');
    if (!/^(0[1-9]|1[0-2])\/\d{2}$/.test(str(p.expiry) || '')) add('payment.expiry', 'Use MM/YY format.');
    if (!/^\d{3,4}$/.test(str(p.cvv) || '')) add('payment.cvv', 'CVV must be 3 or 4 digits.');
  }
  return e;
}
/** Semantic validation (logic → 422). */
function validateBookingSemantics(b) {
  const e = [];
  const dateErr = checkTravelDate(b.date);
  if (dateErr) e.push(dateErr);
  const today = todayStr();
  const seen = new Set();
  b.passengers.forEach((p, i) => {
    if (p.dob >= today) e.push({ field: `passengers[${i}].dob`, message: 'Date of birth must be in the past.' });
    const key = str(p.passport).toUpperCase();
    if (seen.has(key)) e.push({ field: `passengers[${i}].passport`, message: 'Each traveller needs a unique passport / ID.' });
    seen.add(key);
  });
  const [mm, yy] = b.payment.expiry.split('/').map(Number);
  const now = new Date();
  if (2000 + yy < now.getFullYear() || (2000 + yy === now.getFullYear() && mm < now.getMonth() + 1))
    e.push({ field: 'payment.expiry', message: 'This card has expired.' });
  return e;
}

/* --------------------------------- Routes -------------------------------- */
async function createBooking(b, trip, promo) {
  const pax = b.passengers.length;
  const sold = await soldFor(trip.id, b.date);
  const left = Math.max(0, CAPACITY - sold);
  if (left < pax) return { status: 409, code: 'NOT_ENOUGH_SEATS', message: left === 0 ? 'This flight is sold out.' : `Only ${left} seat${left === 1 ? '' : 's'} left on this flight.`, details: [{ field: 'passengers', message: `Only ${left} left.` }] };

  const r = quote(trip, b.cabin, pax, promo, sold);
  if (r.error) return { status: 422, code: 'UNPROCESSABLE_ENTITY', message: r.error.message, details: [r.error] };
  const q = r.quote;

  // Simulated payment gateway
  const cardNum = String(b.payment.cardNumber).replace(/[\s-]/g, '');
  if (cardNum === '4000000000000002') return { status: 402, code: 'PAYMENT_DECLINED', message: 'Your card was declined. Try a different card.', details: [{ field: 'payment.cardNumber', message: 'Card declined.' }] };

  const seats = await assignSeats(trip.id, b.date, pax);
  const reference = await newReference();
  const conn = await pool().getConnection();
  try {
    await conn.beginTransaction();
    await conn.query(
      `INSERT INTO bookings (reference, status, trip_id, travel_date, cabin, from_code, to_code, departs, arrives, arrival_day_offset, duration_min, stops,
         airline, flight_no, contact_email, contact_phone, card_brand, card_last4, passengers_count, fare_per_person, subtotal, discount, promo_code, taxes, fees, total)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [reference, 'confirmed', trip.id, b.date, b.cabin, trip.from.code, trip.to.code, trip.departs, trip.arrives, trip.arrivalDayOffset, trip.durationMin, trip.stops,
        trip.airline, trip.flightNo, str(b.contact.email).toLowerCase(), str(b.contact.phone), brandOf(cardNum), cardNum.slice(-4), pax, q.farePerPerson, q.subtotal, q.discount,
        q.promo ? q.promo.code : null, q.taxes, q.fees, q.total]);
    for (let i = 0; i < pax; i++) {
      const p = b.passengers[i];
      await conn.query('INSERT INTO passengers (booking_ref, first_name, last_name, dob, passport, seat) VALUES (?,?,?,?,?,?)',
        [reference, str(p.firstName), str(p.lastName), p.dob, str(p.passport).toUpperCase(), seats[i]]);
    }
    await conn.commit();
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
  return { status: 201, reference };
}

async function handleApi(req, res, url) {
  const route = url.pathname.replace(/\/+$/, '') || '/';
  const m = req.method;
  const q = Object.fromEntries(url.searchParams);
  const notAllowed = (allow) => fail(res, 405, 'METHOD_NOT_ALLOWED', `${m} is not allowed on ${route}.`, null, { Allow: allow });

  if (route === '/api/health') {
    if (m !== 'GET') return notAllowed('GET');
    await rows('SELECT 1 AS ok');
    return ok(res, 200, { status: 'ok', database: 'connected', time: new Date().toISOString() });
  }

  if (route === '/api/destinations') {
    if (m !== 'GET') return notAllowed('GET');
    const data = CITIES.map((c) => {
      const origin = c.code === 'LHE' ? 'ISB' : 'LHE';
      return { code: c.code, name: c.name, country: c.country, emoji: c.emoji, tagline: c.tagline, colors: c.colors, fromPrice: findTrip(`${origin}-${c.code}-2`).basePrice };
    });
    return ok(res, 200, data, { cabins: Object.fromEntries(Object.entries(CABINS).map(([k, v]) => [k, v.label])), maxTravellers: MAX_PAX });
  }

  if (route === '/api/trips') {
    if (m !== 'GET') return notAllowed('GET');
    const { errors, from, to, pax, cabin } = checkTripQuery(q);
    if (errors.length) return fail(res, 400, 'VALIDATION_ERROR', 'Invalid search.', errors);
    const dErr = checkTravelDate(q.date);
    if (dErr) return fail(res, 422, 'UNPROCESSABLE_ENTITY', dErr.message, [dErr]);
    const list = await Promise.all([0, 1, 2].map(async (slot) => {
      const t = makeTrip(from, to, slot);
      const sold = await soldFor(t.id, q.date);
      const left = Math.max(0, CAPACITY - sold);
      const fare = farePerPerson(t, cabin, sold);
      return { ...t, date: q.date, cabin, seatsLeft: left, available: left >= pax, farePerPerson: fare, estimatedTotal: fare * pax };
    }));
    return ok(res, 200, list, { count: list.length, from, to, date: q.date, passengers: pax, cabin });
  }

  if (route === '/api/quote') {
    if (m !== 'POST') return notAllowed('POST');
    const b = await readJson(req);
    const trip = findTrip(b && b.tripId);
    const errors = [];
    if (!trip) errors.push({ field: 'tripId', message: 'Unknown or malformed tripId.' });
    if (!b || !isDate(b.date)) errors.push({ field: 'date', message: 'Date must be a valid YYYY-MM-DD.' });
    if (!b || !CABINS[b.cabin]) errors.push({ field: 'cabin', message: 'Invalid cabin.' });
    if (!b || !Number.isInteger(b.passengers) || b.passengers < 1 || b.passengers > MAX_PAX) errors.push({ field: 'passengers', message: `Travellers must be 1–${MAX_PAX}.` });
    if (errors.length) return fail(res, 400, 'VALIDATION_ERROR', 'Invalid quote request.', errors);
    const dErr = checkTravelDate(b.date);
    if (dErr) return fail(res, 422, 'UNPROCESSABLE_ENTITY', dErr.message, [dErr]);
    const promo = b.promoCode ? String(b.promoCode).trim().toUpperCase() : null;
    const sold = await soldFor(trip.id, b.date);
    const r = quote(trip, b.cabin, b.passengers, promo, sold);
    if (r.error) return fail(res, 422, 'UNPROCESSABLE_ENTITY', r.error.message, [r.error]);
    return ok(res, 200, r.quote, { seatsLeft: Math.max(0, CAPACITY - sold) });
  }

  if (route === '/api/bookings') {
    if (m !== 'POST') return notAllowed('POST');
    const b = await readJson(req);
    const syntax = validateBookingSyntax(b);
    if (syntax.length) return fail(res, 400, 'VALIDATION_ERROR', 'Some details are missing or malformed.', syntax);
    const trip = findTrip(b.tripId);
    if (!trip) return fail(res, 404, 'TRIP_NOT_FOUND', `Trip ${b.tripId} does not exist.`);
    const semantic = validateBookingSemantics(b);
    if (semantic.length) return fail(res, 422, 'UNPROCESSABLE_ENTITY', 'Some details break a booking rule.', semantic);

    const promo = b.promoCode ? String(b.promoCode).trim().toUpperCase() : null;
    const result = await withLock(`${trip.id}|${b.date}`, () => createBooking(b, trip, promo));
    if (result.status !== 201) return fail(res, result.status, result.code, result.message, result.details);
    const booking = await loadBooking(result.reference, str(b.contact.email).toLowerCase());
    return send(res, 201, { success: true, data: booking }, { Location: `/api/bookings/${booking.reference}` });
  }

  const bm = route.match(/^\/api\/bookings\/([^/]+)$/);
  if (bm) {
    if (!['GET', 'DELETE'].includes(m)) return notAllowed('GET, DELETE');
    const ref = decodeURIComponent(bm[1]).toUpperCase();
    const email = (q.email || '').trim().toLowerCase();
    const errors = [];
    if (!/^VG-[A-Z0-9]{6}$/.test(ref)) errors.push({ field: 'reference', message: 'Reference looks like VG-ABC123.' });
    if (!EMAIL_RE.test(email)) errors.push({ field: 'email', message: 'Enter the email used for the booking.' });
    if (errors.length) return fail(res, 400, 'VALIDATION_ERROR', 'Invalid lookup.', errors);

    const b = await loadBooking(ref, email);
    if (!b) return fail(res, 404, 'BOOKING_NOT_FOUND', 'No booking matches that reference and email.');
    if (m === 'GET') return ok(res, 200, b);

    if (b.status === 'cancelled') return fail(res, 409, 'ALREADY_CANCELLED', 'This booking is already cancelled.');
    const [h, mi] = b.trip.departs.split(':').map(Number);
    const dep = parseDate(b.date); dep.setHours(h, mi, 0, 0);
    const hours = (dep.getTime() - Date.now()) / 3600000;
    if (hours < 24) return fail(res, 422, 'CANCELLATION_CLOSED', 'Bookings cannot be cancelled within 24 hours of departure.');
    const pct = hours > 72 ? 100 : 70;
    const refund = round2((b.pricing.total * pct) / 100);
    await rows("UPDATE bookings SET status = 'cancelled', cancelled_at = NOW(), refund_percent = ?, refund_amount = ? WHERE reference = ? AND status = 'confirmed'", [pct, refund, ref]);
    return ok(res, 200, await loadBooking(ref, email));
  }

  return fail(res, 404, 'NOT_FOUND', `No API route matches ${route}.`);
}

/* ----------------------------- Static frontend ---------------------------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method Not Allowed', { Allow: 'GET, HEAD' });
  let rel;
  try { rel = decodeURIComponent(url.pathname); } catch { return send(res, 400, 'Bad Request'); }
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, 'Forbidden');
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'Not Found');
    res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
}

/* --------------------------------- Server -------------------------------- */
const DB_DOWN = new Set(['ECONNREFUSED', 'PROTOCOL_CONNECTION_LOST', 'ETIMEDOUT', 'ER_ACCESS_DENIED_ERROR', 'ECONNRESET']);
const server = http.createServer(async (req, res) => {
  const started = Date.now();
  res.on('finish', () => console.log(`${req.method} ${req.url.split('?')[0]} → ${res.statusCode} (${Date.now() - started}ms)`));
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (req.method === 'OPTIONS') return send(res, 204);
    if (url.pathname.startsWith('/api/')) {
      const rl = rateLimit(req.socket.remoteAddress);
      if (rl.limited) return fail(res, 429, 'TOO_MANY_REQUESTS', 'Too many requests. Please slow down.', null, { 'Retry-After': String(rl.retryAfter) });
      return await handleApi(req, res, url);
    }
    return serveStatic(req, res, url);
  } catch (err) {
    if (err && err.status) return fail(res, err.status, err.code, err.message);
    console.error(err);
    if (!res.headersSent) {
      if (err && DB_DOWN.has(err.code)) return fail(res, 503, 'SERVICE_UNAVAILABLE', 'Our booking system is temporarily unavailable. Please try again shortly.');
      fail(res, 500, 'INTERNAL_ERROR', 'Something went wrong on our side.');
    }
  }
});

(async () => {
  try {
    await db.init();
    await loadReferenceData();
  } catch (err) {
    console.error('\n✖ Could not start Voyago.\n  ' + err.message + '\n');
    process.exit(1);
  }
  server.listen(PORT, () => console.log(`Voyago running → http://localhost:${PORT}  (MySQL database: ${db.config.database})`));
})();
