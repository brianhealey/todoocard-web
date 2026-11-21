import { useRef, type KeyboardEvent, type ReactNode } from 'react';

export interface TabDef<T extends string> {
  id: T;
  label: string;
}

interface TabListProps<T extends string> {
  tabs: TabDef<T>[];
  active: T;
  onChange: (id: T) => void;
  label: string;
}

export const tabId = (id: string) => `tab-${id}`;
export const panelId = (id: string) => `tabpanel-${id}`;

/** WAI-ARIA tabs with automatic activation: arrow keys, Home and End move and select. */
export function TabList<T extends string>({ tabs, active, onChange, label }: TabListProps<T>) {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = tabs.findIndex((t) => t.id === active);
    let next = -1;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (i + 1) % tabs.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = tabs.length - 1;
    if (next < 0) return;
    e.preventDefault();
    const id = tabs[next].id;
    onChange(id);
    refs.current[id]?.focus();
  };

  return (
    <div className="navtabs" role="tablist" aria-label={label} onKeyDown={onKeyDown}>
      {tabs.map((t) => (
        <button
          key={t.id}
          ref={(el) => {
            refs.current[t.id] = el;
          }}
          type="button"
          role="tab"
          id={tabId(t.id)}
          className={`navtab ${t.id === active ? 'active' : ''}`}
          aria-selected={t.id === active}
          aria-controls={panelId(t.id)}
          tabIndex={t.id === active ? 0 : -1}
          onClick={() => onChange(t.id)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

/** Panels stay mounted while hidden so a running transfer or firmware update keeps its state. */
export function TabPanel({ id, active, children }: { id: string; active: boolean; children: ReactNode }) {
  return (
    <div role="tabpanel" id={panelId(id)} aria-labelledby={tabId(id)} hidden={!active} tabIndex={active ? 0 : -1} className="tabpanel">
      {children}
    </div>
  );
}
