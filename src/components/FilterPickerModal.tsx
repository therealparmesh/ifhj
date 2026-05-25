import { theme } from "../ui";
import { FilterPicker } from "./FilterPicker";

type Props = {
  /** Display label for the filter, e.g. "assignee". Used for title + toasts. */
  label: string;
  items: string[];
  currentId: string | null;
  onPick: (id: string) => void;
  onClear: () => void;
  onCancel: () => void;
};

/**
 * One filter-* modal shape shared across assignee / type / sprint / label /
 * epic. The five filters only differ in their label, their options source,
 * and which slice of `filters` they own — everything else (title, border,
 * flash wording, cancel-returns-to-menu) is identical.
 */
export function FilterPickerModal({ label, items, currentId, onPick, onClear, onCancel }: Props) {
  return (
    <FilterPicker
      title={`filter by ${label}`}
      items={items.map((v) => ({ id: v, label: v }))}
      {...(currentId ? { currentId } : {})}
      borderColor={theme.info}
      onPick={onPick}
      onClear={onClear}
      onCancel={onCancel}
    />
  );
}
