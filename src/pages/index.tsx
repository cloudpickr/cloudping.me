import React, { memo, useEffect, useMemo, useRef, useState } from 'react'
import Head from 'next/head'
import { GetStaticPropsResult } from 'next'
import { CloudProvider, CloudRegion, getAllCloudRegions, getAllProviders } from '@app/data'
import { CloudProviderLogo, CountryFlag, CountryName } from '@app/components'
import { SiteHeader } from '@app/components/site-header'
import { delay, ping, whenPageIdle } from '@app/fns/time'
import { percentile } from '@app/fns/measure-core'
import { FALLBACK_GEO, getClientGeo } from '@app/fns/client-geo'
import { getSiteUrl } from '../site-config'

interface CloudPingProps {
  providers: CloudProvider[]
  regions: Record<string, CloudRegion[]>
  geos: Record<string, string[]>
  countries: string[]
}

export async function getStaticProps(): Promise<GetStaticPropsResult<CloudPingProps>> {
  const providers = getAllProviders()
  const regions = getAllCloudRegions()
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
      countries: Object.values(regions).reduce((prev, curr) => {
        for (const region of curr) {
          if (!prev.includes(region.country)) prev = [...prev, region.country]
        }
        return prev
      }, [] as string[]),
    },
  }
}

interface LatencyState {
  [key: string]: RegionLatency
}
interface RegionLatency {
  key: string
  provider: CloudProvider
  region: CloudRegion
  samples: number[]
  p50?: number
  p80?: number
  p95?: number
  failureCount?: number
  nextAttemptAt?: number
}

const MAX_SAMPLES = 12
const UI_FLUSH_MS = 100

function createLatencyState(providers: CloudProvider[], regions: Record<string, CloudRegion[]>): LatencyState {
  const state: LatencyState = {}
  for (const provider of providers) {
    for (const region of regions[provider.key] || []) {
      const key = `${provider.key}-${region.key}`
      state[key] = { key, provider, region, samples: [] }
    }
  }
  return state
}

function GeoSection({
  geo,
  countries,
  selectedCountries,
  onToggleCountry,
  onToggleGeo,
}: {
  geo: string
  countries: string[]
  selectedCountries: string[]
  onToggleCountry: (c: string) => void
  onToggleGeo: (g: string, checked: boolean) => void
}) {
  const [manualOpen, setManualOpen] = useState<boolean | null>(null)
  const selectedCount = countries.filter((c) => selectedCountries.includes(c)).length
  const isOpen = manualOpen ?? selectedCount > 0
  const allSelected = selectedCount === countries.length
  const someSelected = selectedCount > 0 && selectedCount < countries.length

  return (
    <div className="sidebar-section">
      <div className="sidebar-header group">
        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            className="form-checkbox w-3.5 h-3.5"
            checked={allSelected}
            ref={(el) => {
              if (el) el.indeterminate = someSelected
            }}
            onChange={(e) => {
              e.stopPropagation()
              onToggleGeo(geo, e.target.checked)
            }}
            onClick={(e) => e.stopPropagation()}
          />
          <button type="button" className="flex min-w-0 items-center gap-2 text-left" aria-expanded={isOpen} onClick={() => setManualOpen(!isOpen)}>
            <span className="truncate">{geo}</span>
            <svg
              className={`w-3 h-3 flex-shrink-0 text-[color:var(--text-muted)] transition-transform duration-200 ${isOpen ? 'rotate-90' : ''}`}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          </button>
        </div>
        <span className="text-[color:var(--text-muted)] text-xs font-normal">
          {selectedCount}/{countries.length}
        </span>
      </div>
      {isOpen && (
        <div className="sidebar-content pl-5 pt-1">
          {countries.map((country) => (
            <label key={country} className="flex items-center gap-2 py-0.5 cursor-pointer group">
              <input
                type="checkbox"
                className="form-checkbox w-3 h-3"
                checked={selectedCountries.includes(country)}
                onChange={() => onToggleCountry(country)}
              />
              <CountryFlag width={14} countryCode={country} />
              <CountryName
                countryCode={country}
                className="text-xs text-[color:var(--text-secondary)] group-hover:text-[color:var(--text-secondary)] transition-colors truncate"
              />
            </label>
          ))}
        </div>
      )}
    </div>
  )
}

const RANK_MEDALS = ['🥇', '🥈', '🥉']
const RANK_CSS = ['rank-badge-1', 'rank-badge-2', 'rank-badge-3']

function getBadgeClass(ms?: number) {
  if (!ms) return ''
  if (ms < 80) return 'success'
  if (ms < 200) return 'warning'
  return 'danger'
}

const LatencyCard = memo(function LatencyCard({
  data,
  maxLatency,
  rank,
  rankIndex,
}: {
  data: RegionLatency
  maxLatency: number
  rank?: number
  rankIndex: number
}) {
  const p50 = data.p50
  const p80 = data.p80
  const p95 = data.p95
  const isUnreachable = (data.failureCount || 0) >= 3
  const relative = maxLatency > 0 ? ((p50 || 0) / maxLatency) * 100 : 0
  const getBarColor = () => {
    if (!p50) return 'transparent'
    if (p50 < 80) return 'rgba(34, 197, 94, 0.18)'
    if (p50 < 200) return 'rgba(234, 179, 8, 0.18)'
    return 'rgba(239, 68, 68, 0.18)'
  }
  const isTop3 = rank !== undefined && rank <= 3
  const isAboveFold = rankIndex < 6
  return (
    <div className={`latency-card${isTop3 ? ` rank-${rank}` : ''}${isUnreachable ? ' opacity-50' : ''}`} style={{ ['--rank' as string]: rankIndex }}>
      {p50 && !isUnreachable && (
        <div className="latency-bar" style={{ width: `${Math.min(relative, 100)}%`, background: `linear-gradient(90deg, ${getBarColor()}, transparent)` }} />
      )}
      <div className="latency-card-inner">
        <div className="flex items-center gap-2 sm:gap-3 min-w-0 flex-1">
          <div
            className={`flex-shrink-0 w-6 sm:w-9 text-center font-mono ${
              isTop3 ? `text-lg sm:text-xl leading-none ${RANK_CSS[rank! - 1]}` : 'text-xs text-[color:var(--text-muted)]'
            }`}
          >
            {isTop3 ? RANK_MEDALS[rank! - 1] : rank}
          </div>
          <div className="flex-shrink-0 w-5 h-5 flex items-center justify-center">
            <CloudProviderLogo
              width={20}
              providerKey={data.provider.key}
              providerName={data.provider.display_name}
              loading={isAboveFold ? 'eager' : undefined}
            />
          </div>
          <div className="min-w-0 flex-1">
            {/* Top line: region code (+ provider on sm) */}
            <div className="flex items-center gap-2 min-w-0">
              <code className="text-sm font-mono font-medium truncate">{data.region.key}</code>
              <span className="hidden sm:inline text-xs flex-shrink-0">{data.provider.display_name}</span>
            </div>
            {/* Bottom line: flag + location */}
            <div className="flex items-center gap-1.5 text-xs">
              <CountryFlag width={12} countryCode={data.region.country} loading={isAboveFold ? 'eager' : undefined} />
              <span className="truncate">{data.region.location}</span>
            </div>
          </div>
        </div>
        {/* Mobile badges (P50/P95) — a sibling of the region column so they
            center vertically in the full row height instead of being pinned to
            the region-code line (which left empty space below the values). */}
        {isUnreachable ? (
          <span className="flex sm:hidden text-xs text-red-400 flex-shrink-0 items-center" title={`Failed ${data.failureCount} times`}>
            ⊘ Unreachable
          </span>
        ) : p50 ? (
          <div className="flex sm:hidden items-center gap-1.5 flex-shrink-0">
            <div className="flex flex-col items-center gap-0.5">
              <span className={`latency-badge ${getBadgeClass(p50)}`}>{p50}ms</span>
              <span className="text-[10px] text-[color:var(--text-muted)] font-medium leading-none">P50</span>
            </div>
            <div className="flex flex-col items-center gap-0.5">
              <span className={`latency-badge ${getBadgeClass(p95)}`}>{p95}ms</span>
              <span className="text-[10px] text-[color:var(--text-muted)] font-medium leading-none">P95</span>
            </div>
          </div>
        ) : (
          <div className="flex sm:hidden skeleton w-[86px] h-[34px] flex-shrink-0" />
        )}
        {/* Desktop badges with P50/P80/P95 labels */}
        {isUnreachable ? (
          <span className="hidden sm:flex text-xs text-red-400 flex-shrink-0 items-center gap-1" title={`Failed ${data.failureCount} times`}>
            ⊘ Unreachable
          </span>
        ) : p50 ? (
          <div className="hidden sm:flex items-center gap-3 flex-shrink-0">
            <div className="flex items-center gap-1">
              <span className="text-[10px] text-[color:var(--text-muted)] font-medium">P50</span>
              <span className={`latency-badge ${getBadgeClass(p50)}`}>{p50}ms</span>
            </div>
            <div className="flex items-center gap-1">
              <span className="text-[10px] text-[color:var(--text-muted)] font-medium">P80</span>
              <span className={`latency-badge ${getBadgeClass(p80)}`}>{p80}ms</span>
            </div>
            <div className="flex items-center gap-1">
              <span className="text-[10px] text-[color:var(--text-muted)] font-medium">P95</span>
              <span className={`latency-badge ${getBadgeClass(p95)}`}>{p95}ms</span>
            </div>
          </div>
        ) : (
          <div className="hidden sm:block skeleton w-[150px] h-[22px]" />
        )}
      </div>
    </div>
  )
})

export default function CloudPing(props: CloudPingProps): JSX.Element {
  const [isFilterOpen, setIsFilterOpen] = useState(false)
  const [isMeasuring, setIsMeasuring] = useState(false)
  const [selectedProviders, setSelectedProviders] = useState(props.providers.map((x) => x.key))
  const [selectedCountries, setSelectedCountries] = useState<string[]>(props.geos[FALLBACK_GEO] || [])
  const [isLocationInitialized, setIsLocationInitialized] = useState(false)
  const latencyStateRef = useRef<LatencyState | null>(null)
  if (!latencyStateRef.current) {
    latencyStateRef.current = createLatencyState(props.providers, props.regions)
  }
  const [latencyState, setLatencyState] = useState<LatencyState>(latencyStateRef.current)
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [pingVersion, setPingVersion] = useState(0)

  const flushLatencyState = () => {
    if (flushTimerRef.current != null) {
      clearTimeout(flushTimerRef.current)
      flushTimerRef.current = null
    }
    setLatencyState({ ...latencyStateRef.current! })
  }

  const updateLatencyState = (updater: (current: LatencyState) => LatencyState, immediate = false) => {
    latencyStateRef.current = updater(latencyStateRef.current!)
    if (immediate) {
      flushLatencyState()
      return
    }
    if (flushTimerRef.current != null) return
    flushTimerRef.current = setTimeout(() => {
      flushTimerRef.current = null
      setLatencyState({ ...latencyStateRef.current! })
    }, UI_FLUSH_MS)
  }

  const handleReset = () => {
    updateLatencyState((current) => {
      const next = { ...current }
      for (const key of Object.keys(next)) {
        next[key] = { ...next[key], samples: [], p50: undefined, p80: undefined, p95: undefined, failureCount: 0, nextAttemptAt: undefined }
      }
      return next
    }, true)
    setPingVersion((v) => v + 1)
  }

  const [theme, setTheme] = useState<'light' | 'dark'>('dark')
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
    const clientGeo = getClientGeo(props.geos)
    setSelectedCountries(props.geos[clientGeo] || props.geos[FALLBACK_GEO] || [])
    setIsLocationInitialized(true)
  }, [props.geos])
  const toggleTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark'
    setTheme(next)
    localStorage.setItem('theme', next)
    document.documentElement.setAttribute('data-theme', next)
  }

  async function pingAll(cancelToken: { cancel: boolean }) {
    await delay(1000)
    const now = Date.now()
    const state = latencyStateRef.current
    if (!state) return
    const shuffledItems = Object.values(state)
      .filter((item) => item.region.ping_url && selectedCountries.includes(item.region.country) && selectedProviders.includes(item.provider.key))
      .filter((item) => !item.nextAttemptAt || now >= item.nextAttemptAt)
      .sort(() => 0.5 - Math.random())

    const CONCURRENCY = 6
    const queue = [...shuffledItems]

    async function worker() {
      while (queue.length > 0 && !cancelToken.cancel) {
        const item = queue.shift()
        if (!item) break

        try {
          const newSamples = await ping(`${item.region.ping_url}`)
          updateLatencyState((x) => {
            const n = { ...x[item.key] }
            const accumulated = [...(n.samples || []), ...newSamples].slice(-MAX_SAMPLES)
            n.samples = accumulated
            n.p50 = percentile(accumulated, 50)
            n.p80 = percentile(accumulated, 80)
            n.p95 = percentile(accumulated, 95)
            n.failureCount = 0
            n.nextAttemptAt = undefined
            return { ...x, [item.key]: n }
          })
        } catch {
          updateLatencyState((x) => {
            const n = { ...x[item.key] }
            const fc = (n.failureCount || 0) + 1
            n.failureCount = fc
            if (fc >= 3) {
              const backoff = Math.min(300_000, 10_000 * Math.pow(2, fc - 3))
              const jitter = backoff * (0.8 + Math.random() * 0.4)
              n.nextAttemptAt = Date.now() + jitter
            }
            return { ...x, [item.key]: n }
          })
        }
      }
    }

    const workers = Array.from({ length: CONCURRENCY }, () => worker())
    await Promise.all(workers)
    flushLatencyState()

    if (!cancelToken.cancel) {
      await delay(3000)
      await pingAll(cancelToken)
    }
  }

  useEffect(() => {
    let ct = { cancel: false }

    const runPing = () => {
      if (document.hidden) return
      if (isLocationInitialized && selectedProviders.length >= 1 && selectedCountries.length >= 1) {
        setIsMeasuring(true)
        pingAll(ct)
      } else {
        setIsMeasuring(false)
      }
    }

    const handleVisibilityChange = () => {
      if (document.hidden) {
        ct.cancel = true
        flushLatencyState()
        setIsMeasuring(false)
      } else {
        ct = { cancel: false }
        runPing()
      }
    }

    document.addEventListener('visibilitychange', handleVisibilityChange)
    void whenPageIdle().then(() => {
      if (!ct.cancel) runPing()
    })

    return () => {
      ct.cancel = true
      setIsMeasuring(false)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      if (flushTimerRef.current != null) {
        clearTimeout(flushTimerRef.current)
        flushTimerRef.current = null
      }
    }
  }, [isLocationInitialized, selectedProviders, selectedCountries, pingVersion])

  const { sortedRegions, sortedRegionsWithLatency, maxLatency } = useMemo(() => {
    const filteredRegions = Object.values(latencyState).filter(
      (x) => selectedProviders.includes(x.provider.key) && selectedCountries.includes(x.region.country)
    )
    const reachable = filteredRegions.filter((x) => (x.failureCount || 0) < 3)
    const unreachable = filteredRegions.filter((x) => (x.failureCount || 0) >= 3)
    const withLatency = reachable.filter((x) => x.p50).sort((a, b) => (a.p50 && b.p50 ? a.p50 - b.p50 : 1))
    return {
      sortedRegionsWithLatency: withLatency,
      sortedRegions: [...withLatency, ...reachable.filter((x) => !x.p50), ...unreachable],
      maxLatency: withLatency.length > 1 ? withLatency[withLatency.length - 1].p50 || 0 : 0,
    }
  }, [latencyState, selectedProviders, selectedCountries])

  const toggleProvider = (k: string) => setSelectedProviders((v) => (v.includes(k) ? v.filter((x) => x !== k) : [...v, k]))
  const toggleCountry = (c: string) => setSelectedCountries((v) => (v.includes(c) ? v.filter((x) => x !== c) : [...v, c]))
  const toggleGeo = (geo: string, checked: boolean) =>
    setSelectedCountries((v) => (checked ? [...new Set([...v, ...props.geos[geo]])] : v.filter((x) => !props.geos[geo].includes(x))))

  const title = 'Cloudping.me'
  const description = 'Test your network latency to cloud data centers from AWS, Azure, GCP, and 11 more providers.'
  const siteUrl = getSiteUrl()
  const geoOrder = ['North America', 'Europe', 'Asia', 'Middle East', 'South America', 'Oceania', 'Africa']

  const selectedGeos = Object.entries(props.geos)
    .filter(([, countries]) => countries.some((c) => selectedCountries.includes(c)))
    .map(([geo]) => geo)
  const selectedGeoLabel =
    selectedGeos.length > 2
      ? `${selectedGeos.slice(0, 2).join(', ')} +${selectedGeos.length - 2}`
      : selectedGeos.join(', ') || `${selectedCountries.length} countries`

  return (
    <>
      <Head>
        <title>Cloudping.me</title>
        <meta name="description" content={description} />
        <meta property="og:title" content={title} />
        <meta property="og:type" content="website" />
        {siteUrl ? <meta property="og:url" content={siteUrl} /> : null}
        {siteUrl ? <meta property="og:image" content={`${siteUrl}/images/large-screenshot.png`} /> : null}
        <meta property="og:description" content={description} />
        {siteUrl ? <link rel="canonical" href={siteUrl} /> : null}
        <meta name="theme-color" content="#060910" />
      </Head>
      <div className="min-h-screen">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 sm:py-8">
          <SiteHeader active="ping" theme={theme} onToggleTheme={toggleTheme} />
          <p className="text-sm text-[color:var(--text-secondary)] -mt-6 mb-1">
            Measure network latency to cloud data centers worldwide. Results update continuously.
          </p>
          <p className="text-xs text-[color:var(--text-muted)] mb-8">
            Latency is measured as HTTP round-trip time from your browser. Results may vary by network conditions and do not reflect guaranteed service
            performance.
          </p>
          <div className="mb-8">
            <div className="flex items-center justify-between mb-3">
              <h6 className="text-xs font-medium text-[color:var(--text-muted)] uppercase tracking-wider">Cloud Providers</h6>
              <button
                type="button"
                className="switch-toggle"
                aria-pressed={selectedProviders.length === props.providers.length}
                aria-label="Toggle all providers"
                onClick={() => setSelectedProviders(selectedProviders.length === props.providers.length ? [] : props.providers.map((p) => p.key))}
                title={selectedProviders.length === props.providers.length ? 'Deselect all providers' : 'Select all providers'}
              >
                <span>All</span>
                <span className="switch-toggle-track">
                  <span className="switch-toggle-knob" />
                </span>
              </button>
            </div>
            <div className="pills-wrap">
              {props.providers.map((provider) => {
                const isActive = selectedProviders.includes(provider.key)
                return (
                  <button
                    key={provider.key}
                    onClick={() => toggleProvider(provider.key)}
                    className={`provider-pill ${isActive ? 'active' : ''}`}
                    title={provider.display_name}
                  >
                    <CloudProviderLogo width={16} providerKey={provider.key} providerName={provider.display_name} loading="eager" />
                    <span className="hidden sm:inline">{provider.display_name}</span>
                    <span className="sm:hidden">{provider.short_name ?? provider.display_name}</span>
                  </button>
                )
              })}
            </div>
          </div>
          <div className="flex flex-col lg:flex-row gap-6 lg:gap-8">
            <div className="lg:hidden">
              <button onClick={() => setIsFilterOpen(!isFilterOpen)} className="mobile-filter-btn">
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z"
                  />
                </svg>
                <span>Filter Locations</span>
                <span className="ml-auto text-xs text-[color:var(--text-muted)] truncate max-w-[140px]">{selectedGeoLabel}</span>
              </button>
            </div>
            <aside className={`w-full lg:w-60 flex-shrink-0 ${isFilterOpen ? 'block' : 'hidden lg:block'}`}>
              <div className="rounded-xl border border-[color:var(--border)] p-4 sticky top-4">
                <div className="flex items-center justify-between mb-4">
                  <h5 className="text-sm font-medium text-[color:var(--text-secondary)]">Locations</h5>
                  <button
                    type="button"
                    className="switch-toggle"
                    aria-pressed={selectedCountries.length === props.countries.length}
                    aria-label="Toggle all locations"
                    onClick={() => setSelectedCountries(selectedCountries.length === props.countries.length ? [] : props.countries)}
                    title={selectedCountries.length === props.countries.length ? 'Deselect all locations' : 'Select all locations'}
                  >
                    <span>All</span>
                    <span className="switch-toggle-track">
                      <span className="switch-toggle-knob" />
                    </span>
                  </button>
                </div>
                <div className="overflow-y-auto pr-1 -mr-1" style={{ maxHeight: 'calc(100vh - 160px)' }}>
                  {geoOrder.map((geo) => {
                    if (!props.geos[geo]) return null
                    return (
                      <GeoSection
                        key={geo}
                        geo={geo}
                        countries={props.geos[geo]}
                        selectedCountries={selectedCountries}
                        onToggleCountry={toggleCountry}
                        onToggleGeo={toggleGeo}
                      />
                    )
                  })}
                </div>
              </div>
            </aside>
            <main className="flex-1 min-w-0">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-3">
                  <h5 className="text-sm font-medium text-[color:var(--text-secondary)]">Latency Results</h5>
                  {isMeasuring && <span className="measuring-dot" title="Measuring…" />}
                  <span className="text-xs text-[color:var(--text-muted)] tabular-nums">
                    {sortedRegionsWithLatency.length} / {sortedRegions.length} {isMeasuring ? 'measuring…' : 'measured'}
                  </span>
                </div>
                <div className="flex items-center gap-3">
                  {sortedRegionsWithLatency.length > 0 && (
                    <div className="hidden sm:flex items-center gap-4 text-xs text-[color:var(--text-muted)]">
                      <span className="flex items-center gap-1.5" title="Excellent — suitable for real-time apps">
                        <span className="w-2 h-2 rounded-full bg-[var(--badge-success-text)]" />
                        {'<80ms'}
                      </span>
                      <span className="flex items-center gap-1.5" title="Good for most workloads">
                        <span className="w-2 h-2 rounded-full bg-[var(--badge-warning-text)]" />
                        {'<200ms'}
                      </span>
                      <span className="flex items-center gap-1.5" title="High latency — consider a closer region">
                        <span className="w-2 h-2 rounded-full bg-[var(--badge-danger-text)]" />
                        {'>200ms'}
                      </span>
                    </div>
                  )}
                  {isLocationInitialized && selectedProviders.length >= 1 && selectedCountries.length >= 1 && (
                    <button
                      onClick={handleReset}
                      className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium border border-[color:var(--border)] bg-[color:var(--bg-surface)] hover:bg-[color:var(--border-subtle)] text-[color:var(--text-secondary)] hover:text-[color:var(--text)] transition-all cursor-pointer shadow-sm hover:shadow active:scale-95"
                      title="Clear and restart latency measurements"
                    >
                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.2}>
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99"
                        />
                      </svg>
                      <span>Reset</span>
                    </button>
                  )}
                </div>
              </div>
              <div
                className="latency-list"
                style={isLocationInitialized && sortedRegions.length > 0 ? { ['--rows' as string]: sortedRegions.length } : undefined}
              >
                {!isLocationInitialized ? null : sortedRegions.length === 0 ? (
                  <div className="text-center py-12 text-[color:var(--text-muted)]">
                    <p>No regions selected. Choose providers and locations above.</p>
                  </div>
                ) : (
                  sortedRegions.map((x, index) => (
                    <LatencyCard key={x.key} data={x} maxLatency={maxLatency} rank={x.p50 ? index + 1 : undefined} rankIndex={index} />
                  ))
                )}
              </div>
            </main>
          </div>
          <footer className="mt-12 border-t border-[color:var(--border)] pt-8 flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-[color:var(--text-muted)]">&copy; {new Date().getFullYear()} Cloudping.me</p>
            <div className="flex items-center gap-4 text-sm text-[color:var(--text-muted)]">
              <a
                href="https://github.com/cloudpickr/cloudping.me"
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1.5 hover:text-[color:var(--text-secondary)] transition-colors"
              >
                <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                  <path
                    fillRule="evenodd"
                    clipRule="evenodd"
                    d="M12 2C6.477 2 2 6.477 2 12c0 4.418 2.865 8.166 6.839 9.489.5.092.682-.217.682-.482 0-.237-.009-.866-.013-1.7-2.782.603-3.369-1.342-3.369-1.342-.454-1.154-1.11-1.462-1.11-1.462-.908-.62.069-.608.069-.608 1.003.07 1.531 1.03 1.531 1.03.892 1.529 2.341 1.087 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.11-4.555-4.943 0-1.091.39-1.984 1.029-2.683-.103-.253-.446-1.27.098-2.647 0 0 .84-.269 2.75 1.025A9.578 9.578 0 0112 6.836c.85.004 1.705.114 2.504.336 1.909-1.294 2.747-1.025 2.747-1.025.546 1.377.203 2.394.1 2.647.64.699 1.028 1.592 1.028 2.683 0 3.842-2.339 4.687-4.566 4.935.359.309.678.919.678 1.852 0 1.336-.012 2.415-.012 2.741 0 .267.18.578.688.48C19.138 20.163 22 16.418 22 12c0-5.523-4.477-10-10-10z"
                  />
                </svg>
                <span>Open Source</span>
              </a>
              <a
                href="https://github.com/goenning/webping.cloud"
                target="_blank"
                rel="noopener noreferrer"
                className="hover:text-[color:var(--text-secondary)] transition-colors"
              >
                Based on webping.cloud
              </a>
            </div>
          </footer>
        </div>
      </div>
    </>
  )
}
