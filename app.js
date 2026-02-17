const SALA_CAPACITY = {
  'Renoir Princesa': { 1: 87, 2: 107, 3: 83, 4: 175, 5: 191, 6: 170, 7: 120, 8: 76, 9: 195, 10: 190, 11: 190 },
  'Renoir Plaza de España': { 1: 139, 2: 95, 3: 149, 4: 71, 5: 68 },
  'Golem Madrid': { 1: 74, 2: 193, 3: 64, 4: 115, 5: 157 },
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const DAY_CHIPS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
const MONTHS_ES = {
  enero: 0, febrero: 1, marzo: 2, abril: 3, mayo: 4, junio: 5,
  julio: 6, agosto: 7, septiembre: 8, setiembre: 8, octubre: 9, noviembre: 10, diciembre: 11,
}


const SEATMAP_API_BASE = (() => {
  const configured = typeof window !== 'undefined' ? window.SEATMAP_API_BASE : ''
  if (configured) return String(configured).replace(/\/$/, '')

  if (typeof window !== 'undefined' && ['http:', 'https:'].includes(window.location.protocol)) {
    return window.location.origin.replace(/\/$/, '')
  }

  return 'http://127.0.0.1:8765'
})()

const UPCOMING_DEFAULT_MONTHS = 2
const UPCOMING_API_URL = `${SEATMAP_API_BASE}/api/upcoming-releases`

function buildSeatMapApiUrl(ticketUrl) {
  const encodedTicket = encodeURIComponent(ticketUrl)
  if (/^https?:\/\//i.test(SEATMAP_API_BASE)) {
    return `${SEATMAP_API_BASE}/api/seatmap?ticket_url=${encodedTicket}`
  }
  return `/api/seatmap?ticket_url=${encodedTicket}`
}

const state = {
  allSessions: [],
  catalogMode: 'full',
  mainView: 'catalog',
  sidebarHidden: false,
  favoritesOnly: false,
  cinemaFilter: new Set(['Renoir Princesa', 'Renoir Plaza de España', 'Golem Madrid']),
  dayFilter: new Set(DAYS),
  durationRange: [0, 300],
  densityFilter: 'all',
  releaseFilter: 'all',
  sortBy: 'soonest',
  langQuery: '',
  dateRange: ['', ''],
  favorites: new Set(),
  modalMovieKey: null,
  loadWarnings: [],
  seatMapModal: {
    open: false,
    loading: false,
    error: '',
    data: null,
    sessionId: null,
  },
  upcomingRows: [],
  upcomingFavorites: new Set(),
  collapsedUpcomingDates: new Set(),
  upcomingFilters: {
    dateFrom: '',
    dateTo: '',
    genre: 'all',
    country: 'all',
    minRating: 0,
    minVotes: 0,
    runtimeMin: 0,
    runtimeMax: 240,
    theatersOnly: false,
    favoritesOnly: false,
    sortBy: 'rating_desc',
  },
}

const toMinutes = (timeString) => {
  const [h, m] = (timeString || '').split(':').map(Number)
  return Number.isNaN(h) || Number.isNaN(m) ? null : h * 60 + m
}
const duration = (raw) => {
  const match = String(raw || '').match(/\d+/)
  return match ? Number(match[0]) : null
}
const cleanTitle = (title = '') => title.replace(/\(.*?\)/g, '').trim().toUpperCase()
const slugify = (v = '') => v.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

function formatMinutesAsTime(totalMinutes) {
  if (totalMinutes == null) return 'n/a'
  const dayMinutes = ((totalMinutes % 1440) + 1440) % 1440
  const hours = String(Math.floor(dayMinutes / 60)).padStart(2, '0')
  const mins = String(dayMinutes % 60).padStart(2, '0')
  return `${hours}:${mins}`
}

function sessionTooltip(s) {
  const seats = s.roomCapacity ? `${s.roomCapacity} seats` : 'Seat count unavailable'
  const end = s.startMin != null && s.duration != null ? formatMinutesAsTime(s.startMin + s.duration) : 'n/a'
  return `${seats} • Ends at ${end}`
}

function parseSpanishEstreno(value) {
  if (!value) return null
  const normalized = String(value).trim().toLowerCase()
  const match = normalized.match(/(?:lunes|martes|miércoles|miercoles|jueves|viernes|sábado|sabado|domingo)?\s*(\d{1,2})\s+([a-záéíóúñ]+)\s+(\d{4})/i)
  if (!match) return null
  const day = Number(match[1])
  const monthName = match[2].normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  const year = Number(match[3])
  const monthIndex = MONTHS_ES[monthName]
  if (monthIndex == null) return null
  return new Date(Date.UTC(year, monthIndex, day))
}

function computeWeeksSinceRelease(estrenoDate) {
  if (!estrenoDate) return null
  const now = new Date()
  const nowUTC = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  const relUTC = Date.UTC(estrenoDate.getUTCFullYear(), estrenoDate.getUTCMonth(), estrenoDate.getUTCDate())
  const diffDays = Math.floor((nowUTC - relUTC) / 86400000)
  return diffDays < 0 ? 0 : Math.floor(diffDays / 7)
}

function weekLabel(weeks) {
  if (weeks == null) return 'Release date unavailable'
  if (weeks === 0) return 'Premiere week'
  if (weeks === 1) return 'Week 2 in theaters'
  return `Week ${weeks + 1} in theaters`
}

function releaseBucket(weeks) {
  if (weeks == null) return 'unknown'
  if (weeks === 0) return 'this_week'
  if (weeks <= 2) return 'le2'
  if (weeks <= 4) return 'le4'
  return 'long_running'
}

function isoDate(dateObj) {
  return dateObj.toISOString().slice(0, 10)
}

function addMonths(baseDate, months) {
  const d = new Date(baseDate)
  d.setMonth(d.getMonth() + months)
  return d
}

function parseJsonArray(value) {
  if (Array.isArray(value)) return value
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function normalizeUpcomingRows(rows) {
  return rows.map((row, idx) => ({
    id: `${row.movie_id || 'movie'}-${row.release_date || 'date'}-${idx}`,
    upcomingKey: `${row.movie_id || ''}|${row.release_date || ''}`,
    movieId: String(row.movie_id || ''),
    releaseDate: row.release_date || '',
    title: row.title || 'Unknown title',
    filmaffinityUrl: row.filmaffinity_url || '',
    posterUrl: row.poster_url || 'https://placehold.co/360x540?text=No+Poster',
    durationMin: Number.isFinite(Number(row.duration_min)) ? Number(row.duration_min) : null,
    year: Number.isFinite(Number(row.year)) ? Number(row.year) : null,
    countryCode: (row.country_code || '').toUpperCase(),
    genres: parseJsonArray(row.genres),
    synopsisShort: row.synopsis_short || '',
    director: parseJsonArray(row.director),
    castTop: parseJsonArray(row.cast_top),
    ratingAvg: Number.isFinite(Number(row.rating_avg)) ? Number(row.rating_avg) : null,
    ratingCount: Number.isFinite(Number(row.rating_count)) ? Number(row.rating_count) : null,
    theatersCount: Number.isFinite(Number(row.theaters_count)) ? Number(row.theaters_count) : null,
    theatersUrl: row.theaters_url || '',
    trailerAvailable: Boolean(row.trailer_available),
    scrapedAt: row.scraped_at || '',
  }))
}

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
        i += 1
      } else {
        inQuotes = !inQuotes
      }
    } else if (char === ',' && !inQuotes) {
      row.push(field); field = ''
    } else if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && next === '\n') i += 1
      row.push(field); field = ''
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

function normalizeRows(csvText, source) {
  return parseCSV(csvText).map((row, idx) => {
    const startMin = toMinutes(row.Horario)
    const runTime = duration(row['Duración'])
    const dateObj = row.Fecha ? new Date(`${row.Fecha}T00:00:00`) : null
    const estrenoDate = parseSpanishEstreno(row.Estreno)
    const weeksSinceRelease = computeWeeksSinceRelease(estrenoDate)
    const sala = Number(row.Sala)
    const isVose = /VOSE|V\.O\.S\.E/i.test(row.Pelicula || '')

    return {
      id: `${source}-${idx}`,
      movieTitle: row.Pelicula || 'Unknown title',
      movieKey: cleanTitle(row.Pelicula || ''),
      anchorId: `movie-${slugify(cleanTitle(row.Pelicula || ''))}`,
      date: row.Fecha,
      dateObj,
      dayOfWeek: dateObj?.getDay(),
      dayLabel: dateObj ? DAYS[dateObj.getDay()] : 'Unknown',
      time: row.Horario,
      startMin,
      endMin: startMin != null && runTime != null ? startMin + runTime : null,
      duration: runTime,
      cinema: row.Cine || source,
      room: sala,
      roomCapacity: SALA_CAPACITY[row.Cine]?.[sala] ?? null,
      director: row.Director || 'Unknown',
      synopsis: row.Sinopsis || 'No synopsis available.',
      posterUrl: row.Poster_URL || 'https://placehold.co/360x540?text=No+Poster',
      trailerUrl: row.Trailer_URL || '',
      filmUrl: row.Film_URL || row.Pelicula_URL || '',
      ticketUrl: row.Tickets_URL || row.Ticket_URL || row.Pillalas_URL || '',
      year: row.Estreno?.match(/\b(19|20)\d{2}\b/)?.[0] || null,
      originalLanguage: row.Idioma_Original || '',
      subtitles: isVose ? 'Spanish subtitles (VOSE)' : '',
      languageTag: `${row.Idioma_Original || ''} ${isVose ? 'VOSE' : ''}`.trim() || 'Unspecified',
      rating: row.Calificación || '',
      estrenoDate,
      weeksSinceRelease,
      releaseCategory: releaseBucket(weeksSinceRelease),
    }
  })
}

const trimRecommended = (sessions) => sessions.filter((s) => {
  if (!s.dateObj || s.startMin == null || s.duration == null || s.endMin == null) return false
  const isWeekday = [1, 2, 3, 4].includes(s.dayOfWeek)
  const isFriday = s.dayOfWeek === 5
  const hasCapacity = (s.roomCapacity ?? 0) > 100
  if (!hasCapacity || (!isWeekday && !isFriday)) return false

  if (isFriday) return true
  return s.startMin <= 1200 && s.endMin < 1260
})

function saveFavorites() {
  localStorage.setItem('cinema-favorites-v1', JSON.stringify([...state.favorites]))
}

function loadFavorites() {
  try {
    const raw = localStorage.getItem('cinema-favorites-v1')
    if (!raw) return
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) state.favorites = new Set(parsed)
  } catch { state.favorites = new Set() }
}


function saveUpcomingFavorites() {
  localStorage.setItem('cinema-upcoming-favorites-v1', JSON.stringify([...state.upcomingFavorites]))
}

function loadUpcomingFavorites() {
  try {
    const raw = localStorage.getItem('cinema-upcoming-favorites-v1')
    if (!raw) return
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) state.upcomingFavorites = new Set(parsed)
  } catch { state.upcomingFavorites = new Set() }
}

function moviePassesReleaseFilter(movie) {
  if (state.releaseFilter === 'all') return true
  if (state.releaseFilter === 'unknown') return movie.releaseCategory === 'unknown'
  return movie.releaseCategory === state.releaseFilter
}

function computeViewModel() {
  const recommendedSessions = trimRecommended(state.allSessions)
  const recommendedIds = new Set(recommendedSessions.map((s) => s.id))
  const catalogModes = {
    full: state.allSessions,
    recommended: recommendedSessions,
    unrecommended: state.allSessions.filter((s) => !recommendedIds.has(s.id)),
  }
  const workingSessions = catalogModes[state.catalogMode] || state.allSessions
  const movieStats = new Map()
  workingSessions.forEach((s) => movieStats.set(s.movieKey, (movieStats.get(s.movieKey) || 0) + 1))

  const filteredSessions = workingSessions.filter((s) => (
    state.cinemaFilter.has(s.cinema)
    && state.dayFilter.has(s.dayLabel)
    && s.duration != null && s.duration >= state.durationRange[0] && s.duration <= state.durationRange[1]
    && (!state.dateRange[0] || s.date >= state.dateRange[0])
    && (!state.dateRange[1] || s.date <= state.dateRange[1])
    && `${s.languageTag} ${s.subtitles}`.toLowerCase().includes(state.langQuery.toLowerCase())
    && (!state.favoritesOnly || state.favorites.has(s.movieKey))
    && (state.densityFilter === 'all' || (state.densityFilter === 'single' ? movieStats.get(s.movieKey) === 1 : movieStats.get(s.movieKey) > 1))
  ))

  const movieMap = new Map()
  filteredSessions.forEach((s) => {
    if (!movieMap.has(s.movieKey)) movieMap.set(s.movieKey, { ...s, sessions: [] })
    movieMap.get(s.movieKey).sessions.push(s)
  })

  const movieCards = [...movieMap.values()].filter(moviePassesReleaseFilter)
  movieCards.forEach((m) => m.sessions.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time)))

  const validMovieKeys = new Set(movieCards.map((m) => m.movieKey))
  const scheduleSessions = filteredSessions.filter((s) => validMovieKeys.has(s.movieKey))

  const sorters = {
    soonest: (a, b) => (a.sessions[0]?.date + a.sessions[0]?.time).localeCompare(b.sessions[0]?.date + b.sessions[0]?.time),
    latest: (a, b) => (b.sessions.at(-1)?.date + b.sessions.at(-1)?.time).localeCompare(a.sessions.at(-1)?.date + a.sessions.at(-1)?.time),
    shortest: (a, b) => (a.duration ?? 999) - (b.duration ?? 999),
    sessions: (a, b) => b.sessions.length - a.sessions.length,
    newest_release: (a, b) => (a.weeksSinceRelease ?? 999) - (b.weeksSinceRelease ?? 999),
    oldest_release: (a, b) => (b.weeksSinceRelease ?? -1) - (a.weeksSinceRelease ?? -1),
  }
  movieCards.sort(sorters[state.sortBy] || sorters.soonest)

  const scheduleByDayHour = {}
  scheduleSessions.forEach((s) => {
    scheduleByDayHour[s.date] ||= {}
    const hourKey = `${String(Math.floor((s.startMin ?? 0) / 60)).padStart(2, '0')}:00`
    scheduleByDayHour[s.date][hourKey] ||= []
    scheduleByDayHour[s.date][hourKey].push(s)
  })
  Object.values(scheduleByDayHour).forEach((hours) => {
    Object.values(hours).forEach((list) => list.sort((a, b) => (a.startMin ?? 0) - (b.startMin ?? 0)))
  })

  return {
    movieCards,
    scheduleByDayHour,
    favoritesCount: movieCards.filter((m) => state.favorites.has(m.movieKey)).length,
    modalMovie: state.modalMovieKey ? movieCards.find((m) => m.movieKey === state.modalMovieKey) : null,
  }
}

function computeUpcomingViewModel() {
  const f = state.upcomingFilters
  const genres = new Set()
  const countries = new Set()

  state.upcomingRows.forEach((row) => {
    row.genres.forEach((g) => genres.add(g))
    if (row.countryCode) countries.add(row.countryCode)
  })

  const filtered = state.upcomingRows.filter((row) => (
    (!f.dateFrom || row.releaseDate >= f.dateFrom)
    && (!f.dateTo || row.releaseDate <= f.dateTo)
    && (f.genre === 'all' || row.genres.includes(f.genre))
    && (f.country === 'all' || row.countryCode === f.country)
    && (row.durationMin == null || (row.durationMin >= f.runtimeMin && row.durationMin <= f.runtimeMax))
    && ((row.ratingAvg ?? 0) >= f.minRating)
    && ((row.ratingCount ?? 0) >= f.minVotes)
    && (!f.theatersOnly || (row.theatersCount ?? 0) > 0)
    && (!f.favoritesOnly || state.upcomingFavorites.has(row.upcomingKey))
  ))

  const sorters = {
    rating_desc: (a, b) => ((b.ratingAvg ?? -1) - (a.ratingAvg ?? -1)) || a.title.localeCompare(b.title),
    rating_asc: (a, b) => ((a.ratingAvg ?? 999) - (b.ratingAvg ?? 999)) || a.title.localeCompare(b.title),
    title_asc: (a, b) => a.title.localeCompare(b.title),
    title_desc: (a, b) => b.title.localeCompare(a.title),
  }

  const grouped = {}
  filtered.forEach((row) => {
    grouped[row.releaseDate] ||= []
    grouped[row.releaseDate].push(row)
  })

  Object.values(grouped).forEach((list) => list.sort(sorters[f.sortBy] || sorters.rating_desc))

  return {
    groupedRows: Object.entries(grouped).sort(([a], [b]) => a.localeCompare(b)),
    availableGenres: [...genres].sort((a, b) => a.localeCompare(b)),
    availableCountries: [...countries].sort((a, b) => a.localeCompare(b)),
    totalCount: filtered.length,
  }
}

function chipList(items, set, key, labelTransform = (v) => v) {
  return items.map((item) => `<button class="chip ${set.has(item) ? 'active' : ''}" data-type="${key}" data-value="${item}">${labelTransform(item)}</button>`).join('')
}

function groupSessionsByDay(sessions) {
  const map = {}
  sessions.forEach((s) => { map[s.date] ||= []; map[s.date].push(s) })
  Object.values(map).forEach((arr) => arr.sort((a, b) => (a.startMin ?? 0) - (b.startMin ?? 0)))
  return map
}

function seatTypeLabel(type) {
  return {
    normal: 'Available',
    vendida: 'Sold',
    minusvalido: 'PMR',
    noactiva: 'Not available',
  }[type] || type
}

function seatTypeClass(type) {
  return `seat-dot ${type || 'unknown'}`
}

function renderSeatMapModal() {
  if (!state.seatMapModal.open) return ''
  const { loading, error, data } = state.seatMapModal

  const totals = data?.totals || {}
  const seats = data?.seats || []
  const seatGrid = seats.length ? `
    <div class="seat-grid-wrap">
      <div class="seat-grid" style="--seat-cols:${Math.max(...seats.map((s) => s.column || 1))};--seat-rows:${Math.max(...seats.map((s) => s.row || 1))};">
        ${seats.map((seat) => `<span
          class="${seatTypeClass(seat.type)}"
          style="grid-column:${seat.column || 1};grid-row:${seat.row || 1};"
          title="${seat.label || `Row ${seat.row || '?'} · Seat ${seat.column || '?'}`} (${seatTypeLabel(seat.type)})"
        ></span>`).join('')}
      </div>
    </div>
  ` : '<p>No seat positions found for this session.</p>'

  return `
    <div class="modal-backdrop" id="seatMapBackdrop">
      <div class="modal-shell panel seatmap-shell" role="dialog" aria-modal="true" aria-label="Session seat map">
        <div class="modal-head">
          <h3>Tickets / Seats</h3>
          <button id="closeSeatMap" class="icon-btn" title="Close">✕</button>
        </div>
        <div class="modal-content seatmap-content">
          ${loading ? '<p>Loading live seat map from Pillalas…</p>' : ''}
          ${error ? `<p class="seatmap-error">${error}</p>` : ''}
          ${!loading && !error && data ? `
            <section class="seatmap-summary panel">
              <div><strong>${totals.available_normal ?? 0}</strong><span>Available</span></div>
              <div><strong>${totals.sold_vendida ?? 0}</strong><span>Sold</span></div>
              <div><strong>${totals.pmr_minusvalido ?? 0}</strong><span>PMR</span></div>
              <div><strong>${totals.unavailable_noactiva ?? 0}</strong><span>Not available</span></div>
              <div><strong>${totals.total_seats ?? 0}</strong><span>Total</span></div>
            </section>
            ${seatGrid}
            <div class="seat-legend">
              <span><i class="seat-dot normal"></i>Available</span>
              <span><i class="seat-dot vendida"></i>Sold</span>
              <span><i class="seat-dot minusvalido"></i>PMR</span>
              <span><i class="seat-dot noactiva"></i>Not available</span>
            </div>
            ${data.ticket_url ? `<p><a href="${data.ticket_url}" target="_blank" rel="noreferrer">Open ticket page</a></p>` : ''}
          ` : ''}
        </div>
      </div>
    </div>
  `
}

async function openSeatMap(sessionId) {
  const session = state.allSessions.find((s) => s.id === sessionId)
  if (!session || !session.ticketUrl) {
    state.seatMapModal = { open: true, loading: false, error: 'This session has no ticket URL.', data: null, sessionId }
    render()
    return
  }

  state.seatMapModal = { open: true, loading: true, error: '', data: null, sessionId }
  render()
  try {
    const response = await fetch(buildSeatMapApiUrl(session.ticketUrl))
    const payload = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(payload.error || `Seat map service error (${response.status}).`)
    state.seatMapModal = { open: true, loading: false, error: '', data: payload, sessionId }
  } catch (error) {
    state.seatMapModal = {
      open: true,
      loading: false,
      error: `Unable to load seat map. Make sure the seat-map API is reachable at ${SEATMAP_API_BASE}/api/seatmap (or set window.SEATMAP_API_BASE). (${error.message})`,
      data: null,
      sessionId,
    }
  }
  render()
}

function cinemaTag(cinema) {
  if (cinema.includes('Golem')) return 'tag golem'
  return cinema.includes('Plaza') ? 'tag plaza' : 'tag renoir'
}

function renderMovieBody(m, asModal = false) {
  const grouped = groupSessionsByDay(m.sessions)
  const uniqueCinemas = [...new Set(m.sessions.map((s) => s.cinema))]
  const capacities = m.sessions.map((s) => s.roomCapacity).filter((v) => Number.isFinite(v))
  const avgCapacity = capacities.length ? Math.round(capacities.reduce((acc, cur) => acc + cur, 0) / capacities.length) : null
  const firstSession = m.sessions[0]
  const lastSession = m.sessions.at(-1)
  return `
    <article class="card panel ${state.favorites.has(m.movieKey) ? 'favorite' : ''} ${asModal ? 'modal-card' : ''}" id="${m.anchorId}">
      <div class="poster-wrap"><img src="${m.posterUrl}" alt="${m.movieTitle}" /></div>
      <div class="content">
        <div class="card-top">
          <h3>${m.movieTitle}</h3>
          <button class="favorite-btn ${state.favorites.has(m.movieKey) ? 'is-favorite' : ''}" data-favorite="${m.movieKey}" title="Toggle favorite">★</button>
        </div>
        <p class="meta">${m.director} • ${m.year || 'Year n/a'} • ${m.duration || 'n/a'} min • ${m.sessions.length} sessions</p>
        <p class="release-pill">${weekLabel(m.weeksSinceRelease)}</p>
        <p>${m.synopsis}</p>
        <div class="tags">
          <span class="${cinemaTag(m.cinema)}">${m.cinema}</span>
          <span>${m.originalLanguage || 'Language n/a'}</span>
          ${m.subtitles ? `<span>${m.subtitles}</span>` : ''}
          ${m.rating ? `<span>${m.rating}</span>` : ''}
        </div>
        <div class="links">
          ${m.trailerUrl ? `<a href="${m.trailerUrl}" target="_blank" rel="noreferrer">Trailer</a>` : ''}
          ${m.filmUrl ? `<a href="${m.filmUrl}" target="_blank" rel="noreferrer">Details</a>` : ''}
        </div>
        ${asModal ? `
          <section class="modal-metadata panel">
            <h4>At a glance</h4>
            <dl>
              <div><dt>Release week</dt><dd>${weekLabel(m.weeksSinceRelease)}</dd></div>
              <div><dt>Language / subs</dt><dd>${m.originalLanguage || 'n/a'}${m.subtitles ? ` · ${m.subtitles}` : ''}</dd></div>
              <div><dt>Awards / buzz</dt><dd>${m.rating || 'Not listed'}</dd></div>
              <div><dt>Session span</dt><dd>${firstSession ? `${firstSession.date} ${firstSession.time}` : 'n/a'} → ${lastSession ? `${lastSession.date} ${lastSession.time}` : 'n/a'}</dd></div>
              <div><dt>Cinemas</dt><dd>${uniqueCinemas.join(' • ') || 'n/a'}</dd></div>
              <div><dt>Avg. seats / room</dt><dd>${avgCapacity ?? 'n/a'} seats</dd></div>
            </dl>
          </section>
        ` : ''}
        <details class="sessions-expand" ${asModal ? 'open' : ''}>
          <summary>Upcoming sessions (${m.sessions.length})</summary>
          ${Object.entries(grouped).sort(([a], [b]) => a.localeCompare(b)).map(([date, list]) => `
            <div class="session-day-group">
              <h5>${date}</h5>
              <ul>${list.map((s) => `<li title="${sessionTooltip(s)}"><strong>${s.time}</strong><span class="${cinemaTag(s.cinema)}">${s.cinema}</span><span>Sala ${s.room || 'n/a'}</span><button class="seatmap-btn" data-seatmap="${s.id}" ${s.ticketUrl ? '' : 'disabled'}>Tickets / Seats</button></li>`).join('')}</ul>
            </div>
          `).join('')}
        </details>
      </div>
    </article>
  `
}

function renderCatalog(movieCards) {
  if (!movieCards.length) return '<div class="empty panel"><h3>No movies match the current filters.</h3><p>Try widening date, release, or language filters.</p></div>'
  return `<section><h2>Film Catalog</h2><div class="cards">${movieCards.map((m) => renderMovieBody(m)).join('')}</div></section>`
}

function renderSchedule(scheduleByDayHour) {
  const dayEntries = Object.entries(scheduleByDayHour).sort(([a], [b]) => a.localeCompare(b))
  if (!dayEntries.length) return '<div class="empty panel"><h3>No sessions match the current filters.</h3><p>Adjust filters to populate the timeline.</p></div>'

  return `
    <section>
      <h2>Schedule Timeline</h2>
      <div class="timeline-days">
        ${dayEntries.map(([date, hourMap]) => `
          <article class="timeline-day panel">
            <h3>${date}</h3>
            ${Object.entries(hourMap).sort(([a], [b]) => a.localeCompare(b)).map(([hour, list]) => `
              <details class="hour-block" open>
                <summary><span>${hour}</span><small>${list.length} session${list.length === 1 ? '' : 's'}</small></summary>
                <ul>
                  ${list.map((s) => `
                    <li class="timeline-item ${state.favorites.has(s.movieKey) ? 'favorite' : ''}">
                      <button class="open-modal-link" data-open-modal="${s.movieKey}" title="${sessionTooltip(s)}">${s.movieTitle}</button>
                      <div class="timeline-tags">
                        <span class="time-inline">${s.time}</span>
                        <span class="${cinemaTag(s.cinema)}">${s.cinema}</span>
                        <span title="${sessionTooltip(s)}">Sala ${s.room || 'n/a'}</span>
                        <button class="seatmap-btn" data-seatmap="${s.id}" ${s.ticketUrl ? '' : 'disabled'}>Tickets / Seats</button>
                        <button class="mini-favorite ${state.favorites.has(s.movieKey) ? 'is-favorite' : ''}" data-favorite="${s.movieKey}">★</button>
                      </div>
                    </li>
                  `).join('')}
                </ul>
              </details>
            `).join('')}
          </article>
        `).join('')}
      </div>
    </section>
  `
}


function renderUpcoming(groupedRows, totalCount) {
  if (!groupedRows.length) return '<div class="empty panel"><h3>No upcoming releases match the filters.</h3><p>Try widening date, rating, or runtime constraints.</p></div>'

  return `
    <section>
      <h2>Upcoming Releases</h2>
      <p class="upcoming-subtitle">${totalCount} title${totalCount === 1 ? '' : 's'} in selected window</p>
      <div class="upcoming-groups">
        ${groupedRows.map(([releaseDate, list]) => {
          const collapsed = state.collapsedUpcomingDates.has(releaseDate)
          return `
            <article class="upcoming-day panel">
              <button class="upcoming-day-toggle" data-upcoming-day="${releaseDate}">
                <span>${releaseDate}</span><small>${list.length} title${list.length === 1 ? '' : 's'} ${collapsed ? '▸' : '▾'}</small>
              </button>
              ${collapsed ? '' : `
                <div class="cards upcoming-cards">
                  ${list.map((m) => `
                    <article class="card panel upcoming-card">
                      <div class="poster-wrap upcoming-poster-wrap"><img src="${m.posterUrl}" alt="${m.title}" /></div>
                      <div class="content">
                        <div class="card-top">
                          <h3>${m.title}</h3>
                          <button class="favorite-btn ${state.upcomingFavorites.has(m.upcomingKey) ? 'is-favorite' : ''}" data-upcoming-favorite="${m.upcomingKey}" title="Toggle upcoming favorite">★</button>
                        </div>
                        <p class="meta">${m.year || 'Year n/a'} • ${m.durationMin || 'n/a'} min • ${m.countryCode || '??'}</p>
                        <div class="tags">${m.genres.map((g) => `<span>${g}</span>`).join('')}</div>
                        <p class="upcoming-synopsis">${m.synopsisShort || 'No synopsis available.'}</p>
                        <div class="links">
                          ${m.filmaffinityUrl ? `<a href="${m.filmaffinityUrl}" target="_blank" rel="noreferrer">Film page</a>` : ''}
                          ${m.theatersUrl ? `<a href="${m.theatersUrl}" target="_blank" rel="noreferrer">Cines (${m.theatersCount ?? 0})</a>` : ''}
                        </div>
                        <p class="meta">Rating: ${m.ratingAvg ?? 'n/a'} (${m.ratingCount ?? 0} votes)</p>
                      </div>
                    </article>
                  `).join('')}
                </div>
              `}
            </article>
          `
        }).join('')}
      </div>
    </section>
  `
}

function renderWarnings() {
  if (!state.loadWarnings.length) return ''
  return `
    <section class="warning-banner panel" role="status" aria-live="polite">
      <strong>Partial data loaded:</strong>
      <ul>${state.loadWarnings.map((w) => `<li>${w}</li>`).join('')}</ul>
    </section>
  `
}

function renderModal(modalMovie) {
  if (!modalMovie) return ''
  return `
    <div class="modal-backdrop" id="modalBackdrop">
      <div class="modal-shell panel" role="dialog" aria-modal="true">
        <div class="modal-head">
          <h3>Movie details</h3>
          <button id="closeModal" class="icon-btn" title="Close">✕</button>
        </div>
        <div class="modal-content">${renderMovieBody(modalMovie, true)}</div>
      </div>
    </div>
  `
}

function render() {
  const root = document.getElementById('root')
  const { movieCards, scheduleByDayHour, favoritesCount, modalMovie } = computeViewModel()
  const { groupedRows, availableGenres, availableCountries, totalCount } = computeUpcomingViewModel()

  root.innerHTML = `
    ${state.sidebarHidden ? '<button id="showSidebarFloating" class="show-floating" title="Show sidebar">☰</button>' : ''}
    <div class="app-shell ${state.sidebarHidden ? 'sidebar-hidden' : ''}">
      <aside class="sidebar panel">
        <div class="sidebar-head">
          <h2>Planner Controls</h2>
          <button id="toggleSidebar" class="icon-btn" title="Hide sidebar">◀</button>
        </div>

        <div class="sidebar-content">
          <div class="view-toggle">
            <button class="toggle-btn ${state.mainView === 'catalog' ? 'active' : ''}" data-main-view="catalog">Film Catalog</button>
            <button class="toggle-btn ${state.mainView === 'schedule' ? 'active' : ''}" data-main-view="schedule">Schedule</button>
            <button class="toggle-btn ${state.mainView === 'upcoming' ? 'active' : ''}" data-main-view="upcoming">Upcoming Releases</button>
          </div>

          <div class="row two-col">
            <div>
              <label>Catalog mode</label>
              <select id="catalogMode"><option value="full">Full catalog</option><option value="recommended">Recommended / trimmed</option><option value="unrecommended">Not recommended / trimmed out</option></select>
            </div>
            <div>
              <label>Sort movies</label>
              <select id="sortBy">
                <option value="soonest">Soonest screening</option>
                <option value="latest">Latest screening</option>
                <option value="shortest">Shortest duration</option>
                <option value="sessions">Most total sessions</option>
                <option value="newest_release">Newest releases first</option>
                <option value="oldest_release">Older releases first</option>
              </select>
            </div>
          </div>

          <div class="row">
            <label>Release window</label>
            <select id="releaseFilter">
              <option value="all">All release ages</option>
              <option value="this_week">Premieres this week</option>
              <option value="le2">≤ 2 weeks</option>
              <option value="le4">≤ 4 weeks</option>
              <option value="long_running">Long-running titles</option>
              <option value="unknown">Unknown release date</option>
            </select>
          </div>

          <div class="row sidebar-section cinema-section">
            <label>Cinema</label>
            <div class="chip-grid cinema-chip-grid">${chipList(['Renoir Princesa', 'Renoir Plaza de España', 'Golem Madrid'], state.cinemaFilter, 'cinema')}</div>
          </div>
          <div class="row sidebar-section day-section">
            <label>Day of week</label>
            <div class="chip-grid day-chip-row">${chipList(DAY_CHIPS, state.dayFilter, 'day', (v) => ({ Monday: 'M', Tuesday: 'T', Wednesday: 'W', Thursday: 'T', Friday: 'F', Saturday: 'S', Sunday: 'S' }[v]))}</div>
          </div>

          <div class="row two-col">
            <div><label>Date from</label><input id="dateFrom" type="date" value="${state.dateRange[0] || ''}" /></div>
            <div><label>Date to</label><input id="dateTo" type="date" value="${state.dateRange[1] || ''}" /></div>
          </div>

          <div class="row two-col">
            <div><label>Duration min</label><input id="durMin" type="number" min="0" max="300" value="${state.durationRange[0]}" /></div>
            <div><label>Duration max</label><input id="durMax" type="number" min="0" max="300" value="${state.durationRange[1]}" /></div>
          </div>

          <div class="row two-col">
            <div><label>Language / subtitles</label><input id="langQuery" value="${state.langQuery}" placeholder="francés, VOSE..." /></div>
            <div><label>Availability density</label><select id="densityFilter"><option value="all">All</option><option value="single">One-off</option><option value="multiple">Multiple sessions</option></select></div>
          </div>

          <div class="row favorite-tools">
            <label>Favorites (${favoritesCount})</label>
            <div class="tool-actions">
              <button id="favoritesOnly" class="icon-btn ${state.favoritesOnly ? 'active' : ''}" title="Show only favorites">★ only</button>
              <button id="exportFavorites" class="icon-btn" title="Export favorites">⤓</button>
              <label class="icon-btn" title="Import favorites">⤒<input id="importFavorites" type="file" accept="application/json" /></label>
            </div>
          </div>

          ${state.mainView === 'upcoming' ? `
            <div class="row two-col">
              <div><label>Upcoming date from</label><input id="upcomingDateFrom" type="date" value="${state.upcomingFilters.dateFrom}" /></div>
              <div><label>Upcoming date to</label><input id="upcomingDateTo" type="date" value="${state.upcomingFilters.dateTo}" /></div>
            </div>
            <div class="row two-col">
              <div><label>Genre</label><select id="upcomingGenre"><option value="all">All genres</option>${availableGenres.map((g) => `<option value="${g}">${g}</option>`).join('')}</select></div>
              <div><label>Country</label><select id="upcomingCountry"><option value="all">All countries</option>${availableCountries.map((c) => `<option value="${c}">${c}</option>`).join('')}</select></div>
            </div>
            <div class="row two-col">
              <div><label>Min rating</label><input id="upcomingMinRating" type="number" min="0" max="10" step="0.1" value="${state.upcomingFilters.minRating}" /></div>
              <div><label>Min votes</label><input id="upcomingMinVotes" type="number" min="0" step="1" value="${state.upcomingFilters.minVotes}" /></div>
            </div>
            <div class="row two-col">
              <div><label>Runtime min</label><input id="upcomingRuntimeMin" type="number" min="0" max="300" value="${state.upcomingFilters.runtimeMin}" /></div>
              <div><label>Runtime max</label><input id="upcomingRuntimeMax" type="number" min="0" max="300" value="${state.upcomingFilters.runtimeMax}" /></div>
            </div>
            <div class="row two-col">
              <div><label>Sort</label><select id="upcomingSortBy"><option value="rating_desc">Rating (high → low)</option><option value="rating_asc">Rating (low → high)</option><option value="title_asc">Title (A–Z)</option><option value="title_desc">Title (Z–A)</option></select></div>
              <div><label>Upcoming favorites</label><button id="upcomingFavoritesOnly" class="icon-btn ${state.upcomingFilters.favoritesOnly ? 'active' : ''}">★ only</button></div>
            </div>
            <div class="row">
              <button id="upcomingTheatersOnly" class="icon-btn ${state.upcomingFilters.theatersOnly ? 'active' : ''}">Only with Cines > 0</button>
            </div>
          ` : ''}
        </div>
      </aside>

      <main class="main-content">
        <header class="topline">
          <h1>Cinema Schedule Planner</h1>
          <p>Personal planning dashboard with release-age intelligence and favorites sync.</p>
        </header>
        ${renderWarnings()}
        ${state.mainView === 'catalog' ? renderCatalog(movieCards) : state.mainView === 'schedule' ? renderSchedule(scheduleByDayHour) : renderUpcoming(groupedRows, totalCount)}
      </main>
    </div>
    ${renderModal(modalMovie)}
    ${renderSeatMapModal()}
  `

  document.getElementById('catalogMode').value = state.catalogMode
  document.getElementById('sortBy').value = state.sortBy
  document.getElementById('densityFilter').value = state.densityFilter
  document.getElementById('releaseFilter').value = state.releaseFilter
  if (document.getElementById('upcomingGenre')) document.getElementById('upcomingGenre').value = state.upcomingFilters.genre
  if (document.getElementById('upcomingCountry')) document.getElementById('upcomingCountry').value = state.upcomingFilters.country
  if (document.getElementById('upcomingSortBy')) document.getElementById('upcomingSortBy').value = state.upcomingFilters.sortBy

  bindEvents()
}

function bindEvents() {
  document.querySelectorAll('[data-main-view]').forEach((btn) => {
    btn.onclick = () => { state.mainView = btn.dataset.mainView; render() }
  })

  document.querySelectorAll('[data-type]').forEach((el) => {
    el.onclick = () => {
      const { type, value } = el.dataset
      const target = type === 'cinema' ? state.cinemaFilter : state.dayFilter
      target.has(value) ? target.delete(value) : target.add(value)
      render()
    }
  })

  document.querySelectorAll('[data-favorite]').forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation()
      const movieKey = btn.dataset.favorite
      state.favorites.has(movieKey) ? state.favorites.delete(movieKey) : state.favorites.add(movieKey)
      saveFavorites(); render()
    }
  })


  document.querySelectorAll('[data-upcoming-favorite]').forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation()
      const key = btn.dataset.upcomingFavorite
      state.upcomingFavorites.has(key) ? state.upcomingFavorites.delete(key) : state.upcomingFavorites.add(key)
      saveUpcomingFavorites()
      render()
    }
  })

  document.querySelectorAll('[data-upcoming-day]').forEach((btn) => {
    btn.onclick = () => {
      const day = btn.dataset.upcomingDay
      state.collapsedUpcomingDates.has(day) ? state.collapsedUpcomingDates.delete(day) : state.collapsedUpcomingDates.add(day)
      render()
    }
  })
  document.querySelectorAll('[data-open-modal]').forEach((btn) => {
    btn.onclick = () => { state.modalMovieKey = btn.dataset.openModal; render() }
  })

  const closeModal = document.getElementById('closeModal')
  if (closeModal) closeModal.onclick = () => { state.modalMovieKey = null; render() }

  const modalBackdrop = document.getElementById('modalBackdrop')
  if (modalBackdrop) {
    modalBackdrop.onclick = (e) => {
      if (e.target.id === 'modalBackdrop') {
        state.modalMovieKey = null
        render()
      }
    }
  }

  const seatMapBackdrop = document.getElementById('seatMapBackdrop')
  if (seatMapBackdrop) {
    seatMapBackdrop.onclick = (e) => {
      if (e.target.id === 'seatMapBackdrop') {
        state.seatMapModal.open = false
        render()
      }
    }
  }

  const closeSeatMap = document.getElementById('closeSeatMap')
  if (closeSeatMap) {
    closeSeatMap.onclick = () => {
      state.seatMapModal.open = false
      render()
    }
  }

  document.querySelectorAll('[data-seatmap]').forEach((btn) => {
    btn.onclick = (e) => {
      e.preventDefault()
      openSeatMap(btn.dataset.seatmap)
    }
  })

  const toggleSidebar = document.getElementById('toggleSidebar')
  if (toggleSidebar) toggleSidebar.onclick = () => { state.sidebarHidden = true; render() }

  const showSidebarFloating = document.getElementById('showSidebarFloating')
  if (showSidebarFloating) showSidebarFloating.onclick = () => { state.sidebarHidden = false; render() }

  const favoritesOnly = document.getElementById('favoritesOnly')
  if (favoritesOnly) favoritesOnly.onclick = () => { state.favoritesOnly = !state.favoritesOnly; render() }

  document.getElementById('catalogMode').onchange = (e) => { state.catalogMode = e.target.value; render() }
  document.getElementById('sortBy').onchange = (e) => { state.sortBy = e.target.value; render() }
  document.getElementById('densityFilter').onchange = (e) => { state.densityFilter = e.target.value; render() }
  document.getElementById('releaseFilter').onchange = (e) => { state.releaseFilter = e.target.value; render() }
  document.getElementById('dateFrom').onchange = (e) => { state.dateRange[0] = e.target.value; render() }
  document.getElementById('dateTo').onchange = (e) => { state.dateRange[1] = e.target.value; render() }
  document.getElementById('durMin').onchange = (e) => { state.durationRange[0] = Number(e.target.value); render() }
  document.getElementById('durMax').onchange = (e) => { state.durationRange[1] = Number(e.target.value); render() }
  document.getElementById('langQuery').oninput = (e) => { state.langQuery = e.target.value; render() }
  if (document.getElementById('upcomingDateFrom')) document.getElementById('upcomingDateFrom').onchange = (e) => { state.upcomingFilters.dateFrom = e.target.value; render() }
  if (document.getElementById('upcomingDateTo')) document.getElementById('upcomingDateTo').onchange = (e) => { state.upcomingFilters.dateTo = e.target.value; render() }
  if (document.getElementById('upcomingGenre')) document.getElementById('upcomingGenre').onchange = (e) => { state.upcomingFilters.genre = e.target.value; render() }
  if (document.getElementById('upcomingCountry')) document.getElementById('upcomingCountry').onchange = (e) => { state.upcomingFilters.country = e.target.value; render() }
  if (document.getElementById('upcomingMinRating')) document.getElementById('upcomingMinRating').onchange = (e) => { state.upcomingFilters.minRating = Number(e.target.value) || 0; render() }
  if (document.getElementById('upcomingMinVotes')) document.getElementById('upcomingMinVotes').onchange = (e) => { state.upcomingFilters.minVotes = Number(e.target.value) || 0; render() }
  if (document.getElementById('upcomingRuntimeMin')) document.getElementById('upcomingRuntimeMin').onchange = (e) => { state.upcomingFilters.runtimeMin = Number(e.target.value) || 0; render() }
  if (document.getElementById('upcomingRuntimeMax')) document.getElementById('upcomingRuntimeMax').onchange = (e) => { state.upcomingFilters.runtimeMax = Number(e.target.value) || 240; render() }
  if (document.getElementById('upcomingTheatersOnly')) document.getElementById('upcomingTheatersOnly').onclick = () => { state.upcomingFilters.theatersOnly = !state.upcomingFilters.theatersOnly; render() }
  if (document.getElementById('upcomingFavoritesOnly')) document.getElementById('upcomingFavoritesOnly').onclick = () => { state.upcomingFilters.favoritesOnly = !state.upcomingFilters.favoritesOnly; render() }
  if (document.getElementById('upcomingSortBy')) document.getElementById('upcomingSortBy').onchange = (e) => { state.upcomingFilters.sortBy = e.target.value; render() }

  document.getElementById('exportFavorites').onclick = () => {
    const payload = { exported_at: new Date().toISOString(), favorites: [...state.favorites] }
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'cinema-favorites.json'
    a.click()
    URL.revokeObjectURL(url)
  }

  document.getElementById('importFavorites').onchange = async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    try {
      const parsed = JSON.parse(await file.text())
      const favorites = Array.isArray(parsed) ? parsed : parsed.favorites
      if (!Array.isArray(favorites)) throw new Error('Invalid favorites file')
      state.favorites = new Set(favorites.map((x) => String(x)))
      saveFavorites()
      render()
    } catch (err) {
      alert(`Import failed: ${err.message}`)
    }
  }
}

async function init() {
  loadFavorites()
  loadUpcomingFavorites()
  state.loadWarnings = []

  const discoverLatestCsv = async (prefix) => {
    try {
      const listingResp = await fetch('./_1_data/')
      if (!listingResp.ok) return null
      const html = await listingResp.text()
      const pattern = new RegExp(`${prefix}_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}\.csv`, 'g')
      const matches = [...new Set([...html.matchAll(pattern)].map((m) => m[0]))]
      return matches.sort().at(-1) || null
    } catch {
      return null
    }
  }

  let manifest = {}
  try {
    const manifestResp = await fetch('./_1_data/latest.json')
    if (manifestResp.ok) manifest = await manifestResp.json()
  } catch {
    manifest = {}
  }

  const loadSource = async (key, sourceName, prefix) => {
    const manifestFile = manifest[key]
    const fallbackFile = await discoverLatestCsv(prefix)
    const candidates = [...new Set([manifestFile, fallbackFile].filter(Boolean))]

    if (!candidates.length) {
      state.loadWarnings.push(`${sourceName} data could not be discovered (manifest or directory listing).`)
      return []
    }

    for (const csvFile of candidates) {
      try {
        const response = await fetch(`./_1_data/${csvFile}`)
        if (!response.ok) continue
        const csvText = await response.text()
        if (manifestFile && csvFile !== manifestFile) {
          state.loadWarnings.push(`${sourceName} loaded from fallback file (${csvFile}) because manifest file was unavailable (${manifestFile}).`)
        }
        return normalizeRows(csvText, sourceName)
      } catch {
        // Try next candidate
      }
    }

    state.loadWarnings.push(`${sourceName} data files could not be loaded (${candidates.join(', ')}).`)
    return []
  }

  let upcomingRaw = []
  try {
    const upcomingResp = await fetch(UPCOMING_API_URL)
    if (upcomingResp.ok) {
      const payload = await upcomingResp.json()
      upcomingRaw = payload.rows || []
    } else {
      state.loadWarnings.push('Upcoming releases endpoint unavailable. Start 3_PillalasSeatMapService.py to enable the third dashboard view.')
    }
  } catch {
    state.loadWarnings.push('Upcoming releases endpoint unavailable. Start 3_PillalasSeatMapService.py to enable the third dashboard view.')
  }

  state.upcomingRows = normalizeUpcomingRows(upcomingRaw)
  const today = new Date()
  state.upcomingFilters.dateFrom = isoDate(today)
  state.upcomingFilters.dateTo = isoDate(addMonths(today, UPCOMING_DEFAULT_MONTHS))

  const [renoirRows, golemRows] = await Promise.all([
    loadSource('renoir', 'Renoir', 'cines_renoir'),
    loadSource('golem', 'Golem', 'cines_golem'),
  ])

  state.allSessions = [...renoirRows, ...golemRows]
  const dates = state.allSessions.map((s) => s.date).filter(Boolean).sort()
  state.dateRange = dates.length ? [dates[0], dates.at(-1)] : ['', '']
  render()
}

init().catch((error) => {
  console.error(error)
  document.getElementById('root').innerHTML = `<div class="app-shell"><main class="main-content"><div class="empty panel"><h2>Unable to load data</h2><p>${error.message}</p></div></main></div>`
})
