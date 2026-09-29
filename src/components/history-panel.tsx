import React, { useEffect, useMemo, useRef, useState } from 'react'
import { CloudProviderLogo, CountryFlag } from '@app/components'
import { CellHistory, HistoryPoint, fetchCellHistory } from '@app/fns/probe-history'

export interface HistoryPanelProps {
  origin: string
  originVendor: string | null
  originCode: string
  originCity?: string
  provider: string
  providerName: string
  region: string
  regionLocation: string
  regionCountry: string
  onClose: () => void
}

const CHART_W = 640
const CHART_H = 140
const PAD_L = 40
const PAD_R = 12
const PAD_T = 12
const PAD_B = 22

type Scale = { x: (t: number) => number; y: (v: number) => number }

function useTooltip() {
  const [hover, setHover] = useState<{ i: number; px: number } | null>(null)
  return { hover, setHover }
}

/**
 * Format an x-axis / tooltip tick for a given granularity.
 *
 * Locale is pinned to 'en-US' on purpose. The rest of the UI is English-only, so
 * letting these ticks follow the visitor's browser locale (the old `[]` argument)
 * rendered Hangul/CJK/Arabic dates like "9월 20일" on some visitors — which then
 * fell back to each OS's default CJK font (Malgun Gothic on Windows). Pinning to
 * 'en-US' keeps every visitor on Latin glyphs (fully covered by Inter), also
 * avoids Eastern-Arabic digits breaking SVG tick widths and SSR/CSR hydration
 * mismatches. hour12:false keeps the narrow axis on a 24-hour clock; the time
 * zone still follows the viewer's local zone.
 */
function fmtTick(unixSec: number, mode: '24h' | '7d'): string {
  const d = new Date(unixSec * 1000)
  if (mode === '24h') {
    return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })
  }
  // Data is stored/aggregated in UTC, but ticks are re-derived on the viewer's local
  // day boundaries (see the 7d tick block), so format the date in local time too.
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

/**
 * Downsample a fine series to one point per local calendar day, using the day's
 * median (P50) as the value and that day's local noon as the plotted time. Data
 * is stored/aggregated in UTC; here we re-bucket on the viewer's LOCAL day
 * boundaries and re-render, so the "Daily" points — and the x-axis day ticks that
 * align with them — match the dates the viewer actually sees in their time zone.
 * Used by the 7-day "Daily" toggle — no refetch needed.
 */
function toDaily(points: HistoryPoint[]): HistoryPoint[] {
  const byDay = new Map<number, number[]>()
  for (const p of points) {
    const d = new Date(p.t * 1000)
    // Local noon of this sample's local calendar day (stable per-day key + plot x).
    const noon = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12, 0, 0, 0)
    const key = Math.floor(noon.getTime() / 1000)
    const arr = byDay.get(key)
    if (arr) arr.push(p.ms)
    else byDay.set(key, [p.ms])
  }
  const out: HistoryPoint[] = []
  for (const [t, vals] of byDay) {
    const s = [...vals].sort((a, b) => a - b)
    out.push({ t, ms: s[Math.floor(s.length / 2)] })
  }
  return out.sort((a, b) => a.t - b.t)
}

/**
 * Dependency-free SVG latency chart with x-axis time/date ticks, a hover
 * crosshair, and an inline value read-out. `mode` picks the tick format:
 * clock time for the 24h series, calendar date for the 7-day series.
 */
function LatencyChart({ points, mode, label }: { points: HistoryPoint[]; mode: '24h' | '7d'; label: string }): JSX.Element {
  const svgRef = useRef<SVGSVGElement>(null)
  const { hover, setHover } = useTooltip()

  const model = useMemo(() => {
    if (points.length === 0) return null
    const ms = points.map((p) => p.ms)
    let msMin = Math.min(...ms)
    let msMax = Math.max(...ms)
    if (msMin === msMax) {
      // Give a flat series some vertical room so the line isn't glued to an edge.
      msMin = Math.max(0, msMin - 5)
      msMax = msMax + 5
    }
    // Fixed x timeline: always span the full window (now-24h..now or now-7d..now)
    // so a partially-filled series reads as "still accumulating" rather than
    // being stretched to fill the axis.
    const windowSec = mode === '24h' ? 24 * 3600 : 7 * 86400
    const tMax = Math.floor(Date.now() / 1000)
    const tMin = tMax - windowSec
    const spanT = windowSec
    const spanMs = msMax - msMin || 1
    const scale: Scale = {
      x: (t) => PAD_L + ((t - tMin) / spanT) * (CHART_W - PAD_L - PAD_R),
      y: (v) => PAD_T + (1 - (v - msMin) / spanMs) * (CHART_H - PAD_T - PAD_B),
    }
    const d = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${scale.x(p.t).toFixed(1)},${scale.y(p.ms).toFixed(1)}`).join(' ')
    // Area fills only under the drawn data span, not the whole (possibly empty) window.
    const firstX = scale.x(points[0].t)
    const lastX = scale.x(points[points.length - 1].t)
    const area = `${d} L${lastX.toFixed(1)},${(CHART_H - PAD_B).toFixed(1)} L${firstX.toFixed(1)},${(CHART_H - PAD_B).toFixed(1)} Z`
    // X ticks. 24h: four equal time intervals across the window (a clock axis
    // reads fine that way). 7d: one tick per calendar day so every day is labelled
    // and the ticks line up with the daily data points (plotted at 12:00Z) instead
    // of four sparse marks that miss most points. Ticks sit at local midnight
    // boundaries within the window; the leading partial day is included only if it
    // has room so its label doesn't collide with the y-axis.
    let xTicks: { t: number; anchor: 'start' | 'middle' | 'end' }[]
    if (mode === '24h') {
      const xTickCount = 4
      xTicks = Array.from({ length: xTickCount }, (_, k) => ({
        t: tMin + Math.round((k / (xTickCount - 1)) * windowSec),
        anchor: k === 0 ? 'start' : k === xTickCount - 1 ? 'end' : 'middle',
      }))
    } else {
      // 7d: one tick per LOCAL calendar day the window covers, placed at local noon.
      // Data is UTC but we re-derive ticks on the viewer's local day boundaries so
      // they line up with the "Daily" points (also bucketed to local noon) and read
      // as the dates the viewer sees. Walk local-midnight to local-midnight so DST
      // shifts are handled by the Date arithmetic rather than a fixed 86400s step.
      const days: number[] = []
      const cur = new Date(tMin * 1000)
      cur.setHours(12, 0, 0, 0) // local noon of tMin's local day
      for (; cur.getTime() <= tMax * 1000; cur.setDate(cur.getDate() + 1)) {
        const t = Math.floor(cur.getTime() / 1000)
        if (t >= tMin) days.push(t)
      }
      // Drop a leading tick too close to the y-axis so its label can't collide with it.
      const minX = PAD_L + 14
      xTicks = days.filter((t) => scale.x(t) >= minX).map((t) => ({ t, anchor: 'middle' as const }))
    }
    const yTicks = [msMin, (msMin + msMax) / 2, msMax]
    return { scale, d, area, tMin, tMax, msMin, msMax, xTicks, yTicks }
  }, [points, mode])

  if (!model || points.length === 0) {
    return (
      <div className="history-empty" role="img" aria-label={`${label}: no samples yet`}>
        No samples yet — history is still accumulating.
      </div>
    )
  }

  const { scale, d, area, xTicks, yTicks } = model

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const svg = svgRef.current
    if (!svg) return
    const rect = svg.getBoundingClientRect()
    const px = ((e.clientX - rect.left) / rect.width) * CHART_W
    // Nearest point by x.
    let best = 0
    let bestDist = Infinity
    for (let i = 0; i < points.length; i++) {
      const dist = Math.abs(scale.x(points[i].t) - px)
      if (dist < bestDist) {
        bestDist = dist
        best = i
      }
    }
    setHover({ i: best, px: scale.x(points[best].t) })
  }

  const hp = hover ? points[hover.i] : null
  const desc = `${label}: ${points.length} samples, ${model.msMin.toFixed(0)}–${model.msMax.toFixed(0)}ms`

  return (
    <div className="history-chart-wrap">
      <div className="history-readout" role="status" aria-live="polite" aria-atomic="true">
        {hp ? (
          <>
            <span className="history-readout-ms">{Math.round(hp.ms)}ms</span>
            <span className="history-readout-t">{fmtTick(hp.t, mode)}</span>
          </>
        ) : points.length <= 1 ? (
          <span className="history-readout-hint">still accumulating — one point so far</span>
        ) : (
          <span className="history-readout-hint">hover or tap for values</span>
        )}
      </div>
      <svg
        ref={svgRef}
        className="history-svg"
        viewBox={`0 0 ${CHART_W} ${CHART_H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={desc}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId)
          onMove(e)
        }}
        onPointerMove={onMove}
        onPointerLeave={(e) => {
          if (e.pointerType === 'mouse') setHover(null)
        }}
      >
        <title>{desc}</title>
        {/* y gridlines + labels */}
        {yTicks.map((v, i) => (
          <g key={`y${i}`}>
            <line className="history-grid" x1={PAD_L} x2={CHART_W - PAD_R} y1={scale.y(v)} y2={scale.y(v)} />
            <text className="history-axis" x={PAD_L - 5} y={scale.y(v) + 3} textAnchor="end">
              {Math.round(v)}
            </text>
          </g>
        ))}
        {/* x ticks */}
        {xTicks.map((p, i) => (
          <text key={`x${i}`} className="history-axis" x={scale.x(p.t)} y={CHART_H - 6} textAnchor={p.anchor}>
            {fmtTick(p.t, mode)}
          </text>
        ))}
        <path className="history-area" d={area} />
        <path className="history-line" d={d} fill="none" stroke="currentColor" strokeWidth="1.5" />
        {/* hover crosshair + marker */}
        {hp ? (
          <g>
            <line className="history-crosshair" x1={scale.x(hp.t)} x2={scale.x(hp.t)} y1={PAD_T} y2={CHART_H - PAD_B} />
            <circle cx={scale.x(hp.t)} cy={scale.y(hp.ms)} r="3" fill="currentColor" />
          </g>
        ) : (
          <circle cx={scale.x(points[points.length - 1].t)} cy={scale.y(points[points.length - 1].ms)} r="2.5" fill="currentColor" />
        )}
      </svg>
    </div>
  )
}

/** Provider logo + optional country flag chip used on each side of the header. */
function Endpoint({
  label,
  vendor,
  vendorName,
  countryCode,
  code,
  sub,
}: {
  label: string
  vendor: string | null
  vendorName: string
  countryCode?: string
  code: string
  sub?: string
}): JSX.Element {
  // No vercel.svg asset exists; mirror the main matrix which hides it.
  const showLogo = vendor && vendor !== 'vercel'
  return (
    <div className="history-endpoint">
      <span className="history-endpoint-role">{label}</span>
      <div className="history-endpoint-body">
        <div className="history-endpoint-icons">
          {showLogo ? (
            <span className="history-logo-chip">
              <CloudProviderLogo providerKey={vendor as string} providerName={vendorName} width={20} />
            </span>
          ) : null}
          {countryCode ? <CountryFlag countryCode={countryCode} width={18} /> : null}
        </div>
        <div className="history-endpoint-text">
          <span className="history-endpoint-code">{code}</span>
          {sub ? <span className="history-endpoint-sub">{sub}</span> : null}
        </div>
      </div>
    </div>
  )
}

export function HistoryPanel(props: HistoryPanelProps): JSX.Element {
  const [data, setData] = useState<CellHistory | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [weekPrecision, setWeekPrecision] = useState<'daily' | '2h'>('daily')
  const closeRef = useRef<HTMLButtonElement>(null)
  const modalRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const ctrl = new AbortController()
    setLoading(true)
    setError(null)
    fetchCellHistory(props.origin, props.provider, props.region, ctrl.signal)
      .then((d) => setData(d))
      .catch((e: Error) => {
        if (e.name !== 'AbortError') setError(e.message || 'failed to load')
      })
      .finally(() => setLoading(false))
    return () => ctrl.abort()
  }, [props.origin, props.provider, props.region])

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    closeRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        props.onClose()
        return
      }
      if (e.key !== 'Tab') return
      const modal = modalRef.current
      if (!modal) return
      const focusable = modal.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = previousOverflow
      previousFocus?.focus()
    }
  }, [props.onClose])

  const stats = useMemo(() => {
    // Stats reflect the 24h intraday samples only — mixing them with the
    // 7-day daily aggregates would skew the percentile.
    const all = (data?.intraday ?? []).map((p) => p.ms)
    if (all.length === 0) return null
    const s = [...all].sort((a, b) => a - b)
    const p50 = s[Math.floor(s.length / 2)]
    return { min: s[0], max: s[s.length - 1], p50, n: all.length }
  }, [data])

  const originVendorName =
    props.originVendor === 'aws'
      ? 'AWS'
      : props.originVendor === 'gcp'
        ? 'Google Cloud'
        : props.originVendor === 'azure'
          ? 'Azure'
          : props.originVendor === 'vercel'
            ? 'Vercel'
            : 'origin'

  return (
    <div className="history-overlay">
      <button type="button" className="history-backdrop" aria-label="Close latency history" tabIndex={-1} onClick={props.onClose} />
      <div className="history-modal" ref={modalRef} role="dialog" aria-modal="true" aria-label="Latency history">
        <div className="history-head">
          <div className="history-route">
            <Endpoint label="From (probe)" vendor={props.originVendor} vendorName={originVendorName} code={props.originCode} sub={props.originCity} />
            <span className="history-arrow" aria-hidden="true">
              →
            </span>
            <Endpoint
              label="To (target)"
              vendor={props.provider}
              vendorName={props.providerName}
              countryCode={props.regionCountry}
              code={props.region}
              sub={props.regionLocation}
            />
          </div>
          <button ref={closeRef} type="button" className="history-close" onClick={props.onClose} aria-label="Close">
            ✕
          </button>
        </div>

        {loading ? (
          <div className="history-empty" role="status" aria-live="polite">
            Loading history…
          </div>
        ) : error ? (
          <div className="history-empty" role="alert" aria-live="assertive">
            Couldn’t load history ({error}).
          </div>
        ) : (
          <>
            {stats ? (
              <div className="history-stats" aria-label="Last 24 hours summary">
                <span className="history-stat-range">24h</span>
                <span className="history-stat">
                  <span className="history-stat-k">min</span> {stats.min}ms
                </span>
                <span className="history-stat">
                  <span className="history-stat-k">p50</span> {stats.p50}ms
                </span>
                <span className="history-stat">
                  <span className="history-stat-k">max</span> {stats.max}ms
                </span>
                <span className="history-stat">
                  <span className="history-stat-k">samples</span> {stats.n}
                </span>
              </div>
            ) : null}
            <div className="history-section-label">Last 24h</div>
            <LatencyChart points={data?.intraday ?? []} mode="24h" label="Last 24 hours" />
            <div className="history-section-head">
              <span className="history-section-label">Last 7 days</span>
              <div className="history-toggle" role="group" aria-label="7-day precision">
                <button
                  type="button"
                  className={weekPrecision === 'daily' ? 'is-on' : ''}
                  aria-pressed={weekPrecision === 'daily'}
                  onClick={() => setWeekPrecision('daily')}
                >
                  Daily
                </button>
                <button
                  type="button"
                  className={weekPrecision === '2h' ? 'is-on' : ''}
                  aria-pressed={weekPrecision === '2h'}
                  onClick={() => setWeekPrecision('2h')}
                >
                  2h
                </button>
              </div>
            </div>
            <LatencyChart
              points={weekPrecision === 'daily' ? toDaily(data?.daily ?? []) : (data?.daily ?? [])}
              mode="7d"
              label={weekPrecision === 'daily' ? 'Last 7 days (daily P50)' : 'Last 7 days (2h)'}
            />
          </>
        )}
      </div>
    </div>
  )
}
