import { useState } from "react"
import { ChevronRight } from "lucide-react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

// Renders whatever an event or result carried. The gateway's event schema
// leaves those fields unknown, so this cannot name its input either.
// oxlint-disable-next-line anti-slop/no-unknown-parameters
const render = (value: unknown): string => {
  try {
    return JSON.stringify(value, null, 2) ?? "null"
  } catch {
    return String(value)
  }
}

/** Payloads here are arguments and results — the things an operator most needs
 *  to actually read before approving. Shown collapsed, because some are large,
 *  but never summarised away. */
export function JsonView({
  value,
  label = "payload",
  className
}: {
  readonly value: unknown
  readonly label?: string
  readonly className?: string
}) {
  const [open, setOpen] = useState(false)
  const text = render(value)
  const lines = text.split("\n").length

  if (value === null || value === undefined) {
    return <span className="text-muted-foreground text-sm">—</span>
  }

  return (
    <div className={cn("space-y-1", className)}>
      <Button
        variant="ghost"
        size="sm"
        className="h-7 gap-1 px-1.5 font-mono text-xs"
        onClick={() => setOpen((value) => !value)}
      >
        <ChevronRight className={cn("size-3 transition-transform", open && "rotate-90")} />
        {label} · {lines === 1 ? text.slice(0, 48) : `${lines} lines`}
      </Button>
      {open ? (
        <pre className="bg-muted/60 max-h-80 overflow-auto rounded-md p-3 font-mono text-xs leading-relaxed">
          {text}
        </pre>
      ) : null}
    </div>
  )
}
