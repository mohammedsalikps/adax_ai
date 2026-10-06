import { CONSENT_LABELS, DOCUMENT_CONSENT_TYPE, type PatientDocument } from '@adaxai/contracts'
import { ExternalLink, FileText, FolderOpen, ImageIcon, Upload } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { useMe } from '../../lib/auth.tsx'
import { usePatient } from '../../lib/clinical.ts'
import { useDocumentEnteredInError, usePatientDocuments } from '../../lib/documents.ts'
import { fmtDate } from '../../lib/format.ts'
import { documentFileUrl, documentInlineSrc, documentMeta, groupDocuments, imagingTitle, isImageDocument, localDay, localToday } from '../../lib/patientRecord.ts'
import { HeroEmpty, Panel, PanelGroup } from '../hero/index.ts'
import { ReasonDialog } from '../clinical/HistoryDialogs.tsx'
import { Button } from '../ui/Button.tsx'
import { Alert, ErrorState, LoadingState } from '../ui/Feedback.tsx'
import { Menu } from '../ui/Menu.tsx'
import { useToast } from '../ui/Toast.tsx'
import { UploadDocumentDialog } from './UploadDocumentDialog.tsx'

/** A person's name without the marker the synthetic dataset adds to it. */
const person = (name: string | null) => name?.replace(/\s*\(synthetic\)$/i, '') ?? null

const GROUP_EMPTY: Record<string, string> = { 'Lab reports': 'No lab reports uploaded yet.', Imaging: 'No imaging uploaded yet.', Other: 'No other documents uploaded yet.' }

const TILE = 'flex size-12 shrink-0 items-center justify-center rounded-md border border-line bg-canvas text-ink-muted'

function DocumentRow({ d, today, menu }: { d: PatientDocument; today: string; menu: ReactNode }) {
  const [expanded, setExpanded] = useState(false)
  // Once opened, the image stays in the row (hidden when collapsed): it is read from the server once, not on every toggle.
  const [opened, setOpened] = useState(false)
  const title = imagingTitle(d)
  const image = isImageDocument(d)
  const src = documentFileUrl(d)
  // No thumbnail: nothing is read until the doctor opens the image (each read is the full original, audited).
  const inline = documentInlineSrc(d, opened)
  return (
    <li className="py-2.5" data-testid="patient-document">
      <div className="flex items-start gap-3">
        {image ? (
          <button
            type="button"
            onClick={() => {
              setOpened(true)
              setExpanded((x) => !x)
            }}
            aria-expanded={expanded}
            className={`${TILE} hover:border-line-strong hover:text-ink`}
            title={expanded ? 'Hide the image' : 'Show the image here'}
          >
            <span className="sr-only">{expanded ? `Hide ${title}` : `Show ${title} here`}</span>
            <ImageIcon aria-hidden="true" className="size-5" />
          </button>
        ) : (
          <span aria-hidden="true" className={TILE}>
            <FileText className="size-5" />
          </span>
        )}
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium [overflow-wrap:anywhere]">{title}</p>
          <p className="text-xs text-ink-muted">{documentMeta(d, today)}</p>
          <p className="text-xs text-ink-muted">
            Added by {person(d.uploadedByName) ?? 'unknown'}, {fmtDate(localDay(d.createdAt))}
            {d.dataOrigin === 'synthetic' ? ' · Synthetic data' : ''}
          </p>
          {d.reportText && (
            <details className="mt-1 text-sm">
              <summary className="cursor-pointer text-xs font-medium text-brand-strong">Report text (typed by staff)</summary>
              <p className="mt-1 rounded-md bg-canvas px-3 py-2 whitespace-pre-wrap [overflow-wrap:anywhere]">{d.reportText}</p>
            </details>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <a href={src} target="_blank" rel="noreferrer" className="inline-flex min-h-11 items-center gap-1.5 rounded-md px-2 text-sm font-medium text-brand-strong hover:bg-canvas">
            <ExternalLink aria-hidden="true" className="size-4" />
            Open<span className="sr-only"> {title} in a new tab</span>
          </a>
          {menu}
        </div>
      </div>
      {inline && <img src={inline} hidden={!expanded} alt={`${title}, ${documentMeta(d, today)}`} decoding="async" className="mt-2 max-h-[28rem] w-full rounded-md border border-line bg-canvas object-contain" />}
    </li>
  )
}

/**
 * The patient's documents (DESIGN §5.3 Documents): grouped Lab reports · Imaging · Other, each newest first, with [Upload document]. A PDF
 * opens in a new tab (GET /api/files/:id, audited); an image shows in place when the doctor opens it (rows show an icon, never a thumbnail
 * of the original, so listing the documents reads no file). Doctors and nurses may mark one as entered in error (it leaves
 * the list and is kept with the reason). Uploading needs the patient's consent to care records. Mount it only where it is seen: it reads the
 * documents (an audited read) when it mounts.
 */
export function PatientDocumentsPanel({ patientId, encounterId, as = 'h2' }: { patientId: string; encounterId?: string | undefined; as?: 'h2' | 'h3' }) {
  const { data: me } = useMe()
  const toast = useToast()
  const patient = usePatient(patientId)
  const q = usePatientDocuments(patientId)
  const markError = useDocumentEnteredInError(patientId)
  const [uploading, setUploading] = useState(false)
  const [marking, setMarking] = useState<PatientDocument | null>(null)
  const canWrite = me?.role === 'doctor' || me?.role === 'nurse'
  const consented = !!patient.data?.consents.some((c) => c.type === DOCUMENT_CONSENT_TYPE && c.status === 'granted' && c.currentWording)
  const today = localToday()
  const groups = q.data ? groupDocuments(q.data) : null
  const menu = (d: PatientDocument) =>
    canWrite ? (
      <Menu
        label={`Actions for ${imagingTitle(d)}, added ${fmtDate(localDay(d.createdAt))}`}
        items={[
          {
            label: 'Entered in error…',
            tone: 'danger',
            onSelect: () => {
              markError.reset()
              setMarking(d)
            },
          },
        ]}
      />
    ) : null
  return (
    <Panel
      label="Documents"
      icon={FolderOpen}
      as={as}
      testId="patient-documents"
      actions={
        canWrite ? (
          <Button size="sm" variant="secondary" icon={<Upload aria-hidden="true" className="size-4" />} disabled={!consented} onClick={() => setUploading(true)}>
            Upload document
          </Button>
        ) : null
      }
    >
      {patient.data && !consented && canWrite && (
        <Alert tone="info" className="mb-3" live={false}>
          Record the patient’s consent to “{CONSENT_LABELS[DOCUMENT_CONSENT_TYPE].title}” before uploading a document.
        </Alert>
      )}
      {q.isPending && <LoadingState rows={2} label="Loading the documents…" />}
      {q.isError && !q.data && <ErrorState title="The documents could not be loaded" error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} />}
      {groups?.map((g) => (
        <PanelGroup key={g.label} label={g.label} testId={`documents-group-${g.categories[0]}`}>
          {g.documents.length ? (
            <ul className="divide-y divide-line" aria-label={g.label}>
              {g.documents.map((d) => (
                <DocumentRow key={d.id} d={d} today={today} menu={menu(d)} />
              ))}
            </ul>
          ) : (
            <HeroEmpty>{GROUP_EMPTY[g.label] ?? 'Nothing uploaded yet.'}</HeroEmpty>
          )}
        </PanelGroup>
      ))}
      {q.data && <p className="mt-3 text-xs text-ink-muted">Uploaded by staff. Nothing reads these files: there is no OCR, image model or laboratory feed.</p>}
      {uploading && <UploadDocumentDialog patientId={patientId} encounterId={encounterId} onClose={() => setUploading(false)} />}
      {marking && (
        <ReasonDialog
          title={`Mark “${imagingTitle(marking)}” as entered in error`}
          entry={`${imagingTitle(marking)} · ${documentMeta(marking, today)}; added by ${person(marking.uploadedByName) ?? 'unknown'} on ${fmtDate(localDay(marking.createdAt))}`}
          intro="The document stays in the record, marked as an error with your reason, and leaves this list. This cannot be undone."
          confirmLabel="Mark as entered in error"
          pending={markError.isPending}
          error={markError.error}
          onClose={() => setMarking(null)}
          onConfirm={(reason) =>
            markError.mutate(
              { id: marking.id, reason },
              {
                onSuccess: () => {
                  toast('success', 'Marked as entered in error')
                  setMarking(null)
                },
              },
            )
          }
        />
      )}
    </Panel>
  )
}
