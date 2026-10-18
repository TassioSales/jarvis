/**
 * Display formatters for metrics, units and timestamps on the monitors.
 */

export const bytes = (n: number | null | undefined, unit = '') => {
  if (n == null) return '—'
  const k = 1024
  const steps = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = n
  while (v >= k && i < steps.length - 1) {
    v /= k
    i++
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${steps[i]}${unit}`
}
