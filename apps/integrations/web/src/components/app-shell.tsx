import { NavLink, Outlet } from "react-router"
import { Activity, KeyRound, Moon, Plug, ShieldCheck, Sun, Wrench } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Switch } from "@/components/ui/switch"
import { useApprovals } from "@/lib/queries"
import { cn } from "@/lib/utils"

const navigation = [
  { to: "/integrations", label: "Integrations", icon: Plug },
  { to: "/clients", label: "Clients", icon: KeyRound },
  { to: "/approvals", label: "Approvals", icon: ShieldCheck },
  { to: "/executions", label: "Executions", icon: Activity },
  { to: "/system", label: "System", icon: Wrench }
] as const

/** The count is the point of the badge: a frozen invocation is a person waiting,
 *  and it expires whether or not anyone looked. */
function PendingBadge() {
  const approvals = useApprovals("pending")
  const count = approvals.data?.length ?? 0
  if (count === 0) return null
  return <Badge variant="destructive" className="ml-auto">{count}</Badge>
}

export function AppShell({
  dark,
  onDarkChange
}: {
  readonly dark: boolean
  readonly onDarkChange: (dark: boolean) => void
}) {
  return (
    <div className="bg-background flex min-h-svh">
      <aside className="bg-sidebar text-sidebar-foreground flex w-60 shrink-0 flex-col gap-1 border-r p-3">
        <div className="px-2 py-3">
          <p className="text-xs uppercase tracking-widest opacity-60">gateway</p>
          <p className="text-lg font-semibold">Control plane</p>
        </div>
        <nav className="flex flex-col gap-0.5">
          {navigation.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                cn(
                  "flex items-center gap-2 rounded-md px-2 py-2 text-sm transition-colors",
                  isActive
                    ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
                    : "hover:bg-sidebar-accent/50"
                )}
            >
              <item.icon className="size-4" />
              {item.label}
              {item.to === "/approvals" ? <PendingBadge /> : null}
            </NavLink>
          ))}
        </nav>
        <div className="mt-auto space-y-3 px-2">
          <label htmlFor="appearance" className="flex cursor-pointer items-center gap-2 text-sm">
            {dark ? <Moon className="size-4" /> : <Sun className="size-4" />}
            <span>Dark mode</span>
            <Switch
              id="appearance"
              className="ml-auto"
              checked={dark}
              onCheckedChange={onDarkChange}
            />
          </label>
          <p className="text-sidebar-foreground/50 text-xs leading-relaxed">
            Served by the gateway on loopback. Every action here is performed with
            the local client's key.
          </p>
        </div>
      </aside>
      <main className="flex min-w-0 flex-1 flex-col">
        <Outlet />
      </main>
    </div>
  )
}
