'use client'

import Link from 'next/link'
import Image from 'next/image'
import { usePathname } from 'next/navigation'
import { useSession } from 'next-auth/react'
import {
  LayoutDashboard,
  Building2,
  Users,
  ConciergeBell,
  Activity,
  Settings,
  ListChecks,
  CreditCard,
  ClipboardList,
  Bell,
  UserCircle,
  MessageSquareText,
  DoorClosed,
  UtensilsCrossed,
  Sparkles,
  BedDouble,
  Phone,
  BarChart3,
} from 'lucide-react'
import { cn } from '@roomlink/ui'

const FULL_NAV_ITEMS = [
  { href: '/hotel/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/hotel/onboarding', label: 'Onboarding', icon: ListChecks },
  {
    href: '/hotel/profile',
    label: 'Hotel',
    icon: Building2,
    group: ['/hotel/profile', '/hotel/legal', '/hotel/departments', '/hotel/rooms', '/hotel/qr-codes'],
  },
  { href: '/hotel/staff', label: 'People', icon: Users, group: ['/hotel/staff', '/hotel/managers', '/hotel/reception'] },
  {
    href: '/hotel/services',
    label: 'Guest Services',
    icon: ConciergeBell,
    group: ['/hotel/services', '/hotel/requests', '/hotel/menu'],
  },
  {
    href: '/hotel/activity',
    label: 'Operations',
    icon: Activity,
    group: ['/hotel/activity', '/hotel/notifications', '/hotel/guest-sessions'],
  },
  { href: '/hotel/reports', label: 'Reports', icon: BarChart3 },
  { href: '/hotel/subscription', label: 'Subscription', icon: CreditCard },
  { href: '/hotel/settings', label: 'Settings', icon: Settings },
]

/**
 * PRD §10 — a Department Manager's nav is a focused six items, not the full
 * Hotel Admin tree. "Profile" (own account + sign-out) is deliberately not a
 * sidebar destination: `/hotel/profile` is the *hotel's* profile (Hotel
 * Admin-only config, unrelated to this PRD's "own account" meaning) and no
 * separate personal-account page exists yet — the topbar already shows the
 * signed-in user's name/role and a sign-out action, which covers it for V1.
 */
const MANAGER_NAV_ITEMS = [
  { href: '/hotel/manager/queue', label: 'Dashboard / Queue', icon: LayoutDashboard },
  { href: '/hotel/requests', label: 'Requests', icon: ClipboardList },
  { href: '/hotel/manager/team', label: 'Team', icon: Users },
  { href: '/hotel/manager/activity', label: 'Activity', icon: Activity },
  { href: '/hotel/notifications', label: 'Notifications', icon: Bell },
]

/**
 * Staff PRD §7/Rule 7 — a Department Staff member's nav is the same four
 * destinations as their mobile bottom bar (`StaffBottomNav`), just also
 * reachable from a desktop-width browser. "Profile" *is* a sidebar item for
 * this role (unlike Manager's) since it's this role's only account/sign-out
 * surface — there's no hotel-wide topbar-only convention to lean on here.
 */
const STAFF_NAV_ITEMS = [
  { href: '/hotel/staff/home', label: 'Home', icon: LayoutDashboard },
  { href: '/hotel/staff/tasks', label: 'Tasks', icon: ClipboardList },
  { href: '/hotel/notifications', label: 'Notifications', icon: Bell },
  { href: '/hotel/staff/profile', label: 'Profile', icon: UserCircle },
]

/**
 * Reception PRD §29 — an operational, hotel-wide nav that deliberately
 * excludes Hotel Settings / Staff Management / Department Configuration /
 * Subscription Management (the same screens Reception's `role_permissions`
 * grants already 403 on — this just keeps the nav from advertising links
 * that don't work). "Requests" points at the existing shared `/hotel/requests`
 * page, not a duplicate — Reception already has full view/create/edit
 * access to it via its pre-existing grants.
 *
 * Grouped into sections (rather than a flat list) to match the RoomLink
 * mockup, with deviations requested afterward: Restaurant Menu is its own
 * section (not bundled into Guest Experience, so clicking it doesn't read
 * as part of the Requests section), Orders was moved into that Restaurant
 * section alongside the Menu (both are restaurant-owned concerns), Services
 * was added under Operations, and Active Stays was added to Overview
 * alongside Dashboard (it previously sat next to Notifications in the Hotel
 * Admin app's shared Operations tab strip — `/hotel/guest-sessions` has no
 * role check beyond a valid hotel session, so linking it here is safe).
 * Reports, Settings, and Audit Logs from the mockup still have no
 * corresponding Reception-accessible page, so they remain left out.
 */
const RECEPTION_NAV_SECTIONS = [
  {
    section: 'Overview',
    items: [
      { href: '/hotel/reception-desk/dashboard', label: 'Dashboard', icon: LayoutDashboard },
      { href: '/hotel/guest-sessions', label: 'Active Stays', icon: BedDouble },
    ],
  },
  {
    section: 'Guest Experience',
    items: [
      { href: '/hotel/requests', label: 'Requests', icon: ClipboardList },
      { href: '/hotel/reception-desk/conversations', label: 'Conversations', icon: MessageSquareText },
    ],
  },
  {
    section: 'Restaurant',
    items: [
      { href: '/hotel/menu', label: 'Restaurant Menu', icon: ConciergeBell },
      { href: '/hotel/reception-desk/orders', label: 'Orders', icon: UtensilsCrossed },
    ],
  },
  {
    section: 'Operations',
    items: [
      { href: '/hotel/reception-desk/rooms', label: 'Rooms', icon: DoorClosed },
      { href: '/hotel/reception-desk/staff', label: 'Departments & Staff', icon: Users },
      { href: '/hotel/services', label: 'Services', icon: Sparkles },
    ],
  },
  {
    section: 'Communication',
    items: [
      { href: '/hotel/notifications', label: 'Notifications', icon: Bell },
      { href: '/hotel/reception-desk/call-logs', label: 'Call Logs', icon: Phone },
    ],
  },
]

export function Sidebar() {
  const pathname = usePathname()
  const { data: session } = useSession()
  const isDepartmentManager = session?.user?.roleName === 'Department Manager'
  const isDepartmentStaff = session?.user?.roleName === 'Department Staff'
  const isReception = session?.user?.roleName === 'Reception'
  const items = isDepartmentManager ? MANAGER_NAV_ITEMS : isDepartmentStaff ? STAFF_NAV_ITEMS : FULL_NAV_ITEMS

  function isActive({ href, group }: { href: string; group?: string[] }) {
    return group ? group.some((g) => pathname?.startsWith(g)) : pathname === href
  }

  function navLink({ href, label, icon: Icon, group }: { href: string; label: string; icon: typeof LayoutDashboard; group?: string[] }) {
    const active = isActive({ href, group })
    return (
      <Link
        key={href}
        href={href}
        className={cn(
          'flex items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium transition-colors',
          active ? 'bg-brand-50 text-brand-700' : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'
        )}
      >
        <Icon className="h-4 w-4" aria-hidden />
        {label}
      </Link>
    )
  }

  return (
    <aside className="hidden w-60 shrink-0 border-r border-slate-200 bg-white md:flex md:flex-col">
      <div className="flex h-16 items-center gap-2.5 border-b border-slate-100 px-5">
        <Image src="/logo.png" alt="RoomLink" width={128} height={64} className="h-8 w-auto" priority />
        <span className="text-sm font-semibold text-slate-900">Hotel Admin</span>
      </div>

      <nav className="flex-1 space-y-0.5 overflow-y-auto px-3 py-4">
        {isReception
          ? RECEPTION_NAV_SECTIONS.map(({ section, items: sectionItems }, index) => (
              <div key={section} className={index > 0 ? 'pt-4' : undefined}>
                <p className="px-3 pb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">{section}</p>
                {sectionItems.map(navLink)}
              </div>
            ))
          : items.map(navLink)}
      </nav>

      {/* Outside the role-based nav branches above on purpose — this always renders, for every role. */}
      <div className="border-t border-slate-100 px-5 py-3 text-xs text-slate-400">
        v{process.env.NEXT_PUBLIC_APP_VERSION}
        {process.env.NEXT_PUBLIC_GIT_SHA ? ` · ${process.env.NEXT_PUBLIC_GIT_SHA}` : ''}
      </div>
    </aside>
  )
}
