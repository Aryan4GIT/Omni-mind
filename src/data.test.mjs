/* Self-check for the pure logic: chunking, PDF page chunking, BM25
   ranking, and the event fold. Run: `npm test` (no framework).
   Everything model-shaped lives on the server and is not mocked here —
   these are the pieces that decide what the model ever gets to see. */
import assert from 'node:assert/strict'
import { MIN_CHUNK, chunk, chunkPages, rank, statusAt } from './data.js'

/* ── Chunking prose ─────────────────────────────────────────── */
{
  const doc = `Short.

The kiln reached 1280 degrees before the glaze set, which is hotter than planned.

x

Cooling  took   nine hours   and produced no crazing on any of the test tiles.`

  const out = chunk(doc)
  assert.equal(out.length, 2, 'fragments under the floor are not indexed')
  assert.ok(out.every((c) => c.body.length >= MIN_CHUNK))
  assert.deepEqual(
    out.map((c) => c.id),
    ['c1', 'c2'],
    'ids are sequential over what survives, not over the input',
  )
  assert.ok(!/ {2}/.test(out[1].body), 'runs of whitespace collapse')
  assert.equal(chunk('').length, 0, 'empty input yields no chunks')
  assert.equal(chunk('tiny').length, 0, 'a document with nothing indexable is empty, not one bad chunk')
}

/* ── Chunking PDF pages ─────────────────────────────────────── */
{
  const long = `${'The quarterly figure held steady. '.repeat(60)}`
  const pages = ['   ', 'Page two says revenue was 4.28 million, ahead of the plan of 3.9 million.', long]
  const out = chunkPages(pages, 400)

  assert.ok(
    out.every((c) => c.page !== 1),
    'a blank page contributes nothing',
  )
  assert.equal(out[0].page, 2, 'page numbers survive a skipped page')
  const fromLong = out.filter((c) => c.page === 3)
  assert.ok(fromLong.length > 1, 'an oversized page is split')
  assert.ok(
    fromLong.every((c) => c.body.length <= 400),
    'each part stays under the cap',
  )
  assert.deepEqual(
    out.map((c) => c.id),
    out.map((_, i) => `c${i + 1}`),
    'ids stay unique across pages and splits',
  )
}

/* ── Ranking ────────────────────────────────────────────────── */
const chunks = [
  { id: 'a', page: 1, body: 'The report notes the kiln reached 1280 degrees before the glaze set.' },
  { id: 'b', page: 2, body: 'The report notes that cooling took nine hours with no crazing.' },
  { id: 'c', page: 3, body: 'The report notes the studio ordered more clay in March.' },
]

assert.equal(rank(chunks, 'kiln')[0].chunk.id, 'a', 'the passage holding the term wins')
assert.equal(rank(chunks, 'crazing')[0].chunk.id, 'b')
assert.deepEqual(rank(chunks, 'dividend policy'), [], 'no match is empty, not a guess')
assert.deepEqual(rank(chunks, '???'), [], 'a query with no terms retrieves nothing')
assert.deepEqual(rank([], 'kiln'), [], 'an empty document retrieves nothing')
assert.equal(rank(chunks, 'kiln cooling').length, 2, 'only passages that match are returned')
assert.equal(rank(chunks, 'kiln cooling', 1).length, 1, 'the limit is respected')

// IDF: a term in every passage must not outrank a term in only one.
assert.equal(
  rank(chunks, 'report kiln')[0].chunk.id,
  'a',
  'the rare term decides the ranking, not the common one',
)

// Length normalisation: one mention in a short passage beats one mention
// buried in a long one. This is the half that plain term-overlap gets wrong.
const padded = [
  { id: 'short', page: 1, body: 'The widget shipped in March.' },
  { id: 'long', page: 2, body: `The widget shipped. ${'Unrelated filler sentence here. '.repeat(40)}` },
]
assert.equal(rank(padded, 'widget')[0].chunk.id, 'short', 'shorter passages are not penalised by padding')

// Term frequency: two mentions beat one, all else equal.
const repeated = [
  { id: 'once', page: 1, body: 'The glaze was applied to the tile in a single even coat today.' },
  { id: 'twice', page: 2, body: 'The glaze was applied and the glaze was fired in a single pass.' },
]
assert.equal(rank(repeated, 'glaze')[0].chunk.id, 'twice', 'repeated mentions rank higher')

/* ── Event fold ─────────────────────────────────────────────── */
{
  const events = [
    { t: 0, agent: 'researcher', status: 'running', msg: 'Reading 12 passages' },
    { t: 900, agent: 'researcher', status: 'done', msg: '5 kept' },
    { t: 1400, agent: 'writer', status: 'running', msg: 'Drafting', edge: 'r-w' },
    { t: 4000, agent: 'checker', status: 'revise', msg: '2 unsupported', edge: 'w-c' },
  ]

  assert.deepEqual(statusAt(events, 0), { researcher: 'idle', writer: 'idle', checker: 'idle' })
  assert.equal(statusAt(events, 2).researcher, 'done', 'the later event wins')
  assert.equal(statusAt(events, 2).writer, 'idle', 'an agent that has not run stays queued')
  assert.deepEqual(statusAt(events), { researcher: 'done', writer: 'running', checker: 'revise' })

  // The stream carries terminal frames that belong to no agent; folding
  // must skip them rather than crash on a missing id.
  const withResult = [...events, { t: 5000, type: 'result', brief: '…' }]
  assert.deepEqual(statusAt(withResult), statusAt(events), 'non-agent events do not disturb the fold')
}

console.log('ok — 26 assertions passed')
