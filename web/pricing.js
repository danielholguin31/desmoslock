/* DesmosLock pricing — one source of truth for the website, the quote form and
   the admin console. $8 per student per year is the list price; districts get
   volume and multi-year discounts off it.

   "Student" means a distinct student who sits at least one test in the licence
   year, not a device and not a login. A student who sits nine tests is one seat. */

const PRICING = (() => {
  const LIST = 8.00

  const TIERS = [
    { min: 1,    max: 999,  price: 8.00, label: 'Single school',   blurb: 'Up to 999 students' },
    { min: 1000, max: 4999, price: 7.00, label: 'Multi-school',    blurb: '1,000 – 4,999 students' },
    { min: 5000, max: null, price: 6.00, label: 'District',        blurb: '5,000+ students' }
  ]

  const TERMS = [
    { years: 1, discount: 0,    label: '1 year' },
    { years: 2, discount: 0.05, label: '2 years', note: 'save 5%' },
    { years: 3, discount: 0.10, label: '3 years', note: 'save 10%' }
  ]

  const round2 = (n) => Math.round(n * 100) / 100

  function tierFor (students) {
    const n = Math.max(1, Number(students) || 0)
    return TIERS.slice().reverse().find(t => n >= t.min) || TIERS[0]
  }

  function quote (students, years = 1) {
    const n = Math.max(0, Math.floor(Number(students) || 0))
    const term = TERMS.find(t => t.years === Number(years)) || TERMS[0]
    const tier = tierFor(n)

    const perSeat = round2(tier.price * (1 - term.discount))
    const annual = round2(perSeat * n)
    const contract = round2(annual * term.years)
    const listContract = round2(LIST * n * term.years)

    return {
      students: n,
      years: term.years,
      tier,
      term,
      listPerSeat: LIST,
      perSeat,
      annual,
      contract,
      saving: round2(listContract - contract),
      savingPct: listContract > 0 ? Math.round(((listContract - contract) / listContract) * 100) : 0
    }
  }

  const money = (n, cents = false) =>
    '$' + Number(n).toLocaleString('en-US', {
      minimumFractionDigits: cents ? 2 : 0,
      maximumFractionDigits: cents ? 2 : 0
    })

  const num = (n) => Number(n).toLocaleString('en-US')

  return { LIST, TIERS, TERMS, tierFor, quote, money, num }
})()

if (typeof module !== 'undefined') module.exports = PRICING
