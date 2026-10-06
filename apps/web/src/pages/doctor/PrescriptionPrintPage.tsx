import { SEX_LABELS } from '@adaxai/contracts'
import { ArrowLeft, Printer } from 'lucide-react'
import { useNavigate, useParams } from 'react-router'
import { Button } from '../../components/ui/Button.tsx'
import { Alert, Spinner } from '../../components/ui/Feedback.tsx'
import { errorMessage } from '../../lib/api.ts'
import { useEncounter } from '../../lib/encounters.ts'
import { ageFrom, fmtDate, fmtDateTime } from '../../lib/format.ts'
import { durationLines } from '../../lib/prescriptionCourse.ts'
import { useDocumentTitle } from '../../lib/useDocumentTitle.ts'

/** A medicine's duration: "5 days from 6 Oct 2026" when it has a structured course, else as written (and the written words when they say more). */
function DurationCell({ p }: { p: { duration: string; durationDays?: number | null; startDate?: string | null } }) {
  const d = durationLines(p)
  return (
    <>
      {d.main}
      {d.written && <div className="text-ink-muted">{d.written}</div>}
    </>
  )
}

/**
 * Printable prescription built from the signed consultation. This build is a
 * development system: every printout says so and is not a valid prescription.
 */
export function PrescriptionPrintPage() {
  const { encounterId } = useParams()
  const q = useEncounter(encounterId)
  const navigate = useNavigate()
  useDocumentTitle('Prescription')
  if (q.isPending) return <Spinner />
  if (q.isError) return <Alert tone="error" className="m-6">{errorMessage(q.error)}</Alert>
  const e = q.data
  const signed = e.status === 'signed'
  return (
    <main id="main" className="mx-auto max-w-3xl bg-surface px-6 py-6 print:max-w-none print:px-0 print:py-0">
      <div className="mb-6 flex gap-2 print:hidden">
        <Button variant="secondary" icon={<ArrowLeft aria-hidden="true" className="size-4" />} onClick={() => navigate(-1)}>
          Back
        </Button>
        <Button icon={<Printer aria-hidden="true" className="size-4" />} onClick={() => window.print()}>
          Print
        </Button>
      </div>

      <p className="mb-4 border-2 border-down px-3 py-2 text-center text-sm font-bold tracking-wide text-down uppercase" role="note">
        {signed ? 'Development build · synthetic data · not a valid prescription' : 'Draft — not signed · not a valid prescription'}
      </p>

      <header className="flex flex-wrap items-start justify-between gap-4 border-b-2 border-ink pb-3">
        <div>
          <h1 className="text-xl font-bold">{e.facilityName}</h1>
          <p className="text-sm">{e.visit.departmentName}</p>
        </div>
        <div className="text-right text-sm">
          <p className="font-semibold">{e.doctor.fullName}</p>
          {e.doctor.registrationNumber && <p>Reg. no. {e.doctor.registrationNumber}</p>}
          <p>Date: {fmtDate(e.visit.visitDate)}</p>
        </div>
      </header>

      <section aria-label="Patient" className="grid grid-cols-2 gap-x-6 gap-y-1 border-b border-line py-3 text-sm sm:grid-cols-4">
        <p className="col-span-2">
          <span className="text-ink-muted">Patient: </span>
          <strong>{e.patient.fullName}</strong>
        </p>
        <p>
          <span className="text-ink-muted">MRN: </span>
          {e.patient.mrn}
        </p>
        <p>
          <span className="text-ink-muted">Age/Sex: </span>
          {ageFrom(e.patient.dateOfBirth)} y / {SEX_LABELS[e.patient.sex]}
        </p>
        <p className="col-span-2 sm:col-span-4">
          <span className="text-ink-muted">Allergies: </span>
          {e.patient.activeAllergies.length ? <strong>{e.patient.activeAllergies.join(', ')}</strong> : e.patient.noKnownAllergies ? 'No known allergies' : 'Not recorded'}
        </p>
      </section>

      <section className="py-3 text-sm">
        <h2 className="font-semibold">Diagnosis</h2>
        <ul className="list-disc pl-5">
          {e.diagnoses.map((d, i) => (
            <li key={i}>
              {d.description} {d.code && `(${d.code})`}
            </li>
          ))}
        </ul>
      </section>

      <section className="py-3">
        <h2 className="mb-2 text-lg font-bold">℞</h2>
        {e.prescription.length ? (
          <table className="w-full border-collapse text-left text-sm">
            <thead>
              <tr className="border-b border-ink">
                <th scope="col" className="py-1 pr-2">#</th>
                <th scope="col" className="py-1 pr-2">Medicine</th>
                <th scope="col" className="py-1 pr-2">Dose</th>
                <th scope="col" className="py-1 pr-2">Frequency</th>
                <th scope="col" className="py-1">Duration</th>
              </tr>
            </thead>
            <tbody>
              {e.prescription.map((p, i) => (
                <tr key={i} className="border-b border-line align-top">
                  <td className="py-1.5 pr-2">{i + 1}</td>
                  <td className="py-1.5 pr-2">
                    <strong>{[p.drugName, p.strength].filter(Boolean).join(' ')}</strong> {p.form}
                    {p.instructions && <div className="text-ink-muted">{p.instructions}</div>}
                  </td>
                  <td className="py-1.5 pr-2">
                    {p.dose} ({p.route})
                  </td>
                  <td className="py-1.5 pr-2">{p.frequency}</td>
                  <td className="py-1.5">
                    <DurationCell p={p} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="text-sm">No medicines prescribed.</p>
        )}
      </section>

      {(e.note.plan || e.note.followUp) && (
        <section className="py-3 text-sm">
          {e.note.plan && (
            <>
              <h2 className="font-semibold">Advice</h2>
              <p className="whitespace-pre-wrap">{e.note.plan}</p>
            </>
          )}
          {e.note.followUp && (
            <p className="mt-2">
              <span className="font-semibold">Follow-up: </span>
              {e.note.followUp}
            </p>
          )}
        </section>
      )}

      {e.amendments.length > 0 && (
        <section className="py-3 text-sm">
          <h2 className="font-semibold">Amendments after signing</h2>
          {e.amendments.map((a) => (
            <p key={a.id} className="mt-1">
              {fmtDateTime(a.createdAt)}, {a.authorName}: {a.content} <span className="text-ink-muted">(reason: {a.reason})</span>
            </p>
          ))}
        </section>
      )}

      <footer className="mt-6 border-t border-line pt-3 text-xs text-ink-muted">
        {signed ? (
          <p>
            Electronically signed by {e.doctor.fullName} on {fmtDateTime(e.signedAt)}. Record {e.id}. Integrity hash {e.contentHash?.slice(0, 16)}…
          </p>
        ) : (
          <p>Not signed.</p>
        )}
      </footer>
    </main>
  )
}
