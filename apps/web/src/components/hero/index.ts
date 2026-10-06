/**
 * The Doctor HERO primitives (DESIGN §2). Every unit builds its screens from these and the existing ui/ kit (Button, Menu, Tabs,
 * SegmentedControl, PatientAvatar, Dialog, ConfirmationDialog, Toast, form fields); none invents its own pattern.
 */
export { BottomBar, type BottomBarProps, ACTION_BAR_VAR } from './BottomBar.tsx'
export { HeroEmpty, type HeroEmptyProps } from './HeroEmpty.tsx'
export { KeyValue, KeyValueList, type KeyValueProps } from './KeyValue.tsx'
export { PageTitle, type PageTitleProps } from './PageTitle.tsx'
export { Panel, PanelGroup, type PanelGroupProps, type PanelProps, SECTION_LABEL } from './Panel.tsx'
export { Sheet, type SheetProps } from './Sheet.tsx'
export { SourceTag, type SourceTagProps } from './SourceTag.tsx'
export { StatTile, type StatTileProps } from './StatTile.tsx'
export { StatusPill, type StatusPillProps } from './StatusPill.tsx'
export { HERO_STATUSES, type HeroStatus, type HeroTone, isMissingValue, SOURCE_KINDS, type SourceKind, sourceTagSpec, statusPillSpec, statValue } from './spec.ts'
