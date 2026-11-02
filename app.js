'use strict';
/* Voyago frontend – talks to the REST API in server.js */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(n);
const dur = (m) => `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
const pad = (n) => String(n).padStart(2, '0');
const isoDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const longDate = (s) => new Date(s + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
const initials = (s) => s.split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase();

const state = { cities: [], cabins: {}, maxPax: 6, search: null, trips: [], sort: 'price', sel: null, promo: null, lastQuote: null };

/* ------------------------------- API client ------------------------------ */
async function api(method, path, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const res = await fetch(path, opts);
  let json = null;
  if (res.status !== 204) { try { json = await res.json(); } catch { /* not JSON */ } }
  return { status: res.status, ok: res.ok, json };
}
const errText = (r) => {
  const e = r.json && r.json.error;
  if (!e) return `Something went wrong (${r.status}).`;
  return e.message;
};
function toast(msg, type = '') {
  const el = document.createElement('div');
  el.className = `toast ${type}`; el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), 3800);
}

/* --------------------------------- Modal --------------------------------- */
function openModal(html, narrow = false) {
  $('#modal-body').innerHTML = html;
  $('.modal-panel').classList.toggle('narrow', narrow);
  $('#modal').hidden = false;
  document.body.classList.add('lock');
  $('#modal').scrollTop = 0;
}
function closeModal() { $('#modal').hidden = true; document.body.classList.remove('lock'); $('#modal-body').innerHTML = ''; }
document.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#modal').hidden) closeModal(); });

/* ----------------------------------- Nav --------------------------------- */
const nav = $('#nav');
const onScroll = () => nav.classList.toggle('solid', window.scrollY > 40);
window.addEventListener('scroll', onScroll, { passive: true }); onScroll();

/* ------------------------------ Init / search ---------------------------- */
async function init() {
  const r = await api('GET', '/api/destinations').catch(() => null);
  if (!r || !r.ok) { toast('We can’t load destinations right now. Please refresh in a moment.', 'error'); return; }
  state.cities = r.json.data; state.cabins = r.json.meta.cabins; state.maxPax = r.json.meta.maxTravellers;

  const opts = state.cities.map((c) => `<option value="${c.code}">${esc(c.name)} (${c.code})</option>`).join('');
  $('#s-from').innerHTML = opts; $('#s-to').innerHTML = opts;
  $('#s-from').value = 'LHE'; $('#s-to').value = 'DXB';
  $('#s-pax').innerHTML = Array.from({ length: state.maxPax }, (_, i) => `<option value="${i + 1}">${i + 1} traveller${i ? 's' : ''}</option>`).join('');
  $('#s-cabin').innerHTML = Object.entries(state.cabins).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('');

  const d = new Date(); const min = isoDate(d); d.setDate(d.getDate() + 14);
  $('#s-date').min = min; $('#s-date').value = isoDate(d);
  renderDestinations();
}

function renderDestinations() {
  $('#dest-grid').innerHTML = state.cities.map((c) => `
    <button class="dest" data-code="${c.code}" style="background:linear-gradient(150deg,${c.colors[0]},${c.colors[1]})" aria-label="Plan a trip to ${esc(c.name)}">
      <span class="em">${c.emoji}</span>
      <span class="info">
        <h3>${esc(c.name)}</h3><div class="co">${esc(c.country)}</div>
        <div class="tg">${esc(c.tagline)}</div>
        <span class="from">from ${money(c.fromPrice)}</span>
      </span>
    </button>`).join('');
}
$('#dest-grid').addEventListener('click', (e) => {
  const b = e.target.closest('.dest'); if (!b) return;
  const from = $('#s-from');
  $('#s-to').value = b.dataset.code;
  if (from.value === b.dataset.code) from.value = b.dataset.code === 'LHE' ? 'ISB' : 'LHE';
  window.scrollTo({ top: 0, behavior: 'smooth' });
  setTimeout(() => $('#s-date').focus({ preventScroll: true }), 450);
  toast(`Great pick — set your date and search flights to ${state.cities.find((c) => c.code === b.dataset.code).name}.`);
});

$('#swap').addEventListener('click', () => { const f = $('#s-from'), t = $('#s-to'); [f.value, t.value] = [t.value, f.value]; });

$('#search').addEventListener('submit', async (e) => {
  e.preventDefault();
  const s = { from: $('#s-from').value, to: $('#s-to').value, date: $('#s-date').value, passengers: Number($('#s-pax').value), cabin: $('#s-cabin').value };
  if (s.from === s.to) return toast('Departure and destination must be different.', 'error');
  if (!s.date) return toast('Please choose a travel date.', 'error');
  state.search = s;
  await runSearch(true);
});

async function runSearch(scroll) {
  const s = state.search; if (!s) return;
  const sec = $('#results'); sec.hidden = false;
  $('#r-list').innerHTML = '<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>';
  const cityName = (c) => state.cities.find((x) => x.code === c).name;
  $('#r-title').textContent = `${cityName(s.from)} → ${cityName(s.to)}`;
  $('#r-sub').textContent = `${longDate(s.date)} · ${s.passengers} traveller${s.passengers > 1 ? 's' : ''} · ${state.cabins[s.cabin]}`;
  if (scroll) sec.scrollIntoView({ behavior: 'smooth', block: 'start' });

  const qs = new URLSearchParams(s);
  let r;
  try { r = await api('GET', '/api/trips?' + qs); } catch { r = null; }
  if (!r) { $('#r-list').innerHTML = '<div class="state"><b>Network error</b>Check that the server is running and try again.</div>'; return; }
  if (!r.ok) {
    $('#r-list').innerHTML = `<div class="state"><b>We couldn’t search that</b>${esc(errText(r))}</div>`;
    return;
  }
  state.trips = r.json.data;
  renderTrips();
}

function renderTrips() {
  const key = { price: (t) => t.farePerPerson, duration: (t) => t.durationMin, departs: (t) => t.departs };
  const list = [...state.trips].sort((a, b) => (key[state.sort](a) > key[state.sort](b) ? 1 : -1));
  const pax = state.search.passengers;
  $('#r-list').innerHTML = list.map((t) => {
    const seatClass = t.seatsLeft === 0 ? 'out' : t.seatsLeft <= 10 ? 'low' : '';
    const seatText = t.seatsLeft === 0 ? 'Sold out' : t.seatsLeft <= 10 ? `Only ${t.seatsLeft} seats left` : `${t.seatsLeft} seats available`;
    return `
    <article class="trip">
      <div class="air"><div class="air-logo">${esc(initials(t.airline))}</div><div><b>${esc(t.airline)}</b><small>${esc(t.flightNo)} · ${esc(state.cabins[t.cabin])}</small></div></div>
      <div class="times">
        <div class="t"><b>${t.departs}</b><small>${t.from.code}</small></div>
        <div class="route-line"><div>${dur(t.durationMin)}</div><div class="bar"></div><div class="stop ${t.stops ? 'has' : ''}">${t.stops ? '1 stop' : 'Non-stop'}</div></div>
        <div class="t"><b>${t.arrives}${t.arrivalDayOffset ? `<sup class="next">+${t.arrivalDayOffset}</sup>` : ''}</b><small>${t.to.code}</small></div>
      </div>
      <div class="buy">
        <div class="price">${money(t.farePerPerson)}<small>per person${pax > 1 ? ` · ${money(t.estimatedTotal)} total` : ''}</small></div>
        <span class="seats ${seatClass}">${seatText}</span>
        <button class="btn btn-accent" data-trip="${t.id}" ${t.available ? '' : 'disabled'}>${t.available ? 'Select' : (t.seatsLeft ? 'Not enough seats' : 'Sold out')}</button>
      </div>
    </article>`;
  }).join('');
}
$('#sort').addEventListener('click', (e) => {
  const b = e.target.closest('.chip'); if (!b) return;
  $$('.chip', $('#sort')).forEach((c) => c.classList.toggle('active', c === b));
  state.sort = b.dataset.sort; renderTrips();
});
$('#r-list').addEventListener('click', (e) => {
  const b = e.target.closest('[data-trip]'); if (!b) return;
  openBooking(state.trips.find((t) => t.id === b.dataset.trip));
});

/* ------------------------------ Booking wizard --------------------------- */
function field(label, name, attrs = '', cls = '') {
  return `<label class="field ${cls}"><span>${label}</span><input data-field="${name}" ${attrs}><em class="err"></em></label>`;
}

function openBooking(trip) {
  const s = state.search; const n = s.passengers;
  state.sel = trip; state.promo = null; state.lastQuote = null;
  const today = isoDate(new Date());

  const paxForms = Array.from({ length: n }, (_, i) => `
    <div class="group">
      <h3><span class="num">${i + 1}</span> Traveller ${i + 1}</h3>
      <div class="fields">
        ${field('First name', `passengers[${i}].firstName`, 'autocomplete="given-name" placeholder="As on passport"')}
        ${field('Last name', `passengers[${i}].lastName`, 'autocomplete="family-name"')}
        ${field('Date of birth', `passengers[${i}].dob`, `type="date" max="${today}"`)}
        ${field('Passport / ID number', `passengers[${i}].passport`, 'placeholder="e.g. AB1234567" style="text-transform:uppercase"')}
      </div>
    </div>`).join('');

  openModal(`
  <div class="book">
    <div class="book-main">
      <h2 id="modal-title">Complete your booking</h2>
      <p class="muted small">${esc(trip.airline)} ${esc(trip.flightNo)} · ${longDate(s.date)} · ${trip.departs} → ${trip.arrives}</p>
      <div class="stepper"><div class="s on" data-s="1">1 · Travellers</div><div class="s" data-s="2">2 · Payment</div></div>
      <div class="banner" id="banner"></div>

      <div class="panel" id="p1">
        <div class="group">
          <h3>Contact details</h3>
          <div class="fields">
            ${field('Email (for your e-ticket)', 'contact.email', 'type="email" autocomplete="email" placeholder="you@example.com"')}
            ${field('Phone', 'contact.phone', 'type="tel" autocomplete="tel" placeholder="+92 300 1234567"')}
          </div>
        </div>
        ${paxForms}
        <div class="group">
          <h3>Promo code</h3>
          <div class="row-promo">
            ${field('Have a code?', 'promoCode', 'placeholder="WELCOME10" style="text-transform:uppercase"')}
            <button type="button" class="btn btn-ghost" id="apply-promo">Apply</button>
          </div>
        </div>
        <div class="actions"><button class="btn btn-lg" id="to-pay" type="button">Continue to payment</button></div>
      </div>

      <div class="panel" id="p2" hidden>
        <div class="hint">🧪 Demo payment — no real charge. Use <b>4242 4242 4242 4242</b>, any future expiry and any CVV. Card <b>4000 0000 0000 0002</b> simulates a decline.</div>
        <div class="group">
          <h3>Card details</h3>
          <div class="fields">
            ${field('Name on card', 'payment.cardName', 'autocomplete="cc-name"', 'full')}
            ${field('Card number', 'payment.cardNumber', 'inputmode="numeric" autocomplete="cc-number" placeholder="1234 5678 9012 3456" maxlength="23"', 'full')}
            ${field('Expiry (MM/YY)', 'payment.expiry', 'inputmode="numeric" autocomplete="cc-exp" placeholder="08/29" maxlength="5"')}
            ${field('CVV', 'payment.cvv', 'inputmode="numeric" autocomplete="cc-csc" placeholder="123" maxlength="4" type="password"')}
          </div>
        </div>
        <div class="actions">
          <button class="btn btn-ghost" id="back" type="button">← Back</button>
          <button class="btn btn-accent btn-lg" id="pay" type="button">Pay now</button>
        </div>
      </div>
    </div>
    <aside class="book-side" id="summary"></aside>
  </div>`);

  renderSummary(null);
  refreshQuote();

  const root = $('#modal-body');
  // light input formatting
  $('[data-field="payment.cardNumber"]', root).addEventListener('input', (e) => { e.target.value = e.target.value.replace(/\D/g, '').slice(0, 19).replace(/(.{4})/g, '$1 ').trim(); });
  $('[data-field="payment.expiry"]', root).addEventListener('input', (e) => {
    let v = e.target.value.replace(/\D/g, '').slice(0, 4);
    if (v.length >= 3) v = v.slice(0, 2) + '/' + v.slice(2);
    e.target.value = v;
  });
  $('[data-field="payment.cvv"]', root).addEventListener('input', (e) => { e.target.value = e.target.value.replace(/\D/g, '').slice(0, 4); });
  $('#apply-promo', root).addEventListener('click', applyPromo);
  $('[data-field="promoCode"]', root).addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); applyPromo(); } });
  $('#to-pay', root).addEventListener('click', () => { if (checkRequired($('#p1'))) goStep(2); });
  $('#back', root).addEventListener('click', () => goStep(1));
  $('#pay', root).addEventListener('click', pay);
}

function goStep(n) {
  $('#p1').hidden = n !== 1; $('#p2').hidden = n !== 2;
  $$('.stepper .s').forEach((el) => {
    const i = Number(el.dataset.s); el.classList.toggle('on', i === n); el.classList.toggle('done', i < n);
  });
  hideBanner(); $('#modal').scrollTo({ top: 0, behavior: 'smooth' });
}
function checkRequired(panel) {
  let okAll = true;
  $$('[data-field]', panel).forEach((el) => {
    if (el.dataset.field === 'promoCode') return;
    const empty = !el.value.trim();
    setFieldError(el.dataset.field, empty ? 'Required.' : '');
    if (empty) okAll = false;
  });
  if (!okAll) showBanner('Please fill in the highlighted fields.');
  else hideBanner();
  return okAll;
}
function setFieldError(name, msg) {
  const el = $(`[data-field="${name}"]`); if (!el) return false;
  el.classList.toggle('invalid', !!msg);
  const em = el.parentElement.querySelector('.err'); if (em) em.textContent = msg || '';
  return true;
}
const clearErrors = () => $$('[data-field]').forEach((el) => setFieldError(el.dataset.field, ''));
function showBanner(msg) { const b = $('#banner'); if (b) { b.textContent = msg; b.classList.add('show'); } }
function hideBanner() { const b = $('#banner'); if (b) b.classList.remove('show'); }

async function refreshQuote() {
  const s = state.search;
  const r = await api('POST', '/api/quote', { tripId: state.sel.id, date: s.date, cabin: s.cabin, passengers: s.passengers, promoCode: state.promo || undefined }).catch(() => null);
  if (r && r.ok) { state.lastQuote = r.json.data; renderSummary(r.json.data); return true; }
  if (r && r.status === 422 && r.json.error.details && r.json.error.details[0].field === 'promoCode') {
    setFieldError('promoCode', r.json.error.message); state.promo = null; return false;
  }
  if (r) showBanner(errText(r));
  return false;
}
async function applyPromo() {
  const input = $('[data-field="promoCode"]');
  const code = input.value.trim().toUpperCase();
  setFieldError('promoCode', '');
  if (!code) { state.promo = null; await refreshQuote(); return; }
  state.promo = code;
  const okQ = await refreshQuote();
  if (okQ && state.lastQuote.promo) toast(`Promo applied: ${state.lastQuote.promo.description}`, 'success');
  else if (!okQ) { await refreshQuote(); }
}

function renderSummary(q) {
  const t = state.sel, s = state.search;
  const lines = q ? `
    <div class="sum-lines">
      <div class="line"><span>${money(q.farePerPerson)} × ${q.passengers} traveller${q.passengers > 1 ? 's' : ''}</span><span>${money(q.subtotal)}</span></div>
      ${q.discount ? `<div class="line disc"><span>Promo ${esc(q.promo.code)}</span><span>−${money(q.discount)}</span></div>` : ''}
      <div class="line"><span>Taxes (12%)</span><span>${money(q.taxes)}</span></div>
      <div class="line"><span>Service fee</span><span>${money(q.fees)}</span></div>
      <div class="line total"><span>Total</span><span>${money(q.total)}</span></div>
    </div>` : '<div class="sum-lines"><div class="line"><span>Calculating price…</span></div></div>';
  $('#summary').innerHTML = `
    <div class="sum-route">${t.from.code} <span>✈</span> ${t.to.code}</div>
    <div class="sum-meta">${esc(t.from.city)} to ${esc(t.to.city)}<br>${longDate(s.date)} · ${esc(state.cabins[s.cabin])}<br>${t.departs} → ${t.arrives}${t.arrivalDayOffset ? ` (+${t.arrivalDayOffset})` : ''} · ${dur(t.durationMin)} · ${t.stops ? '1 stop' : 'Non-stop'}</div>
    ${lines}
    <div class="promo-tip">💡 Try <b>WELCOME10</b> for 10% off, or <b>FAMILY15</b> when travelling with 3 or more.</div>`;
}

async function pay() {
  clearErrors(); hideBanner();
  if (!checkRequired($('#p2'))) return;
  const s = state.search; const get = (n) => ($(`[data-field="${n}"]`) || {}).value || '';
  const body = {
    tripId: state.sel.id, date: s.date, cabin: s.cabin,
    promoCode: state.promo || undefined,
    contact: { email: get('contact.email').trim(), phone: get('contact.phone').trim() },
    passengers: Array.from({ length: s.passengers }, (_, i) => ({
      firstName: get(`passengers[${i}].firstName`), lastName: get(`passengers[${i}].lastName`),
      dob: get(`passengers[${i}].dob`), passport: get(`passengers[${i}].passport`),
    })),
    payment: { cardName: get('payment.cardName'), cardNumber: get('payment.cardNumber'), expiry: get('payment.expiry'), cvv: get('payment.cvv') },
  };
  const btn = $('#pay'); btn.disabled = true; btn.textContent = 'Processing…';
  let r;
  try { r = await api('POST', '/api/bookings', body); }
  catch { btn.disabled = false; btn.textContent = 'Pay now'; return showBanner('Network error. Please try again.'); }
  btn.disabled = false; btn.textContent = 'Pay now';

  if (r.status === 201) {
    const b = r.json.data;
    try { localStorage.setItem('voyago:last', JSON.stringify({ reference: b.reference, email: b.contact.email })); } catch { /* ignore */ }
    $('#modal-body').innerHTML = `<div class="ticket-wrap ticket-print">${ticketHTML(b, { fresh: true })}</div>`;
    $('#modal').scrollTop = 0;
    bindTicketActions(b);
    runSearch(false); // refresh seat counts
    return;
  }
  // Map server errors back onto the form
  const details = (r.json && r.json.error && r.json.error.details) || [];
  let step1 = false, unmatched = false;
  details.forEach((d) => {
    if (!setFieldError(d.field, d.message)) unmatched = true;
    else if (/^(passengers|contact|promoCode)/.test(d.field)) step1 = true;
  });
  showBanner(errText(r) + (r.status === 409 ? ' Please go back and pick another flight.' : ''));
  if (step1) goStep(1), showBanner(errText(r));
  if (r.status === 409) runSearch(false);
  if (unmatched && !details.length) toast(errText(r), 'error');
}

/* --------------------------------- Ticket -------------------------------- */
function barcode(ref) {
  let x = 0, bars = '';
  let h = 7; for (const c of ref) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  for (let i = 0; i < 42; i++) {
    h = (h * 1103515245 + 12345) >>> 0;
    const w = 1 + (h >>> 8) % 3;
    if (i % 2 === 0) bars += `<rect x="${x}" y="0" width="${w}" height="54" fill="#0f2a3d"/>`;
    x += w + 1;
  }
  return `<svg class="barcode" viewBox="0 0 ${x} 54" preserveAspectRatio="none" aria-label="Barcode">${bars}</svg>`;
}

function ticketHTML(b, { fresh = false, manage = false } = {}) {
  const t = b.trip, cancelled = b.status === 'cancelled';
  return `
    <div class="done-head ${cancelled ? 'cancelled' : ''}">
      <div class="tick">${cancelled ? '✕' : '✓'}</div>
      <h2>${cancelled ? 'Booking cancelled' : fresh ? 'You’re all set!' : 'Your booking'}</h2>
      <p class="muted">${cancelled ? 'This ticket is no longer valid.' : `A confirmation has been prepared for <b>${esc(b.contact.email)}</b>.`}</p>
    </div>
    <div class="ticket">
      <div class="t-main">
        <div class="brand-s">✈ Voyago · Boarding pass</div>
        <div class="t-route">
          <div><div class="code">${esc(t.from.code)}</div><div class="city">${esc(t.from.city)}</div></div>
          <div class="mid">${dur(t.durationMin)}<hr>${t.stops ? '1 stop' : 'Non-stop'}</div>
          <div style="text-align:right"><div class="code">${esc(t.to.code)}</div><div class="city">${esc(t.to.city)}</div></div>
        </div>
        <div class="t-grid">
          <div><small>Date</small><b>${longDate(b.date)}</b></div>
          <div><small>Departs</small><b>${t.departs}</b></div>
          <div><small>Arrives</small><b>${t.arrives}${t.arrivalDayOffset ? ` (+${t.arrivalDayOffset})` : ''}</b></div>
          <div><small>Flight</small><b>${esc(t.flightNo)}</b></div>
          <div><small>Airline</small><b>${esc(t.airline)}</b></div>
          <div><small>Cabin</small><b>${esc(state.cabins[b.cabin] || b.cabin)}</b></div>
        </div>
      </div>
      <div class="t-side">
        <small>Booking reference</small>
        <div class="ref">${esc(b.reference)}</div>
        ${barcode(b.reference)}
        <span class="status-chip ${cancelled ? 'cancelled' : ''}">${cancelled ? 'Cancelled' : 'Confirmed'}</span>
      </div>
    </div>
    <div class="pax-list">
      <div class="pax-row head"><span>Traveller</span><span>Passport / ID</span><span>Seat</span></div>
      ${b.passengers.map((p) => `<div class="pax-row"><span>${esc(p.firstName)} ${esc(p.lastName)}</span><span>${esc(p.passport)}</span><b>${esc(p.seat)}</b></div>`).join('')}
    </div>
    <div class="pay-note"><span>Paid with ${esc(b.payment.brand)} •••• ${esc(b.payment.last4)}</span><b>Total ${money(b.pricing.total)}</b></div>
    ${cancelled && b.refund ? `<div class="refund">Refund of ${money(b.refund.amount)} (${b.refund.percent}%) will return to your card in 5–7 working days.</div>` : ''}
    <div class="ticket-actions">
      ${cancelled ? '' : '<button class="btn" id="print">🖨 Print ticket</button>'}
      ${manage && !cancelled ? '<button class="btn btn-danger" id="cancel-booking">Cancel booking</button>' : ''}
      <button class="btn btn-ghost" data-close>Close</button>
    </div>`;
}
function bindTicketActions(b) {
  const p = $('#print'); if (p) p.addEventListener('click', () => window.print());
  const c = $('#cancel-booking');
  if (c) c.addEventListener('click', async () => {
    if (!confirm('Cancel this booking? Refund depends on how close departure is.')) return;
    c.disabled = true;
    const r = await api('DELETE', `/api/bookings/${encodeURIComponent(b.reference)}?email=${encodeURIComponent(b.contact.email)}`).catch(() => null);
    if (r && r.ok) {
      toast('Booking cancelled', 'success');
      $('#modal-body').innerHTML = `<div class="ticket-wrap ticket-print">${ticketHTML(r.json.data, { manage: true })}</div>`;
      bindTicketActions(r.json.data);
      runSearch(false);
    } else { c.disabled = false; toast(r ? errText(r) : 'Network error', 'error'); }
  });
}

/* ------------------------------ Manage booking --------------------------- */
function openManage() {
  let last = {};
  try { last = JSON.parse(localStorage.getItem('voyago:last') || '{}'); } catch { /* ignore */ }
  openModal(`
    <div class="manage">
      <h2 id="modal-title">Manage your booking</h2>
      <p class="muted">Enter the reference from your e-ticket and the email you booked with.</p>
      <div class="banner" id="banner"></div>
      <form id="manage-form" novalidate>
        ${field('Booking reference', 'reference', `placeholder="VG-ABC123" style="text-transform:uppercase" value="${esc(last.reference || '')}"`)}
        ${field('Email', 'email', `type="email" placeholder="you@example.com" value="${esc(last.email || '')}"`)}
        <button class="btn btn-lg btn-block" type="submit">Find my booking</button>
      </form>
    </div>`, true);
  $('#manage-form').addEventListener('submit', async (e) => {
    e.preventDefault(); clearErrors(); hideBanner();
    const ref = $('[data-field="reference"]').value.trim(), email = $('[data-field="email"]').value.trim();
    const r = await api('GET', `/api/bookings/${encodeURIComponent(ref || '-')}?email=${encodeURIComponent(email || '-')}`).catch(() => null);
    if (!r) return showBanner('Network error. Please try again.');
    if (r.ok) {
      const b = r.json.data;
      openModal(`<div class="ticket-wrap ticket-print">${ticketHTML(b, { manage: true })}</div>`);
      return bindTicketActions(b);
    }
    ((r.json && r.json.error && r.json.error.details) || []).forEach((d) => setFieldError(d.field, d.message));
    showBanner(errText(r));
  });
}
$('#open-manage').addEventListener('click', openManage);

init();
