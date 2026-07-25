import { useCallback, useEffect, useRef, useState } from 'react'
import Transcribe from './panels/Transcribe.jsx'
import Retrieve from './panels/Retrieve.jsx'
import Orchestrate from './panels/Orchestrate.jsx'
import { Dot, cx, pad } from './ui.jsx'

const TABS = [
  { id: 'voice', label: 'Transcribe', hint: 'Speech to text, in the browser' },
  { id: 'rag', label: 'Retrieve', hint: 'Question your own documents' },
  { id: 'agents', label: 'Orchestrate', hint: 'Three agents over your sources' },
]

const stamp = () => new Date().toLocaleTimeString('en-GB')

export default function App() {
  const [tab, setTab] = useState('voice')
  const [bus, setBus] = useState([])
  const [up, setUp] = useState(0)
  const [health, setHealth] = useState('checking') // checking | ready | nokey | offline
  const seq = useRef(0)

  /* ── Sources live here, not in Retrieve ─────────────────────
     Both Retrieve and Orchestrate read them, and Transcribe writes
     into them, so a recording can be questioned and then briefed
     without leaving the app. */
  const [docs, setDocs] = useState([])
  const [activeId, setActiveId] = useState(null)

  /* Stable across renders — panels hold this in effect dependency lists. */
  const emit = useCallback((service, text) => {
    setBus((b) => [{ id: ++seq.current, service, text, at: stamp() }, ...b].slice(0, 40))
  }, [])

  /** Register a source from chunks the caller already produced (`chunk` for
   *  prose, `chunkPages` for PDFs). Returns the doc, or null when there was
   *  nothing retrievable in it. */
  const addDoc = useCallback((name, chunks, { kind = 'txt', size = 0, unit = 'blk' } = {}) => {
    if (!chunks?.length) return null
    const doc = { id: `doc-${++seq.current}-${Date.now()}`, name, kind, size, unit, chunks }
    setDocs((d) => [...d, doc])
    setActiveId(doc.id)
    return doc
  }, [])

  useEffect(() => {
    const tick = setInterval(() => setUp((s) => s + 1), 1000)
    fetch('/api/health')
      .then((r) => r.json())
      .then((h) => {
        setHealth(h.ok ? 'ready' : 'nokey')
        emit(
          'system',
          h.ok ? `API attached · ${h.model}` : 'API reachable, but GEMINI_API_KEY is not set',
        )
      })
      .catch(() => {
        setHealth('offline')
        emit('system', 'API server unreachable · run `npm run server`')
      })
    return () => clearInterval(tick)
  }, [emit])

  const panels = { voice: Transcribe, rag: Retrieve, agents: Orchestrate }
  const props = { emit, docs, setDocs, activeId, setActiveId, addDoc, health, setTab }

  const HEALTH = {
    checking: { dot: 'running', label: 'linking' },
    ready: { dot: 'live', label: 'live' },
    nokey: { dot: 'revise', label: 'no key' },
    offline: { dot: 'failed', label: 'offline' },
  }[health]

  return (
    <div className="flex min-h-dvh flex-col lg:h-dvh lg:overflow-hidden">
      {/* ── Navigation ──────────────────────────────────────── */}
      <header className="sticky top-0 z-20 shrink-0 border-b border-line bg-bg/85 backdrop-blur-md">
        <div className="flex h-11 items-center gap-1 px-3">
          <div className="flex shrink-0 items-center gap-2 pr-4">
            <span className="size-2 rotate-45 bg-accent" aria-hidden="true" />
            <span className="font-display text-base font-semibold tracking-[-0.02em]">OmniMind</span>
          </div>

          <nav
            aria-label="Services"
            className="flex min-w-0 items-center gap-1 overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          >
            {TABS.map((t) => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                aria-current={tab === t.id ? 'page' : undefined}
                title={t.hint}
                className={cx(
                  '-mb-px h-11 shrink-0 border-b-2 px-3 text-xs whitespace-nowrap transition-colors duration-150',
                  tab === t.id
                    ? 'border-accent text-ink'
                    : 'border-transparent text-muted hover:border-line hover:text-ink',
                )}
              >
                {t.label}
              </button>
            ))}
          </nav>

          <div className="ml-auto hidden shrink-0 items-center gap-4 pl-4 font-mono text-mono text-dim sm:flex">
            <span>
              SRC <span className="text-muted">{pad(docs.length, 2)}</span>
            </span>
            <span>
              UP{' '}
              <span className="text-muted">
                {pad(Math.floor(up / 60))}:{pad(up % 60)}
              </span>
            </span>
            <span
              className="flex items-center gap-1.5 tracking-[0.11em] uppercase"
              title={
                health === 'nokey'
                  ? 'Put GEMINI_API_KEY in .env and restart the server'
                  : health === 'offline'
                    ? 'Start the API server with `npm run server`'
                    : undefined
              }
            >
              <Dot status={HEALTH.dot} /> {HEALTH.label}
            </span>
          </div>
        </div>
      </header>

      {/* ── Event bus ───────────────────────────────────────────
          One stream for all three services. Panels stay mounted, so a
          recording keeps reporting while you are on the agent graph. */}
      <div className="relative shrink-0 border-b border-line bg-surface">
        <ul
          style={{ maskImage: 'linear-gradient(to right, #000 82%, transparent)' }}
          className="flex h-7 items-center overflow-hidden"
        >
          {bus.slice(0, 8).map((e, i) => (
            <li
              key={e.id}
              style={{ opacity: Math.max(0.22, 1 - i * 0.13) }}
              className="slip flex h-7 shrink-0 items-center gap-2 border-r border-line-soft px-3 font-mono text-mono whitespace-nowrap"
            >
              <time className="text-dim">{e.at}</time>
              {e.service === 'system' ? (
                <span className="text-dim">{e.text}</span>
              ) : (
                <button
                  onClick={() => setTab(e.service)}
                  className="text-muted transition-colors hover:text-accent-lift"
                >
                  <span className="text-dim">{e.service} · </span>
                  {e.text}
                </button>
              )}
            </li>
          ))}
          {!bus.length && (
            <li className="px-3 font-mono text-mono text-dim">no events yet</li>
          )}
        </ul>
      </div>

      {/* ── Panels ──────────────────────────────────────────────
          All three stay mounted so state and a live recording survive
          a tab switch — that is what makes this one hub, not three. */}
      <main className="flex min-h-0 flex-1 flex-col">
        {TABS.map(({ id }) => {
          const Panel = panels[id]
          const on = tab === id
          return (
            <div
              key={id}
              inert={!on}
              style={{ display: on ? 'flex' : 'none' }}
              className="min-h-0 flex-1 flex-col"
            >
              <Panel {...props} />
            </div>
          )
        })}
      </main>
    </div>
  )
}
