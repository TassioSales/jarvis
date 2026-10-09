/**
 * The WMO weather codes Open-Meteo reports, folded down to what is worth
 * saying. Returned in English; callers pass it through `t()`.
 */
export function sky(code: number): string {
  if (code === 0) return 'Clear sky'
  if (code === 1) return 'Mostly clear'
  if (code === 2) return 'Partly cloudy'
  if (code === 3) return 'Overcast'
  if (code === 45 || code === 48) return 'Fog'
  if (code >= 51 && code <= 57) return 'Drizzle'
  if (code === 65 || code === 67 || code === 82) return 'Heavy rain'
  if (code >= 61 && code <= 67) return 'Rain'
  if (code >= 71 && code <= 77) return 'Snow'
  if (code >= 80 && code <= 86) return 'Showers'
  if (code >= 95) return 'Thunderstorm'
  return 'Overcast'
}
