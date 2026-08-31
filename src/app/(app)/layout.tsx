import { AppearanceProvider } from "@/components/AppearanceProvider";
import { AppHeader } from "@/components/AppHeader";
import { DesktopTabs } from "@/components/AppNav";
import { AssignmentNotifications } from "@/components/AssignmentNotifications";
import { GuestBanner } from "@/components/GuestBanner";
import { ReliabilityProvider } from "@/components/ReliabilityFlags";
import { RequireAuth } from "@/lib/auth/RequireAuth";

export default function AppShellLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <RequireAuth>
      <AppearanceProvider>
        <ReliabilityProvider>
          <div className="flex min-h-full flex-1 flex-col">
            <GuestBanner />
            <AppHeader />
            <DesktopTabs />
            <AssignmentNotifications />
            <div className="flex-1 pb-[env(safe-area-inset-bottom)] md:pb-0">
              {children}
            </div>
          </div>
        </ReliabilityProvider>
      </AppearanceProvider>
    </RequireAuth>
  );
}
