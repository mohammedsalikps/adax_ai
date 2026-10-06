import { SPEAKER_LABELS, type Transcript, type TranscriptSegment } from '@adaxai/contracts'
import { ArrowDown, Check, ChevronDown, LoaderCircle, TriangleAlert } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { fmtOffset, languageName } from '../../lib/capture.ts'
import { Button } from '../ui/Button.tsx'
import { Badge } from '../ui/Feedback.tsx'
import { Menu } from '../ui/Menu.tsx'
import { focusedLineIds, isNearBottom } from './live.ts'

/** A model score below this is flagged: it is the mean probability the model gave its own words, not a chance that the text is right. */
export const LOW_SCORE = 0.5

const SPEAKER_CHIP: Record<string, string> = {
  Doctor: 'border-brand/30 bg-brand-soft text-brand-strong',
  Patient: 'border-notice/30 bg-notice-soft text-notice',
}
const CHIP_DEFAULT = 'border-line bg-canvas text-ink'

/**
 * Who spoke this line, as a control: the speech model identifies no speakers, so the doctor says. A line nobody has assigned says so, in
 * words and with a dashed outline; one the doctor assigned carries a tick. Changing it never changes the words.
 */
function SpeakerControl({ segment, canAssign, busy, onPick }: { segment: TranscriptSegment; canAssign: boolean; busy: boolean; onPick: (speaker: string) => void }) {
  const who = segment.speaker
  const assigned = segment.speakerSource === 'doctor_assigned'
  const cls = who ? (SPEAKER_CHIP[who] ?? CHIP_DEFAULT) : 'border-dashed border-ink-muted/50 bg-surface text-ink-muted'
  const body = (
    <>
      {assigned && <Check aria-hidden="true" className="size-3 shrink-0" />}
      <span>{who ?? 'Not assigned'}</span>
      {canAssign && <ChevronDown aria-hidden="true" className="size-3 shrink-0 opacity-70" />}
    </>
  )
  const chip = `inline-flex min-h-6 items-center gap-1 rounded-full border px-2 text-xs font-semibold ${cls}`
  if (!canAssign) {
    return (
      <span className={chip} title={segment.speakerSource === 'typed_label' ? 'Typed label' : undefined}>
        {body}
      </span>
    )
  }
  return (
    <Menu
      label={`Speaker of ${segment.id}: ${who ?? 'not assigned'}. Change`}
      align="start"
      trigger={body}
      triggerClassName={`${chip} hover:brightness-95 disabled:opacity-60`}
      items={[
        ...SPEAKER_LABELS.map((l) => ({ label: l, onSelect: () => onPick(l), disabled: busy || l === who })),
        ...(who ? [{ label: 'Not assigned', onSelect: () => onPick('Unknown'), disabled: busy }] : []),
      ]}
    />
  )
}

/**
 * Who spoke a line, the calm way (the consultation's live transcription): a coloured chip only when somebody said who it was (the doctor, or a
 * typed "Doctor:" label), otherwise a neutral "Speaker" that the doctor can assign. The speech model identifies nobody, and nothing here does.
 */
function SpeakerChip({ segment, canAssign, busy, onPick }: { segment: TranscriptSegment; canAssign: boolean; busy: boolean; onPick: (speaker: string) => void }) {
  const who = segment.speaker
  const cls = who ? (SPEAKER_CHIP[who] ?? CHIP_DEFAULT) : 'border-line bg-surface text-ink-muted'
  const at = segment.startMs != null ? `the line at ${fmtOffset(segment.startMs)}` : `line ${segment.id.replace(/^S/, '')}`
  const body = (
    <>
      <span>{who ?? 'Speaker'}</span>
      {canAssign && <ChevronDown aria-hidden="true" className="size-3 shrink-0 opacity-60" />}
    </>
  )
  const chip = `inline-flex min-h-6 items-center gap-1 rounded-full border px-2 text-xs font-medium ${cls}`
  if (!canAssign) return <span className={chip}>{body}</span>
  return (
    <Menu
      label={`Speaker of ${at}: ${who ?? 'not assigned'}. Change`}
      align="start"
      trigger={body}
      triggerClassName={`${chip} hover:bg-canvas disabled:opacity-60`}
      items={[
        ...SPEAKER_LABELS.map((l) => ({ label: l, onSelect: () => onPick(l), disabled: busy || l === who })),
        ...(who ? [{ label: 'Not assigned', onSelect: () => onPick('Unknown'), disabled: busy }] : []),
      ]}
    />
  )
}

/**
 * The conversation as it is transcribed (DESIGN §5.4): a calm list, one line per thing said, with its time on the recording, who spoke (only
 * when somebody said so; otherwise a neutral "Speaker" to assign) and, when the speech model itself was unsure of its words, a quiet flag. A
 * part still being transcribed says so; one that could not be is offered again. The list follows its newest line while the doctor is at the end
 * of it; scrolled up to read, it stays where it is, and a small button brings the newest lines back.
 */
export function ConversationView({
  transcript,
  highlight,
  canAssign,
  assigning,
  onAssign,
  onRetry,
  retrying,
  follow,
}: {
  transcript: Transcript
  highlight: ReadonlySet<string>
  canAssign: boolean
  assigning: boolean
  onAssign: (segmentId: string, speaker: string) => void
  onRetry?: (() => void) | undefined
  retrying?: boolean
  /** New lines are arriving (a recording in progress): follow them while the doctor is at the end of the list. */
  follow: boolean
}) {
  const box = useRef<HTMLOListElement>(null)
  const atEnd = useRef(true)
  const [behind, setBehind] = useState(false)
  type Row = { kind: 'line'; at: number; s: TranscriptSegment } | { kind: 'part'; at: number; index: number; status: 'received' | 'failed'; offsetMs: number }
  const rows: Row[] = [
    ...transcript.segments.map((s, i): Row => ({ kind: 'line', at: s.startMs ?? i, s })),
    ...transcript.chunks.filter((c) => c.status !== 'transcribed').map((c): Row => ({ kind: 'part', at: c.offsetMs, index: c.index, status: c.status as 'received' | 'failed', offsetMs: c.offsetMs })),
  ]
  rows.sort((a, b) => a.at - b.at)
  const count = rows.length
  const toEnd = () => {
    const el = box.current
    if (el) el.scrollTop = el.scrollHeight
    atEnd.current = true
    setBehind(false)
  }
  // New rows: followed while the doctor is at the end (inside the list only: the page itself never jumps).
  useEffect(() => {
    if (!follow) return
    if (atEnd.current) toEnd()
    else setBehind(true)
  }, [count, follow])
  // The lines pointed at in THIS transcript: by their transcript and label (an important point), or by a bare label (an older caller). A line
  // of another recording that only shares the label ("S3") is never lit here.
  const pointedIds = focusedLineIds(highlight, transcript.id)
  const pointed = new Set(pointedIds)
  const firstPointed = pointedIds[0]
  // A line chosen from an important point is brought into view, inside the list; after the frame is laid out (a sheet that has just opened
  // is not yet shown while its content's effects run).
  useEffect(() => {
    if (!firstPointed) return
    const frame = requestAnimationFrame(() => {
      const el = box.current
      const line = document.getElementById(`line-${transcript.id}-${firstPointed}`)
      if (el && line) {
        el.scrollTop = Math.max(0, line.offsetTop - el.offsetTop - 8)
        atEnd.current = isNearBottom(el)
      }
    })
    return () => cancelAnimationFrame(frame)
  }, [highlight, firstPointed, transcript.id])
  return (
    <div className="relative">
      <ol
        ref={box}
        aria-label="Conversation"
        className="max-h-[22rem] min-h-16 space-y-0.5 overflow-y-auto overscroll-contain pr-1 xl:max-h-[26rem]"
        data-testid="raw-transcript"
        onScroll={(e) => {
          atEnd.current = isNearBottom(e.currentTarget)
          if (atEnd.current) setBehind(false)
        }}
      >
        {rows.map((r) =>
          r.kind === 'line' ? (
            <li key={r.s.id} id={`line-${transcript.id}-${r.s.id}`} className={`flex gap-3 rounded-md px-1.5 py-1.5 ${pointed.has(r.s.id) ? 'bg-ai-soft ring-1 ring-ai/40' : ''}`} data-testid="transcript-line" data-pointed={pointed.has(r.s.id) || undefined}>
              <span className="w-10 shrink-0 pt-0.5 text-xs tabular-nums text-ink-muted" title={r.s.startMs != null ? `On the recording from ${fmtOffset(r.s.startMs)} to ${fmtOffset(r.s.endMs)}` : 'Typed: no time'}>
                {r.s.startMs != null ? fmtOffset(r.s.startMs) : ''}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <SpeakerChip segment={r.s} canAssign={canAssign} busy={assigning} onPick={(speaker) => onAssign(r.s.id, speaker)} />
                  {r.s.language && r.s.language !== transcript.language && <span className="text-xs text-ink-muted">{languageName(r.s.language)}</span>}
                  {r.s.confidence != null && r.s.confidence < LOW_SCORE && (
                    <span className="inline-flex items-center gap-1 text-xs font-medium text-pending" title="The speech model was unsure of its own words here. Check this line against what was said.">
                      <TriangleAlert aria-hidden="true" className="size-3" />
                      Low model score
                    </span>
                  )}
                </div>
                <p className="mt-0.5 text-sm leading-6 break-words">{r.s.text}</p>
              </div>
            </li>
          ) : r.status === 'received' ? (
            <li key={`part-${r.index}`} className="flex items-center gap-3 px-1.5 py-1.5 text-sm text-ink-muted" data-testid="transcript-part-pending">
              <span className="w-10 shrink-0 text-xs tabular-nums">{fmtOffset(r.offsetMs)}</span>
              <span className="inline-flex items-center gap-2">
                <LoaderCircle aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" />
                Transcribing…
              </span>
            </li>
          ) : (
            <li key={`part-${r.index}`} className="flex flex-wrap items-center gap-3 px-1.5 py-1.5 text-sm" data-testid="transcript-part-failed">
              <span className="w-10 shrink-0 text-xs tabular-nums text-ink-muted">{fmtOffset(r.offsetMs)}</span>
              <span className="inline-flex min-w-0 flex-1 items-center gap-2">
                <TriangleAlert aria-hidden="true" className="size-4 shrink-0 text-down" />
                This part could not be transcribed. The audio is saved.
              </span>
              {onRetry && (
                <Button size="sm" variant="secondary" onClick={onRetry} loading={retrying}>
                  Retry
                </Button>
              )}
            </li>
          ),
        )}
      </ol>
      {behind && (
        <div className="pointer-events-none absolute inset-x-0 bottom-1 flex justify-center">
          <Button size="sm" variant="secondary" className="pointer-events-auto shadow-pop" icon={<ArrowDown aria-hidden="true" className="size-4" />} onClick={toEnd}>
            Newest lines
          </Button>
        </div>
      )}
    </div>
  )
}

/**
 * The raw transcript: what the system heard, line by line, each with where it starts on the recording, who spoke (as the doctor assigned),
 * the language the model detected and, only when it is low, a mark that the model itself was unsure. Typed lines have no times, language or
 * score. A part that is still being transcribed, or could not be, is shown as that and never as guessed text.
 */
export function TranscriptView({
  transcript,
  highlight,
  canAssign,
  assigning,
  onAssign,
  onRetry,
  retrying,
  follow,
}: {
  transcript: Transcript
  highlight: ReadonlySet<string>
  canAssign: boolean
  assigning: boolean
  onAssign: (segmentId: string, speaker: string) => void
  /** Retry the failed transcription of a part (the audio is saved). */
  onRetry?: (() => void) | undefined
  retrying?: boolean
  /** Keep the newest line in view (a recording in progress). */
  follow: boolean
}) {
  const end = useRef<HTMLLIElement>(null)
  const lastCount = useRef(0)
  useEffect(() => {
    if (follow && transcript.segments.length !== lastCount.current) end.current?.scrollIntoView?.({ block: 'nearest' })
    lastCount.current = transcript.segments.length
  }, [follow, transcript.segments.length])
  // A line chosen from an important point is brought into view (never a line of another recording that only shares its label).
  const pointed = new Set(focusedLineIds(highlight, transcript.id))
  useEffect(() => {
    const first = focusedLineIds(highlight, transcript.id)[0]
    if (first) document.getElementById(`line-${transcript.id}-${first}`)?.scrollIntoView?.({ block: 'nearest' })
  }, [highlight, transcript.id])
  // Lines in time order, with the parts that have no text yet in their place on the timeline.
  type Row = { kind: 'line'; at: number; s: TranscriptSegment } | { kind: 'part'; at: number; index: number; status: 'received' | 'failed'; offsetMs: number }
  const rows: Row[] = [
    ...transcript.segments.map((s, i): Row => ({ kind: 'line', at: s.startMs ?? i, s })),
    ...transcript.chunks.filter((c) => c.status !== 'transcribed').map((c): Row => ({ kind: 'part', at: c.offsetMs, index: c.index, status: c.status as 'received' | 'failed', offsetMs: c.offsetMs })),
  ]
  rows.sort((a, b) => a.at - b.at)
  return (
    <ol aria-label="Transcript lines" className="max-h-[26rem] space-y-1 overflow-y-auto rounded-lg border border-line border-l-4 border-l-ink-muted/40 bg-canvas p-2" data-testid="raw-transcript">
      {rows.map((r) =>
        r.kind === 'line' ? (
          <li key={r.s.id} id={`line-${transcript.id}-${r.s.id}`} className={`rounded-md px-2 py-1.5 ${pointed.has(r.s.id) ? 'bg-ai-soft ring-1 ring-ai/40' : ''}`} data-testid="transcript-line">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="font-mono text-xs tabular-nums text-ink-muted" title={r.s.startMs != null ? `On the recording from ${fmtOffset(r.s.startMs)} to ${fmtOffset(r.s.endMs)}` : 'Typed: no time'}>
                {r.s.startMs != null ? fmtOffset(r.s.startMs) : '—'}
              </span>
              <SpeakerControl segment={r.s} canAssign={canAssign} busy={assigning} onPick={(speaker) => onAssign(r.s.id, speaker)} />
              {r.s.language && r.s.language !== transcript.language && <Badge>{languageName(r.s.language)}</Badge>}
              {r.s.confidence != null && r.s.confidence < LOW_SCORE && (
                <Badge tone="warn" icon={<TriangleAlert aria-hidden="true" className="size-3" />}>
                  <span title="The speech model was unsure of its own words here. Check this line against what was said.">Low model score</span>
                </Badge>
              )}
              <span className="ml-auto font-mono text-[0.6875rem] text-ink-muted">{r.s.id}</span>
            </div>
            <p className="mt-0.5 text-sm break-words">{r.s.text}</p>
          </li>
        ) : r.status === 'received' ? (
          <li key={`part-${r.index}`} className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-ink-muted" data-testid="transcript-part-pending">
            <LoaderCircle aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" />
            <span className="font-mono text-xs tabular-nums">{fmtOffset(r.offsetMs)}</span>
            Transcribing part {r.index + 1}…
          </li>
        ) : (
          <li key={`part-${r.index}`} className="flex flex-wrap items-center gap-2 rounded-md border border-down/30 bg-down-soft/40 px-2 py-1.5 text-sm" data-testid="transcript-part-failed">
            <TriangleAlert aria-hidden="true" className="size-4 shrink-0 text-down" />
            <span className="font-mono text-xs tabular-nums">{fmtOffset(r.offsetMs)}</span>
            <span>Part {r.index + 1} could not be transcribed. The audio is saved.</span>
            {onRetry && (
              <Button size="sm" variant="secondary" onClick={onRetry} loading={retrying}>
                Retry
              </Button>
            )}
          </li>
        ),
      )}
      <li ref={end} aria-hidden="true" />
    </ol>
  )
}
