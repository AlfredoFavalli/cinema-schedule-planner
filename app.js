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

function chipList(items, set, key, labelTransform = (v) => v) {
  return items.map((item) => `<button class="chip ${set.has(item) ? 'active' : ''}" data-type="${key}" data-value="${item}">${labelTransform(item)}</button>`).join('')
}

function groupSessionsByDay(sessions) {
  const map = {}
  sessions.forEach((s) => { map[s.date] ||= []; map[s.date].push(s) })
  Object.values(map).forEach((arr) => arr.sort((a, b) => (a.startMin ?? 0) - (b.startMin ?? 0)))
  return map
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
              <ul>${list.map((s) => `<li title="${sessionTooltip(s)}"><strong>${s.time}</strong><span class="${cinemaTag(s.cinema)}">${s.cinema}</span><span>Sala ${s.room || 'n/a'}</span></li>`).join('')}</ul>
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
        </div>
      </aside>

      <main class="main-content">
        <header class="topline">
          <h1>Cinema Schedule Planner</h1>
          <p>Personal planning dashboard with release-age intelligence and favorites sync.</p>
        </header>
        ${state.mainView === 'catalog' ? renderCatalog(movieCards) : renderSchedule(scheduleByDayHour)}
      </main>
    </div>
    ${renderModal(modalMovie)}
  `

  document.getElementById('catalogMode').value = state.catalogMode
  document.getElementById('sortBy').value = state.sortBy
  document.getElementById('densityFilter').value = state.densityFilter
  document.getElementById('releaseFilter').value = state.releaseFilter

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
  document.getElementById('root').innerHTML = `<div class="app-shell"><main class="main-content"><div class="empty panel"><h2>Unable to load data</h2><p>${error.message}</p></div></main></div>`
})
