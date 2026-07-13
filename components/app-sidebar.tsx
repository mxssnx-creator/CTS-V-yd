"use client"

import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import {
  Activity,
  Target,
  Zap,
  TrendingUp,
  PieChart,
  Cog,
  Calculator,
  Layers,
  Home,
  Monitor,
  Workflow,
  LogOut,
  MessageSquare,
  FlaskConical,
} from "lucide-react"
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  SidebarFooter,
} from "@/components/ui/sidebar"
import { ThemeSwitcher } from "@/components/theme-switcher"
import { StyleSwitcher } from "@/components/style-switcher"
import { ExchangeSelectorTop } from "@/components/exchange-selector-top"
import { useAuth } from "@/lib/auth-context"
import { Button } from "@/components/ui/button"
import type React from "react"

const menuItems = [
  {
    title: "Overview",
    href: "/",
    icon: Home,
  },
  {
    title: "Live Trading",
    href: "/live-trading",
    icon: Activity,
  },
  {
    title: "Presets",
    href: "/presets",
    icon: Target,
  },
  {
    title: "Indications",
    href: "/indications",
    icon: Zap,
  },
  {
    title: "Strategies",
    href: "/strategies",
    icon: TrendingUp,
  },
  {
    title: "Statistics",
    href: "/statistics",
    icon: PieChart,
  },
  {
    title: "Position Analysis",
    href: "/analysis",
    icon: Calculator,
  },
  {
    title: "Structure",
    href: "/structure",
    icon: Layers,
  },
  {
    title: "Logistics",
    href: "/logistics",
    icon: Workflow,
  },
  {
    title: "Monitoring",
    href: "/monitoring",
    icon: Monitor,
  },
  {
    title: "Settings",
    href: "/settings",
    icon: Cog,
  },
]

// Testing menu items
const testingItems: Array<{
  title: string
  href: string
  icon: React.ComponentType<{ className?: string }>
}> = [
  {
    title: "Autotest & Debug",
    href: "/autotest",
    icon: FlaskConical,
  },
  {
    title: "Connection",
    href: "/testing/connection",
    icon: FlaskConical,
  },
  {
    title: "Order Testing",
    href: "/testing/orders",
    icon: Activity,
  },
  {
    title: "Engine",
    href: "/testing/engine",
    icon: Activity,
  },
]

// Adding Additional menu items section for new features
const additionalItems: Array<{
  title: string
  href: string
  icon: React.ComponentType<{ className?: string }>
}> = [
  {
    title: "Chat History",
    href: "/additional/chat-history",
    icon: MessageSquare,
  },
  {
    title: "Volume Corrections",
    href: "/additional/volume-corrections",
    icon: FlaskConical,
  },
]

export function AppSidebar() {
  const pathname = usePathname()
  const router = useRouter()
  const { user, logout } = useAuth()

  const handleLogout = () => {
    logout()
    router.push("/login")
  }

  return (
    <Sidebar collapsible="offcanvas">
      <SidebarHeader className="border-b border-sidebar-border">
        <div className="flex items-center justify-between px-2 py-2">
          <div className="flex items-center gap-2">
            <div className="size-7 rounded-lg sidebar-logo-badge flex items-center justify-center">
              <span className="text-white font-bold text-xs">CT</span>
            </div>
            <div className="flex flex-col group-data-[collapsible=icon]:hidden">
              <span className="font-semibold text-xs text-sidebar-foreground">CTS v3</span>
              <span className="text-[10px] text-muted-foreground">Trading System</span>
            </div>
          </div>

        </div>
      </SidebarHeader>
      <SidebarContent className="overflow-x-hidden">
        <SidebarGroup>
          <SidebarGroupLabel className="text-xs">Navigation</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {menuItems.map((item) => {
                const isActive = pathname === item.href
                return (
                  <SidebarMenuItem key={item.href}>
                    <SidebarMenuButton asChild isActive={isActive} tooltip={item.title} className="h-9">
                      <Link href={item.href} className="flex items-center gap-2">
                        <item.icon className="h-4 w-4" />
                        <span className="text-sm">{item.title}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                )
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup>
          <SidebarGroupLabel className="text-xs">Testing</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {testingItems.map((item) => {
                const isActive = pathname === item.href
                return (
                  <SidebarMenuItem key={item.href}>
                    <SidebarMenuButton asChild isActive={isActive}>
                      <Link href={item.href}>
                        <item.icon className="w-4 h-4" />
                        <span className="text-sm">{item.title}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                )
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup>
          <SidebarGroupLabel className="text-xs">Additional</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {additionalItems.map((item) => {
                const isActive = pathname === item.href
                return (
                  <SidebarMenuItem key={item.href}>
                    <SidebarMenuButton asChild isActive={isActive}>
                      <Link href={item.href}>
                        <item.icon className="w-4 h-4" />
                        <span className="text-sm">{item.title}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                )
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="space-y-2 border-t border-sidebar-border p-1.5">
        {user && (
          <div className="px-2 py-1 group-data-[collapsible=icon]:hidden">
            <p className="text-xs font-medium truncate">{user.username}</p>
            <p className="text-[10px] text-muted-foreground truncate">{user.email}</p>
            <Button onClick={handleLogout} variant="ghost" size="sm" className="w-full mt-1 h-7 text-xs justify-start">
              <LogOut className="h-3 w-3 mr-2" />
              Logout
            </Button>
          </div>
        )}
        <div className="px-1 pb-1 group-data-[collapsible=icon]:hidden">
          <ExchangeSelectorTop variant="sidebar" />
        </div>
        <div className="flex items-center justify-between gap-1 group-data-[collapsible=icon]:justify-center">
          <span className="text-[10px] text-muted-foreground group-data-[collapsible=icon]:hidden">Appearance</span>
          <div className="flex items-center gap-1 group-data-[collapsible=icon]:flex-col">
            <StyleSwitcher />
            <ThemeSwitcher />
          </div>
        </div>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}
