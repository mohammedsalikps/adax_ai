import type { ServiceOrder } from '@adaxai/contracts'
import { useState } from 'react'
import { errorMessage, issuesToErrors } from '../../lib/api.ts'
import { fmtDateTime, fmtTime } from '../../lib/format.ts'
import { noOrdersText, ordersListView, orderStatusPill, orderTimeline, useCancelServiceOrder, useServiceOrders } from '../../lib/serviceOrders.ts'
import { HeroEmpty } from '../hero/HeroEmpty.tsx'
import { SourceTag } from '../hero/SourceTag.tsx'
import { StatusPill } from '../hero/StatusPill.tsx'
import { Button } from '../ui/Button.tsx'
import { ConfirmationDialog } from '../ui/ConfirmationDialog.tsx'
import { ErrorState, LoadingState } from '../ui/Feedback.tsx'
import { useToast } from '../ui/Toast.tsx'

/** Props of a list of service orders (DESIGN §5.4 Orders, §5.6, §7). */
export interface ServiceOrdersListProps {
  /** The consultation's orders only; without it, every order of the patient. */
  encounterId?: string
  patientId: string
  /** One line per order (the consultation's history panel), instead of the full rows. */
  compact?: boolean
}

/**
 * Service orders with their status (Requested · In progress · Completed · Cancelled, always in words) and the SIMULATED lab mark, read from
 * `GET /api/encounters/:id/service-orders` or `GET /api/patients/:id/service-orders`, newest first. Read again every 30 s only while an order
 * is still open. A completed order shows only the simulated lab's sentence that nothing was performed: never a result value. The doctor
 * who placed an open order can cancel it here.
 */
export function ServiceOrdersList({ encounterId, patientId, compact = false }: ServiceOrdersListProps) {
  const scope = { encounterId, patientId }
  const q = useServiceOrders(scope)
  const [cancelling, setCancelling] = useState<ServiceOrder | null>(null)

  const view = ordersListView(q)
  if (view.kind === 'loading') return <LoadingState label="Loading orders…" rows={1} />
  if (view.kind === 'failed') return <ErrorState title="The orders could not be loaded" error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} />
  const orders = view.data.orders
  // A failed later read (a poll, a refetch on focus) keeps the orders and their Cancel buttons; it only says they may be out of date.
  const stale = view.stale && <p className="mb-2 text-sm text-pending">The latest update failed, so this may be out of date.</p>
  if (!orders.length)
    return (
      <>
        {stale}
        <HeroEmpty testId="service-orders-empty">{noOrdersText(scope)}</HeroEmpty>
      </>
    )
  // A consultation's orders are of one day: the time is enough. A patient's span days.
  const time = encounterId ? fmtTime : fmtDateTime
  return (
    <>
      {stale}
      <ul aria-label="Service orders" data-testid="service-orders" className="divide-y divide-line">
        {orders.map((o) => (
          <li key={o.id} data-testid="service-order" data-order-status={o.status} className={`min-w-0 first:pt-0 last:pb-0 ${compact ? 'py-2' : 'py-3'}`}>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className={`min-w-0 flex-1 text-sm [overflow-wrap:anywhere] ${compact ? '' : 'font-medium'}`}>{o.serviceName}</span>
              {o.simulated && <SourceTag kind="simulated" />}
              <StatusPill {...orderStatusPill(o.status)} />
            </div>
            <div className="mt-0.5 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
              <p className="min-w-0 text-xs text-ink-muted tabular-nums">
                {orderTimeline(o, time)}
                {!compact && o.orderedByName ? ` · ${o.orderedByName}` : ''}
              </p>
              {o.canCancel && (
                <Button size="sm" variant="ghost" className="-my-1 ml-auto" aria-label={`Cancel order: ${o.serviceName}`} onClick={() => setCancelling(o)}>
                  Cancel
                </Button>
              )}
            </div>
            {!compact && o.note && <p className="mt-1 text-sm [overflow-wrap:anywhere] text-ink-muted">Note: {o.note}</p>}
            {o.status === 'completed' && o.reportText && <p className="mt-1 text-xs text-ink-muted">{o.reportText}</p>}
            {!compact && o.status === 'cancelled' && o.cancelReason && <p className="mt-1 text-xs [overflow-wrap:anywhere] text-ink-muted">Reason: {o.cancelReason}</p>}
          </li>
        ))}
      </ul>
      {cancelling && <CancelOrderDialog order={cancelling} onClose={() => setCancelling(null)} />}
    </>
  )
}

function CancelOrderDialog({ order, onClose }: { order: ServiceOrder; onClose: () => void }) {
  const cancel = useCancelServiceOrder()
  const toast = useToast()
  const [reason, setReason] = useState('')
  const reasonError = issuesToErrors(cancel.error).reason
  return (
    <ConfirmationDialog
      title="Cancel this order?"
      confirmLabel="Cancel order"
      keepLabel="Keep order"
      loading={cancel.isPending}
      error={cancel.isError && !reasonError ? errorMessage(cancel.error) : undefined}
      reason={{ label: 'Reason (optional)', value: reason, onChange: setReason, error: reasonError }}
      onClose={onClose}
      onConfirm={() =>
        cancel.mutate(
          { orderId: order.id, body: { reason: reason.trim() || null } },
          {
            onSuccess: (o) => {
              toast('success', `Order cancelled · ${o.serviceName}`)
              onClose()
            },
          },
        )
      }
    >
      <p>
        <span className="font-medium">{order.serviceName}</span> will be cancelled. This cannot be undone.
      </p>
    </ConfirmationDialog>
  )
}
