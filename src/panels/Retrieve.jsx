import { useEffect, useRef, useState } from 'react'
import { chunk, chunkPages, post, rank } from '../data.js'
import { Btn, Panel, Placeholder, Status, bytes, cx } from '../ui.jsx'

const TEXT = ['txt', 'md', 'markdown', 'csv', 'log', 'json']
const ext = (name) => name.split('.').pop().toLowerCase()

/* Generic starters — they work on any document, unlike questions written
   for one fixture. */
const SUGGESTED = [
  'Summarise this document',
  'What are the key numbers?',
  'What does this leave unanswered?',
]

/** Extract text per page. pdf.js is loaded on first use so the ~1MB
 *  parser never lands in the initial bundle. */
async function readPdf(file) {
  const pdfjs = await import('pdfjs-dist')
  const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url')
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default

  const pdf = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise
  const pages = []
  for (let n = 1; n <= pdf.numPages; n++) {
    const content = await (await pdf.getPage(n)).getTextContent()
    pages.push(content.items.map((i) => i.str).join(' '))
  }
  return pages
}

/** Bold **spans** in the model's answer. */
const fmt = (s) =>
  s
    .split(/(\*\*[^*]+\*\*)/g)
    .map((p, i) =>
      p.startsWith('**') ? (
        <strong key={i} className="font-medium text-ink">
          {p.slice(2, -2)}
        </strong>
      ) : (
        p
      ),
    )

export default function Retrieve({ emit, docs, setDocs, activeId, setActiveId, addDoc, health }) {
  const [turns, setTurns] = useState([])
  const [stage, setStage] = useState(null) // null | 'reading' | 'ranking' | 'asking'
  const [q, setQ] = useState('')
  const [fileError, setFileError] = useState(null)
  const [hl, setHl] = useState(null)

  const chunkEls = useRef({})
  const threadEl = useRef(null)
  const fileInput = useRef(null)

  const doc = docs.find((d) => d.id === activeId)
  const busy = stage !== null
  const cited = new Set(turns.at(-1)?.answer?.cites ?? [])

  useEffect(() => {
    threadEl.current?.scrollTo({ top: threadEl.current.scrollHeight, behavior: 'smooth' })
  }, [turns, stage])

  async function addFiles(files) {
    setFileError(null)
    for (const f of [...files]) {
      const kind = ext(f.name)
      const isPdf = kind === 'pdf'
      if (!isPdf && !TEXT.includes(kind)) {
        setFileError(`Can’t read .${kind} files. Drop a PDF, or a .txt / .md / .csv file.`)
        emit('rag', `Rejected ${f.name} · unsupported type`)
        continue
      }
      try {
        setStage('reading')
        emit('rag', `Reading ${f.name}`)
        const chunks = isPdf ? chunkPages(await readPdf(f)) : chunk(await f.text())
        const added = addDoc(f.name, chunks, {
          kind,
          size: f.size,
          unit: isPdf ? 'p' : 'blk',
        })
        if (!added) {
          setFileError(
            isPdf
              ? `${f.name} has no extractable text. Scanned PDFs are images — they need OCR, which this app does not do.`
              : `${f.name} has no paragraph of 40+ characters to index.`,
          )
          emit('rag', `${f.name} · no extractable text`)
          continue
        }
        emit('rag', `${f.name} indexed · ${added.chunks.length} chunks`)
      } catch (e) {
        setFileError(`Could not read ${f.name}: ${e.message}`)
        emit('rag', `Failed to read ${f.name}`)
      } finally {
        setStage(null)
      }
    }
  }

  async function ask(text) {
    const question = text.trim()
    if (!question || busy || !doc) return
    setQ('')
    setTurns((t) => [...t, { question }])
    emit('rag', `Query · “${question.slice(0, 42)}${question.length > 42 ? '…' : ''}”`)

    const finish = (patch) =>
      setTurns((t) => t.map((x, i) => (i === t.length - 1 ? { ...x, done: true, ...patch } : x)))

    try {
      setStage('ranking')
      // ponytail: lexical BM25 only. Abstract questions ("summarise this")
      // share no terms with the text, so a thin result set falls back to the
      // head of the document. Swap in embeddings if recall starts to matter.
      const ranked = rank(doc.chunks, question, 10)
      const sent = ranked.length >= 3 ? ranked.map((h) => h.chunk) : doc.chunks.slice(0, 10)

      setStage('asking')
      const out = await post('/api/ask', {
        question,
        chunks: sent.map((c) => ({ id: c.id, page: c.page, body: c.body, label: `${doc.unit}.${c.page}` })),
      })

      finish({ answer: out.found ? out : null, miss: out.found ? null : out.answer, searched: sent.length })
      emit(
        'rag',
        out.found ? `Answered from ${out.cites.length} passage(s)` : 'Not covered by this document',
      )
    } catch (e) {
      finish({ error: e.message })
      emit('rag', `Query failed · ${e.message}`)
    } finally {
      setStage(null)
    }
  }

  function removeDoc(id) {
    setDocs((d) => d.filter((x) => x.id !== id))
    if (id === activeId) {
      setTurns([])
      setActiveId(docs.find((d) => d.id !== id)?.id ?? null)
    }
  }

  const jump = (id) => chunkEls.current[id]?.scrollIntoView({ block: 'center', behavior: 'smooth' })

  const STAGE = { reading: 'Extracting text', ranking: 'Ranking passages', asking: 'Asking Gemini' }

  return (
    <div className="grid min-h-0 flex-1 gap-px bg-line lg:grid-cols-[236px_1fr_400px]">
      {/* ── Sources ─────────────────────────────────────────── */}
      <Panel label="Sources" right={<span className="font-mono text-mono text-dim">{docs.length}</span>}>
        <div
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault()
            addFiles(e.dataTransfer.files)
          }}
          className="m-3 border border-dashed border-line px-3 py-4 text-center transition-colors hover:border-accent/60"
        >
          <p className="text-xs text-muted">Drop a file here</p>
          <input
            ref={fileInput}
            type="file"
            accept=".pdf,.txt,.md,.markdown,.csv,.log,.json"
            multiple
            className="sr-only"
            onChange={(e) => {
              addFiles(e.target.files)
              e.target.value = ''
            }}
          />
          <Btn variant="quiet" className="mt-2" onClick={() => fileInput.current?.click()}>
            Browse
          </Btn>
          <p className="mt-2 font-mono text-micro tracking-[0.06em] text-dim uppercase">
            pdf · txt · md · csv
          </p>
        </div>

        {fileError && (
          <p role="alert" className="mx-3 mb-3 border-l-2 border-err bg-raise px-3 py-2 text-xs text-muted">
            {fileError}
          </p>
        )}

        <ul>
          {docs.map((d) => (
            <li key={d.id} className="group relative">
              <button
                onClick={() => {
                  setActiveId(d.id)
                  setTurns([])
                }}
                className={cx(
                  'w-full border-l-2 py-2 pr-8 pl-3 text-left transition-colors',
                  d.id === activeId
                    ? 'border-accent bg-raise'
                    : 'border-transparent hover:border-line hover:bg-raise/60',
                )}
              >
                <span className="block truncate text-xs text-ink">{d.name}</span>
                <span className="mt-1 flex items-center gap-2 font-mono text-micro text-dim">
                  {d.chunks.length} {d.unit} · {bytes(d.size)}
                </span>
              </button>
              <button
                onClick={() => removeDoc(d.id)}
                aria-label={`Remove ${d.name}`}
                className="absolute top-2 right-2 px-1 font-mono text-mono text-dim opacity-0 transition-opacity group-hover:opacity-100 hover:text-err focus-visible:opacity-100"
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      </Panel>

      {/* ── Preview ─────────────────────────────────────────── */}
      <Panel
        label={doc ? doc.name : 'Preview'}
        right={
          doc ? (
            <span className="font-mono text-mono text-dim">
              {doc.chunks.length} chunks{cited.size ? ` · ${cited.size} cited` : ''}
            </span>
          ) : null
        }
      >
        {!doc ? (
          <Placeholder eyebrow="No sources" title="Add a document to begin">
            Drop a PDF, a text file, or a Markdown file on the left. Text is extracted in your
            browser, split into passages, and only the passages that match your question are sent to
            the model. Nothing is uploaded anywhere else.
          </Placeholder>
        ) : (
          <div className="divide-y divide-line-soft">
            {doc.chunks.map((c) => (
              <article
                key={c.id}
                ref={(el) => (chunkEls.current[c.id] = el)}
                className={cx(
                  'grid grid-cols-[44px_1fr] gap-3 border-l-2 px-3 py-3 transition-colors duration-200',
                  hl === c.id
                    ? 'border-accent bg-accent/10'
                    : cited.has(c.id)
                      ? 'border-accent/70 bg-raise'
                      : 'border-transparent',
                )}
              >
                <span className="pt-0.5 font-mono text-micro text-dim">
                  {doc.unit}.{c.page}
                </span>
                <p className="text-xs leading-relaxed text-muted">{c.body}</p>
              </article>
            ))}
          </div>
        )}
      </Panel>

      {/* ── Ask ─────────────────────────────────────────────── */}
      <Panel
        label="Ask"
        right={busy ? <Status status="running" label={STAGE[stage]} /> : null}
        bodyClass="flex min-h-0 flex-col"
      >
        <div ref={threadEl} className="min-h-0 flex-1 overflow-y-auto">
          {!turns.length ? (
            <Placeholder
              tone={health === 'ready' ? 'muted' : 'warn'}
              eyebrow={health === 'ready' ? 'Ready' : health === 'nokey' ? 'No API key' : 'API offline'}
              title={health === 'ready' ? 'Ask about this document' : 'The model is not reachable'}
            >
              {health === 'ready'
                ? 'Answers come from Gemini, reading only the passages retrieved from the document you selected. Every answer cites the passages it used — hover a citation to highlight it on the left.'
                : health === 'nokey'
                  ? 'Put GEMINI_API_KEY in a .env file next to server.js and restart the API server. Retrieval and PDF extraction work without it; answering does not.'
                  : 'Start the API server with `npm run server`, then reload this page.'}
            </Placeholder>
          ) : (
            <ol className="divide-y divide-line-soft">
              {turns.map((t, i) => (
                <li key={i} className="px-3 py-3">
                  <p className="flex gap-2 text-md text-ink">
                    <span className="select-none font-mono text-accent">&gt;</span>
                    {t.question}
                  </p>

                  {!t.done ? (
                    <div className="mt-3">
                      <div className="h-px w-full overflow-hidden bg-line">
                        <div className="sweep h-px w-1/4 bg-accent" />
                      </div>
                      <p className="eyebrow mt-2">{STAGE[stage] ?? 'Working'}</p>
                    </div>
                  ) : t.error ? (
                    <p role="alert" className="mt-2 border-l-2 border-err pl-2 text-xs text-muted">
                      {t.error}
                    </p>
                  ) : t.answer ? (
                    <>
                      <p className="mt-2 text-xs leading-relaxed text-muted">{fmt(t.answer.answer)}</p>
                      <div className="mt-2 flex flex-wrap items-center gap-1.5">
                        <span className="eyebrow mr-1 text-dim">read {t.searched}</span>
                        {t.answer.cites.map((id) => {
                          const c = doc?.chunks.find((x) => x.id === id)
                          if (!c) return null
                          return (
                            <button
                              key={id}
                              onMouseEnter={() => setHl(id)}
                              onMouseLeave={() => setHl(null)}
                              onFocus={() => setHl(id)}
                              onBlur={() => setHl(null)}
                              onClick={() => jump(id)}
                              className="rounded-sm border border-line px-1.5 py-0.5 font-mono text-micro text-muted transition-colors hover:border-accent hover:text-accent-lift"
                            >
                              {doc.unit}.{c.page}
                            </button>
                          )
                        })}
                      </div>
                    </>
                  ) : (
                    <p className="mt-2 border-l-2 border-warn pl-2 text-xs text-muted">
                      {t.miss ?? 'Nothing in this document covers that.'}
                    </p>
                  )}
                </li>
              ))}
            </ol>
          )}
        </div>

        <div className="shrink-0 border-t border-line">
          <div className="flex flex-wrap gap-1.5 px-3 pt-2.5">
            {SUGGESTED.map((s) => (
              <button
                key={s}
                onClick={() => ask(s)}
                disabled={busy || !doc}
                className="rounded-sm border border-line px-2 py-1 text-micro text-muted transition-colors hover:border-dim hover:text-ink disabled:opacity-40"
              >
                {s}
              </button>
            ))}
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault()
              ask(q)
            }}
            className="flex items-center gap-2 p-3"
          >
            <span className="select-none font-mono text-accent">&gt;</span>
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              disabled={busy || !doc}
              placeholder={doc ? 'Ask about this document' : 'Add a source first'}
              aria-label="Ask about this document"
              className="min-w-0 flex-1 bg-transparent text-md text-ink placeholder:text-dim focus:outline-none disabled:opacity-50"
            />
            <Btn variant="solid" type="submit" disabled={busy || !q.trim() || !doc}>
              Ask
            </Btn>
          </form>
        </div>
      </Panel>
    </div>
  )
}
