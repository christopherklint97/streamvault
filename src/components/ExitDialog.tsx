import { useState, useCallback } from 'react';
import { useAppStore } from '../stores/appStore';
import { KEY_CODES } from '../utils/keys';

export default function ExitDialog() {
  const showExitDialog = useAppStore((s) => s.showExitDialog);
  const hideExitConfirm = useAppStore((s) => s.hideExitConfirm);
  const [focusedButton, setFocusedButton] = useState<'yes' | 'no'>('no');

  const handleExit = useCallback(() => {
    try {
      tizen.application.getCurrentApplication().exit();
    } catch {
      window.close();
    }
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      switch (e.keyCode) {
        case KEY_CODES.LEFT:
        case KEY_CODES.RIGHT:
          e.preventDefault();
          setFocusedButton((prev) => (prev === 'yes' ? 'no' : 'yes'));
          break;
        case KEY_CODES.ENTER:
          e.preventDefault();
          if (focusedButton === 'yes') {
            handleExit();
          } else {
            hideExitConfirm();
          }
          break;
        case KEY_CODES.BACK:
          e.preventDefault();
          hideExitConfirm();
          break;
      }
    },
    [focusedButton, handleExit, hideExitConfirm]
  );

  if (!showExitDialog) return null;

  return (
    <div className="exit-dialog-overlay" onKeyDown={handleKeyDown}>
      <div className="exit-dialog">
        <h2 className="exit-dialog__title">Exit StreamVault?</h2>
        <p className="exit-dialog__text">Are you sure you want to exit?</p>
        <div className="exit-dialog__buttons">
          <button
            className={`exit-dialog__btn${focusedButton === 'yes' ? ' exit-dialog__btn--focused' : ''}`}
            data-focusable
            tabIndex={0}
            onClick={handleExit}
            onFocus={() => setFocusedButton('yes')}
          >
            Yes
          </button>
          <button
            className={`exit-dialog__btn${focusedButton === 'no' ? ' exit-dialog__btn--focused' : ''}`}
            data-focusable
            tabIndex={0}
            autoFocus
            onClick={hideExitConfirm}
            onFocus={() => setFocusedButton('no')}
          >
            No
          </button>
        </div>
      </div>
    </div>
  );
}
