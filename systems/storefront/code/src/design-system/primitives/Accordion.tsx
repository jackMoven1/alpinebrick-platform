import { useState, type ReactNode } from 'react'

export interface AccordionItem {
  id: string
  question: string
  answer: ReactNode
}

type AccordionProps = {
  items: AccordionItem[]
}

export function Accordion({ items }: AccordionProps) {
  const [openId, setOpenId] = useState<string | null>(null)

  return (
    <div>
      {items.map((item) => {
        const panelId = `accordion-panel-${item.id}`
        const triggerId = `accordion-trigger-${item.id}`
        const isOpen = openId === item.id
        return (
          <div key={item.id} className="border-b border-border">
            <button
              type="button"
              id={triggerId}
              aria-expanded={isOpen}
              aria-controls={panelId}
              onClick={() => setOpenId(isOpen ? null : item.id)}
              className="flex w-full items-center justify-between py-4 text-left text-sm font-semibold uppercase tracking-[0.12em] text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              {item.question}
            </button>
            <div
              id={panelId}
              role="region"
              aria-labelledby={triggerId}
              hidden={!isOpen}
              className="pb-4 text-sm text-muted-foreground"
            >
              {item.answer}
            </div>
          </div>
        )
      })}
    </div>
  )
}
