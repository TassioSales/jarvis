import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'

/**
 * Traffic and travel times, from TomTom.
 *
 * The claude.ai connectors do not reach this bridge — it runs with no settings
 * loaded, on purpose — so the maps are asked directly, with a key of the
 * user's own in TOMTOM_API_KEY. Two calls per question: each end of the trip
 * is turned into coordinates, then one route is computed with live traffic.
 *
 * Read-only throughout, so nothing here waits on consent. Optional: with no
 * key the server is not registered at all.
 */
const KEY = process.env.TOMTOM_API_KEY?.trim()
const COUNTRY = process.env.JARVIS_COUNTRY?.trim() || 'BR'
const API = 'https://api.tomtom.com'

export const mapsReady = () => Boolean(KEY)

const text = (s) => ({ content: [{ type: 'text', text: s }] })

// TomTom takes the key in the query string, so a failed request's URL must
// never be logged or handed back to the model.
async function get(path, params) {
  const url = `${API}${path}?${new URLSearchParams({ ...params, key: KEY })}`
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) })
  if (!res.ok) throw new Error(`TomTom answered ${res.status}`)
  return res.json()
}

async function locate(query) {
  const data = await get(`/search/2/search/${encodeURIComponent(query)}.json`, {
    limit: '1',
    countrySet: COUNTRY,
    language: 'pt-BR',
  })
  const hit = data.results?.[0]
  if (!hit?.position) return null
  return {
    lat: hit.position.lat,
    lon: hit.position.lon,
    label: hit.poi?.name ? `${hit.poi.name}, ${hit.address?.freeformAddress ?? ''}` : hit.address?.freeformAddress,
  }
}

const HOME_WORDS = /^\s*(casa|minha casa|em casa|home|my house|aqui|here)\s*$/i

/**
 * A place, with "casa" (or nothing at all) meaning his home: the exact
 * coordinates when they are set (JARVIS_LAT/LON), since a neighbourhood's name
 * sent to a search can come back as the next town; else his home address.
 */
async function where(query) {
  const home = process.env.JARVIS_HOME_ADDRESS?.trim()
  if (!query?.trim() || HOME_WORDS.test(query) || (home && query.trim() === home)) {
    const lat = Number(process.env.JARVIS_LAT)
    const lon = Number(process.env.JARVIS_LON)
    if (process.env.JARVIS_LAT && Number.isFinite(lat) && Number.isFinite(lon)) {
      return { lat, lon, label: home || 'casa' }
    }
    return home ? locate(home) : null
  }
  return locate(query)
}

const minutes = (s) => Math.round(s / 60)

/**
 * One drive, with traffic, as numbers: for the dashboard as much as the tool.
 * @returns {Promise<{from: string, to: string, minutes: number, km: number, delay: number, usual: number | null} | null>}
 */
export async function routeSummary(from, to) {
  if (!KEY) return null
  const [a, b] = await Promise.all([where(from), where(to)])
  if (!a || !b) return null
  const data = await get(`/routing/1/calculateRoute/${a.lat},${a.lon}:${b.lat},${b.lon}/json`, {
    traffic: 'true',
    travelMode: 'car',
    computeTravelTimeFor: 'all',
  })
  const s = data.routes?.[0]?.summary
  if (!s) return null
  return {
    from: a.label,
    to: b.label,
    minutes: minutes(s.travelTimeInSeconds),
    km: Math.round(s.lengthInMeters / 100) / 10,
    delay: minutes(s.trafficDelayInSeconds ?? 0),
    usual: s.noTrafficTravelTimeInSeconds ? minutes(s.noTrafficTravelTimeInSeconds) : null,
  }
}

export function mapsServer() {
  return createSdkMcpServer({
    name: 'jarvis_maps',
    version: '1.0.0',
    instructions: 'Live traffic and driving time between two places, and looking a place up.',
    alwaysLoad: true,
    tools: [
      tool(
        'route',
        'Driving time between two places right now, with live traffic: minutes, ' +
          'distance, and how much of the time is delay. Give each end as an address ' +
          'or a place name, as specific as you have it (street, neighbourhood, city). ' +
          'Leave `from` out when he does not say where from: it starts at his home. "casa" means his home too.',
        {
          from: z.string().optional().describe('Where the trip starts. Omit for his home.'),
          to: z.string().describe('Where it ends ("casa" for his home).'),
        },
        async ({ from, to }) => {
          try {
            const [a, b] = await Promise.all([where(from), where(to)])
            if (!a) return text(from ? `Could not find "${from}" on the map.` : 'His home address is not set.')
            if (!b) return text(`Could not find "${to}" on the map.`)
            const data = await get(
              `/routing/1/calculateRoute/${a.lat},${a.lon}:${b.lat},${b.lon}/json`,
              { traffic: 'true', travelMode: 'car', computeTravelTimeFor: 'all' },
            )
            const s = data.routes?.[0]?.summary
            if (!s) return text('No route was found between those two places.')
            const usual = s.noTrafficTravelTimeInSeconds
            return text(
              `From ${a.label} to ${b.label}: ${minutes(s.travelTimeInSeconds)} min now, ` +
                `${(s.lengthInMeters / 1000).toFixed(1)} km. ` +
                `Traffic delay: ${minutes(s.trafficDelayInSeconds ?? 0)} min` +
                (usual ? `; with empty roads it takes ${minutes(usual)} min.` : '.'),
            )
          } catch (err) {
            return text(`The maps service did not answer (${err?.message ?? 'error'}).`)
          }
        },
      ),
      tool(
        'find_place',
        'Look a place or an address up: its full address and coordinates.',
        { query: z.string() },
        async ({ query }) => {
          try {
            const hit = await locate(query)
            return text(hit ? `${hit.label} (${hit.lat}, ${hit.lon})` : `Nothing found for "${query}".`)
          } catch (err) {
            return text(`The maps service did not answer (${err?.message ?? 'error'}).`)
          }
        },
      ),
    ],
  })
}
