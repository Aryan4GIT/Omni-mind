/* Pure logic and shared constants. No React, no timers, no fixtures —
   everything here is testable with plain `node` (see data.test.mjs). */

/* ── Chunking ───────────────────────────────────────────────────
   Paragraphs are the natural retrieval unit for prose. Very short
   fragments (headers, page numbers, stray captions) carry no
   retrievable content, so they are dropped rather than indexed. */

export const MIN_CHUNK = 40

export function chunk(text) {
  return text
    .split(/\n\s*\n/)
    .map((s) => s.trim().replace(/[ \t]+/g, ' '))
    .filter((s) => s.length >= MIN_CHUNK)
    .map((body, i) => ({ id: `c${i + 1}`, page: i + 1, body }))
}

/** Split on sentence boundaries, packing up to `max` characters per part.
 *  A single sentence longer than `max` is left whole — cutting mid-sentence
 *  would produce a citation nobody can read. */
function pack(text, max) {
  if (text.length <= max) return [text]
  const parts = []
  let buf = ''
  for (const s of text.split(/(?<=[.!?])\s+/)) {
    if (buf && buf.length + s.length + 1 > max) {
      parts.push(buf)
      buf = ''
    }
    buf = buf ? `${buf} ${s}` : s
  }
  if (buf) parts.push(buf)
  return parts
}

/** Chunk extracted PDF pages. Page numbers are carried through so a
 *  citation points at a page you can actually turn to. */
export function chunkPages(pages, max = 1600) {
  const out = []
  pages.forEach((raw, i) => {
    const text = raw.trim().replace(/\s+/g, ' ')
    if (text.length < MIN_CHUNK) return
    for (const body of pack(text, max)) out.push({ id: `c${out.length + 1}`, page: i + 1, body })
  })
  return out
}

/* ── Ranking ────────────────────────────────────────────────────
   BM25 over the document's own chunks. Plain term-overlap counting
   treats one mention the same as ten and quietly favours long
   passages; BM25 costs ~15 lines and is right on both counts.
   k1/b are the standard defaults — no reason to tune them here. */

const K1 = 1.5
const B = 0.75

const terms = (s) => s.toLowerCase().match(/[a-z0-9][a-z0-9'-]*/g) ?? []

/** @returns {{chunk: object, score: number}[]} highest first, zero-scoring dropped. */
export function rank(chunks, query, limit = 8) {
  const q = [...new Set(terms(query))]
  if (!q.length || !chunks.length) return []

  const docs = chunks.map((c) => terms(c.body))
  const avg = docs.reduce((n, d) => n + d.length, 0) / docs.length

  // Document frequency per query term, over this document's chunks.
  const df = new Map()
  for (const t of q) df.set(t, docs.filter((d) => d.includes(t)).length)

  return chunks
    .map((c, i) => {
      const d = docs[i]
      let score = 0
      for (const t of q) {
        const n = df.get(t)
        if (!n) continue
        const tf = d.reduce((k, w) => (w === t ? k + 1 : k), 0)
        if (!tf) continue
        const idf = Math.log(1 + (docs.length - n + 0.5) / (n + 0.5))
        score += idf * ((tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * d.length) / avg)))
      }
      return { chunk: c, score }
    })
    .filter((h) => h.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
}

/* ── Orchestrator graph ─────────────────────────────────────────
   Shape only. The run itself comes from the server, one event at a
   time — nothing here is scripted. */

export const AGENTS = [
  { id: 'researcher', name: 'Researcher', job: 'Picks the passages that bear on the task' },
  { id: 'writer', name: 'Writer', job: 'Drafts from those passages only' },
  { id: 'checker', name: 'Fact-Checker', job: 'Verifies each claim against a passage' },
]

export const EDGES = [
  { id: 'r-w', from: 'researcher', to: 'writer', label: 'evidence' },
  { id: 'w-c', from: 'writer', to: 'checker', label: 'draft' },
  { id: 'c-w', from: 'checker', to: 'writer', label: 'revise', back: true },
]

/** Fold the events received so far into the current status of each agent. */
export function statusAt(events, n = events.length) {
  const s = { researcher: 'idle', writer: 'idle', checker: 'idle' }
  for (let i = 0; i < n; i++) if (events[i].agent) s[events[i].agent] = events[i].status
  return s
}

export const DEFAULT_TASK =
  'Summarise what the sources say, and flag anything they leave unanswered.'

/* ── Server calls ───────────────────────────────────────────────
   Everything that needs a model goes through the local API server,
   which holds the key. The browser never sees it. */

async function fail(res) {
  const body = await res.json().catch(() => ({}))
  throw new Error(body.error ?? `Server returned ${res.status}`)
}

export async function post(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) await fail(res)
  return res.json()
}

/** POST an NDJSON stream, invoking `onEvent` for each complete line. */
export async function postStream(path, body, onEvent, signal) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  if (!res.ok) await fail(res)

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop() // trailing partial line
    for (const line of lines) if (line.trim()) onEvent(JSON.parse(line))
  }
  if (buf.trim()) onEvent(JSON.parse(buf))
}
