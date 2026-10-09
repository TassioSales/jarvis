/**
 * The small drawn pieces the side monitors share: a weather icon and a dial.
 *
 * Line drawings in the interface's own stroke, rather than an icon font or a
 * set of images — they take the accent colour with everything else, stay sharp
 * at any size, and there is nothing to download.
 */

/** Which picture a WMO weather code gets. */
function kind(code: number): 'sun' | 'part' | 'cloud' | 'fog' | 'rain' | 'snow' | 'storm' {
  if (code === 0 || code === 1) return 'sun'
  if (code === 2) return 'part'
  if (code === 3) return 'cloud'
  if (code === 45 || code === 48) return 'fog'
  if (code >= 71 && code <= 77) return 'snow'
  if (code >= 95) return 'storm'
  if (code >= 51) return 'rain'
  return 'cloud'
}

const CLOUD = 'M7 18h10a4 4 0 0 0 .6-7.95A5.5 5.5 0 0 0 7.2 9.1 4.5 4.5 0 0 0 7 18Z'
const RAYS = 'M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4'

export function SkyIcon({ code }: { code: number }) {
  const what = kind(code)
  return (
    <svg className="sky" viewBox="0 0 24 24" aria-hidden="true">
      {what === 'sun' && (
        <>
          <circle cx="12" cy="12" r="4" />
          <path d={RAYS} />
        </>
      )}
      {what === 'part' && (
        <>
          <circle cx="8" cy="8" r="3" />
          <path d="M8 2.5v1.2M2.5 8h1.2M4.1 4.1l.9.9M11.9 4.1l-.9.9" />
          <path d={CLOUD} transform="translate(2 3) scale(.86)" />
        </>
      )}
      {what === 'cloud' && <path d={CLOUD} />}
      {what === 'fog' && (
        <>
          <path d={CLOUD} transform="translate(0 -3)" />
          <path d="M5 18h14M7 21h10" />
        </>
      )}
      {what === 'rain' && (
        <>
          <path d={CLOUD} transform="translate(0 -3)" />
          <path d="M8 18l-1 3M12 18l-1 3M16 18l-1 3" />
        </>
      )}
      {what === 'snow' && (
        <>
          <path d={CLOUD} transform="translate(0 -3)" />
          <path d="M8 19h.01M12 21h.01M16 19h.01" strokeWidth="2.4" />
        </>
      )}
      {what === 'storm' && (
        <>
          <path d={CLOUD} transform="translate(0 -3)" />
          <path d="M12.5 16l-2.5 3.5h3L11 23" />
        </>
      )}
    </svg>
  )
}

/**
 * A reading from 0 to 100 as a three-quarter dial.
 *
 * The number is in the middle in ink; the arc only shows how full. Past 85 the
 * arc takes the warning colour and the word beneath says so too, so the state
 * is never carried by colour alone.
 */
export function Gauge({ label, value, detail }: { label: string; value: number; detail?: string }) {
  const pct = Math.max(0, Math.min(100, value))
  const r = 42
  // 270 degrees of a circle, open at the bottom.
  const sweep = 0.75 * 2 * Math.PI * r
  const hot = pct > 85
  return (
    <div className={`gauge ${hot ? 'gauge-hot' : ''}`}>
      <svg viewBox="0 0 100 100" aria-hidden="true">
        <circle className="gauge-track" cx="50" cy="50" r={r} strokeDasharray={`${sweep} 999`} />
        <circle
          className="gauge-fill"
          cx="50"
          cy="50"
          r={r}
          strokeDasharray={`${(pct / 100) * sweep} 999`}
        />
        <text x="50" y="54" textAnchor="middle" className="gauge-value">
          {Math.round(pct)}
          <tspan className="gauge-unit">%</tspan>
        </text>
      </svg>
      <span className="gauge-label">{label}</span>
      {detail && <span className="gauge-detail">{detail}</span>}
    </div>
  )
}
