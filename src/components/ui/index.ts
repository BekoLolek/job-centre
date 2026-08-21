// The shared presentational kit. Everything here wraps a class from globals.css —
// no data fetching, no business logic, no app types.

export { cx } from "./cx";
export { plural } from "./plural";

export { default as Alert } from "./Alert";
export type { AlertProps, AlertTone } from "./Alert";

export { default as Avatar } from "./Avatar";
export type { AvatarProps, AvatarSize } from "./Avatar";

export { default as Badge } from "./Badge";
export type { BadgeProps, BadgeTone } from "./Badge";

export { default as Button } from "./Button";
export type { ButtonSize, ButtonVariant } from "./Button";

export { default as ChoiceChip, ChoiceRow } from "./ChoiceChip";
export type { ChoiceChipProps } from "./ChoiceChip";

export { default as EmptyState } from "./EmptyState";
export type { EmptyStateProps } from "./EmptyState";

export { default as Eyebrow } from "./Eyebrow";
export type { EyebrowProps } from "./Eyebrow";

export { default as Field } from "./Field";
export type { FieldProps } from "./Field";

export { default as Modal } from "./Modal";
export type { ModalProps } from "./Modal";

export { default as Panel } from "./Panel";
export type { PanelPadding } from "./Panel";

export { default as Select } from "./Select";
export type { SelectProps } from "./Select";

export { default as Stepper } from "./Stepper";
export type { StepperProps } from "./Stepper";

export { default as StatTile } from "./StatTile";
export type { StatTileProps } from "./StatTile";

export { default as StatusPill } from "./StatusPill";
export type { Status, StatusPillProps } from "./StatusPill";

export {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeadCell,
  TableRow,
} from "./Table";
export type { TableAlign, TableCellProps, TableHeadCellProps } from "./Table";

export { default as Tabs } from "./Tabs";
export type { TabItem, TabsProps } from "./Tabs";

export { default as Textarea } from "./Textarea";
export type { TextareaProps } from "./Textarea";

export { default as Toggle } from "./Toggle";
export type { ToggleProps } from "./Toggle";
export { default as Icon } from "./Icon";
export type { IconName } from "./Icon";
export { default as Section, SectionList } from "./Section";
