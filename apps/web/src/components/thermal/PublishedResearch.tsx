import { ChevronRight, ExternalLink } from 'lucide-react'
import { FIGURE_BASIS_TEXT, PRIMARY_STUDIES, PUBLISHED_BADGE, PUBLISHED_LINE, PUBLISHED_METRICS_HEADING, PUBLISHED_NOT_SHOWN, PUBLISHED_REVIEW } from '../../lib/thermalResearch.ts'

const CHIP = 'inline-flex items-center rounded-md border border-pending/30 bg-pending-soft px-2 py-0.5 text-xs font-semibold tracking-wide text-pending [overflow-wrap:anywhere]'

/** A DOI as a plain link that opens in a new tab: nothing is fetched until the doctor follows it. */
function DoiLink({ doi, url }: { doi: string; url: string }) {
  return (
    <a href={url} target="_blank" rel="noreferrer" className="font-medium break-all text-brand underline underline-offset-2 hover:text-brand-strong">
      doi:{doi}
      <ExternalLink aria-hidden="true" className="ml-1 inline size-3.5 align-[-2px]" />
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  )
}

/**
 * The review the owner named, closed until opened, under a label that says what it is: PUBLISHED RESEARCH — NOT ADAX-AI VALIDATION. Its
 * fields are the ones verified on the publisher's page and PDF; the objective, approaches, limitations and gaps are short summaries, not
 * quotes. The published figures are the cited primary studies' own, each read in the primary paper, and each says whether the review reports
 * it too. None of them is a result of ADAXAI, which implements no method from the review. Held as data: nothing is fetched.
 */
export function PublishedResearch() {
  const r = PUBLISHED_REVIEW
  const facts: [string, string][] = [...r.dates.map(([k, v]): [string, string] => [k, v]), ['Licence', r.licence], ['Keywords', r.keywords.join('; ')]]
  return (
    <details className="group rounded-xl border border-line bg-surface" data-testid="research-paper">
      <summary className="flex min-h-control cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-1 rounded-xl px-4 py-2 [&::-webkit-details-marker]:hidden">
        <ChevronRight aria-hidden="true" className="size-4 shrink-0 group-open:rotate-90" />
        <h3 className="text-base font-semibold">Published research</h3>
        <span className={CHIP}>{PUBLISHED_BADGE}</span>
      </summary>
      <div className="space-y-4 border-t border-line px-4 py-4 text-sm">
        <p className="font-medium" data-testid="research-paper-line">
          {PUBLISHED_LINE}
        </p>

        <div className="space-y-1">
          <p className="font-semibold">{r.title}</p>
          <p>{r.authors.join(', ')}</p>
          <p className="text-ink-muted">
            <i>{r.journal}</i> ({r.publisher}), {r.year}, vol. {r.volume}, article {r.article}. {r.type}.
          </p>
          <p>
            <DoiLink doi={r.doi} url={r.url} />
          </p>
        </div>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
          {facts.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="font-medium text-ink-muted">{k}</dt>
              <dd className="tabular-nums">{v}</dd>
            </div>
          ))}
        </dl>

        <div className="space-y-1">
          <h4 className="font-semibold">Objective (summary)</h4>
          <p>{r.objective}</p>
        </div>

        <div className="space-y-1">
          <h4 className="font-semibold">Referenced model approaches</h4>
          <ul className="list-disc space-y-1 pl-5">
            {r.approaches.map((a) => (
              <li key={a}>{a}</li>
            ))}
          </ul>
        </div>

        <div className="space-y-3" data-testid="research-paper-metrics">
          <h4 className="font-semibold">{PUBLISHED_METRICS_HEADING}</h4>
          {PRIMARY_STUDIES.map((s) => (
            <div key={s.key} className="space-y-2 rounded-lg border border-line bg-canvas p-3" data-testid="research-study" data-study={s.key}>
              <p>
                <span className="font-semibold">{s.cite}.</span> {s.authors}. {s.title}. <i>{s.journal}</i>. <DoiLink doi={s.doi} url={s.url} />
              </p>
              <p className="text-xs">{s.design}</p>
              <p className="text-xs">{s.method}</p>
              <p className="text-xs font-medium">{s.figuresOf}:</p>
              <ul className="space-y-1 text-xs">
                {s.figures.map((f) => (
                  <li key={f.when} className="flex flex-wrap gap-x-2" data-basis={f.basis}>
                    <span className="font-medium">{f.when}:</span>
                    <span className="tabular-nums">{f.values}</span>
                    <span className="text-ink-muted">({FIGURE_BASIS_TEXT[f.basis]})</span>
                  </li>
                ))}
              </ul>
              <p className="text-xs text-ink-muted">{s.reviewNote}</p>
            </div>
          ))}
          <p className="text-xs text-ink-muted">{PUBLISHED_NOT_SHOWN}</p>
        </div>

        <div className="space-y-1">
          <h4 className="font-semibold">Limitations (summary)</h4>
          <ul className="list-disc space-y-1 pl-5">
            {r.limitations.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
        </div>

        <div className="space-y-1">
          <h4 className="font-semibold">Research gaps (summary)</h4>
          <ul className="list-disc space-y-1 pl-5">
            {r.gaps.map((g) => (
              <li key={g}>{g}</li>
            ))}
          </ul>
        </div>
      </div>
    </details>
  )
}
