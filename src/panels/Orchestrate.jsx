import { useEffect, useMemo, useRef, useState } from 'react'
import { AGENTS, DEFAULT_TASK, EDGES, postStream, rank, statusAt } from '../data.js'
import { Btn, Panel, Placeholder, Status, clock, cx } from '../ui.jsx'

/* Graph geometry. One viewBox, scaled to fit — keeps node and edge
   coordinates in one place instead of spread across CSS. */
const W = 148
const H = 70
const POS = { researcher: { x: 16, y: 48 }, writer: { x: 206, y: 48 }, checker: { x: 396, y: 48 } }
const PATH = {
  'r-w': 'M 164 83 L 200 83',
  'w-c': 'M 354 83 L 390 83',
  'c-w': 'M 470 118 C 470 176, 470 178, 420 178 L 330 178 C 280 178, 280 176, 280 124',
}

/* Two ramps, not one. BORDER stays quiet so a finished run doesn't turn the
   whole graph green; TONE carries the semantics in small marks — the dot,
   the status word, the log bullet. */
const BORDER = { idle: '#1E2637', running: '#6366F1', done: '#2C3550', revise: '#D99E4A', failed: '#DD6B6B' }
const TONE = { idle: '#414B63', running: '#6366F1', done: '#5BC48B', revise: '#D99E4A', failed: '#DD6B6B' }
const LABEL = { idle: 'queued', running: 'running', done: 'done', revise: 'sent back', failed: 'failed' }

const short = (s) => (s.length > 22 ? `${s.slice(0, 21)}…` : s)

function Graph({ status, activeEdge, traversed, hover, setHover }) {
  return (
    <svg
      viewBox="0 0 560 212"
      className="w-full"
      role="img"
      aria-label="Agent graph: the Researcher selects passages and feeds the Writer, the Writer feeds the Fact-Checker, and the Fact-Checker can send the draft back to the Writer."
    >
      <defs>
        {['#1E2637', '#6366F1', '#2C3550'].map((c) => (
          <marker key={c} id={`ar${c.slice(1)}`} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
            <path d="M0,0 L8,4 L0,8 z" fill={c} />
          </marker>
        ))}
      </defs>

      {EDGES.map((e) => {
        const on = activeEdge === e.id
        const used = traversed.has(e.id)
        const lit = on || hover === e.from || hover === e.to
        const color = on ? '#6366F1' : lit || used ? '#2C3550' : '#1E2637'
        return (
          <g key={e.id}>
            <path
              d={PATH[e.id]}
              fill="none"
              stroke={color}
              strokeWidth={on ? 1.5 : 1}
              strokeDasharray={on ? '4 4' : e.back ? '3 4' : undefined}
              className={on ? 'flow' : undefined}
              markerEnd={`url(#ar${color.slice(1)})`}
              vectorEffect="non-scaling-stroke"
            />
            {e.back && (
              <>
                <rect x={348} y={170} width={54} height={14} fill="#0B0F19" />
                <text x={375} y={180} textAnchor="middle" fill={on ? '#818CF8' : '#414B63'} fontSize="8.5" letterSpacing="1" fontFamily="Geist Mono, monospace">
                  REVISE
                </text>
              </>
            )}
          </g>
        )
      })}

      {AGENTS.map((a, i) => {
        const s = status[a.id]
        const p = POS[a.id]
        const active = s === 'running'
        return (
          <g key={a.id} onMouseEnter={() => setHover(a.id)} onMouseLeave={() => setHover(null)} className="cursor-default">
            <title>{a.job}</title>
            <rect
              x={p.x}
              y={p.y}
              width={W}
              height={H}
              rx="3"
              fill={active || hover === a.id ? '#161D2E' : '#111725'}
              stroke={BORDER[s]}
              strokeWidth={active ? 1.5 : 1}
              vectorEffect="non-scaling-stroke"
            />
            {active && <rect x={p.x} y={p.y} width={W} height={H} rx="3" fill="#6366F1" fillOpacity="0.08" />}
            {/* Ordinal is real here: the graph is a pipeline, so 1/2/3 is
                information, not decoration. */}
            <text x={p.x + W - 10} y={p.y + 19} textAnchor="end" fill="#414B63" fontSize="9" fontFamily="Geist Mono, monospace">
              {i + 1}/3
            </text>
            <circle cx={p.x + 14} cy={p.y + 15} r="3" fill={TONE[s]} className={active ? 'breathe' : undefined} />
            <text x={p.x + 24} y={p.y + 19} fill="#E8EAF0" fontSize="13" fontFamily="Geist, sans-serif" fontWeight="500">
              {a.name}
            </text>
            <text x={p.x + 14} y={p.y + 38} fill={TONE[s]} fontSize="8.5" letterSpacing="1.1" fontFamily="Geist Mono, monospace">
              {LABEL[s].toUpperCase()}
            </text>
            <text x={p.x + 14} y={p.y + 56} fill="#6B7590" fontSize="9.5" fontFamily="Geist Mono, monospace">
              {short(s === 'idle' ? a.job : (status[`${a.id}:msg`] ?? a.job))}
            </text>
          </g>
        )
      })}
    </svg>
  )
}

/* How many passages the Researcher is handed. Enough to reason over a
   real document, small enough to stay inside a sensible prompt. */
const POOL = 24

export default function Orchestrate({ emit, docs, setTab, health }) {
  const [task, setTask] = useState(DEFAULT_TASK)
  const [events, setEvents] = useState([])
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)
  const [phase, setPhase] = useState('idle') // idle | running | complete | failed
  const [ms, setMs] = useState(0)
  const [hover, setHover] = useState(null)

  const abort = useRef(null)
  const logEl = useRef(null)

  useEffect(() => () => abort.current?.abort(), [])

  useEffect(() => {
    if (phase !== 'running') return
    const origin = performance.now()
    const id = setInterval(() => setMs(performance.now() - origin), 100)
    return () => clearInterval(id)
  }, [phase])

  useEffect(() => {
    logEl.current?.scrollTo({ top: logEl.current.scrollHeight, behavior: 'smooth' })
  }, [events])

  /* Every chunk across every source, with ids that stay unique when two
     documents both number their chunks from one. */
  const pool = useMemo(
    () =>
      docs.flatMap((d) =>
        d.chunks.map((c) => ({
          id: `${d.id}#${c.id}`,
          page: c.page,
          body: c.body,
          label: `${d.name} ${d.unit}.${c.page}`,
        })),
      ),
    [docs],
  )

  async function start() {
    if (!task.trim() || !pool.length) return
    abort.current?.abort()
    abort.current = new AbortController()

    setEvents([])
    setResult(null)
    setError(null)
    setMs(0)
    setPhase('running')

    const ranked = rank(pool, task, POOL)
    const chunks = ranked.length >= 3 ? ranked.map((h) => h.chunk) : pool.slice(0, POOL)
    emit('agents', `Run started · ${chunks.length} passages from ${docs.length} source(s)`)

    try {
      await postStream(
        '/api/run',
        { task, chunks },
        (ev) => {
          if (ev.type === 'result') {
            setResult(ev)
            setPhase(ev.halted ? 'failed' : 'complete')
            setMs(ev.t)
            emit(
              'agents',
              ev.halted
                ? 'Run halted · nothing relevant in the sources'
                : `Run complete · ${ev.verdicts.filter((v) => v.verdict === 'supported').length}/${ev.verdicts.length} claims verified`,
            )
          } else if (ev.type === 'error') {
            setError(ev.error)
            setPhase('failed')
            emit('agents', `Run failed · ${ev.error}`)
          } else {
            setEvents((e) => [...e, ev])
            emit('agents', `${ev.agent} · ${ev.msg}`)
          }
        },
        abort.current.signal,
      )
    } catch (e) {
      if (e.name === 'AbortError') return
      setError(e.message)
      setPhase('failed')
      emit('agents', `Run failed · ${e.message}`)
    }
  }

  function stop() {
    abort.current?.abort()
    setPhase('idle')
    emit('agents', 'Run stopped')
  }

  const status = useMemo(() => {
    const s = statusAt(events)
    for (const e of events) if (e.agent) s[`${e.agent}:msg`] = e.msg
    return s
  }, [events])

  const activeEdge = useMemo(() => {
    for (let i = events.length - 1; i >= 0; i--) {
      if (!events[i].edge) continue
      return status[events[i].agent] === 'running' ? events[i].edge : null
    }
    return null
  }, [events, status])

  const traversed = new Set(events.map((e) => e.edge).filter(Boolean))
  const running = phase === 'running'
  const blocked = !pool.length

  return (
    <div className="grid min-h-0 flex-1 grid-rows-[auto_1fr] gap-px bg-line">
      {/* Control bar */}
      <div className="flex flex-wrap items-center gap-3 bg-surface px-3 py-2.5">
        <label className="eyebrow shrink-0" htmlFor="task">
          Task
        </label>
        <input
          id="task"
          value={task}
          onChange={(e) => setTask(e.target.value)}
          disabled={running}
          className="h-7 min-w-[220px] flex-1 rounded-sm border border-line bg-raise px-2.5 text-xs text-ink placeholder:text-dim focus:border-accent focus:outline-none disabled:text-muted"
          placeholder="What should the agents produce from your sources?"
        />
        <span className="shrink-0 font-mono text-mono text-dim">
          {pool.length} passages · {docs.length} src
        </span>
        {running ? (
          <Btn onClick={stop}>Stop</Btn>
        ) : (
          <Btn variant="solid" onClick={start} disabled={!task.trim() || blocked || health !== 'ready'}>
            {phase === 'idle' ? 'Start run' : 'Run again'}
          </Btn>
        )}
        <time className="w-14 shrink-0 text-right font-mono text-xs text-muted">{clock(ms)}</time>
      </div>

      <div className="grid min-h-0 gap-px bg-line lg:grid-cols-[1fr_356px]">
        <div className="grid min-h-0 grid-rows-[auto_1fr] gap-px bg-line">
          <Panel
            label="Graph"
            right={
              <Status
                status={running ? 'running' : phase === 'failed' ? 'failed' : phase === 'complete' ? 'done' : 'idle'}
                label={phase}
              />
            }
            bodyClass="flex min-h-[220px] items-center justify-center overflow-auto p-5"
          >
            {/* Capped: the graph is a diagram at a readable size, not a poster. */}
            <div className="w-full max-w-[720px]">
              <Graph status={status} activeEdge={activeEdge} traversed={traversed} hover={hover} setHover={setHover} />
            </div>
          </Panel>

          <Panel
            label="Brief"
            right={
              result?.verdicts ? (
                <span className="font-mono text-mono text-dim">
                  {result.verdicts.filter((v) => v.verdict === 'supported').length}/{result.verdicts.length} verified
                  {result.passes > 1 && ` · ${result.passes} passes`}
                </span>
              ) : null
            }
          >
            {error ? (
              <Placeholder tone="err" eyebrow="Run failed" title="The run did not finish">
                {error}
              </Placeholder>
            ) : result?.brief ? (
              <div className="px-3 py-3">
                <p className="max-w-[70ch] text-md leading-relaxed whitespace-pre-wrap text-ink">
                  {result.brief}
                </p>

                <h3 className="eyebrow mt-5 mb-2">Claims checked against the sources</h3>
                <ul className="divide-y divide-line-soft border-t border-line-soft">
                  {result.verdicts.map((v, i) => (
                    <li key={i} className="grid grid-cols-[76px_1fr] gap-3 py-2">
                      <span
                        className={cx(
                          'font-mono text-micro tracking-[0.06em] uppercase',
                          v.verdict === 'supported' ? 'text-ok' : 'text-warn',
                        )}
                      >
                        {v.verdict === 'supported' ? 'supported' : 'unsupported'}
                      </span>
                      <div className="min-w-0">
                        <p className="text-xs text-ink">{v.claim}</p>
                        {v.verdict !== 'supported' && (
                          <p className="mt-1 text-xs text-muted">{v.note}</p>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>

                {result.unresolved && (
                  <p role="status" className="mt-4 border-l-2 border-warn bg-raise px-3 py-2.5 text-xs text-muted">
                    Some claims are still unsupported after {result.passes} passes. They are left in
                    and labelled rather than quietly dropped — the sources may simply not cover them.
                  </p>
                )}
              </div>
            ) : running ? (
              <Placeholder eyebrow="Working" title="The agents are still running">
                The brief lands here once the Fact-Checker has been through it. Watch the log on the
                right for what each agent is doing.
              </Placeholder>
            ) : blocked ? (
              <Placeholder
                tone="warn"
                eyebrow="No sources"
                title="There is nothing to research"
                action={<Btn variant="solid" onClick={() => setTab('rag')}>Add a source</Btn>}
              >
                These agents only read documents you have added. Drop a PDF or a text file into
                Retrieve — or record something in Transcribe and add the transcript — then come back.
              </Placeholder>
            ) : health !== 'ready' ? (
              <Placeholder
                tone="warn"
                eyebrow={health === 'nokey' ? 'No API key' : 'API offline'}
                title="The model is not reachable"
              >
                {health === 'nokey'
                  ? 'Put GEMINI_API_KEY in a .env file next to server.js and restart the API server.'
                  : 'Start the API server with `npm run server`, then reload this page.'}
              </Placeholder>
            ) : (
              <Placeholder eyebrow="No run yet" title="Nothing has been dispatched">
                Describe what you want out of your {pool.length} indexed passages. The Researcher
                picks the relevant ones, the Writer drafts from those alone, and the Fact-Checker
                verifies each claim — sending the draft back if any of them do not hold up.
              </Placeholder>
            )}
          </Panel>
        </div>

        <Panel
          label="Run log"
          right={<span className="font-mono text-mono text-dim">{events.length} events</span>}
          bodyClass="overflow-hidden"
        >
          <div ref={logEl} className="h-full overflow-y-auto">
            {!events.length ? (
              <Placeholder eyebrow="Idle" title="No events">
                Each agent reports here as it works. Nothing is pre-timed — the gaps are the model
                thinking.
              </Placeholder>
            ) : (
              <ol aria-live="polite" className="divide-y divide-line-soft">
                {events.map((e, i) => (
                  <li key={i} className="slip grid grid-cols-[52px_1fr] gap-3 px-3 py-2">
                    <time className="pt-px font-mono text-mono text-dim">{clock(e.t)}</time>
                    <div className="min-w-0">
                      <span className="flex items-center gap-1.5">
                        <span className="size-1.5 shrink-0 rounded-full" style={{ background: TONE[e.status] }} />
                        <span className="font-mono text-micro tracking-[0.11em] text-muted uppercase">
                          {e.agent}
                        </span>
                      </span>
                      <p
                        className={cx(
                          'mt-0.5 text-xs',
                          e.status === 'failed' ? 'text-err' : e.status === 'revise' ? 'text-warn' : 'text-ink',
                        )}
                      >
                        {e.msg}
                      </p>
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </div>
        </Panel>
      </div>
    </div>
  )
}
