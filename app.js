import React, { useEffect, useMemo, useState } from 'https://esm.sh/react@18.3.1'
import { createRoot } from 'https://esm.sh/react-dom@18.3.1/client'
import htm from 'https://esm.sh/htm@3.1.1/react'
import Papa from 'https://esm.sh/papaparse@5.4.1'

const html = htm.bind(React.createElement)
const SALA_CAPACITY = {
  'Renoir Princesa': { 1: 87, 2: 107, 3: 83, 4: 175, 5: 191, 6: 170, 7: 120, 8: 76, 9: 195, 10: 190, 11: 190 },
  'Renoir Plaza de España': { 1: 139, 2: 95, 3: 149, 4: 71, 5: 68 },
  'Golem Madrid': { 1: 74, 2: 193, 3: 64, 4: 115, 5: 157 },
}
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

const toMinutes = (timeString) => {
  const [h, m] = (timeString || '').split(':').map(Number)
  return Number.isNaN(h) || Number.isNaN(m) ? null : h * 60 + m
}
const timeBucket = (min) => (min == null ? 'unknown' : min < 720 ? 'morning' : min < 1080 ? 'afternoon' : 'evening')
const duration = (raw) => Number(String(raw || '').match(/\d+/)?.[0] || NaN)
const cleanTitle = (t = '') => t.replace(/\(.*?\)/g, '').trim().toUpperCase()

const normalizeRows = (csvText, source) => {
  const { data } = Papa.parse(csvText, { header: true, skipEmptyLines: true })
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
      endMin: startMin != null && Number.isFinite(d) ? startMin + d : null,
      duration: Number.isFinite(d) ? d : null,
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

const trimRecommended = (sessions) => sessions.filter((s) => s.dateObj && s.startMin != null && s.duration != null && s.endMin != null && [1,2,3,4,5].includes(s.dayOfWeek) && s.startMin <= 1200 && s.endMin < 1260 && (s.roomCapacity ?? 0) > 100)

function App() {
  const [allSessions, setAllSessions] = useState([])
  const [catalogMode, setCatalogMode] = useState('full')
  const [cinemaFilter, setCinemaFilter] = useState(new Set(['Renoir Princesa', 'Renoir Plaza de España', 'Golem Madrid']))
  const [dayFilter, setDayFilter] = useState(new Set(DAYS))
  const [bucketFilter, setBucketFilter] = useState(new Set(['morning', 'afternoon', 'evening']))
  const [durationRange, setDurationRange] = useState([0, 300])
  const [densityFilter, setDensityFilter] = useState('all')
  const [sortBy, setSortBy] = useState('soonest')
  const [langQuery, setLangQuery] = useState('')
  const [dateRange, setDateRange] = useState(['', ''])

  useEffect(() => {
    Promise.all([
      fetch('./_1_data/cines_renoir_2026-02-15_21-03.csv').then((r) => r.text()),
      fetch('./_1_data/cines_golem_2026-02-16_00-24.csv').then((r) => r.text()),
    ]).then(([r, g]) => {
      const data = [...normalizeRows(r, 'Renoir'), ...normalizeRows(g, 'Golem')]
      const dates = data.map((s) => s.date).filter(Boolean).sort()
      setDateRange([dates[0], dates.at(-1)])
      setAllSessions(data)
    })
  }, [])

  const workingSessions = useMemo(() => catalogMode === 'recommended' ? trimRecommended(allSessions) : allSessions, [catalogMode, allSessions])

  const movieStats = useMemo(() => {
    const m = new Map()
    workingSessions.forEach((s) => m.set(s.movieKey, (m.get(s.movieKey) || 0) + 1))
    return m
  }, [workingSessions])

  const filteredSessions = useMemo(() => workingSessions.filter((s) =>
    cinemaFilter.has(s.cinema) && dayFilter.has(s.dayLabel) && bucketFilter.has(s.bucket) &&
    s.duration != null && s.duration >= durationRange[0] && s.duration <= durationRange[1] &&
    (!dateRange[0] || s.date >= dateRange[0]) && (!dateRange[1] || s.date <= dateRange[1]) &&
    `${s.languageTag} ${s.subtitles}`.toLowerCase().includes(langQuery.toLowerCase()) &&
    (densityFilter === 'all' || (densityFilter === 'single' ? movieStats.get(s.movieKey) === 1 : movieStats.get(s.movieKey) > 1))
  ), [workingSessions, cinemaFilter, dayFilter, bucketFilter, durationRange, dateRange, langQuery, densityFilter, movieStats])

  const movieCards = useMemo(() => {
    const map = new Map()
    filteredSessions.forEach((s) => {
      if (!map.has(s.movieKey)) map.set(s.movieKey, { ...s, sessions: [] })
      map.get(s.movieKey).sessions.push(s)
    })
    const arr = [...map.values()]
    const sorter = {
      soonest: (a, b) => (a.sessions[0]?.date + a.sessions[0]?.time).localeCompare(b.sessions[0]?.date + b.sessions[0]?.time),
      latest: (a, b) => (b.sessions.at(-1)?.date + b.sessions.at(-1)?.time).localeCompare(a.sessions.at(-1)?.date + a.sessions.at(-1)?.time),
      shortest: (a, b) => (a.duration ?? 999) - (b.duration ?? 999),
      sessions: (a, b) => b.sessions.length - a.sessions.length,
    }
    return arr.sort(sorter[sortBy])
  }, [filteredSessions, sortBy])

  const schedule = useMemo(() => {
    const out = {}
    filteredSessions.forEach((s) => {
      out[s.date] ||= {}
      out[s.date][s.cinema] ||= []
      out[s.date][s.cinema].push(s)
    })
    return out
  }, [filteredSessions])

  const toggleSet = (setter, set, value) => {
    const next = new Set(set)
    next.has(value) ? next.delete(value) : next.add(value)
    setter(next)
  }

  return html`
    <div className="page">
      <header>
        <h1>Cinema Schedule Planner</h1>
        <p>Renoir + Golem visual explorer with cards, schedule view, and smart filters.</p>
      </header>
      <section className="panel controls">
        <div className="row two-col">
          <div><label>Catalog</label><select value=${catalogMode} onChange=${(e) => setCatalogMode(e.target.value)}><option value="full">Full catalog</option><option value="recommended">Recommended / trimmed</option></select></div>
          <div><label>Sort by</label><select value=${sortBy} onChange=${(e) => setSortBy(e.target.value)}><option value="soonest">Soonest screening</option><option value="latest">Latest screening</option><option value="shortest">Shortest duration</option><option value="sessions">Most total sessions</option></select></div>
        </div>
        <div className="row wrap"><label>Cinema</label>${['Renoir Princesa','Renoir Plaza de España','Golem Madrid'].map((x)=>html`<button className=${cinemaFilter.has(x)?'chip active':'chip'} onClick=${()=>toggleSet(setCinemaFilter, cinemaFilter, x)}>${x}</button>`)}</div>
        <div className="row wrap"><label>Day of week</label>${DAYS.map((x)=>html`<button className=${dayFilter.has(x)?'chip active':'chip'} onClick=${()=>toggleSet(setDayFilter, dayFilter, x)}>${x.slice(0,3)}</button>`)}</div>
        <div className="row wrap"><label>Time of day</label>${['morning','afternoon','evening'].map((x)=>html`<button className=${bucketFilter.has(x)?'chip active':'chip'} onClick=${()=>toggleSet(setBucketFilter, bucketFilter, x)}>${x}</button>`)}</div>
        <div className="row two-col">
          <div><label>Date from</label><input type="date" value=${dateRange[0]||''} onChange=${(e)=>setDateRange([e.target.value,dateRange[1]])} /></div>
          <div><label>Date to</label><input type="date" value=${dateRange[1]||''} onChange=${(e)=>setDateRange([dateRange[0],e.target.value])} /></div>
        </div>
        <div className="row two-col">
          <div><label>Duration min</label><input type="number" min="0" max="300" value=${durationRange[0]} onChange=${(e)=>setDurationRange([Number(e.target.value), durationRange[1]])}/></div>
          <div><label>Duration max</label><input type="number" min="0" max="300" value=${durationRange[1]} onChange=${(e)=>setDurationRange([durationRange[0], Number(e.target.value)])}/></div>
        </div>
        <div className="row two-col">
          <div><label>Language / subtitles</label><input value=${langQuery} onChange=${(e)=>setLangQuery(e.target.value)} placeholder="francés, VOSE..."/></div>
          <div><label>Availability density</label><select value=${densityFilter} onChange=${(e)=>setDensityFilter(e.target.value)}><option value="all">All</option><option value="single">One-off</option><option value="multiple">Multiple sessions</option></select></div>
        </div>
        <div className="stats">Showing ${movieCards.length} films / ${filteredSessions.length} sessions</div>
      </section>
      <section><h2>Film catalog</h2><div className="cards">${movieCards.map((m)=>html`<article className="card panel" key=${m.movieKey}><img src=${m.posterUrl} alt=${m.movieTitle}/><div className="content"><h3>${m.movieTitle}</h3><p className="meta">${m.director} • ${m.year || 'Year n/a'} • ${m.duration || 'n/a'} min • ${m.sessions.length} sessions</p><p>${m.synopsis}</p><div className="tags"><span>${m.cinema}</span><span>${m.originalLanguage || 'Language n/a'}</span>${m.subtitles ? html`<span>${m.subtitles}</span>` : null}${m.rating ? html`<span>${m.rating}</span>` : null}</div><div className="links">${m.trailerUrl ? html`<a href=${m.trailerUrl} target="_blank">Trailer</a>` : null}${m.filmUrl ? html`<a href=${m.filmUrl} target="_blank">Details</a>` : null}</div></div></article>`)}</div></section>
      <section><h2>Schedule view (by day / cinema)</h2><div className="schedule-grid">${Object.entries(schedule).sort(([a],[b])=>a.localeCompare(b)).map(([date,cinemas])=>html`<div className="panel day-block" key=${date}><h3>${date}</h3>${Object.entries(cinemas).map(([name,sessions])=>html`<div className="cinema-block" key=${name}><h4>${name}</h4><ul>${sessions.sort((a,b)=>a.startMin-b.startMin).map((s)=>html`<li key=${s.id}><strong>${s.time}</strong> — ${s.movieTitle} <span>Sala ${s.room || 'n/a'}</span></li>`)}</ul></div>`)}</div>`)}</div></section>
    </div>
  `
}

createRoot(document.getElementById('root')).render(html`<${App} />`)
