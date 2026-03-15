import { useAppStore } from '../stores/appStore';
import { cn } from '../utils/cn';

export default function Toast() {
  const showToast = useAppStore((s) => s.showToast);
  const toastMessage = useAppStore((s) => s.toastMessage);

  return (
    <div className={cn(
      'fixed bottom-20 lg:bottom-10 left-1/2 -translate-x-1/2 translate-y-4 py-2.5 px-5 lg:py-3.5 lg:px-8 bg-[rgba(20,20,35,0.95)] border border-white/[0.08] rounded-[10px] text-sm lg:text-18 z-[10001] opacity-0 transition-all duration-250 pointer-events-none max-w-[calc(100%-32px)] lg:max-w-none',
      showToast && 'opacity-100 translate-y-0 pointer-events-auto'
    )}>
      <span>{toastMessage}</span>
    </div>
  );
}
