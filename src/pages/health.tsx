import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import Head from 'next/head'
import dynamic from 'next/dynamic'
import { GetStaticPropsResult } from 'next'
import { CloudProvider, CloudRegion, getAllCloudRegions, getAllProviders } from '@app/data'
import { CloudProviderLogo } from '@app/components'
import { SiteHeader } from '@app/components/site-header'
// HistoryPanel is a sizeable SVG charting component that only renders after a
// cell click. Load it lazily so its code stays out of the initial /health
// bundle (smaller parse/hydrate cost — also lighter on low-end mobile).
const HistoryPanel = dynamic(() => import('@app/components/history-panel').then((m) => m.HistoryPanel), { ssr: false })
import {
  MatrixSnapshot,
  ProbeColumn,
  ORIGIN_CITIES,
  ProbeResult,
  columnCode,
  normalizeCompactMatrixSnapshot,
  MIN_N24H,
  sameCloudKind,
  originVendor,
  originVendorRank,
  originContinent,
  ORIGIN_CONTINENT_ORDER,
  ORIGIN_CONTINENTS,
} from '@app/fns/probe-snapshot'
import { detectClientGeo } from '@app/fns/client-geo'
import { getSiteUrl } from '../site-config'

/* eslint-disable jsx-a11y/no-noninteractive-tabindex -- the horizontally scrollable matrix region must be keyboard-focusable */

// The matrix only reads these four region fields. Shipping the full CloudRegion
// (with ping_url ~19KB and display_name ~10KB across 301 regions) blows the page
// data past Next.js's 128KB warning threshold, so props carry a slimmed shape.
type HealthRegion = Pick<CloudRegion, 'key' | 'country' | 'location' | 'geo'>

// Pre-hydration fallbacks for the From-origin filter pills. Before the client
// matrix fetch resolves, `columns` is empty, so these pills would be absent then
// appear after load — pushing the matrix down (CLS). Render the stable deployed
// set at first paint so the pills hold their space and don't change count once
// data arrives.
//   - Vendors: the live fleet is aws/gcp/azure (no vercel origin today). Listed
//     explicitly because ORIGIN_CONTINENTS keys are region codes without a
//     vendor prefix, so they can't be derived from there.
//   - Continents: derived from ORIGIN_CONTINENTS (same catalog the live columns
//     map through via originContinent), kept in ORIGIN_CONTINENT_ORDER.
const FROM_VENDOR_FALLBACK = ['aws', 'gcp', 'azure']
const FROM_CONTINENT_FALLBACK = ORIGIN_CONTINENT_ORDER.filter((c) => Object.values(ORIGIN_CONTINENTS).includes(c))

interface HealthProps {
  providers: CloudProvider[]
  regions: Record<string, HealthRegion[]>
  geos: Record<string, string[]>
}

interface CatalogRow {
  key: string
  provider: CloudProvider
  region: HealthRegion
}

export async function getStaticProps(): Promise<GetStaticPropsResult<HealthProps>> {
  const providers = getAllProviders()
  const fullRegions = getAllCloudRegions()

  // Slim each region to only the fields the matrix renders, dropping ping_url and
  // display_name so the serialized page data stays under Next.js's 128KB threshold.
  const regions: Record<string, HealthRegion[]> = {}
  for (const [key, list] of Object.entries(fullRegions)) {
    regions[key] = list.map((r) => ({ key: r.key, country: r.country, location: r.location, geo: r.geo }))
  }

  return {
    props: {
      providers,
      regions,
      geos: Object.values(regions).reduce(
        (prev, curr) => {
          for (const region of curr) {
            if (!prev[region.geo]) prev[region.geo] = []
            if (!prev[region.geo].includes(region.country)) prev[region.geo] = [...prev[region.geo], region.country]
          }
          return prev
        },
        {} as Record<string, string[]>
      ),
    },
    revalidate: 900,
  }
}

const GEO_ORDER = ['North America', 'Europe', 'Asia', 'Middle East', 'South America', 'Oceania', 'Africa']

function formatUpdated(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m ${s % 60}s`
}

function columnSubtitle(col: ProbeColumn): string {
  const when = col.stale ? `stale · ${formatUpdated(col.at)}` : formatUpdated(col.at)
  if (typeof col.durationMs !== 'number') return when
  return `${when} · ${formatDuration(col.durationMs)}`
}

type LatencyBand = 'fast' | 'mid' | 'slow' | 'fail' | 'empty'
type Metric = 'latest' | 'p24'
type FocusBand = 'fast' | 'mid' | 'slow'

interface SelectedCell {
  origin: string
  originVendor: string | null
  originCode: string
  originCity?: string
  provider: string
  providerName: string
  region: string
  regionLocation: string
  regionCountry: string
}

function latencyBand(ms: number | null, ok: boolean): LatencyBand {
  if (!ok || ms == null) return 'fail'
  if (ms < 100) return 'fast'
  if (ms <= 180) return 'mid'
  return 'slow'
}

// The legend doubles as a band filter: clicking a swatch focuses that latency
// band and dims every other cell, which is the only practical way to scan 301
// rows for, say, the slow ones. Labels must match the thresholds above.
const LEGEND_BANDS: { key: 'fast' | 'mid' | 'slow'; label: string }[] = [
  { key: 'fast', label: '< 100ms' },
  { key: 'mid', label: '100–180ms' },
  { key: 'slow', label: '> 180ms' },
]

function formatMs(ms: number): string {
  return `${Math.round(ms)}ms`
}

function columnCity(col: ProbeColumn): string | undefined {
  return ORIGIN_CITIES[columnCode(col)]
}

// The matrix body is virtualized: only rows near the viewport are in the DOM,
// with spacer rows standing in for the rest. Provider group headers interleave
// with region rows, so both live in one flat list that the window slices by index.
type MatrixItem = { kind: 'group'; provider: CloudProvider } | { kind: 'row'; row: CatalogRow }

function buildMatrixItems(rows: CatalogRow[], showProvider: boolean): MatrixItem[] {
  const items: MatrixItem[] = []
  rows.forEach((row, index) => {
    if (showProvider && (index === 0 || rows[index - 1].provider.key !== row.provider.key)) {
      items.push({ kind: 'group', provider: row.provider })
    }
    items.push({ kind: 'row', row })
  })
  return items
}

// Header rows ahead of the body, for aria-rowindex (continent row + origin row).
const MATRIX_HEAD_ROWS = 2
// Extra rows rendered past each viewport edge so a touch fling does not outrun rendering.
const OVERSCAN_ROWS = 8
// The window edges snap to this many rows so small scrolls do not re-render at all.
const RANGE_STEP = 4
// Rendered before the scroll container has been measured.
const INITIAL_RENDER_ROWS = 40

// Index of the item whose [offsets[i], offsets[i + 1]) span contains y.
function itemAt(offsets: number[], y: number): number {
  let lo = 0
  let hi = Math.max(0, offsets.length - 2)
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (offsets[mid] <= y) lo = mid
    else hi = mid - 1
  }
  return lo
}

function selectedCellFor(col: ProbeColumn, row: CatalogRow): SelectedCell {
  return {
    origin: col.id,
    originVendor: originVendor(col),
    originCode: columnCode(col),
    originCity: columnCity(col),
    provider: row.provider.key,
    providerName: row.provider.display_name,
    region: row.region.key,
    regionLocation: row.region.location,
    regionCountry: row.region.country,
  }
}

const MatrixGroupRow = React.memo(function MatrixGroupRow({
  index,
  provider,
  columns,
}: {
  index: number
  provider: CloudProvider
  columns: ProbeColumn[]
}): JSX.Element {
  return (
    <tr className="matrix-group-row" data-i={index} aria-rowindex={index + MATRIX_HEAD_ROWS + 1}>
      <th className="matrix-group" scope="rowgroup">
        <div className="matrix-to-provider">
          <CloudProviderLogo width={14} providerKey={provider.key} providerName={provider.display_name} />
          <span>{provider.display_name}</span>
        </div>
      </th>
      {columns.map((col) => (
        <td key={col.id} className="matrix-group-fill" />
      ))}
    </tr>
  )
})

// One region row. Memoized so shifting the virtual window only mounts the rows
// entering it; rows that stay in view are not re-rendered. Clicks and keys are
// handled once on the tbody (MatrixBody), so cells carry no handlers.
const MatrixRow = React.memo(function MatrixRow({
  index,
  row,
  columns,
  lookup,
  metric,
  compact,
  tabCol,
}: {
  index: number
  row: CatalogRow
  columns: ProbeColumn[]
  lookup: Map<string, ProbeResult>
  metric: Metric
  compact: boolean
  // Column holding the grid's single tab stop (roving tabindex), or -1.
  tabCol: number
}): JSX.Element {
  return (
    <tr className="matrix-row" data-i={index} aria-rowindex={index + MATRIX_HEAD_ROWS + 1}>
      <th className="matrix-to" title={`${row.provider.display_name} · ${row.region.location}`} scope="row">
        <code>{row.region.key}</code>
        <span className="matrix-to-location">{row.region.location}</span>
      </th>
      {columns.map((col, c) => {
        const cell = lookup.get(`${col.id}|${row.provider.key}|${row.region.key}`)
        const kind = sameCloudKind(col, row.provider.key, row.region.location)
        const displayMs = metric === 'p24' ? (cell?.ms24h ?? cell?.ms ?? null) : (cell?.ms ?? null)
        const displayOk = metric === 'p24' ? cell?.ms24h != null || Boolean(cell?.ok && cell.ms != null) : Boolean(cell?.ok && cell.ms != null)
        const band = cell ? latencyBand(displayMs, displayOk && displayMs != null) : 'empty'
        const isMark = kind === 'on-net' || kind === 'adjacent'

        // Compact mode skips the verbose per-cell tooltip/aria strings
        // entirely — on thousands of cells that string building is the
        // GC pressure we are cutting on low-end phones. We still give
        // screen readers a short, meaningful label, and full detail is
        // one tap away in the history modal.
        let title: string | undefined
        let ariaLabel: string
        let markTip: string | null = null
        if (compact) {
          const short = !cell ? 'no sample' : displayMs == null ? 'unreachable' : formatMs(displayMs)
          ariaLabel = cell ? `${short}, open history` : short
        } else {
          const failText = cell?.error === 'timeout' ? 'timeout' : cell?.error === 'network' ? 'network' : 'unreachable'
          const parts = [
            !cell
              ? 'no sample'
              : displayMs == null
                ? failText
                : `${formatMs(displayMs)} ${metric === 'p24' ? '24h P50' : 'latest min'} from ${columnCode(col)} to ${row.region.key}`,
          ]
          if (cell?.ms != null) parts.push(`latest ${formatMs(cell.ms)}`)
          if (cell?.ms24h != null) parts.push(`24h ${formatMs(cell.ms24h)} n=${cell.n24h ?? '?'}`)
          if (cell?.samples) parts.push(`${cell.samples} samples`)
          markTip =
            kind === 'on-net'
              ? 'Same cloud in the same metro — this rides the provider backbone, so it is faster than a real internet path. Not comparable with the other cells.'
              : kind === 'adjacent'
                ? 'Vercel origin hitting AWS in the same metro — close to on-net, so it is faster than a real internet path. Not comparable with the other cells.'
                : null
          ariaLabel = cell ? `${parts.join('. ')}${markTip ? `. ${markTip}` : ''}. Open latency history.` : parts.join('. ')
          title = cell ? `${parts.join(' · ')} · click for history` : parts.join(' · ')
        }
        return (
          <td
            key={col.id}
            className={`matrix-cell ${band}${kind === 'on-net' ? ' on-net' : kind === 'adjacent' ? ' adjacent' : ''}${cell ? ' clickable' : ''}`}
            tabIndex={c === tabCol ? 0 : -1}
            title={title}
            aria-label={ariaLabel}
          >
            {cell ? (displayMs == null ? '—' : formatMs(displayMs)) : '—'}
            {cell && isMark ? <span className="matrix-mark" data-tip={markTip ?? undefined} aria-hidden="true" /> : null}
          </td>
        )
      })}
    </tr>
  )
})

const MatrixBody = React.memo(function MatrixBody({
  items,
  columns,
  lookup,
  metric,
  compact,
  onSelectCell,
}: {
  items: MatrixItem[]
  columns: ProbeColumn[]
  lookup: Map<string, ProbeResult>
  metric: Metric
  // Compact mode (small screens): skip building the verbose per-cell title and
  // aria-label strings. Thousands of cells each allocating two long joined
  // strings is a real memory/GC burden on low-end phones, and touch devices
  // never show the title tooltip anyway. Full detail stays one tap away in the
  // HistoryPanel modal opened on cell click.
  compact: boolean
  onSelectCell: (cell: SelectedCell) => void
}): JSX.Element {
  const bodyRef = useRef<HTMLTableSectionElement>(null)
  // Rendered height of each row kind, measured from the DOM after every render.
  // CSS pins every row of a kind to one height, so one sample per kind is exact.
  const [heights, setHeights] = useState({ row: 29, group: 29 })
  const [range, setRange] = useState(() => ({ start: 0, end: Math.min(items.length, INITIAL_RENDER_ROWS) }))
  // Roving-tabindex position (item index + column index) of the grid's tab stop.
  const [active, setActive] = useState<{ i: number; c: number } | null>(null)
  // Keyboard target whose row was outside the window; focused once it renders.
  const pendingFocus = useRef<{ i: number; c: number } | null>(null)
  const headHeight = useRef(0)

  // offsets[i] = top of item i within the body; offsets[items.length] = body height.
  const offsets = useMemo(() => {
    const out = new Array<number>(items.length + 1)
    out[0] = 0
    for (let i = 0; i < items.length; i++) out[i + 1] = out[i] + (items[i].kind === 'row' ? heights.row : heights.group)
    return out
  }, [items, heights])

  const scrollElement = (): HTMLElement | null => bodyRef.current?.closest<HTMLElement>('.matrix-scroll') ?? null

  const updateRange = useCallback(() => {
    const body = bodyRef.current
    const el = body?.closest<HTMLElement>('.matrix-scroll')
    if (!body || !el) return
    const head = (body.parentElement as HTMLTableElement | null)?.tHead
    headHeight.current = head ? head.offsetHeight : 0
    // Lets native focus scrolling (Tab into the grid) clear the sticky header.
    el.style.setProperty('--matrix-head-h', `${headHeight.current}px`)
    // The sticky thead covers the top of the viewport, so in body coordinates
    // the visible band is [scrollTop, scrollTop + clientHeight - theadHeight].
    const top = el.scrollTop
    const bottom = top + Math.max(0, el.clientHeight - headHeight.current)
    const n = items.length
    const first = Math.max(0, itemAt(offsets, top) - OVERSCAN_ROWS)
    const last = Math.min(n, itemAt(offsets, bottom) + 1 + OVERSCAN_ROWS)
    const start = first - (first % RANGE_STEP)
    const end = Math.min(n, Math.ceil(last / RANGE_STEP) * RANGE_STEP)
    // A focused cell about to leave the DOM would drop focus to <body>; park it
    // on the scroll region instead so keyboard users stay inside the matrix.
    const focused = document.activeElement
    if (focused instanceof HTMLElement && body.contains(focused)) {
      const i = Number(focused.closest('tr')?.dataset.i)
      if (i < start || i >= end) el.focus({ preventScroll: true })
    }
    setRange((prev) => (prev.start === start && prev.end === end ? prev : { start, end }))
  }, [items.length, offsets])

  // Recompute synchronously whenever the list or measured heights change
  // (filters, metric-independent), before the browser paints a stale window.
  useLayoutEffect(() => {
    updateRange()
  }, [updateRange])

  useEffect(() => {
    const el = scrollElement()
    if (!el) return
    let frame = 0
    const schedule = () => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        updateRange()
      })
    }
    el.addEventListener('scroll', schedule, { passive: true })
    const observer = new ResizeObserver(schedule)
    observer.observe(el)
    return () => {
      el.removeEventListener('scroll', schedule)
      observer.disconnect()
      if (frame) cancelAnimationFrame(frame)
    }
  }, [updateRange])

  // Measure one row of each kind; a changed height (breakpoint, font load)
  // re-derives the offsets. Everything the window math uses (scrollTop,
  // clientHeight, these heights) must be in layout pixels: getBoundingClientRect
  // is post-transform/zoom, so a scaled page (zoom, embedded preview) would
  // shrink the offsets and balloon the window toward every row.
  useLayoutEffect(() => {
    const body = bodyRef.current
    if (!body) return
    const measured = (selector: string, fallback: number) => {
      const h = body.querySelector<HTMLElement>(selector)?.offsetHeight ?? 0
      return h > 0 ? h : fallback
    }
    const next = { row: measured('tr.matrix-row', heights.row), group: measured('tr.matrix-group-row', heights.group) }
    if (next.row !== heights.row || next.group !== heights.group) setHeights(next)
  })

  // Rows scroll in and out of the DOM, so an auto-sized first column would
  // widen whenever a longer region label arrived. Measure the widest label of
  // the whole list up front and pin the corner cell (always rendered) to it.
  useLayoutEffect(() => {
    const el = scrollElement()
    const th = bodyRef.current?.querySelector<HTMLElement>('th.matrix-to')
    const code = th?.querySelector('code')
    const location = th?.querySelector<HTMLElement>('.matrix-to-location')
    if (!el || !th || !code || !location) return
    const measure = () => {
      const locationStyle = getComputedStyle(location)
      // Small screens hide the location and clamp the column in CSS.
      if (locationStyle.display === 'none') {
        el.style.removeProperty('--matrix-to-w')
        return
      }
      const ctx = document.createElement('canvas').getContext('2d')
      if (!ctx) return
      const thStyle = getComputedStyle(th)
      // The computed `font` shorthand is often empty, so rebuild it from longhands.
      const fontOf = (s: CSSStyleDeclaration) => `${s.fontStyle} ${s.fontWeight} ${s.fontSize} ${s.fontFamily}`
      const codeFont = fontOf(getComputedStyle(code))
      const locationFont = fontOf(locationStyle)
      const gap = parseFloat(locationStyle.marginLeft) || 0
      let widest = 0
      for (const item of items) {
        if (item.kind !== 'row') continue
        ctx.font = codeFont
        const keyWidth = ctx.measureText(item.row.region.key).width
        ctx.font = locationFont
        widest = Math.max(widest, keyWidth + gap + ctx.measureText(item.row.region.location).width)
      }
      const chrome = parseFloat(thStyle.paddingLeft) + parseFloat(thStyle.paddingRight) + parseFloat(thStyle.borderRightWidth)
      el.style.setProperty('--matrix-to-w', `${Math.ceil(widest + chrome) + 2}px`)
    }
    measure()
    // Web fonts may land after the first measurement and change the widths.
    let cancelled = false
    void document.fonts?.ready.then(() => {
      if (!cancelled) measure()
    })
    return () => {
      cancelled = true
    }
  }, [items, compact])

  // A new list invalidates item indices; start the tab stop over.
  useEffect(() => {
    setActive(null)
    pendingFocus.current = null
  }, [items, columns])

  const cellElement = (i: number, c: number): HTMLTableCellElement | null => {
    const tr = bodyRef.current?.querySelector<HTMLTableRowElement>(`tr[data-i="${i}"]`)
    return tr?.cells[c + 1] ?? null
  }

  // Scroll horizontally so the cell is not hidden under the sticky first column.
  const revealColumn = (el: HTMLElement, td: HTMLTableCellElement) => {
    const tr = td.parentElement as HTMLTableRowElement
    const stickyWidth = tr.cells[0].offsetWidth
    // Cell edges in scroll-content (layout) pixels. offsetLeft is measured from
    // <body> for both, so the difference is the cell's offset inside the table.
    const table = tr.closest('table') as HTMLTableElement
    const left = td.offsetLeft - table.offsetLeft
    const right = left + td.offsetWidth
    if (left - stickyWidth < el.scrollLeft) el.scrollLeft = left - stickyWidth
    else if (right > el.scrollLeft + el.clientWidth) el.scrollLeft = right - el.clientWidth
  }

  const focusCell = (el: HTMLElement, td: HTMLTableCellElement) => {
    revealColumn(el, td)
    td.focus({ preventScroll: true })
  }

  // Focus a pending keyboard target once its row has rendered.
  useLayoutEffect(() => {
    const target = pendingFocus.current
    const el = scrollElement()
    if (!target || !el) return
    const td = cellElement(target.i, target.c)
    if (!td) return
    pendingFocus.current = null
    focusCell(el, td)
  })

  const moveTo = (i: number, c: number) => {
    const el = scrollElement()
    if (!el) return
    // Keep the row between the sticky header and the bottom edge. Offsets are
    // known for every row, rendered or not, so this also reaches far rows.
    const viewHeight = el.clientHeight - headHeight.current
    // offsetHeight rounds the (fractional) header height and scrollTop snaps to
    // whole pixels, so round outward with a pixel of slack at the bottom.
    if (offsets[i] < el.scrollTop) el.scrollTop = Math.floor(offsets[i])
    else if (offsets[i + 1] > el.scrollTop + viewHeight) el.scrollTop = Math.ceil(offsets[i + 1] - viewHeight) + 1
    setActive({ i, c })
    const td = cellElement(i, c)
    if (td) {
      focusCell(el, td)
    } else {
      pendingFocus.current = { i, c }
      updateRange()
    }
  }

  // Step over `count` region rows (skipping group headers) in `dir`, clamped.
  const stepRow = (i: number, dir: 1 | -1, count: number) => {
    let at = i
    for (let step = 0; step < count; step++) {
      let k = at + dir
      while (k >= 0 && k < items.length && items[k].kind !== 'row') k += dir
      if (k < 0 || k >= items.length) break
      at = k
    }
    return at
  }

  const cellPosition = (target: EventTarget): { i: number; c: number } | null => {
    const td = (target as Element).closest?.('td')
    const tr = td?.parentElement as HTMLTableRowElement | null | undefined
    if (!td || !tr?.dataset.i) return null
    const i = Number(tr.dataset.i)
    const c = td.cellIndex - 1
    return items[i]?.kind === 'row' && c >= 0 && c < columns.length ? { i, c } : null
  }

  const openCell = (i: number, c: number) => {
    const item = items[i]
    const col = columns[c]
    if (item?.kind !== 'row' || !col) return
    if (!lookup.has(`${col.id}|${item.row.provider.key}|${item.row.region.key}`)) return
    onSelectCell(selectedCellFor(col, item.row))
  }

  const onClick = (e: React.MouseEvent) => {
    const pos = cellPosition(e.target)
    if (pos) openCell(pos.i, pos.c)
  }

  const onFocus = (e: React.FocusEvent) => {
    const pos = cellPosition(e.target)
    if (pos) setActive((prev) => (prev && prev.i === pos.i && prev.c === pos.c ? prev : pos))
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    const pos = cellPosition(e.target)
    if (!pos) return
    const { i, c } = pos
    const el = scrollElement()
    const page = Math.max(1, Math.floor(((el?.clientHeight ?? 0) - headHeight.current) / heights.row) - 1)
    const firstRow = stepRow(-1, 1, 1)
    const lastRow = stepRow(items.length, -1, 1)
    let next: { i: number; c: number }
    switch (e.key) {
      case 'ArrowLeft':
        next = { i, c: Math.max(0, c - 1) }
        break
      case 'ArrowRight':
        next = { i, c: Math.min(columns.length - 1, c + 1) }
        break
      case 'ArrowUp':
        next = { i: stepRow(i, -1, 1), c }
        break
      case 'ArrowDown':
        next = { i: stepRow(i, 1, 1), c }
        break
      case 'PageUp':
        next = { i: stepRow(i, -1, page), c }
        break
      case 'PageDown':
        next = { i: stepRow(i, 1, page), c }
        break
      case 'Home':
        next = e.ctrlKey || e.metaKey ? { i: firstRow, c: 0 } : { i, c: 0 }
        break
      case 'End':
        next = e.ctrlKey || e.metaKey ? { i: lastRow, c: columns.length - 1 } : { i, c: columns.length - 1 }
        break
      case 'Enter':
      case ' ':
        e.preventDefault()
        openCell(i, c)
        return
      default:
        return
    }
    e.preventDefault()
    if (next.i !== i || next.c !== c) moveTo(next.i, next.c)
  }

  const { start, end } = range
  // The tab stop stays on the active cell while its row is rendered; otherwise
  // it falls back to the first rendered region row so Tab can always enter.
  let tabRow = -1
  let tabCol = 0
  if (active && active.i >= start && active.i < end && items[active.i]?.kind === 'row' && active.c < columns.length) {
    tabRow = active.i
    tabCol = active.c
  } else {
    for (let i = start; i < Math.min(end, items.length); i++) {
      if (items[i].kind === 'row') {
        tabRow = i
        break
      }
    }
  }
  const topSpace = offsets[Math.min(start, items.length)]
  const bottomSpace = offsets[items.length] - offsets[Math.min(end, items.length)]

  return (
    // Cells carry no handlers: one delegated listener set here serves every
    // cell, and the table's grid role makes the tbody an interactive container.
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <tbody ref={bodyRef} onClick={onClick} onKeyDown={onKeyDown} onFocus={onFocus}>
      {topSpace > 0 ? (
        <tr className="matrix-spacer" aria-hidden="true">
          <td colSpan={columns.length + 1} style={{ height: topSpace }} />
        </tr>
      ) : null}
      {items.slice(start, end).map((item, k) => {
        const index = start + k
        return item.kind === 'group' ? (
          <MatrixGroupRow key={`g:${item.provider.key}`} index={index} provider={item.provider} columns={columns} />
        ) : (
          <MatrixRow
            key={item.row.key}
            index={index}
            row={item.row}
            columns={columns}
            lookup={lookup}
            metric={metric}
            compact={compact}
            tabCol={index === tabRow ? tabCol : -1}
          />
        )
      })}
      {bottomSpace > 0 ? (
        <tr className="matrix-spacer" aria-hidden="true">
          <td colSpan={columns.length + 1} style={{ height: bottomSpace }} />
        </tr>
      ) : null}
    </tbody>
  )
})

export default function Health(props: HealthProps): JSX.Element {
  const catalog = useMemo<CatalogRow[]>(() => {
    const rows: CatalogRow[] = []
    for (const provider of props.providers) {
      const regions = [...(props.regions[provider.key] || [])].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
      for (const region of regions) {
        rows.push({ key: `${provider.key}:${region.key}`, provider, region })
      }
    }
    return rows
  }, [props.providers, props.regions])

  const [theme, setTheme] = useState<'light' | 'dark'>('dark')
  // Small-screen flag. Drives compact matrix cells (no verbose per-cell
  // title/aria-label strings) to cut string allocation on low-memory phones.
  // Defaults to false so SSR/first paint matches desktop; refined on mount.
  const [isCompact, setIsCompact] = useState(false)
  const [{ snapshot, selectedFromContinents }, setMatrixState] = useState<{
    snapshot: MatrixSnapshot | null
    selectedFromContinents: string[] | null
  }>({ snapshot: null, selectedFromContinents: null })
  const [loadError, setLoadError] = useState<string | null>(null)
  // Whether a values-only refresh (manual button or the 30-min auto timer) is
  // in flight. Distinct from the initial load (snapshot === null) so the button
  // can show progress without blanking the matrix.
  const [refreshing, setRefreshing] = useState(false)
  const [selectedProviders, setSelectedProviders] = useState(props.providers.map((p) => p.key))
  // Continent selection is derived from selectedKeys (see geoAllSelected /
  // toggleGeo), not stored separately — so checking/unchecking individual
  // regions keeps the continent pills in sync automatically.
  const [selectedKeys, setSelectedKeys] = useState(catalog.map((r) => r.key))
  // The To (target region) box is collapsed by default — it holds every row-side
  // filter and would otherwise eat most of the screen above the matrix.
  const [toFilterOpen, setToFilterOpen] = useState(false)
  const [filterQuery, setFilterQuery] = useState('')
  const [metric, setMetric] = useState<Metric>('latest')
  // Empty = no band focus (every cell at full strength).
  const [focusBands, setFocusBands] = useState<FocusBand[]>([])
  // From-column (probe origin) filters: by CSP vendor and by continent.
  const [selectedFromVendors, setSelectedFromVendors] = useState<string[] | null>(null)
  // Clicked cell → per-cell latency history panel.
  const [selectedCell, setSelectedCell] = useState<SelectedCell | null>(null)

  useEffect(() => {
    const saved = localStorage.getItem('theme')
    if (saved === 'light' || saved === 'dark') {
      setTheme(saved)
      document.documentElement.setAttribute('data-theme', saved)
    } else if (window.matchMedia('(prefers-color-scheme: light)').matches) {
      setTheme('light')
      document.documentElement.setAttribute('data-theme', 'light')
    } else {
      document.documentElement.setAttribute('data-theme', 'dark')
    }
  }, [])

  useEffect(() => {
    const mql = window.matchMedia('(max-width: 640px)')
    const apply = () => setIsCompact(mql.matches)
    apply()
    mql.addEventListener('change', apply)
    return () => mql.removeEventListener('change', apply)
  }, [])

  // Fetch the latest published probe snapshot and swap only the matrix values
  // into state. Shared by the initial mount load, the manual refresh button, and
  // the 30-minute auto-refresh timer. `isInitial` gates the one-time client-geo
  // continent default so a refresh never clobbers the user's continent choice.
  const loadMatrix = useCallback((opts?: { isInitial?: boolean; signal?: AbortSignal }) => {
    const isInitial = opts?.isInitial ?? false
    if (!isInitial) setRefreshing(true)
    // Let the browser/CDN reuse the API's cached response (the route sets
    // s-maxage=60, stale-while-revalidate=300). The board only refreshes about
    // every 30 min, so a <=60s cache is harmless to freshness but lets repeat
    // visits and reloads paint the matrix immediately instead of waiting on a
    // fresh upstream round-trip. (Previously `cache: 'no-store'` forced a cold
    // fetch every load, hurting LCP.)
    return fetch('/api/health-matrix', { signal: opts?.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.json()
      })
      .then((data) => {
        const matrix = normalizeCompactMatrixSnapshot(data)
        if (!matrix) throw new Error('unexpected snapshot shape')
        setLoadError(null)
        setMatrixState((prev) => {
          // On the first load, pick the viewer's continent. On refresh, keep
          // whatever the user has selected (and every other filter is separate
          // state, so a values swap leaves the UI selection intact).
          if (isInitial) {
            const availableContinents = new Set(Object.values(matrix.from).map((column) => originContinent(column)))
            const initialContinent = detectClientGeo(availableContinents)
            return {
              snapshot: matrix,
              selectedFromContinents: initialContinent && availableContinents.has(initialContinent) ? [initialContinent] : null,
            }
          }
          return { snapshot: matrix, selectedFromContinents: prev.selectedFromContinents }
        })
      })
      .catch((err: Error) => {
        // On refresh, keep the existing values and surface a soft error; on the
        // initial load there's nothing to keep, so the empty-state message shows.
        if (err.name !== 'AbortError') setLoadError(err.message || 'failed to load')
      })
      .finally(() => {
        if (!isInitial) setRefreshing(false)
      })
  }, [])

  // Initial load.
  useEffect(() => {
    const controller = new AbortController()
    setLoadError(null)
    loadMatrix({ isInitial: true, signal: controller.signal })
    return () => controller.abort()
  }, [loadMatrix])

  // Manual "refresh values" action (button). Ignores overlapping clicks.
  const handleRefresh = useCallback(() => {
    if (refreshing) return
    loadMatrix()
  }, [loadMatrix, refreshing])

  // Auto-refresh: the server probe publishes ~every 30 min, so schedule the next
  // values reload for 30 min after the CURRENT snapshot's timestamp (+90s buffer
  // so we fetch just after the new snapshot lands, not just before). Re-anchors
  // whenever snapshot.at changes. Only fires on a visible tab; if the tab was
  // hidden past the due time, it refreshes on return.
  useEffect(() => {
    if (!snapshot?.at) return
    const REFRESH_INTERVAL_MS = 30 * 60 * 1000
    const BUFFER_MS = 90 * 1000
    let timer: ReturnType<typeof setTimeout> | undefined

    const schedule = () => {
      const dueAt = new Date(snapshot.at).getTime() + REFRESH_INTERVAL_MS + BUFFER_MS
      const delay = Math.max(0, dueAt - Date.now())
      timer = setTimeout(() => {
        if (document.visibilityState === 'visible') loadMatrix()
        // If hidden, the visibilitychange handler below refreshes on return.
      }, delay)
    }

    const onVisible = () => {
      if (document.visibilityState !== 'visible') return
      const dueAt = new Date(snapshot.at).getTime() + REFRESH_INTERVAL_MS + BUFFER_MS
      if (Date.now() >= dueAt) loadMatrix()
    }

    schedule()
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      if (timer) clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [snapshot?.at, loadMatrix])

  const toggleTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark'
    setTheme(next)
    localStorage.setItem('theme', next)
    document.documentElement.setAttribute('data-theme', next)
  }

  const columns = useMemo(() => {
    if (!snapshot) return [] as ProbeColumn[]
    // Order From columns by continent, then CSP (aws → gcp → azure → vercel),
    // then by region code (alphabetical, e.g. ap-northeast-1 before ap-northeast-2).
    const continentRank = (col: ProbeColumn) => {
      const idx = ORIGIN_CONTINENT_ORDER.indexOf(originContinent(col))
      return idx === -1 ? ORIGIN_CONTINENT_ORDER.length : idx
    }
    return Object.values(snapshot.from).sort((a, b) => {
      const ca = continentRank(a)
      const cb = continentRank(b)
      if (ca !== cb) return ca - cb
      const va = originVendorRank(a)
      const vb = originVendorRank(b)
      if (va !== vb) return va - vb
      const left = columnCode(a)
      const right = columnCode(b)
      return left < right ? -1 : left > right ? 1 : a.id.localeCompare(b.id)
    })
  }, [snapshot])

  const lookup = useMemo(() => {
    const map = new Map<string, ProbeResult>()
    for (const col of columns) {
      for (const item of col.results) {
        map.set(`${col.id}|${item.provider}|${item.region}`, item)
      }
    }
    return map
  }, [columns])

  // Which CSP vendors / continents actually appear among the From columns.
  const fromVendors = useMemo(() => {
    const set = new Set<string>()
    for (const col of columns) {
      const v = originVendor(col)
      if (v) set.add(v)
    }
    const live = ['aws', 'gcp', 'azure', 'vercel'].filter((v) => set.has(v))
    // Before the snapshot loads, `columns` is empty and these pills would be
    // absent, then appear after the client fetch — pushing the matrix down
    // (CLS). Render the deployed fleet's vendors up front so the filter box
    // holds its height from first paint. Kept in sync with the live set below;
    // if the snapshot later omits one it simply deactivates rather than removing
    // the pill. (Memory-safe: ~3 static buttons, no matrix data.)
    return live.length ? live : FROM_VENDOR_FALLBACK
  }, [columns])

  const fromContinents = useMemo(() => {
    const set = new Set<string>()
    for (const col of columns) set.add(originContinent(col))
    const live = ORIGIN_CONTINENT_ORDER.filter((c) => set.has(c))
    return live.length ? live : FROM_CONTINENT_FALLBACK
  }, [columns])

  // Apply From-column filters (null = show all). Row filters are separate.
  const visibleColumns = useMemo(() => {
    return columns.filter((col) => {
      const v = originVendor(col)
      if (selectedFromVendors && !(v && selectedFromVendors.includes(v))) return false
      if (selectedFromContinents && !selectedFromContinents.includes(originContinent(col))) return false
      return true
    })
  }, [columns, selectedFromVendors, selectedFromContinents])

  const has24h = useMemo(() => {
    let maxN = 0
    for (const col of columns) {
      for (const r of col.results) {
        if ((r.n24h || 0) > maxN) maxN = r.n24h || 0
      }
    }
    return maxN >= MIN_N24H
  }, [columns])

  const scoped = useMemo(() => catalog.filter((row) => selectedProviders.includes(row.provider.key)), [catalog, selectedProviders])

  // Regions grouped by continent within the current provider scope, so the
  // continent pills reflect exactly the rows a user could pick right now.
  const scopedByGeo = useMemo(() => {
    const map = new Map<string, CatalogRow[]>()
    for (const row of scoped) {
      const list = map.get(row.region.geo)
      if (list) list.push(row)
      else map.set(row.region.geo, [row])
    }
    return map
  }, [scoped])

  // A continent pill is "on" only when every region it covers (in scope) is
  // selected. Partial selection reads as off, per the requested behavior.
  const geoAllSelected = useMemo(() => {
    const selectedSet = new Set(selectedKeys)
    const result = new Map<string, boolean>()
    for (const [geo, list] of scopedByGeo) {
      result.set(geo, list.length > 0 && list.every((row) => selectedSet.has(row.key)))
    }
    return result
  }, [scopedByGeo, selectedKeys])

  const rows = useMemo(() => scoped.filter((row) => selectedKeys.includes(row.key)), [scoped, selectedKeys])
  const showProvider = selectedProviders.length !== 1
  const matrixItems = useMemo(() => buildMatrixItems(rows, showProvider), [rows, showProvider])
  const selectedGeoCount = useMemo(() => {
    let n = 0
    for (const on of geoAllSelected.values()) if (on) n++
    return n
  }, [geoAllSelected])
  // Collapsed-header summary so the counts stay visible without opening the box.
  const toFilterSummary = `${selectedProviders.length}/${props.providers.length} clouds · ${selectedGeoCount}/${scopedByGeo.size} continents · ${rows.length}/${catalog.length} regions`
  // Which corner-mark kinds actually occur on screen. The legend keys only those,
  // so it never explains a glyph a viewer cannot find — 'adjacent' needs a Vercel
  // origin, and snapshots without one simply drop that row from the key.
  const markKinds = useMemo(() => {
    let onNet = false
    let adjacent = false
    for (const col of visibleColumns) {
      for (const row of rows) {
        const k = sameCloudKind(col, row.provider.key, row.region.location)
        if (k === 'on-net') onNet = true
        else if (k === 'adjacent') adjacent = true
        if (onNet && adjacent) return { onNet, adjacent }
      }
    }
    return { onNet, adjacent }
  }, [visibleColumns, rows])
  const filterMatches = useMemo(() => {
    const q = filterQuery.trim().toLowerCase()
    if (!q) return scoped
    return scoped.filter(
      (row) =>
        row.region.key.toLowerCase().includes(q) ||
        row.region.location.toLowerCase().includes(q) ||
        row.provider.display_name.toLowerCase().includes(q) ||
        (row.provider.short_name || '').toLowerCase().includes(q)
    )
  }, [scoped, filterQuery])

  const siteUrl = getSiteUrl()
  const title = 'Health — Cloudping.me'
  const description =
    'Shared cloud-region latency matrix probed from AWS, GCP, and Azure regions. Latest values show the fastest successful HTTP round-trip after warmup; 24h values are median per-run results.'

  const toggleProvider = (k: string) => setSelectedProviders((v) => (v.includes(k) ? v.filter((x) => x !== k) : [...v, k]))
  // Continent pill: select or clear every in-scope region of that continent.
  // If they're all selected now, clear them; otherwise select them all.
  const toggleGeo = (geo: string) => {
    const list = scopedByGeo.get(geo) || []
    if (list.length === 0) return
    const keys = list.map((row) => row.key)
    const allOn = geoAllSelected.get(geo) === true
    setSelectedKeys((current) => {
      if (allOn) {
        const remove = new Set(keys)
        return current.filter((k) => !remove.has(k))
      }
      return [...new Set([...current, ...keys])]
    })
  }
  // From-column filters. null means "all"; toggling narrows to an explicit set.
  const toggleFromVendor = (v: string) =>
    setSelectedFromVendors((cur) => {
      const base = cur ?? fromVendors
      const next = base.includes(v) ? base.filter((x) => x !== v) : [...base, v]
      return next.length === fromVendors.length ? null : next
    })
  const toggleFromContinent = (c: string) =>
    setMatrixState((state) => {
      const base = state.selectedFromContinents ?? fromContinents
      const next = base.includes(c) ? base.filter((x) => x !== c) : [...base, c]
      return { ...state, selectedFromContinents: next.length === fromContinents.length ? null : next }
    })
  const toggleRegion = (key: string) => setSelectedKeys((v) => (v.includes(key) ? v.filter((x) => x !== key) : [...v, key]))
  const toggleBand = (b: FocusBand) => setFocusBands((v) => (v.includes(b) ? v.filter((x) => x !== b) : [...v, b]))
  const selectCell = useCallback((cell: SelectedCell) => setSelectedCell(cell), [])
  const closeHistory = useCallback(() => setSelectedCell(null), [])

  const setScopedKeys = (on: boolean) => {
    const scopedSet = new Set(scoped.map((r) => r.key))
    setSelectedKeys((current) => {
      const selectedInScope = current.filter((key) => scopedSet.has(key)).length
      if ((on && selectedInScope === scopedSet.size) || (!on && selectedInScope === 0)) return current
      const rest = current.filter((key) => !scopedSet.has(key))
      return on ? [...rest, ...scoped.map((r) => r.key)] : rest
    })
  }

  return (
    <>
      <Head>
        <title>{title}</title>
        <meta name="description" content={description} />
        <meta property="og:title" content={title} />
        <meta property="og:description" content={description} />
        {siteUrl ? <link rel="canonical" href={`${siteUrl}/health`} /> : null}
        <meta name="theme-color" content="#060910" />
      </Head>
      <div className="min-h-screen w-screen max-w-full overflow-x-hidden">
        <div className="matrix-page px-4 sm:px-6 py-6 sm:py-8">
          <SiteHeader active="health" theme={theme} onToggleTheme={toggleTheme} />
          <div className="flex flex-col gap-1 mb-6">
            <h2 className="matrix-title">Cloud Region Latency Matrix</h2>
            <p className="text-sm text-[color:var(--text-secondary)]">
              Rows = target cloud regions. Columns = probe origins
              {` (${columns.length || '\u2007\u2007'})`}. Fastest successful HTTP round-trip after warmup — not ICMP ping.
            </p>
            <p className="text-xs text-[color:var(--text-muted)]">
              {snapshot
                ? `Last updated ${formatUpdated(snapshot.at)}. Refreshed about every 30 minutes.`
                : loadError
                  ? `No probe snapshot yet (${loadError}). Run the Probe GitHub Action to publish the status branch.`
                  : 'Loading latest probe snapshot…'}
            </p>
          </div>

          {/* From-column (probe origin) filters first: the matrix's columns come
              from here, and the box stays small enough to leave open. */}
          <div className="matrix-from-filter">
            <span className="matrix-from-filter-label">From (probe origins)</span>
            <div className="matrix-from-filter-pills">
              {fromVendors.map((v) => {
                const on = selectedFromVendors === null || selectedFromVendors.includes(v)
                return (
                  <button
                    key={`fv-${v}`}
                    type="button"
                    onClick={() => toggleFromVendor(v)}
                    className={`provider-pill flex-shrink-0 ${on ? 'active' : ''}`}
                    title={`${v.toUpperCase()} origins`}
                  >
                    {v !== 'vercel' ? <CloudProviderLogo width={14} providerKey={v} providerName={v.toUpperCase()} /> : null}
                    <span>{v.toUpperCase()}</span>
                  </button>
                )
              })}
              <span className="matrix-from-filter-sep" aria-hidden="true" />
              {fromContinents.length ? (
                <button
                  type="button"
                  className={`provider-pill ${selectedFromContinents === null ? 'active' : ''}`}
                  aria-pressed={selectedFromContinents === null}
                  onClick={() =>
                    setMatrixState((state) => ({
                      ...state,
                      // Toggle: All (null = every origin) ↔ None ([] = hide all).
                      // Turning All off drops to None so you can then pick just
                      // the continents you want; turning it on restores all.
                      selectedFromContinents: state.selectedFromContinents === null ? [] : null,
                    }))
                  }
                >
                  All
                </button>
              ) : null}
              {fromContinents.map((c) => {
                const on = selectedFromContinents === null || selectedFromContinents.includes(c)
                return (
                  <button key={`fc-${c}`} type="button" onClick={() => toggleFromContinent(c)} className={`provider-pill ${on ? 'active' : ''}`}>
                    {c}
                  </button>
                )
              })}
            </div>
          </div>

          {/* To-row (target region) filters — collapsed by default. Every row-side
              control lives in here (cloud, continent, per-region list) so there is
              only one place to narrow rows; the header shows the active counts. */}
          <div className="matrix-to-filter">
            <button type="button" className="matrix-to-filter-head" onClick={() => setToFilterOpen((v) => !v)} aria-expanded={toFilterOpen}>
              <span className="matrix-from-filter-label">To (target regions)</span>
              <span className="matrix-to-filter-summary">
                <span>{toFilterSummary}</span>
                <span className="matrix-to-filter-caret" aria-hidden="true">
                  {toFilterOpen ? '▾' : '▸'}
                </span>
              </span>
            </button>
            {toFilterOpen ? (
              <div className="matrix-to-filter-body">
                <div className="matrix-to-filter-row matrix-to-filter-row-pills">
                  <div className="matrix-to-filter-lead">
                    <span className="matrix-to-filter-sublabel">Cloud</span>
                  </div>
                  <div className="pills-wrap matrix-to-filter-pills">
                    <button
                      type="button"
                      className={`provider-pill ${selectedProviders.length === props.providers.length ? 'active' : ''}`}
                      aria-pressed={selectedProviders.length === props.providers.length}
                      onClick={() =>
                        setSelectedProviders((current) => (current.length === props.providers.length ? [] : props.providers.map((provider) => provider.key)))
                      }
                    >
                      All
                    </button>
                    {props.providers.map((provider) => {
                      const isActive = selectedProviders.includes(provider.key)
                      return (
                        <button
                          key={provider.key}
                          type="button"
                          onClick={() => toggleProvider(provider.key)}
                          className={`provider-pill flex-shrink-0 ${isActive ? 'active' : ''}`}
                          title={provider.display_name}
                        >
                          <CloudProviderLogo width={16} providerKey={provider.key} providerName={provider.display_name} />
                          <span className="hidden sm:inline">{provider.display_name}</span>
                          <span className="sm:hidden">{provider.short_name ?? provider.display_name}</span>
                        </button>
                      )
                    })}
                  </div>
                </div>

                <div className="matrix-to-filter-row matrix-to-filter-row-pills">
                  <div className="matrix-to-filter-lead">
                    <span className="matrix-to-filter-sublabel">Continent</span>
                  </div>
                  <div className="pills-wrap matrix-to-filter-pills">
                    <button
                      type="button"
                      className={`provider-pill ${scopedByGeo.size > 0 && selectedGeoCount === scopedByGeo.size ? 'active' : ''}`}
                      aria-pressed={scopedByGeo.size > 0 && selectedGeoCount === scopedByGeo.size}
                      onClick={() => setScopedKeys(!(scoped.length > 0 && rows.length === scoped.length))}
                    >
                      All
                    </button>
                    {GEO_ORDER.map((geo) => {
                      if (!scopedByGeo.has(geo)) return null
                      const on = geoAllSelected.get(geo) === true
                      return (
                        <button key={geo} type="button" onClick={() => toggleGeo(geo)} className={`provider-pill ${on ? 'active' : ''}`}>
                          {geo}
                        </button>
                      )
                    })}
                  </div>
                </div>

                {/* Per-region picker, scoped to the cloud + continent pills above. */}
                <div className="matrix-to-filter-row">
                  <span className="matrix-to-filter-sublabel">
                    Regions {rows.length}/{scoped.length}
                  </span>
                  <input
                    type="search"
                    value={filterQuery}
                    onChange={(e) => setFilterQuery(e.target.value)}
                    placeholder="Search regions"
                    className="matrix-filter-search"
                  />
                  <button
                    type="button"
                    className={`provider-pill ${scoped.length > 0 && rows.length === scoped.length ? 'active' : ''}`}
                    aria-pressed={scoped.length > 0 && rows.length === scoped.length}
                    onClick={() => setScopedKeys(!(scoped.length > 0 && rows.length === scoped.length))}
                  >
                    All
                  </button>
                </div>
                <div className="matrix-filter-grid">
                  {filterMatches.map((row) => {
                    const on = selectedKeys.includes(row.key)
                    return (
                      <label key={row.key} className={`matrix-filter-item ${on ? 'is-on' : ''}`}>
                        <input type="checkbox" checked={on} onChange={() => toggleRegion(row.key)} />
                        <span className="font-mono">{row.region.key}</span>
                        {showProvider ? <span className="text-[color:var(--text-muted)]">{row.provider.short_name}</span> : null}
                      </label>
                    )
                  })}
                </div>
              </div>
            ) : null}
          </div>

          <div className="matrix-toolbar">
            <div className="matrix-toolbar-left">
              {/* Two views of the same cell, so a segmented control (same pattern as
                  the history modal's Daily/2h) rather than two loose chips. */}
              <div className="history-toggle matrix-toggle" role="group" aria-label="Latency metric">
                <button
                  type="button"
                  className={metric === 'latest' ? 'is-on' : ''}
                  aria-pressed={metric === 'latest'}
                  onClick={() => setMetric('latest')}
                  title="Fastest successful round-trip of the most recent run"
                >
                  Latest min
                </button>
                <button
                  type="button"
                  className={metric === 'p24' ? 'is-on' : ''}
                  aria-pressed={metric === 'p24'}
                  onClick={() => setMetric('p24')}
                  disabled={!has24h}
                  title={has24h ? 'Median of per-run values over the last 24 hours' : `Need about ${MIN_N24H} runs (~2 hours) before 24h P50`}
                >
                  24h P50
                </button>
              </div>
            </div>
            <div className="matrix-toolbar-right">
              <div className="matrix-legend" role="group" aria-label="Latency color scale — click a band to focus it">
                <span className="matrix-legend-label">Latency:</span>
                {LEGEND_BANDS.map((b) => {
                  const on = focusBands.includes(b.key)
                  return (
                    <button
                      key={b.key}
                      type="button"
                      className={`matrix-swatch ${b.key}${focusBands.length > 0 && !on ? ' is-off' : ''}`}
                      aria-pressed={on}
                      onClick={() => toggleBand(b.key)}
                      title={on ? `Stop focusing ${b.label}` : `Focus ${b.label} cells`}
                    >
                      {b.label}
                    </button>
                  )
                })}
                {focusBands.length > 0 ? (
                  <button type="button" className="matrix-legend-clear" onClick={() => setFocusBands([])}>
                    Clear
                  </button>
                ) : null}
              </div>
              {snapshot ? (
                <div className="matrix-toolbar-refresh">
                  {loadError && !refreshing ? <span className="matrix-refresh-error">refresh failed ({loadError})</span> : null}
                  <button
                    type="button"
                    className="matrix-refresh-btn"
                    onClick={handleRefresh}
                    disabled={refreshing}
                    aria-label="Refresh latency values"
                    title="Refresh latency values without reloading the page"
                  >
                    {refreshing ? 'Refreshing…' : '↻ Refresh'}
                  </button>
                </div>
              ) : null}
            </div>
          </div>
          <div className="matrix-scroll" role="region" aria-label="Cloud latency matrix" tabIndex={0}>
            {rows.length === 0 || visibleColumns.length === 0 ? (
              <div className="matrix-placeholder text-[color:var(--text-muted)]">
                <p>
                  {snapshot ? 'No regions match the current filters.' : loadError ? 'Waiting for the first probe snapshot.' : 'Loading latest probe snapshot…'}
                </p>
              </div>
            ) : (
              <table
                className={`matrix-table${focusBands.length ? ' has-focus' : ''}${focusBands.map((b) => ` focus-${b}`).join('')}`}
                role="grid"
                aria-readonly="true"
                aria-rowcount={matrixItems.length + MATRIX_HEAD_ROWS}
              >
                <caption className="sr-only">Latency from each probe origin to every visible cloud region</caption>
                <thead>
                  <tr aria-rowindex={1}>
                    <th className="matrix-corner" rowSpan={2} scope="col">
                      To \ From
                    </th>
                    {(() => {
                      // Continent group header row spanning each run of same-continent columns.
                      const groups: { continent: string; span: number }[] = []
                      for (const col of visibleColumns) {
                        const c = originContinent(col)
                        const last = groups[groups.length - 1]
                        if (last && last.continent === c) last.span += 1
                        else groups.push({ continent: c, span: 1 })
                      }
                      return groups.map((g, i) => (
                        <th key={`grp-${g.continent}-${i}`} colSpan={g.span} className="matrix-from-continent" scope="colgroup">
                          {g.continent}
                        </th>
                      ))
                    })()}
                  </tr>
                  <tr aria-rowindex={2}>
                    {visibleColumns.map((col) => {
                      const vendor = originVendor(col)
                      return (
                        <th key={col.id} title={`${col.label} · ${columnSubtitle(col)}`} scope="col">
                          <span className="matrix-from-head">
                            {vendor && vendor !== 'vercel' ? <CloudProviderLogo width={13} providerKey={vendor} providerName={vendor.toUpperCase()} /> : null}
                            <span className="matrix-from-code">{columnCity(col) ?? columnCode(col)}</span>
                          </span>
                          {col.stale ? <span className="matrix-from-stale">stale</span> : null}
                        </th>
                      )
                    })}
                  </tr>
                </thead>
                <MatrixBody items={matrixItems} columns={visibleColumns} lookup={lookup} metric={metric} compact={isCompact} onSelectCell={selectCell} />
              </table>
            )}
          </div>
          {/* The corner mark is keyed here and nowhere else: the toolbar used to
              carry a duplicate swatch beside a footnote that only pointed at it. */}
          <p className="matrix-footnote">
            Latest min = the fastest of up to 4 successful HTTP GETs to response headers after 2 warmups (at least 3 successes); 24h P50 is the median of
            per-run values and may include older probe behavior. Click a cell for history.
            {markKinds.onNet ? (
              <>
                {' '}
                <span className="matrix-tri on-net" aria-hidden="true" /> marks a cell whose origin and target are the same cloud in the same metro — it rides
                the provider backbone rather than a real internet path, so it is not comparable with the other cells.
              </>
            ) : null}
            {markKinds.adjacent ? (
              <>
                {' '}
                <span className="matrix-tri adjacent" aria-hidden="true" /> is a Vercel origin hitting AWS in the same metro, which is close to the same thing.
              </>
            ) : null}
          </p>
        </div>
        {selectedCell ? (
          <HistoryPanel
            origin={selectedCell.origin}
            originVendor={selectedCell.originVendor}
            originCode={selectedCell.originCode}
            originCity={selectedCell.originCity}
            provider={selectedCell.provider}
            providerName={selectedCell.providerName}
            region={selectedCell.region}
            regionLocation={selectedCell.regionLocation}
            regionCountry={selectedCell.regionCountry}
            onClose={closeHistory}
          />
        ) : null}
      </div>
    </>
  )
}
