import { useState, type ReactNode } from 'react'

export interface Tab {
  id: string
  label: string
  content: ReactNode
}

type TabsProps = {
  tabs: Tab[]
}

export function Tabs({ tabs }: TabsProps) {
  const [activeId, setActiveId] = useState<string>(tabs[0]?.id ?? '')

  return (
    <div>
      <div role="tablist" className="flex border-b border-border">
        {tabs.map((tab) => {
          const isActive = tab.id === activeId
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              id={`tab-${tab.id}`}
              aria-selected={isActive}
              aria-controls={`tabpanel-${tab.id}`}
              tabIndex={isActive ? 0 : -1}
              onClick={() => setActiveId(tab.id)}
              className={`px-4 py-2.5 text-xs font-semibold uppercase tracking-[0.12em] focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none ${
                isActive
                  ? 'border-b-2 border-primary text-foreground'
                  : 'border-b-2 border-transparent text-muted-foreground'
              }`}
            >
              {tab.label}
            </button>
          )
        })}
      </div>
      {tabs.map((tab) => {
        const isActive = tab.id === activeId
        return (
          <div
            key={tab.id}
            role="tabpanel"
            id={`tabpanel-${tab.id}`}
            aria-labelledby={`tab-${tab.id}`}
            hidden={!isActive}
            className="pt-4 text-sm text-foreground"
          >
            {tab.content}
          </div>
        )
      })}
    </div>
  )
}
