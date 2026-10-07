import { APPOINTMENT_STATUS_LABELS, notificationText, type PortalAppointment, type PortalAppointmentList, type PortalNotifications } from '@adaxai/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { BellRing, CalendarClock } from 'lucide-react'
import { Button } from '../../components/ui/Button.tsx'
import { Badge, EmptyState, ErrorState, LoadingState } from '../../components/ui/Feedback.tsx'
import { Card, PageHeader } from '../../components/ui/Layout.tsx'
import { useToast } from '../../components/ui/Toast.tsx'
import { api, errorMessage } from '../../lib/api.ts'
import { fmtClock, fmtInstantIn } from '../../lib/appointments.ts'
import { fmtDate } from '../../lib/format.ts'
import { useDocumentTitle } from '../../lib/useDocumentTitle.ts'
import { plainName } from '../../lib/displayName.ts'

const TONE = { booked: 'brand', checked_in: 'warn', completed: 'ok', cancelled: 'neutral', rescheduled: 'neutral', no_show: 'down' } as const

function AppointmentRow({ a }: { a: PortalAppointment }) {
  return (
    <li className="rounded-lg border border-line p-3" data-testid={`portal-appointment-${a.id}`}>
      <p className="flex flex-wrap items-center gap-2 font-medium">
        {fmtDate(a.localDate)}, {fmtClock(a.localTime)}
        {a.awaitingOutcome ? <Badge tone="neutral">Time has passed</Badge> : <Badge tone={TONE[a.status]} dot>{a.status === 'no_show' ? 'Marked as not attended' : APPOINTMENT_STATUS_LABELS[a.status]}</Badge>}
      </p>
      <p className="text-sm text-ink-muted">
        {a.departmentName}
        {a.doctorName ? ` · ${plainName(a.doctorName)}` : ''} · {a.durationMinutes} minutes
      </p>
    </li>
  )
}

/** The patient's own appointments and the messages the clinic made available to them. Portal only: nothing here is sent by SMS or email. */
export function PortalAppointmentsPage() {
  useDocumentTitle('Appointments')
  const qc = useQueryClient()
  const toast = useToast()
  const appts = useQuery({ queryKey: ['portal', '/appointments'], queryFn: () => api<PortalAppointmentList>('/portal/appointments'), staleTime: 30_000, gcTime: 5 * 60_000 })
  const inbox = useQuery({ queryKey: ['portal', '/notifications'], queryFn: () => api<PortalNotifications>('/portal/notifications'), staleTime: 15_000, gcTime: 5 * 60_000 })
  const read = useMutation({
    mutationFn: (id: string) => api<{ ok: true }>(`/portal/notifications/${id}/read`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['portal', '/notifications'] }),
    onError: (e) => toast('error', errorMessage(e)),
  })
  const timezone = appts.data?.appointments[0]?.timezone
  // Upcoming: booked and still to come, or checked in. A booked one whose time passed with no outcome is not upcoming.
  const open = (appts.data?.appointments ?? []).filter((a) => (a.status === 'booked' && !a.awaitingOutcome) || a.status === 'checked_in')
  // Open appointments soonest first; the rest, newest first.
  const upcoming = [...open].reverse()
  const past = (appts.data?.appointments ?? []).filter((a) => !open.includes(a))
  return (
    <>
      <PageHeader title="Appointments" description={timezone ? `Times are on the clinic’s clock (${timezone}).` : undefined} />
      <div className="space-y-6">
        <Card title="Messages from the clinic" actions={inbox.data && inbox.data.unread > 0 ? <Badge tone="brand">{inbox.data.unread} new</Badge> : undefined}>
          <p className="mb-3 text-xs text-ink-muted">Messages about your appointments appear here only. The clinic does not send text messages or email from this system.</p>
          {inbox.isPending && <LoadingState rows={2} />}
          {inbox.isError && <ErrorState title="Your messages could not be loaded" error={inbox.error} onRetry={() => void inbox.refetch()} retrying={inbox.isFetching} />}
          {inbox.data && !inbox.data.notifications.length && <EmptyState title="No messages yet">Messages about your appointments appear here when the clinic makes them available. If you were expecting one, contact the clinic.</EmptyState>}
          {inbox.data && inbox.data.notifications.length > 0 && (
            <ul className="space-y-2" aria-label="Messages">
              {inbox.data.notifications.map((n) => {
                const t = notificationText(n.kind, n.payload)
                return (
                  <li key={n.id} className={`rounded-lg border p-3 ${n.readAt ? 'border-line' : 'border-brand/40 bg-brand-soft/40'}`} data-testid="portal-notification">
                    <p className="flex flex-wrap items-center gap-2 font-medium">
                      <BellRing aria-hidden="true" className="size-4 text-brand" />
                      {t.title}
                      {!n.readAt && <Badge tone="brand">New</Badge>}
                    </p>
                    <p className="text-sm">{t.message}</p>
                    <div className="mt-1 flex flex-wrap items-center gap-2">
                      <span className="text-xs text-ink-muted">Received {fmtInstantIn(n.deliveredAt, inbox.data.timezone)}</span>
                      {!n.readAt && (
                        <Button size="sm" variant="ghost" loading={read.isPending && read.variables === n.id} onClick={() => read.mutate(n.id)}>
                          Mark as read
                          <span className="sr-only">: {t.title}</span>
                        </Button>
                      )}
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </Card>

        <Card title="Upcoming appointments">
          {appts.isPending && <LoadingState rows={2} />}
          {appts.isError && <ErrorState title="Your appointments could not be loaded" error={appts.error} onRetry={() => void appts.refetch()} retrying={appts.isFetching} />}
          {appts.data && !upcoming.length && (
            <EmptyState title="No upcoming appointments">
              <span className="inline-flex items-center gap-1">
                <CalendarClock aria-hidden="true" className="size-4" /> Contact the clinic to book one.
              </span>
            </EmptyState>
          )}
          {upcoming.length > 0 && (
            <ul className="space-y-2" aria-label="Upcoming appointments">
              {upcoming.map((a) => (
                <AppointmentRow key={a.id} a={a} />
              ))}
            </ul>
          )}
        </Card>

        {past.length > 0 && (
          <Card title="Earlier appointments">
            <ul className="space-y-2" aria-label="Earlier appointments">
              {past.map((a) => (
                <AppointmentRow key={a.id} a={a} />
              ))}
            </ul>
          </Card>
        )}
      </div>
    </>
  )
}
