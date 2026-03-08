import { useAppStore } from '../stores/appStore';

export default function Toast() {
  const showToast = useAppStore((s) => s.showToast);
  const toastMessage = useAppStore((s) => s.toastMessage);

  return (
    <div className={`toast${showToast ? ' toast--visible' : ''}`}>
      <span className="toast__message">{toastMessage}</span>
    </div>
  );
}
