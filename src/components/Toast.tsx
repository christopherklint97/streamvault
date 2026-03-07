import { useAppStore } from '../stores/appStore';

export default function Toast() {
  const showToast = useAppStore((s) => s.showToast);
  const toastMessage = useAppStore((s) => s.toastMessage);

  if (!showToast) return null;

  return (
    <div className="toast">
      <span className="toast__message">{toastMessage}</span>
    </div>
  );
}
