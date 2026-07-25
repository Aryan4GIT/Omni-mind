import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { chunk } from '../data.js'
import { Btn, Dot, Panel, Placeholder, Status, clock, cx } from '../ui.jsx'

/* Real speech recognition, via the browser's own engine. No key, no
   upload from our side, no scripted transcript. Chrome and Edge
   implement it; Firefox and Safari do not, and we say so rather than
   faking a result. */
const SR =
  typeof window !== 'undefined' &&
  (window.SpeechRecognition || window.webkitSpeechRecognition)

/* ── Waveform ───────────────────────────────────────────────────
   A scrolling amplitude history, not a spectrum analyser: one sample
   per frame pushed into a ring buffer and drawn as mirrored bars
   marching left. Reads as elapsed speech, which is what a transcript is. */
function Waveform({ getLevel, active }) {
  const ref = useRef(null)
  const hist = useRef([]) // survives re-subscribes, so stopping doesn't wipe history

  useEffect(() => {
    const cvs = ref.current
    let raf

    const draw = () => {
      raf = requestAnimationFrame(draw)
      const w = cvs.clientWidth
      const h = cvs.clientHeight
      if (!w || !h) return // panel is hidden — skip, don't resize to zero

      const dpr = window.devicePixelRatio || 1
      if (cvs.width !== Math.round(w * dpr)) {
        cvs.width = Math.round(w * dpr)
        cvs.height = Math.round(h * dpr)
      }
      const g = cvs.getContext('2d')
      g.setTransform(dpr, 0, 0, dpr, 0, 0)
      g.clearRect(0, 0, w, h)

      const BAR = 3
      const STEP = 5
      const cap = Math.ceil(w / STEP)
      const bars = hist.current
      bars.push(getLevel())
      if (bars.length > cap) bars.splice(0, bars.length - cap)
      // Pad the front at the silence floor so a fresh session shows a full
      // baseline rather than two bars stranded at the right edge.
      if (bars.length < cap) bars.unshift(...new Array(cap - bars.length).fill(0))

      const mid = h / 2

      // Baseline: visible even in silence, so the panel is never blank.
      g.fillStyle = '#1E2637'
      g.fillRect(0, mid, w, 1)

      const start = w - bars.length * STEP
      for (let i = 0; i < bars.length; i++) {
        const amp = Math.max(0.012, bars[i]) * (h / 2 - 6)
        // Recency ramp: the leading edge burns indigo, history cools to the
        // hairline colour so the bar field reads as a timeline.
        const p = i / Math.max(1, bars.length - 1)
        g.fillStyle = `rgba(99,102,241,${(0.16 + 0.84 * p ** 2.6).toFixed(3)})`
        g.fillRect(start + i * STEP, mid - amp, BAR, amp * 2)
      }

      if (active) {
        g.fillStyle = '#818CF8'
        g.fillRect(w - 1, 0, 1, h)
      }
    }

    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [getLevel, active])

  return <canvas ref={ref} className="block h-[124px] w-full" aria-hidden="true" />
}

const LANGS = [
  ['en-US', 'English (US)'],
  ['en-GB', 'English (UK)'],
  ['en-IN', 'English (IN)'],
  ['hi-IN', 'Hindi'],
  ['es-ES', 'Spanish'],
  ['fr-FR', 'French'],
  ['de-DE', 'German'],
  ['ja-JP', 'Japanese'],
]

/* ── Panel ──────────────────────────────────────────────────── */

export default function Transcribe({ emit, addDoc, setTab }) {
  const [mode, setMode] = useState('idle') // idle | arming | recording | stopped | error
  const [error, setError] = useState(null)
  const [lang, setLang] = useState('en-US')
  const [segs, setSegs] = useState([]) // { t, text, conf }
  const [interim, setInterim] = useState('')
  const [ms, setMs] = useState(0)
  const [saved, setSaved] = useState(null)

  const audio = useRef({ ctx: null, stream: null, analyser: null, bins: null })
  const rec = useRef(null)
  const want = useRef(false) // should recognition be running? drives auto-restart
  const origin = useRef(0)
  const segStart = useRef(null)
  const levelRef = useRef(0)
  const streamRef = useRef(null)

  const teardown = useCallback(() => {
    want.current = false
    if (rec.current) {
      rec.current.onend = null
      rec.current.onerror = null
      rec.current.onresult = null
      try {
        rec.current.stop()
      } catch {
        /* already stopped */
      }
      rec.current = null
    }
    const a = audio.current
    a.stream?.getTracks().forEach((t) => t.stop())
    a.ctx?.close().catch(() => {})
    audio.current = { ctx: null, stream: null, analyser: null, bins: null }
  }, [])

  useEffect(() => teardown, [teardown])

  /* Mic energy, smoothed, one sample per frame. Silence when not live. */
  const getLevel = useCallback(() => {
    const a = audio.current
    let raw = 0
    if (a.analyser && mode === 'recording') {
      a.analyser.getByteFrequencyData(a.bins)
      let sum = 0
      const top = Math.min(48, a.bins.length)
      for (let i = 0; i < top; i++) sum += a.bins[i]
      raw = Math.min(1, sum / top / 122)
    }
    levelRef.current += (raw - levelRef.current) * 0.35
    return levelRef.current
  }, [mode])

  /* Elapsed clock. One interval, so the transcript's timestamps and the
     figure above it can never disagree. */
  useEffect(() => {
    if (mode !== 'recording') return
    const id = setInterval(() => setMs(performance.now() - origin.current), 100)
    return () => clearInterval(id)
  }, [mode])

  /* Follow the transcript while it writes, but leave the reader alone
     if they have scrolled up. */
  useEffect(() => {
    const el = streamRef.current
    if (!el || mode !== 'recording') return
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 90) el.scrollTop = el.scrollHeight
  }, [segs, interim, mode])

  function build() {
    const r = new SR()
    r.continuous = true
    r.interimResults = true
    r.lang = lang
    r.maxAlternatives = 1

    r.onresult = (e) => {
      let pending = ''
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const result = e.results[i]
        const alt = result[0]
        if (result.isFinal) {
          const text = alt.transcript.trim()
          if (!text) continue
          const t = segStart.current ?? performance.now() - origin.current
          segStart.current = null
          setSegs((s) => [...s, { t, text, conf: alt.confidence || null }])
        } else {
          pending += alt.transcript
        }
      }
      if (pending && segStart.current === null) segStart.current = performance.now() - origin.current
      setInterim(pending)
    }

    r.onerror = (e) => {
      if (e.error === 'no-speech' || e.error === 'aborted') return // benign; onend restarts
      want.current = false
      setMode('error')
      setError(
        e.error === 'not-allowed' || e.error === 'service-not-allowed'
          ? 'Microphone access was denied. Allow it for this site in the address-bar permissions, then record again.'
          : e.error === 'network'
            ? 'The recognition service could not be reached. Speech recognition in Chrome needs a network connection.'
            : `Recognition stopped: ${e.error}`,
      )
      emit('voice', `Recognition error · ${e.error}`)
    }

    // Chrome ends the session after a stretch of silence even with
    // continuous=true. Restart while the user still wants to record.
    r.onend = () => {
      if (!want.current) return
      try {
        r.start()
      } catch {
        /* already restarting */
      }
    }
    return r
  }

  async function start() {
    if (!SR) return
    setError(null)
    setSaved(null)
    setMode('arming')
    emit('voice', 'Requesting microphone')
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const ctx = new (window.AudioContext || window.webkitAudioContext)()
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 512
      analyser.smoothingTimeConstant = 0.72
      ctx.createMediaStreamSource(stream).connect(analyser)
      audio.current = { ctx, stream, analyser, bins: new Uint8Array(analyser.frequencyBinCount) }

      rec.current = build()
      want.current = true
      rec.current.start()

      origin.current = performance.now() - ms
      setMode('recording')
      emit('voice', `Listening · ${lang}`)
    } catch {
      teardown()
      setMode('error')
      setError(
        'The browser denied microphone access. Allow it for this site in the address-bar permissions and try again.',
      )
      emit('voice', 'Microphone blocked by the browser')
    }
  }

  function stop() {
    teardown()
    setInterim('')
    setMode('stopped')
    emit('voice', `Stopped at ${clock(ms)} · ${segs.length} segments`)
  }

  function reset() {
    teardown()
    setMode('idle')
    setSegs([])
    setInterim('')
    setError(null)
    setSaved(null)
    setMs(0)
  }

  const text = useMemo(() => segs.map((s) => s.text).join('\n\n'), [segs])
  const words = useMemo(
    () => segs.reduce((n, s) => n + s.text.split(/\s+/).filter(Boolean).length, 0),
    [segs],
  )
  const conf = useMemo(() => {
    const scored = segs.filter((s) => s.conf != null)
    return scored.length ? scored.reduce((n, s) => n + s.conf, 0) / scored.length : null
  }, [segs])

  function toSources() {
    const name = `transcript-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}.txt`
    const doc = addDoc(name, chunk(text), { kind: 'txt', size: new Blob([text]).size })
    if (!doc) {
      setSaved('Too short to index — a source needs at least one paragraph of 40+ characters.')
      return
    }
    setSaved(`Added as ${name} · ${doc.chunks.length} chunks`)
    emit('rag', `${name} indexed · ${doc.chunks.length} chunks`)
  }

  const recording = mode === 'recording'

  return (
    <div className="grid min-h-0 flex-1 grid-rows-[auto_1fr] gap-px bg-line">
      {/* Capture band — the waveform is the hero, full bleed across the top */}
      <section className="bg-surface">
        <header className="flex h-9 items-center justify-between gap-3 border-b border-line px-3">
          <div className="flex items-center gap-3">
            <h2 className="eyebrow">Capture</h2>
            <span className="hidden font-mono text-mono text-dim sm:inline">
              {recording ? 'mic · 1 ch · browser speech engine' : 'no input'}
            </span>
          </div>
          <div className="flex items-center gap-4">
            <time className="font-mono text-xs text-ink tabular-nums">{clock(ms)}</time>
            <Status
              status={
                recording ? 'live' : mode === 'error' ? 'failed' : mode === 'stopped' ? 'done' : 'idle'
              }
              label={
                recording
                  ? 'rec'
                  : mode === 'arming'
                    ? 'arming'
                    : mode === 'error'
                      ? 'blocked'
                      : mode === 'stopped'
                        ? 'ended'
                        : 'ready'
              }
            />
          </div>
        </header>

        <Waveform getLevel={getLevel} active={recording} />

        <div className="flex flex-wrap items-center gap-2 border-t border-line-soft px-3 py-2">
          {recording ? (
            <Btn onClick={stop}>Stop</Btn>
          ) : (
            <Btn variant="solid" onClick={start} disabled={!SR || mode === 'arming'}>
              <Dot status={mode === 'arming' ? 'running' : 'failed'} className="bg-white" />
              {mode === 'arming' ? 'Arming' : segs.length ? 'Resume' : 'Record'}
            </Btn>
          )}

          <label className="sr-only" htmlFor="lang">
            Recognition language
          </label>
          <select
            id="lang"
            value={lang}
            onChange={(e) => setLang(e.target.value)}
            disabled={recording}
            className="h-7 rounded-sm border border-line bg-raise px-2 font-mono text-mono text-muted focus:border-accent focus:outline-none disabled:opacity-50"
          >
            {LANGS.map(([code, label]) => (
              <option key={code} value={code}>
                {label}
              </option>
            ))}
          </select>

          <Btn onClick={toSources} disabled={!segs.length}>
            Add to sources
          </Btn>
          <Btn variant="quiet" onClick={() => navigator.clipboard?.writeText(text)} disabled={!segs.length}>
            Copy
          </Btn>
          <Btn variant="quiet" onClick={reset} disabled={!segs.length && !ms}>
            Reset
          </Btn>

          <span className="ml-auto font-mono text-mono text-dim">
            {words} words · {segs.length} segments
            {conf !== null && ` · ${Math.round(conf * 100)}% conf`}
          </span>
        </div>

        {saved && (
          <p className="flex items-center gap-3 border-t border-line-soft px-3 py-2 text-xs text-muted">
            {saved}
            <Btn variant="quiet" onClick={() => setTab('rag')}>
              Open in Retrieve
            </Btn>
          </p>
        )}
      </section>

      {/* Transcript + per-segment metadata */}
      <div className="grid min-h-0 gap-px bg-line lg:grid-cols-[1fr_312px]">
        <Panel
          label="Transcript"
          right={recording ? <span className="font-mono text-mono text-accent-lift">listening</span> : null}
          bodyClass="overflow-hidden"
        >
          <div ref={streamRef} className="h-full overflow-y-auto">
            {!SR ? (
              <Placeholder
                tone="warn"
                eyebrow="Unsupported browser"
                title="This browser has no speech engine"
              >
                Speech recognition is only implemented in Chrome and Edge. There is nothing to fall
                back to that would be real, so nothing is shown here. Open OmniMind in Chrome, or
                paste a transcript into Retrieve as a .txt file instead.
              </Placeholder>
            ) : mode === 'error' ? (
              <Placeholder
                tone="err"
                eyebrow="Recognition stopped"
                title="OmniMind can’t hear anything"
                action={
                  <Btn variant="solid" onClick={start}>
                    Try again
                  </Btn>
                }
              >
                {error}
              </Placeholder>
            ) : !segs.length && !interim ? (
              <Placeholder eyebrow="No audio yet" title="Nothing captured">
                Press Record and speak. Words land here as the browser’s speech engine recognises
                them — the grey line at the bottom is the phrase still being decided. Chrome sends
                audio to Google’s recognition service to do this.
              </Placeholder>
            ) : (
              <ol className="divide-y divide-line-soft">
                {segs.map((s, i) => (
                  <li key={i} className="slip grid grid-cols-[56px_1fr] gap-3 px-3 py-2.5">
                    <div className="pt-0.5">
                      <time className="block font-mono text-mono text-dim">{clock(s.t)}</time>
                      {s.conf != null && (
                        <span
                          className={cx(
                            'font-mono text-micro tracking-[0.06em]',
                            s.conf < 0.8 ? 'text-warn' : 'text-dim',
                          )}
                        >
                          {Math.round(s.conf * 100)}%
                        </span>
                      )}
                    </div>
                    <p className="text-md leading-relaxed text-ink">{s.text}</p>
                  </li>
                ))}
                {interim && (
                  <li className="grid grid-cols-[56px_1fr] gap-3 px-3 py-2.5">
                    <span className="pt-0.5 font-mono text-mono text-dim">···</span>
                    <p className="text-md leading-relaxed text-muted italic">{interim}</p>
                  </li>
                )}
              </ol>
            )}
          </div>
        </Panel>

        <Panel label="Segments" className="hidden lg:flex">
          {segs.length ? (
            <table className="w-full">
              <thead>
                <tr className="border-b border-line-soft">
                  {['time', 'conf', 'words'].map((h) => (
                    <th key={h} className="eyebrow px-3 py-2 text-left font-normal last:text-right">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="font-mono text-mono">
                {segs.map((s, i) => (
                  <tr key={i} className="border-b border-line-soft/60 hover:bg-raise">
                    <td className="px-3 py-1.5 text-muted">{clock(s.t)}</td>
                    <td className={cx('px-3 py-1.5', s.conf != null && s.conf < 0.8 ? 'text-warn' : 'text-ink')}>
                      {s.conf != null ? Math.round(s.conf * 100) : '—'}
                    </td>
                    <td className="px-3 py-1.5 text-right text-ink">
                      {s.text.split(/\s+/).filter(Boolean).length}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Placeholder eyebrow="Empty" title="No segments">
              Each phrase the engine commits lands here with its timestamp and the confidence it
              reported. A dash means the engine returned no confidence for that phrase.
            </Placeholder>
          )}
        </Panel>
      </div>
    </div>
  )
}
