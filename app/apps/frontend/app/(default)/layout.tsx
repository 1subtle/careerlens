import { ResumePreviewProvider } from '@/components/common/resume_previewer_context';
import { StatusCacheProvider } from '@/lib/context/status-cache';
import { LocalizedErrorBoundary } from '@/components/common/error-boundary';
import { AuthGate } from '@/components/auth/auth-gate';

export default function DefaultLayout({ children }: { children: React.ReactNode }) {
  return (
    <AuthGate>
      <StatusCacheProvider>
        <ResumePreviewProvider>
          <LocalizedErrorBoundary>
            <main className="min-h-screen flex flex-col">{children}</main>
          </LocalizedErrorBoundary>
        </ResumePreviewProvider>
      </StatusCacheProvider>
    </AuthGate>
  );
}
