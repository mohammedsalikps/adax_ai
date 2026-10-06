import { DOCUMENT_CATEGORY_LABELS, DOCUMENT_MAX_BYTES, DOCUMENT_MODALITY_LABELS, DOCUMENT_REPORT_TEXT_MAX, type DocumentCategory, type DocumentModality, IMAGING_DOCUMENT_CATEGORIES } from '@adaxai/contracts'
import { Camera, Upload } from 'lucide-react'
import { useRef, useState } from 'react'
import { errorMessage, issuesToErrors } from '../../lib/api.ts'
import { useUploadDocument } from '../../lib/documents.ts'
import { fileSize, localToday } from '../../lib/patientRecord.ts'
import { Button } from '../ui/Button.tsx'
import { Dialog } from '../ui/Dialog.tsx'
import { Alert } from '../ui/Feedback.tsx'
import { SelectField, TextAreaField, TextField } from '../ui/Form.tsx'
import { useToast } from '../ui/Toast.tsx'

const MAX_MB = Math.round(DOCUMENT_MAX_BYTES / (1024 * 1024))
/** What the file picker offers; the server decides by the file's content, not by this. */
const ACCEPT = 'application/pdf,.pdf,image/jpeg,.jpg,.jpeg,image/png,.png'

/**
 * Adds one document to the patient's record (DESIGN §5.3 Documents): a laboratory report, an imaging report or image, or another paper, as a
 * PDF, JPEG or PNG (a photo of a paper report from a tablet's camera works too). Staff may type the report's text; nothing reads the file
 * itself. Linked to the consultation when added from one.
 */
export function UploadDocumentDialog({ patientId, encounterId, onClose }: { patientId: string; encounterId?: string | undefined; onClose: () => void }) {
  const toast = useToast()
  const upload = useUploadDocument(patientId)
  const sending = useRef(false)
  const [file, setFile] = useState<File | null>(null)
  const [fileProblem, setFileProblem] = useState('')
  const [category, setCategory] = useState<DocumentCategory>('lab_report')
  const [modality, setModality] = useState<DocumentModality | ''>('')
  const [title, setTitle] = useState('')
  const [studyDate, setStudyDate] = useState('')
  const [reportText, setReportText] = useState('')
  const [titleProblem, setTitleProblem] = useState('')
  const imaging = IMAGING_DOCUMENT_CATEGORIES.includes(category)
  const errors = upload.isError ? issuesToErrors(upload.error) : {}
  const pick = (f: File | undefined) => {
    if (!f) return
    setFile(f)
    setFileProblem(f.size > DOCUMENT_MAX_BYTES ? `The file is larger than ${MAX_MB} MB.` : '')
    upload.reset()
  }
  const save = () => {
    if (!file) return setFileProblem('Choose a file.')
    if (file.size > DOCUMENT_MAX_BYTES) return setFileProblem(`The file is larger than ${MAX_MB} MB.`)
    if (!title.trim()) return setTitleProblem('Give the document a title.')
    if (sending.current) return
    sending.current = true
    upload.mutate(
      { file, category, modality: imaging && modality ? modality : null, title: title.trim(), studyDate: studyDate || null, reportText, encounterId: encounterId ?? null },
      {
        onSettled: () => {
          sending.current = false
        },
        onSuccess: () => {
          toast('success', 'Document added to the record')
          onClose()
        },
      },
    )
  }
  return (
    <Dialog
      open
      onClose={onClose}
      title="Upload document"
      dismissible={!upload.isPending}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={upload.isPending}>
            Cancel
          </Button>
          <Button onClick={save} loading={upload.isPending} disabled={!file}>
            Upload
          </Button>
        </>
      }
    >
      <form
        noValidate
        className="space-y-4 text-sm"
        onSubmit={(e) => {
          e.preventDefault()
          save()
        }}
        data-testid="upload-document-dialog"
      >
        <p className="text-ink-muted">PDF, JPEG or PNG, up to {MAX_MB} MB. The file is kept as it is; no program reads it. DICOM is not supported.</p>
        {upload.isError && !Object.keys(errors).length && <Alert tone="error">{errorMessage(upload.error)}</Alert>}
        <div className="space-y-1">
          <div className="flex flex-wrap gap-x-4 gap-y-2">
            <label className="inline-flex min-h-11 cursor-pointer items-center gap-2 font-medium text-brand-strong underline underline-offset-2">
              <Upload aria-hidden="true" className="size-4" />
              Choose a file
              <input type="file" accept={ACCEPT} className="sr-only" onChange={(e) => pick(e.target.files?.[0])} data-testid="upload-document-file" />
            </label>
            <label className="inline-flex min-h-11 cursor-pointer items-center gap-2 font-medium text-brand-strong underline underline-offset-2">
              <Camera aria-hidden="true" className="size-4" />
              Take a photo of a paper report
              <input type="file" accept="image/jpeg,image/png" capture="environment" className="sr-only" onChange={(e) => pick(e.target.files?.[0])} />
            </label>
          </div>
          {file && (
            <p>
              Selected: <strong className="[overflow-wrap:anywhere]">{file.name}</strong> ({fileSize(file.size)})
            </p>
          )}
          {(fileProblem || errors.file) && <p className="text-xs font-medium text-down">{fileProblem || errors.file}</p>}
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <SelectField
            label="Type"
            value={category}
            onChange={(e) => {
              setCategory(e.target.value as DocumentCategory)
              if (!IMAGING_DOCUMENT_CATEGORIES.includes(e.target.value as DocumentCategory)) setModality('')
            }}
            error={errors.category}
          >
            {(Object.keys(DOCUMENT_CATEGORY_LABELS) as DocumentCategory[]).map((c) => (
              <option key={c} value={c}>
                {DOCUMENT_CATEGORY_LABELS[c]}
              </option>
            ))}
          </SelectField>
          {imaging && (
            <SelectField label="Modality (optional)" value={modality} onChange={(e) => setModality(e.target.value as DocumentModality | '')} error={errors.modality}>
              <option value="">Not stated</option>
              {(Object.keys(DOCUMENT_MODALITY_LABELS) as DocumentModality[]).map((m) => (
                <option key={m} value={m}>
                  {DOCUMENT_MODALITY_LABELS[m]}
                </option>
              ))}
            </SelectField>
          )}
        </div>
        <TextField
          label="Title"
          required
          maxLength={160}
          placeholder={imaging ? 'Brain, with contrast' : 'Complete blood count'}
          value={title}
          onChange={(e) => {
            setTitle(e.target.value)
            setTitleProblem('')
          }}
          error={titleProblem || errors.title}
        />
        <TextField label="Date of the test or study (optional)" type="date" max={localToday()} value={studyDate} onChange={(e) => setStudyDate(e.target.value)} error={errors.studyDate} />
        <TextAreaField
          label="Report text (optional)"
          rows={3}
          maxLength={DOCUMENT_REPORT_TEXT_MAX}
          hint="Typed by you from the report, if it helps the record. It is kept with the document as staff-entered text."
          value={reportText}
          onChange={(e) => setReportText(e.target.value)}
          error={errors.reportText}
        />
        {encounterId && <p className="text-xs text-ink-muted">Added from this consultation: the document is linked to it.</p>}
        <button type="submit" className="sr-only" tabIndex={-1} aria-hidden="true" />
      </form>
    </Dialog>
  )
}
