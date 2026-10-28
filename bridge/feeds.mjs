/**
 * What the side monitors show that comes from outside: the weather and the
 * headlines.
 *
 * Fetched here rather than in the page for the reason everything remote is: the
 * page's CSP lets it talk to this bridge and nothing else, so the browser never
 * reveals to a third party what is on the wall. Both sources are free and need
 * no key — Open-Meteo for the forecast, a public RSS feed for the news.
 *
 * Everything is cached. Three windows poll this, the answers change a few times
 * an hour at most, and a free service is owed that much restraint. A failed
 * refresh serves the last good answer rather than blanking a monitor.
 */

const WEATHER_TTL = 10 * 60_000
const NEWS_TTL = 10 * 60_000
const PLACE_TTL = 12 * 60 * 60_000
const TIMEOUT = 8000

const LANG = (process.env.JARVIS_LANG ?? process.env.VITE_JARVIS_LANG ?? 'en-GB').split(/[-_]/)
const LANGUAGE = LANG[0].toLowerCase()
const REGION = (LANG[1] ?? (LANGUAGE === 'pt' ? 'BR' : 'GB')).toUpperCase()

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT) })
  if (!res.ok) throw new Error(`${new URL(url).hostname} answered ${res.status}`)
  return res.json()
}

/** Serve from cache while fresh; refresh otherwise; fall back to stale on failure. */
function cached(ttl, load) {
  let value = null
  let at = 0
  let inFlight = null
  const get = async () => {
    if (value && Date.now() - at < ttl) return value
    inFlight ??= load()
      .then((fresh) => {
        value = fresh
        at = Date.now()
        return fresh
      })
      .catch((err) => {
        console.warn(`[jarvis] feed refresh failed: ${err.message}`)
        if (value) return value
        throw err
      })
      .finally(() => {
        inFlight = null
      })
    return inFlight
  }
  /** The last good answer without fetching, or null. Never waits. */
  get.peek = () => value
  return get
}

/**
 * Where the forecast is for.
 *
 * JARVIS_CITY when it is set — the only way to be right for someone on a VPN
 * or a mobile connection. Otherwise the city the machine's address resolves
 * to, which is the right town for most people and costs them no setup.
 */
const place = cached(PLACE_TTL, async () => {
  const city = process.env.JARVIS_CITY?.trim()
  // Exact coordinates win over everything. A neighbourhood is not a place a
  // city search knows, and the address's guess lands on the next town over
  // (Total Ville, Santa Maria DF came out as Novo Gama, GO).
  const lat = Number(process.env.JARVIS_LAT)
  const lon = Number(process.env.JARVIS_LON)
  if (process.env.JARVIS_LAT && process.env.JARVIS_LON && Number.isFinite(lat) && Number.isFinite(lon)) {
    return { city: city || 'Casa', region: process.env.JARVIS_REGION?.trim() ?? '', lat, lon }
  }
  if (city) {
    const found = await getJson(
      'https://geocoding-api.open-meteo.com/v1/search?count=1' +
        `&language=${LANGUAGE}&name=${encodeURIComponent(city)}`,
    )
    const hit = found.results?.[0]
    if (!hit) throw new Error(`no place called "${city}"`)
    return { city: hit.name, region: hit.admin1 ?? '', lat: hit.latitude, lon: hit.longitude }
  }
  const here = await getJson('https://ipwho.is/')
  if (!here.success) throw new Error('could not locate this machine')
  return { city: here.city, region: here.region ?? '', lat: here.latitude, lon: here.longitude }
})

export const weather = cached(WEATHER_TTL, async () => {
  const at = await place()
  const data = await getJson(
    'https://api.open-meteo.com/v1/forecast?timezone=auto&forecast_days=7' +
      `&latitude=${at.lat}&longitude=${at.lon}` +
      '&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,uv_index,is_day' +
      '&hourly=temperature_2m,precipitation_probability' +
      '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,uv_index_max,sunrise,sunset',
  )
  // Air quality, from the same provider's sister service. Optional: a
  // forecast without it is still a forecast.
  const air = await getJson(
    'https://air-quality-api.open-meteo.com/v1/air-quality?timezone=auto' +
      `&latitude=${at.lat}&longitude=${at.lon}&current=us_aqi,pm2_5,pm10`,
  ).catch(() => null)

  // The next twenty-four hours, starting from the hour we are in — a chart
  // that begins at midnight spends half its width on a day that is over.
  const start = Math.max(
    0,
    data.hourly.time.findIndex((t) => t >= data.current.time.slice(0, 13)),
  )
  const hours = data.hourly.time.slice(start, start + 24).map((time, i) => ({
    time,
    temp: data.hourly.temperature_2m[start + i],
    rain: data.hourly.precipitation_probability[start + i] ?? 0,
  }))

  return {
    city: at.city,
    region: at.region,
    now: {
      temp: data.current.temperature_2m,
      feels: data.current.apparent_temperature,
      humidity: data.current.relative_humidity_2m,
      wind: data.current.wind_speed_10m,
      code: data.current.weather_code,
      uv: data.current.uv_index ?? null,
      day: data.current.is_day === 1,
    },
    sun: { rise: data.daily.sunrise?.[0] ?? null, set: data.daily.sunset?.[0] ?? null },
    uvMax: data.daily.uv_index_max?.[0] ?? null,
    air: air?.current
      ? { aqi: air.current.us_aqi ?? null, pm25: air.current.pm2_5 ?? null, pm10: air.current.pm10 ?? null }
      : null,
    today: {
      min: data.daily.temperature_2m_min[0],
      max: data.daily.temperature_2m_max[0],
      rain: data.daily.precipitation_probability_max[0] ?? 0,
    },
    tomorrow: {
      min: data.daily.temperature_2m_min[1],
      max: data.daily.temperature_2m_max[1],
      rain: data.daily.precipitation_probability_max[1] ?? 0,
    },
    hours,
    // The week ahead, today first.
    week: data.daily.time.map((date, i) => ({
      date,
      code: data.daily.weather_code[i],
      min: data.daily.temperature_2m_min[i],
      max: data.daily.temperature_2m_max[i],
      rain: data.daily.precipitation_probability_max[i] ?? 0,
    })),
  }
})

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
const decode = (s) =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&(\w+);/g, (m, name) => ENTITIES[name] ?? m)
    .trim()

const tag = (xml, name) =>
  decode(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`).exec(xml)?.[1] ?? '')

/**
 * The top stories for the configured language and country.
 *
 * Headline, outlet and time only. That is all a wall display should carry, and
 * all that is ours to show — the article stays with whoever wrote it.
 */
export const news = cached(NEWS_TTL, async () => {
  const res = await fetch(
    `https://news.google.com/rss?hl=${LANGUAGE}-${REGION}&gl=${REGION}&ceid=${REGION}:${LANGUAGE}`,
    { signal: AbortSignal.timeout(TIMEOUT), headers: { 'user-agent': 'Mozilla/5.0 JARVIS' } },
  )
  if (!res.ok) throw new Error(`news feed answered ${res.status}`)
  const xml = await res.text()

  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 10).map(([, item]) => {
    const source = tag(item, 'source')
    // The feed writes "Headline - Outlet"; the outlet has its own field here.
    const title = tag(item, 'title')
    const suffix = ` - ${source}`
    return {
      title: source && title.endsWith(suffix) ? title.slice(0, -suffix.length) : title,
      source,
      at: new Date(tag(item, 'pubDate')).toISOString(),
    }
  })
})

const MARKETS_TTL = 10 * 60_000

/** What is quoted, against the real. Fixed order: it is also the display order. */
const QUOTES = [
  { pair: 'USD-BRL', name: 'USD' },
  { pair: 'EUR-BRL', name: 'EUR' },
  { pair: 'BTC-BRL', name: 'BTC' },
]

/**
 * Thirty days of closing rates for each quote, oldest first.
 *
 * A reading of the market, not advice about it: the last rate, how far it has
 * moved over the day and over the month, and the line that got it there.
 */
export const markets = cached(MARKETS_TTL, async () => {
  const series = await Promise.all(
    QUOTES.map(async ({ pair, name }) => {
      const days = await getJson(`https://economia.awesomeapi.com.br/json/daily/${pair}/30`)
      const points = days
        .map((d) => ({ at: new Date(Number(d.timestamp) * 1000).toISOString(), value: Number(d.bid) }))
        .filter((p) => Number.isFinite(p.value))
        .reverse()
      const last = points.at(-1)?.value ?? 0
      const first = points[0]?.value ?? last
      return {
        name,
        last,
        dayPct: Number(days[0]?.pctChange ?? 0),
        monthPct: first ? ((last - first) / first) * 100 : 0,
        points,
      }
    }),
  )
  return series
})

/**
 * One story per subject for the briefing, with a picture where the feed has one.
 *
 * Three feeds rather than one because "the news" read aloud wants shape — a
 * technology item, an economy item, a politics item — and the top-stories feed
 * is whatever is loudest today, which is often three versions of one event.
 */
const TOPICS =
  LANGUAGE === 'pt'
    ? [
        {
          topic: 'tecnologia',
          url: 'https://news.google.com/rss/headlines/section/topic/TECHNOLOGY?hl=pt-BR&gl=BR&ceid=BR:pt-419',
        },
        { topic: 'economia', url: 'https://g1.globo.com/rss/g1/economia/', source: 'G1' },
        { topic: 'política', url: 'https://g1.globo.com/rss/g1/politica/', source: 'G1' },
      ]
    : [
        {
          topic: 'technology',
          url: `https://news.google.com/rss/headlines/section/topic/TECHNOLOGY?hl=${LANGUAGE}-${REGION}&gl=${REGION}&ceid=${REGION}:${LANGUAGE}`,
        },
        {
          topic: 'business',
          url: `https://news.google.com/rss/headlines/section/topic/BUSINESS?hl=${LANGUAGE}-${REGION}&gl=${REGION}&ceid=${REGION}:${LANGUAGE}`,
        },
        {
          topic: 'world',
          url: `https://news.google.com/rss/headlines/section/topic/WORLD?hl=${LANGUAGE}-${REGION}&gl=${REGION}&ceid=${REGION}:${LANGUAGE}`,
        },
      ]

const stories = cached(NEWS_TTL, async () => {
  const found = await Promise.all(
    TOPICS.map(async ({ topic, url, source }) => {
      try {
        const res = await fetch(url, {
          signal: AbortSignal.timeout(TIMEOUT),
          headers: { 'user-agent': 'Mozilla/5.0 JARVIS' },
        })
        if (!res.ok) return null
        // Among the lead stories, prefer one that comes with a picture: a
        // card with a photograph reads as news, one without as a notice.
        const lead = [...(await res.text()).matchAll(/<item>([\s\S]*?)<\/item>/g)]
          .slice(0, 5)
          .map((m) => m[1])
        const item = lead.find((i) => /<media:content[^>]+url="/.test(i)) ?? lead[0]
        if (!item) return null
        const from = source ?? tag(item, 'source')
        const title = tag(item, 'title')
        const suffix = ` - ${from}`
        const image = /<media:content[^>]+url="([^"]+)"/.exec(item)?.[1] ?? null
        return {
          topic,
          title: from && title.endsWith(suffix) ? title.slice(0, -suffix.length) : title,
          source: from,
          image: image ? decode(image) : null,
          at: new Date(tag(item, 'pubDate')).toISOString(),
        }
      } catch {
        // One feed being down costs the briefing one story, not the briefing.
        return null
      }
    }),
  )
  return found.filter(Boolean)
})

export { stories }

/** Everything the briefing reads out, gathered in one request. */
export async function briefing() {
  const [w, m, s] = await Promise.allSettled([weather(), markets(), stories()])
  return {
    weather: w.status === 'fulfilled' ? w.value : null,
    markets: m.status === 'fulfilled' ? m.value : null,
    stories: s.status === 'fulfilled' ? s.value : [],
  }
}

/**
 * Articles with their text, from outlets whose feeds carry it.
 *
 * The top-stories feed is headlines only, which is enough to say that
 * something happened and nothing more. These three publish a summary or the
 * opening of the piece alongside the title, so he can say what the story is
 * actually about without a web search — and so there is a second and third
 * account to check a headline against.
 *
 * Only an excerpt is kept. It is there to brief from, not to republish; the
 * article stays with its publisher, one link away.
 */
const ARTICLE_FEEDS =
  LANGUAGE === 'pt'
    ? [
        { source: 'G1', url: 'https://g1.globo.com/rss/g1/' },
        { source: 'Agência Brasil', url: 'https://agenciabrasil.ebc.com.br/rss/ultimasnoticias/feed.xml' },
        { source: 'BBC News Brasil', url: 'https://feeds.bbci.co.uk/portuguese/rss.xml' },
      ]
    : [
        { source: 'BBC News', url: 'https://feeds.bbci.co.uk/news/rss.xml' },
        { source: 'The Guardian', url: 'https://www.theguardian.com/world/rss' },
      ]

const EXCERPT = 420

/** Feed markup down to a sentence or two of plain text. */
const plain = (html) =>
  decode(html)
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

function excerpt(text) {
  if (text.length <= EXCERPT) return text
  const cut = text.slice(0, EXCERPT)
  // End on a sentence if there is one in reach, otherwise on a word.
  const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '))
  return stop > EXCERPT * 0.5 ? cut.slice(0, stop + 1) : `${cut.slice(0, cut.lastIndexOf(' '))}…`
}

export const articles = cached(NEWS_TTL, async () => {
  const batches = await Promise.all(
    ARTICLE_FEEDS.map(async ({ source, url }) => {
      try {
        const res = await fetch(url, {
          signal: AbortSignal.timeout(TIMEOUT),
          headers: { 'user-agent': 'Mozilla/5.0 JARVIS' },
        })
        if (!res.ok) return []
        return [...(await res.text()).matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 12).map(([, item]) => ({
          title: tag(item, 'title'),
          source,
          summary: excerpt(plain(tag(item, 'description'))),
          link: tag(item, 'link'),
          at: new Date(tag(item, 'pubDate')).toISOString(),
        }))
      } catch {
        return []
      }
    }),
  )
  return batches.flat().filter((a) => a.title)
})

/**
 * Whether two headlines are the same story.
 *
 * Outlets word the same event differently, so this compares the words that
 * carry the event — names, places, numbers — and ignores the grammar around
 * them. Two headlines match when they share at least three such words and a
 * fair proportion of all of them. Deliberately strict: calling two different
 * stories one is the mistake that makes "confirmed by two outlets" a lie,
 * while missing a match only makes him attribute a story he could have stated.
 */
const FILLER = new Set(
  ('para como mais menos sobre apos após entre contra desde ainda pode podem deve devem ' +
    'diz dizem afirma anuncia novo nova novos novas anos dias hoje ontem amanha amanhã ' +
    'that this with from after over into says said will have been were their about').split(' '),
)
const keywords = (title) =>
  new Set(
    title
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .split(/[^a-z0-9]+/)
      .filter((w) => (w.length >= 4 || /^\d{2,}$/.test(w)) && !FILLER.has(w)),
  )

function sameStory(a, b) {
  const ka = keywords(a)
  const kb = keywords(b)
  let shared = 0
  for (const w of ka) if (kb.has(w)) shared++
  return shared >= 3 && shared / Math.min(ka.size, kb.size) >= 0.5
}

/**
 * The top stories, each with the outlets found carrying it.
 *
 * A story with one outlet behind it is that outlet's report; with two or more
 * it is something that can be stated. The list of names is what lets him tell
 * the two apart out loud.
 */
export const verified = cached(NEWS_TTL, async () => {
  const [top, more] = await Promise.all([news(), articles().catch(() => [])])
  const pool = [...top, ...more]
  return top.map((story) => {
    const outlets = new Set([story.source])
    for (const other of pool) {
      if (other.source !== story.source && sameStory(story.title, other.title)) outlets.add(other.source)
    }
    const text = more.find((a) => sameStory(story.title, a.title))
    return { ...story, outlets: [...outlets], summary: text?.summary ?? '' }
  })
})

/**
 * The months ahead: how much rain to expect, and how sure that is.
 *
 * A forecast past two weeks is not "it will rain on the 14th" — nobody can
 * know that. It is fifty-one runs of the same model started from slightly
 * different conditions, and what can honestly be read off them is a total per
 * month and how far the runs disagree. So each month is given as a middle
 * value with a low and a high around it, and the spread is the forecast's own
 * statement of its confidence.
 */
export const outlook = cached(6 * 60 * 60_000, async () => {
  const at = await place()
  const data = await getJson(
    'https://seasonal-api.open-meteo.com/v1/seasonal?timezone=auto&forecast_days=183' +
      `&latitude=${at.lat}&longitude=${at.lon}&daily=precipitation_sum`,
  )
  const members = Object.keys(data.daily).filter((k) => /^precipitation_sum_member\d+$/.test(k))
  const months = new Map()
  data.daily.time.forEach((day, i) => {
    const key = day.slice(0, 7)
    if (!months.has(key)) months.set(key, { days: 0, totals: members.map(() => 0) })
    const month = months.get(key)
    month.days++
    members.forEach((m, j) => {
      month.totals[j] += data.daily[m][i] ?? 0
    })
  })
  const pick = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]
  return {
    city: at.city,
    months: [...months.entries()]
      .map(([month, { days, totals }]) => {
        const sorted = [...totals].sort((a, b) => a - b)
        const [y, m] = month.split('-').map(Number)
        return {
          month,
          // A month the forecast only partly covers would read as a dry one.
          whole: days >= new Date(y, m, 0).getDate(),
          mm: Math.round(pick(sorted, 0.5)),
          low: Math.round(pick(sorted, 0.2)),
          high: Math.round(pick(sorted, 0.8)),
        }
      })
      .filter((m) => m.whole)
      .slice(0, 5),
  }
})

/**
 * What is already known about the outside world, as a few lines of text for a
 * model's prompt — the forecast and the rates as last fetched.
 *
 * This is what lets "how's the weather" be answered at once and by the small
 * model, instead of costing an agent turn and a web search to rediscover a
 * figure that is sitting in this process. Read from the cache only: it never
 * makes a request, and says nothing about what has not been fetched yet.
 */
export function worldNote() {
  const lines = []
  const w = weather.peek()
  if (w) {
    lines.push(
      `Weather in ${w.city} right now: ${Math.round(w.now.temp)}°C (feels ${Math.round(w.now.feels)}°C), ` +
        `humidity ${Math.round(w.now.humidity)}%, wind ${Math.round(w.now.wind)} km/h. ` +
        `Today ${Math.round(w.today.min)}–${Math.round(w.today.max)}°C, ${w.today.rain}% chance of rain. ` +
        `Tomorrow ${Math.round(w.tomorrow.min)}–${Math.round(w.tomorrow.max)}°C, ${w.tomorrow.rain}% chance of rain.`,
    )
  }
  const m = markets.peek()
  if (m?.length) {
    lines.push(
      'Exchange rates in Brazilian reais: ' +
        m.map((q) => `${q.name} ${q.last >= 1000 ? Math.round(q.last) : q.last.toFixed(2)} (${q.dayPct >= 0 ? '+' : ''}${q.dayPct.toFixed(2)}% today)`).join(', ') +
        '.',
    )
  }
  const n = verified.peek() ?? news.peek()
  if (n?.length) {
    lines.push(
      "Today's top stories, with the outlets carrying each. One outlet: attribute it to that outlet. " +
        'Two or more: it may be stated as established.\n' +
        n
          .slice(0, 5)
          .map(
            (h) =>
              `  • "${h.title}" — ${(h.outlets ?? [h.source]).join(', ')}` +
              (h.summary ? `. ${h.summary.slice(0, 240)}` : ''),
          )
          .join('\n'),
    )
  }
  const o = outlook.peek()
  if (o?.months?.length) {
    lines.push(
      `Rain outlook for ${o.city}, month by month, as a likely total in millimetres with the range the ` +
        'forecast runs span (a wide range means low confidence; never give a day-by-day forecast from this): ' +
        o.months.map((m) => `${m.month} about ${m.mm} mm (${m.low}–${m.high})`).join('; ') +
        '.',
    )
  }
  if (!lines.length) return ''
  return '\n\nLive readings you may state as fact (fetched minutes ago, their own city):\n- ' + lines.join('\n- ')
}

// Fetched once at start so the first question about either finds them here.
void weather().catch(() => {})
void markets().catch(() => {})
void verified().catch(() => {})
void outlook().catch(() => {})
