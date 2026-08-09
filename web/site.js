/* Pricing calculator + quote submission for desmoslock.com */

const $ = (s) => document.querySelector(s)
const $$ = (s) => [...document.querySelectorAll(s)]

let term = 1

/* ─────────────────────────────────────────────────────── tier cards */

;(function renderTiers () {
  const el = $('#tiers')
  if (!el) return
  el.innerHTML = ''
  for (const t of PRICING.TIERS) {
    const card = document.createElement('div')
    card.className = 'tier'
    card.dataset.min = t.min
    card.innerHTML = `
      <div class="tier-name"></div>
      <div class="tier-price">${PRICING.money(t.price, true)}<small>/student/year</small></div>
      <div class="tier-blurb"></div>`
    card.querySelector('.tier-name').textContent = t.label
    card.querySelector('.tier-blurb').textContent = t.blurb
    el.appendChild(card)
  }
})()

/* ─────────────────────────────────────────────────────── calculator */

function renderTerms () {
  const el = $('#q-terms')
  if (!el) return
  el.innerHTML = ''
  for (const t of PRICING.TERMS) {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'term-pill' + (t.years === term ? ' on' : '')
    b.innerHTML = `<b></b>${t.note ? `<em>${t.note}</em>` : ''}`
    b.querySelector('b').textContent = t.label
    b.addEventListener('click', () => { term = t.years; renderTerms(); recalc() })
    el.appendChild(b)
  }
}

function recalc () {
  const students = Number($('#q-students').value) || 0
  const q = PRICING.quote(students, term)

  $('#o-tier').textContent = q.tier.label
  $('#o-annual').textContent = PRICING.money(q.annual)
  $('#o-seat').textContent = PRICING.money(q.perSeat, true)
  $('#o-students').textContent = PRICING.num(q.students)
  $('#o-contract').textContent = PRICING.money(q.contract) + (q.years > 1 ? ` over ${q.years} years` : '')

  const save = $('#o-save')
  if (q.saving > 0) {
    save.textContent = `Saves ${PRICING.money(q.saving)} against list price — ${q.savingPct}% off`
    save.classList.remove('hidden')
  } else {
    save.classList.add('hidden')
  }

  $$('.tier').forEach(c => c.classList.toggle('on', Number(c.dataset.min) === q.tier.min))

  // Keep the quote form in step with the calculator.
  if ($('#f-students')) $('#f-students').value = q.students
  if ($('#f-years')) $('#f-years').value = String(q.years)
  renderSummary()
}

function syncFromSlider () { $('#q-students').value = $('#q-slider').value; recalc() }
function syncToSlider () {
  const v = Math.min(20000, Math.max(50, Number($('#q-students').value) || 0))
  $('#q-slider').value = v
  recalc()
}

if ($('#q-students')) {
  renderTerms()
  $('#q-slider').addEventListener('input', syncFromSlider)
  $('#q-students').addEventListener('input', syncToSlider)
  recalc()
}

/* ────────────────────────────────────────────────────── quote form */

function renderSummary () {
  const el = $('#qf-summary')
  if (!el) return
  const q = PRICING.quote($('#f-students')?.value, $('#f-years')?.value)
  el.innerHTML = `
    <div class="qs-row"><span>${PRICING.num(q.students)} students · ${q.term.label} · ${q.tier.label}</span></div>
    <div class="qs-row big"><span>${PRICING.money(q.perSeat, true)} per student per year</span>
      <b>${PRICING.money(q.contract)}</b></div>
    <div class="qs-row dim"><span>${PRICING.money(q.annual)} a year${q.years > 1 ? ` × ${q.years} years` : ''}</span>
      ${q.saving > 0 ? `<span class="qs-save">−${PRICING.money(q.saving)}</span>` : ''}</div>`
}

;['#f-students', '#f-years'].forEach(sel => {
  const el = $(sel)
  if (el) el.addEventListener('input', renderSummary)
})
renderSummary()

$('#quote-form')?.addEventListener('submit', async (e) => {
  e.preventDefault()
  const err = $('#qf-error')
  const btn = $('#qf-submit')
  err.classList.add('hidden')

  const val = (id) => ($(id)?.value || '').trim()
  const required = { '#f-school': 'school or district name', '#f-name': 'your name', '#f-email': 'work email' }
  for (const [sel, label] of Object.entries(required)) {
    if (!val(sel)) {
      err.textContent = `Please add your ${label}.`
      err.classList.remove('hidden')
      $(sel).focus()
      return
    }
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(val('#f-email'))) {
    err.textContent = 'That email address does not look right.'
    err.classList.remove('hidden')
    $('#f-email').focus()
    return
  }

  const q = PRICING.quote(val('#f-students'), val('#f-years'))
  if (q.students < 1) {
    err.textContent = 'How many students will sit tests?'
    err.classList.remove('hidden')
    return
  }

  btn.disabled = true
  btn.textContent = 'Sending…'

  const payload = {
    school_name: val('#f-school'),
    contact_name: val('#f-name'),
    contact_email: val('#f-email'),
    contact_phone: val('#f-phone') || null,
    job_title: val('#f-title') || null,
    country: val('#f-country') || null,
    region: val('#f-region') || null,
    students: q.students,
    campuses: Number(val('#f-campuses')) || 1,
    term_years: q.years,
    start_date: val('#f-start') || null,
    price_per_seat: q.perSeat,
    annual_total: q.annual,
    contract_total: q.contract,
    hear_about: val('#f-hear') || null,
    notes: val('#f-notes') || null
  }

  try {
    const res = await fetch(CONFIG.supabaseUrl + '/rest/v1/quote_requests', {
      method: 'POST',
      headers: {
        apikey: CONFIG.supabaseKey,
        Authorization: 'Bearer ' + CONFIG.supabaseKey,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal'
      },
      body: JSON.stringify(payload)
    })
    if (!res.ok) throw new Error(`We could not send that (${res.status}). Email ${CONFIG.salesEmail} and we'll sort it out.`)

    $('#quote-form').classList.add('hidden')
    $('#qf-done-body').textContent =
      `We'll email ${payload.contact_email} a formal quote for ${PRICING.num(q.students)} students — ` +
      `${PRICING.money(q.perSeat, true)} per student per year, ${PRICING.money(q.contract)} over ${q.years === 1 ? 'the year' : `${q.years} years`}. ` +
      `Quotes are valid for 60 days and include PO details.`
    $('#qf-done').classList.remove('hidden')
    $('#qf-done').scrollIntoView({ behavior: 'smooth', block: 'center' })
  } catch (e2) {
    err.textContent = e2.message
    err.classList.remove('hidden')
  } finally {
    btn.disabled = false
    btn.textContent = 'Send quote request'
  }
})

// Carry the calculator's numbers into the form when someone clicks through.
$('#o-cta')?.addEventListener('click', () => {
  if ($('#f-students')) $('#f-students').value = Number($('#q-students').value) || 0
  if ($('#f-years')) $('#f-years').value = String(term)
  renderSummary()
})
