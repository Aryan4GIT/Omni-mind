# OmniMind

Three tools over your own material: live speech-to-text, question-answering over
documents you drop in, and a three-agent loop that drafts a brief and fact-checks it
against those same documents.

```bash
npm install
cp .env.example .env        # then paste your Gemini API key into it
npm run dev                 # http://localhost:5173 — starts the API server too
npm test                    # chunking, ranking, and the orchestration loop
npm run build && npm start  # one process, serves the built app and the API
```

Needs Node 20.12+ and a [Gemini API key](https://aistudio.google.com/apikey). The model is
`gemini-2.5-flash` by default; set `GEMINI_MODEL` in `.env` to change it.

## Where the key lives

In `.env`, read by `server.js`, and nowhere else. The browser talks to `/api/*` on the
local server; the key is never sent to the client, never in a bundle, never in
`localStorage`. `.env` is gitignored.

Without a key the app still runs — recording, PDF extraction, chunking, and ranking are
all local. Anything that needs the model returns a 503 and the header reads `NO KEY`.

## What each service actually does

**Transcribe** uses the browser's own speech engine (`SpeechRecognition`). Real
microphone, real recognition, real per-phrase confidence, eight languages. Chrome and
Edge implement it; Firefox and Safari do not, and the panel says so rather than
substituting a script. Note that Chrome performs recognition through Google's servers —
audio leaves the machine. **Add to sources** pushes the transcript into Retrieve, so you
can record a meeting and then question it.

**Retrieve** takes PDFs, `.txt`, `.md`, `.csv`, and `.log`. PDF text is extracted in the
browser with pdf.js, one chunk per page (split further if a page runs long) so citations
point at a page you can turn to. Your question is ranked against the chunks with BM25;
the top passages go to Gemini, which answers **only** from them and returns the ids it
used. `found: false` comes back as "not in this document" — a real answer, not a failure.

**Orchestrate** runs three agents over every source you have added:

| Agent | Does | Thinking |
|---|---|---|
| Researcher | Picks the passages that bear on the task, drops the rest | off |
| Writer | Drafts from those passages only, and lists its own claims | dynamic |
| Fact-Checker | Marks each claim supported or unsupported against a passage | dynamic |

The revision loop is real: unsupported claims go back to the Writer with the checker's
reason attached, and the Writer rewrites. If a claim still does not hold up after two
passes the run says so and labels it, rather than quietly dropping it. Progress streams
back as NDJSON, one event per line — the gaps in the run log are the model thinking.

Every model reply is constrained by a JSON schema (Gemini's `responseSchema`), so nothing
parses prose. Passage ids the model invents are dropped before they reach the UI.

## Files

```
server.js             express, key custody, /api/ask + /api/run + /api/health
agents.js             prompts, schemas, and the orchestration loop
agents.test.mjs       27 assertions over the loop, with the model stubbed
src/
  App.jsx             shell, event bus, sources shared across all three panels
  data.js             chunking, BM25, the event fold, fetch helpers — all pure
  data.test.mjs       26 assertions over chunking and ranking
  ui.jsx              Panel, Btn, Status, Placeholder, formatters
  index.css           design tokens, base layer, keyframes
  panels/
    Transcribe.jsx    waveform, live recognition, add-to-sources
    Retrieve.jsx      PDF extraction, ranked ask, citations linked to chunks
    Orchestrate.jsx   agent graph, streamed run log, verified brief
```

`agents.js` takes its `call` function as an argument, so the whole orchestration loop —
the revision round, the pass ceiling, the id guard — is tested offline with a stub. No
key, no cost, no network.

## The event bus

The strip under the nav is one stream for all three services. All three panels stay
mounted — switching tabs hides a panel but does not unmount it — so a recording keeps
reporting while you are looking at the agent graph. Click any event to jump to the
service that emitted it.

## Design system

All tokens live in one `@theme` block in `src/index.css`, as real CSS custom properties
that double as Tailwind utilities (`bg-surface`, `text-muted`, `border-line`). Retheme the
app by editing that block and nothing else.

```
--color-bg      #0B0F19   canvas          --font-display  Geist        headings
--color-surface #111725   panels          --font-sans     Inter        UI
--color-raise   #161D2E   headers, inputs --font-mono     Geist Mono   all data
--color-line    #1E2637   hairlines
--color-ink     #E8EAF0   primary text    --text-base     13px
--color-muted   #6B7590   secondary       8px spacing grid
--color-accent  #6366F1   indigo          2px radius
```

Editorial minimalism. One accent. Structure comes from 1px gaps with the canvas showing
through rather than margins, so panel edges are shared hairlines. Status hues (green /
amber / red) appear only where color carries meaning, and always next to a word — never
by hue alone. Every number is `font-variant-numeric: tabular-nums`.

## Accessibility

Keyboard focus is visible everywhere, hidden panels are `inert` so they stay out of the
tab order, the run log is an `aria-live` region, reduced motion is respected, and the
agent graph carries a text description alongside the log that states the same thing.

## Known limits

- **Retrieval is lexical.** BM25 matches words, not meaning, so a question phrased
  entirely in synonyms can miss. When ranking returns too little, the head of the
  document is sent instead and the model is told to say if that does not answer it.
  Embeddings are the upgrade if recall starts to matter.
- **Scanned PDFs yield nothing.** They are images; extracting text needs OCR, which this
  does not do. The upload says so rather than indexing empty pages.
- **No speaker diarization.** The browser speech API does not identify speakers, so the
  transcript has none.
- **Sources are in memory.** Reloading the page clears them. Nothing is written to disk
  or to a database.
- **The graph is fixed at three agents.** A fourth means new coordinates in `POS` and
  `PATH` — fine for three, not a general layout engine.
- **Mobile** collapses the multi-column layouts to a single scrolling column. It works,
  but this is a design built for a wide screen.
