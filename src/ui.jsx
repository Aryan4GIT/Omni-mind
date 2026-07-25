/* Shared primitives. Every panel is built from these, so spacing and
   type stay identical across the three tools. */

export const cx = (...c) => c.filter(Boolean).join(' ')

/** Panel: a bordered region with a mono header rail and a body that scrolls
 *  on its own. `right` sits flush against the header's right edge. */
export function Panel({ label, right, children, className, bodyClass }) {
  return (
    <section className={cx('flex min-h-0 min-w-0 flex-col bg-surface', className)}>
      <header className="flex h-9 shrink-0 items-center justify-between gap-3 border-b border-line px-3">
        <h2 className="eyebrow truncate">{label}</h2>
        {right ? <div className="flex shrink-0 items-center gap-3">{right}</div> : null}
      </header>
      <div className={cx('min-h-0 flex-1', bodyClass ?? 'overflow-y-auto')}>{children}</div>
    </section>
  )
}

const DOT = {
  idle: 'bg-dim',
  queued: 'bg-dim',
  running: 'bg-accent breathe',
  done: 'bg-ok',
  revise: 'bg-warn',
  failed: 'bg-err',
  live: 'bg-accent breathe',
}

export function Dot({ status = 'idle', className }) {
  return <span className={cx('size-1.5 shrink-0 rounded-full', DOT[status] ?? 'bg-dim', className)} />
}

/** Status chip: dot + word. Never color alone — the label always ships. */
export function Status({ status, label }) {
  return (
    <span className="flex items-center gap-1.5">
      <Dot status={status} />
      <span className="font-mono text-micro uppercase tracking-[0.11em] text-muted">
        {label ?? status}
      </span>
    </span>
  )
}

const BTN = {
  solid:
    'bg-accent text-white hover:bg-accent-lift disabled:bg-line disabled:text-dim disabled:hover:bg-line',
  ghost:
    'border border-line text-ink hover:border-dim hover:bg-raise disabled:text-dim disabled:hover:bg-transparent disabled:hover:border-line',
  quiet: 'text-muted hover:text-ink hover:bg-raise',
}

export function Btn({ variant = 'ghost', className, ...props }) {
  return (
    <button
      type="button"
      {...props}
      className={cx(
        'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-sm px-2.5 font-mono text-mono tracking-[0.06em] uppercase transition-colors duration-150 disabled:cursor-not-allowed',
        BTN[variant],
        className,
      )}
    />
  )
}

/** The one component for empty, loading, error and no-result states.
 *  Type only — no illustration. `tone` colors the eyebrow, nothing else. */
export function Placeholder({ tone = 'muted', eyebrow, title, children, action }) {
  const tint = { muted: 'text-muted', err: 'text-err', warn: 'text-warn' }[tone]
  return (
    <div className="flex flex-col items-start gap-2 px-4 py-6">
      {eyebrow ? <p className={cx('eyebrow', tint)}>{eyebrow}</p> : null}
      <h3 className="font-display text-md font-medium tracking-[-0.01em] text-ink">{title}</h3>
      {children ? <p className="max-w-[46ch] text-xs text-muted">{children}</p> : null}
      {action ? <div className="mt-2 flex flex-wrap gap-2">{action}</div> : null}
    </div>
  )
}

/** Key/value strip used in every panel header. Label above, figure below. */
export function Metric({ label, value, tone }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="eyebrow">{label}</span>
      <span className={cx('font-mono text-xs leading-none', tone ?? 'text-ink')}>{value}</span>
    </div>
  )
}

export const pad = (n, w = 2) => String(n).padStart(w, '0')

/** ms → mm:ss.t */
export function clock(ms) {
  const s = Math.max(0, ms) / 1000
  return `${pad(Math.floor(s / 60))}:${pad(Math.floor(s % 60))}.${Math.floor((s % 1) * 10)}`
}

export function bytes(n) {
  if (n < 1024) return `${n} B`
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1024 ** 2).toFixed(1)} MB`
}
