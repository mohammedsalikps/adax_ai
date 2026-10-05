import type { PatientDetail, Role } from '@adaxai/contracts'
import { QueryClientProvider } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { createBrowserRouter, Outlet, RouterProvider } from 'react-router'
import { PortalLayout } from './components/PortalLayout.tsx'
import { CapturePanel } from './components/capture/CapturePanel.tsx'
import { AiAssistantPanel } from './components/clinical/AiAssistantPanel.tsx'
import { ConsultAction, ConsultationLink } from './components/clinical/ConsultAction.tsx'
import { Timeline } from './components/clinical/Timeline.tsx'
import { RequireAuth, RoleRedirect } from './components/RequireAuth.tsx'
import { ToastProvider } from './components/ui/Toast.tsx'
import { watchSessionOnFocus } from './lib/focus.ts'
import { createQueryClient } from './lib/queryClient.ts'
import { AdminAuditPage } from './pages/admin/AdminAuditPage.tsx'
import { AppointmentsPage } from './pages/clinical/AppointmentsPage.tsx'
import { PortalAppointmentsPage } from './pages/patient/PortalAppointmentsPage.tsx'
import { AdminDepartmentsPage } from './pages/admin/AdminDepartmentsPage.tsx'
import { AdminOverviewPage } from './pages/admin/AdminOverviewPage.tsx'
import { AdminAiOperationsPage } from './pages/admin/AdminAiOperationsPage.tsx'
import { AdminThermalDataPage } from './pages/admin/AdminThermalDataPage.tsx'
import { AiReviewPage } from './pages/doctor/AiReviewPage.tsx'
import { DoctorHomePage } from './pages/doctor/DoctorHomePage.tsx'
import { EarlierDraftsNotice, MyConsultationsPage } from './pages/doctor/MyConsultationsPage.tsx'
import { AdminUsersPage } from './pages/admin/AdminUsersPage.tsx'
import { ActivatePage } from './pages/ActivatePage.tsx'
import { ChangePasswordPage } from './pages/ChangePasswordPage.tsx'
import { PatientProfilePage } from './pages/clinical/PatientProfilePage.tsx'
import { PatientsPage } from './pages/clinical/PatientsPage.tsx'
import { QueuePage } from './pages/clinical/QueuePage.tsx'
import { TodaysPatientsPage } from './pages/doctor/TodaysPatientsPage.tsx'
import { RegisterPatientPage } from './pages/clinical/RegisterPatientPage.tsx'
import { PatientThermalCard, ThermalDetailPage, ThermalListPage } from './pages/clinical/ThermalPages.tsx'
import { ConsultationPage } from './pages/doctor/ConsultationPage.tsx'
import { PrescriptionPrintPage } from './pages/doctor/PrescriptionPrintPage.tsx'
import { ApplicationSelectorPage } from './pages/ApplicationSelectorPage.tsx'
import { LoginPage } from './pages/LoginPage.tsx'
import { NotFoundPage } from './pages/NotFoundPage.tsx'
import { AdminDevicesPage, StaffDevicesPage } from './pages/DevicesPages.tsx'
import { AuscultationCard } from './components/clinical/AuscultationCard.tsx'
import { DeviceReadingsCard } from './components/clinical/DeviceReadingsCard.tsx'
import { PortalConsentsPage, PortalHomePage, PortalProfilePage, PortalRecordPage, PortalRecordsPage, PortalVisitsPage, PortalVitalsPage } from './pages/patient/PortalPages.tsx'
import { ClinicalImagesCard } from './components/clinical/ClinicalImagesCard.tsx'
import { ConsultationIntelligence } from './components/ai/ConsultationIntelligence.tsx'
import { ManaAssistant } from './components/mana/ManaAssistant.tsx'

const portal = (role: Role) => (
  <RequireAuth roles={[role]}>
    <PortalLayout role={role} />
  </RequireAuth>
)

const profileExtra = (p: PatientDetail) => (
  <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
    <PatientThermalCard patient={p} />
    <ClinicalImagesCard patientId={p.id} />
    <DeviceReadingsCard patientId={p.id} />
    <AuscultationCard patientId={p.id} />
  </div>
)
const profile = <PatientProfilePage visitAction={(v) => <ConsultationLink visit={v} />} timeline={(id) => <Timeline patientId={id} />} extra={profileExtra} />
/** Doctors also get Mana AI on the patient record. */
const doctorProfile = <PatientProfilePage visitAction={(v) => <ConsultationLink visit={v} />} timeline={(id) => <Timeline patientId={id} />} extra={profileExtra} companion={(p) => <ManaAssistant patientId={p.id} />} />

const router = createBrowserRouter([
  {
    path: '/print/encounters/:encounterId',
    element: (
      <RequireAuth roles={['doctor', 'nurse']}>
        <PrescriptionPrintPage />
      </RequireAuth>
    ),
  },
  { path: '/', element: <RoleRedirect /> },
  { path: '/login', element: <ApplicationSelectorPage /> },
  { path: '/login/doctor', element: <LoginPage application="doctor" /> },
  { path: '/login/patient', element: <LoginPage application="patient" /> },
  { path: '/login/admin', element: <LoginPage application="admin" /> },
  { path: '/activate', element: <ActivatePage /> },
  {
    path: '/change-password',
    element: (
      <RequireAuth allowPasswordChange>
        <ChangePasswordPage />
      </RequireAuth>
    ),
  },
  {
    path: '/admin',
    element: portal('admin'),
    children: [
      { index: true, element: <AdminOverviewPage /> },
      { path: 'users', element: <AdminUsersPage /> },
      { path: 'departments', element: <AdminDepartmentsPage /> },
      { path: 'devices', element: <AdminDevicesPage /> },
      { path: 'thermal-data', element: <AdminThermalDataPage /> },
      { path: 'ai', element: <AdminAiOperationsPage /> },
      { path: 'audit', element: <AdminAuditPage /> },
      { path: 'appointments', element: <AppointmentsPage /> },
    ],
  },
  {
    path: '/doctor',
    element: portal('doctor'),
    children: [
      { index: true, element: <DoctorHomePage consultationAction={(v) => <ConsultAction visit={v} />} notice={<EarlierDraftsNotice />} /> },
      { path: 'queue', element: <TodaysPatientsPage consultationAction={(v) => <ConsultAction visit={v} />} notice={<EarlierDraftsNotice />} /> },
      { path: 'consultations', element: <MyConsultationsPage /> },
      { path: 'appointments', element: <AppointmentsPage /> },
      { path: 'patients', element: <PatientsPage /> },
      { path: 'patients/:patientId', element: doctorProfile },
      {
        path: 'encounters/:encounterId',
        element: (
          <ConsultationPage
            capturePanel={(e, inserter) => <CapturePanel encounter={e} inserter={inserter} />}
            leftPanel={(e, inserter) => (
              <>
                <DeviceReadingsCard patientId={e.patient.id} encounterId={e.id} />
                <AuscultationCard patientId={e.patient.id} encounterId={e.id} />
                <ClinicalImagesCard patientId={e.patient.id} encounter={e} inserter={inserter} />
              </>
            )}
            sidePanel={(e, inserter) => (
              <>
                <ConsultationIntelligence encounterId={e.id} inserter={inserter} />
                <ManaAssistant patientId={e.patient.id} encounterId={e.id} />
                <AiAssistantPanel encounter={e} inserter={inserter} />
              </>
            )}
          />
        ),
      },
      { path: 'register', element: <RegisterPatientPage /> },
      { path: 'thermal', element: <ThermalListPage /> },
      { path: 'ai-review', element: <AiReviewPage /> },
      { path: 'thermal/:captureId', element: <ThermalDetailPage /> },
    ],
  },
  {
    path: '/nurse',
    element: portal('nurse'),
    children: [
      { index: true, element: <QueuePage /> },
      { path: 'register', element: <RegisterPatientPage /> },
      { path: 'appointments', element: <AppointmentsPage /> },
      { path: 'patients', element: <PatientsPage /> },
      { path: 'patients/:patientId', element: profile },
      { path: 'encounters/:encounterId', element: <ConsultationPage /> },
      { path: 'thermal/:captureId', element: <ThermalDetailPage /> },
      { path: 'devices', element: <StaffDevicesPage /> },
    ],
  },
  {
    path: '/patient',
    element: portal('patient'),
    children: [
      { index: true, element: <PortalHomePage /> },
      { path: 'records', element: <PortalRecordsPage /> },
      { path: 'records/:recordId', element: <PortalRecordPage /> },
      { path: 'visits', element: <PortalVisitsPage /> },
      { path: 'appointments', element: <PortalAppointmentsPage /> },
      { path: 'vitals', element: <PortalVitalsPage /> },
      { path: 'consents', element: <PortalConsentsPage /> },
      { path: 'profile', element: <PortalProfilePage /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
  { path: '*', element: <Outlet />, children: [{ path: '*', element: <NotFoundPage /> }] },
])

export function App() {
  const [queryClient] = useState(createQueryClient)
  // A window looked at again re-checks who is signed in (another tab may have changed it).
  useEffect(() => watchSessionOnFocus(queryClient), [queryClient])
  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <RouterProvider router={router} />
      </ToastProvider>
    </QueryClientProvider>
  )
}
