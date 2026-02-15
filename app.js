const SALA_CAPACITY = {
  'Renoir Princesa': { 1: 87, 2: 107, 3: 83, 4: 175, 5: 191, 6: 170, 7: 120, 8: 76, 9: 195, 10: 190, 11: 190 },
  'Renoir Plaza de España': { 1: 139, 2: 95, 3: 149, 4: 71, 5: 68 },
  'Golem Madrid': { 1: 74, 2: 193, 3: 64, 4: 115, 5: 157 },
}
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

const state = {
  allSessions: [],
  catalogMode: 'full',
  cinemaFilter: new Set(['Renoir Princesa', 'Renoir Plaza de España', 'Golem Madrid']),
  dayFilter: new Set(DAYS),
  bucketFilter: new Set(['morning', 'afternoon', 'evening']),
  durationRange: [0, 300],
  densityFilter: 'all',
  sortBy: 'soonest',
  langQuery: '',
  dateRange: ['', ''],
}

const toMinutes = (timeString) => {
  const [h, m] = (timeString || '').split(':').map(Number)
  return Number.isNaN(h) || Number.isNaN(m) ? null : h * 60 + m
}
const timeBucket = (min) => (min == null ? 'unknown' : min < 720 ? 'morning' : min < 1080 ? 'afternoon' : 'evening')
const duration = (raw) => {
  const m = String(raw || '').match(/\d+/)
  return m ? Number(m[0]) : null
}
const cleanTitle = (t = '') => t.replace(/\(.*?\)/g, '').trim().toUpperCase()

function parseCSV(text) {
  const rows = []
  let row = []
  let field = ''
  let inQuotes = false

  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    const next = text[i + 1]

    if (char === '"') {
      if (inQuotes && next === '"') {
        field += '"'
        i++
      } else {
        inQuotes = !inQuotes
      }
    } else if (char === ',' && !inQuotes) {
      row.push(field)
      field = ''
    } else if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && next === '\n') i++
      row.push(field)
      field = ''
      if (row.some((x) => x.length)) rows.push(row)
      row = []
    } else {
      field += char
    }
  }

  if (field.length || row.length) {
    row.push(field)
    if (row.some((x) => x.length)) rows.push(row)
  }

  const headers = rows.shift() || []
  return rows.map((r) => Object.fromEntries(headers.map((h, idx) => [h, r[idx] || ''])))
}

const normalizeRows = (csvText, source) => {
  const data = parseCSV(csvText)
  return data.map((row, i) => {
    const startMin = toMinutes(row.Horario)
    const d = duration(row['Duración'])
    const dateObj = row.Fecha ? new Date(`${row.Fecha}T00:00:00`) : null
    const sala = Number(row.Sala)
    const vose = /VOSE|V\.O\.S\.E/i.test(row.Pelicula || '')
    return {
      id: `${source}-${i}`,
      movieTitle: row.Pelicula || 'Unknown title',
      movieKey: cleanTitle(row.Pelicula || ''),
      date: row.Fecha,
      dateObj,
      dayOfWeek: dateObj?.getDay(),
      dayLabel: DAYS[dateObj?.getDay?.() ?? 0],
      time: row.Horario,
      startMin,
      endMin: startMin != null && d != null ? startMin + d : null,
      duration: d,
      cinema: row.Cine || source,
      room: sala,
      roomCapacity: SALA_CAPACITY[row.Cine]?.[sala] ?? null,
      director: row.Director || 'Unknown',
      synopsis: row.Sinopsis || 'No synopsis available.',
      posterUrl: row.Poster_URL || 'https://placehold.co/400x580?text=No+Poster',
      trailerUrl: row.Trailer_URL || '',
      filmUrl: row.Film_URL || row.Pelicula_URL || '',
      year: row.Estreno?.match(/\b(19|20)\d{2}\b/)?.[0] || null,
      originalLanguage: row.Idioma_Original || '',
      subtitles: vose ? 'Spanish subtitles (VOSE)' : '',
      languageTag: `${row.Idioma_Original || ''} ${vose ? 'VOSE' : ''}`.trim() || 'Unspecified',
      rating: row.Calificación || '',
      bucket: timeBucket(startMin),
    }
  })
}

const trimRecommended = (sessions) => sessions.filter((s) => s.dateObj && s.startMin != null && s.duration != null && s.endMin != null && [1, 2, 3, 4, 5].includes(s.dayOfWeek) && s.startMin <= 1200 && s.endMin < 1260 && (s.roomCapacity ?? 0) > 100)

function computeViewModel() {
  const workingSessions = state.catalogMode === 'recommended' ? trimRecommended(state.allSessions) : state.allSessions

  const movieStats = new Map()
  for (const s of workingSessions) movieStats.set(s.movieKey, (movieStats.get(s.movieKey) || 0) + 1)

  const filteredSessions = workingSessions.filter((s) =>
    state.cinemaFilter.has(s.cinema) && state.dayFilter.has(s.dayLabel) && state.bucketFilter.has(s.bucket) &&
    s.duration != null && s.duration >= state.durationRange[0] && s.duration <= state.durationRange[1] &&
    (!state.dateRange[0] || s.date >= state.dateRange[0]) && (!state.dateRange[1] || s.date <= state.dateRange[1]) &&
    `${s.languageTag} ${s.subtitles}`.toLowerCase().includes(state.langQuery.toLowerCase()) &&
    (state.densityFilter === 'all' || (state.densityFilter === 'single' ? movieStats.get(s.movieKey) === 1 : movieStats.get(s.movieKey) > 1))
  )

  const movieMap = new Map()
  filteredSessions.forEach((s) => {
    if (!movieMap.has(s.movieKey)) movieMap.set(s.movieKey, { ...s, sessions: [] })
    movieMap.get(s.movieKey).sessions.push(s)
  })
  const movieCards = [...movieMap.values()]
  movieCards.forEach((m) => m.sessions.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time)))

  const sorter = {
    soonest: (a, b) => (a.sessions[0]?.date + a.sessions[0]?.time).localeCompare(b.sessions[0]?.date + b.sessions[0]?.time),
    latest: (a, b) => (b.sessions.at(-1)?.date + b.sessions.at(-1)?.time).localeCompare(a.sessions.at(-1)?.date + a.sessions.at(-1)?.time),
    shortest: (a, b) => (a.duration ?? 999) - (b.duration ?? 999),
    sessions: (a, b) => b.sessions.length - a.sessions.length,
  }
  movieCards.sort(sorter[state.sortBy])

  const schedule = {}
  filteredSessions.forEach((s) => {
    schedule[s.date] ||= {}
    schedule[s.date][s.cinema] ||= []
    schedule[s.date][s.cinema].push(s)
  })

  return { filteredSessions, movieCards, schedule }
}

function chipList(items, set, key) {
  return items.map((item) => `<button class="chip ${set.has(item) ? 'active' : ''}" data-type="${key}" data-value="${item}">${item.length > 3 && key === 'day' ? item.slice(0, 3) : item}</button>`).join('')
}

function render() {
  const root = document.getElementById('root')
  const { filteredSessions, movieCards, schedule } = computeViewModel()

  root.innerHTML = `
  <div class="page">
    <header>
      <h1>Cinema Schedule Planner</h1>
      <p>Renoir + Golem visual explorer with cards, schedule view, and smart filters.</p>
    </header>
    <section class="panel controls">
      <div class="row two-col">
        <div><label>Catalog</label><select id="catalogMode"><option value="full">Full catalog</option><option value="recommended">Recommended / trimmed</option></select></div>
        <div><label>Sort by</label><select id="sortBy"><option value="soonest">Soonest screening</option><option value="latest">Latest screening</option><option value="shortest">Shortest duration</option><option value="sessions">Most total sessions</option></select></div>
      </div>
      <div class="row wrap"><label>Cinema</label>${chipList(['Renoir Princesa', 'Renoir Plaza de España', 'Golem Madrid'], state.cinemaFilter, 'cinema')}</div>
      <div class="row wrap"><label>Day of week</label>${chipList(DAYS, state.dayFilter, 'day')}</div>
      <div class="row wrap"><label>Time of day</label>${chipList(['morning', 'afternoon', 'evening'], state.bucketFilter, 'bucket')}</div>
      <div class="row two-col">
        <div><label>Date from</label><input id="dateFrom" type="date" value="${state.dateRange[0] || ''}" /></div>
        <div><label>Date to</label><input id="dateTo" type="date" value="${state.dateRange[1] || ''}" /></div>
      </div>
      <div class="row two-col">
        <div><label>Duration min</label><input id="durMin" type="number" min="0" max="300" value="${state.durationRange[0]}"/></div>
        <div><label>Duration max</label><input id="durMax" type="number" min="0" max="300" value="${state.durationRange[1]}"/></div>
      </div>
      <div class="row two-col">
        <div><label>Language / subtitles</label><input id="langQuery" value="${state.langQuery}" placeholder="francés, VOSE..."/></div>
        <div><label>Availability density</label><select id="densityFilter"><option value="all">All</option><option value="single">One-off</option><option value="multiple">Multiple sessions</option></select></div>
      </div>
      <div class="stats">Showing ${movieCards.length} films / ${filteredSessions.length} sessions</div>
    </section>
    <section><h2>Film catalog</h2><div class="cards">
      ${movieCards.map((m) => `<article class="card panel"><img src="${m.posterUrl}" alt="${m.movieTitle}"/><div class="content"><h3>${m.movieTitle}</h3><p class="meta">${m.director} • ${m.year || 'Year n/a'} • ${m.duration || 'n/a'} min • ${m.sessions.length} sessions</p><p>${m.synopsis}</p><div class="tags"><span>${m.cinema}</span><span>${m.originalLanguage || 'Language n/a'}</span>${m.subtitles ? `<span>${m.subtitles}</span>` : ''}${m.rating ? `<span>${m.rating}</span>` : ''}</div><div class="links">${m.trailerUrl ? `<a href="${m.trailerUrl}" target="_blank" rel="noreferrer">Trailer</a>` : ''}${m.filmUrl ? `<a href="${m.filmUrl}" target="_blank" rel="noreferrer">Details</a>` : ''}</div></div></article>`).join('')}
    </div></section>
    <section><h2>Schedule view (by day / cinema)</h2><div class="schedule-grid">
      ${Object.entries(schedule).sort(([a], [b]) => a.localeCompare(b)).map(([date, cinemas]) => `<div class="panel day-block"><h3>${date}</h3>${Object.entries(cinemas).map(([name, sessions]) => `<div class="cinema-block"><h4>${name}</h4><ul>${sessions.sort((a, b) => a.startMin - b.startMin).map((s) => `<li><strong>${s.time}</strong> — ${s.movieTitle} <span>Sala ${s.room || 'n/a'}</span></li>`).join('')}</ul></div>`).join('')}</div>`).join('')}
    </div></section>
  </div>`

  document.getElementById('catalogMode').value = state.catalogMode
  document.getElementById('sortBy').value = state.sortBy
  document.getElementById('densityFilter').value = state.densityFilter

  bindEvents()
}

function bindEvents() {
  document.querySelectorAll('[data-type]').forEach((el) => {
    el.addEventListener('click', () => {
      const { type, value } = el.dataset
      const target = type === 'cinema' ? state.cinemaFilter : type === 'day' ? state.dayFilter : state.bucketFilter
      target.has(value) ? target.delete(value) : target.add(value)
      render()
    })
  })

  document.getElementById('catalogMode').onchange = (e) => { state.catalogMode = e.target.value; render() }
  document.getElementById('sortBy').onchange = (e) => { state.sortBy = e.target.value; render() }
  document.getElementById('densityFilter').onchange = (e) => { state.densityFilter = e.target.value; render() }
  document.getElementById('dateFrom').onchange = (e) => { state.dateRange[0] = e.target.value; render() }
  document.getElementById('dateTo').onchange = (e) => { state.dateRange[1] = e.target.value; render() }
  document.getElementById('durMin').onchange = (e) => { state.durationRange[0] = Number(e.target.value); render() }
  document.getElementById('durMax').onchange = (e) => { state.durationRange[1] = Number(e.target.value); render() }
  document.getElementById('langQuery').oninput = (e) => { state.langQuery = e.target.value; render() }
}

async function init() {
  const [renoirCsv, golemCsv] = await Promise.all([
    fetch('./_1_data/cines_renoir_2026-02-15_21-03.csv').then((r) => r.text()),
    fetch('./_1_data/cines_golem_2026-02-16_00-24.csv').then((r) => r.text()),
  ])
  state.allSessions = [...normalizeRows(renoirCsv, 'Renoir'), ...normalizeRows(golemCsv, 'Golem')]
  const dates = state.allSessions.map((s) => s.date).filter(Boolean).sort()
  state.dateRange = [dates[0], dates.at(-1)]
  render()
}

init().catch((error) => {
  console.error(error)
  document.getElementById('root').innerHTML = `<div class="page"><div class="panel controls"><h2>Unable to load data</h2><p>${error.message}</p></div></div>`
})
