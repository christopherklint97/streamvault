import { useState, useCallback, useEffect, useRef } from 'react';
import { useAppStore } from '../stores/appStore';
import { KEY_CODES } from '../utils/keys';
import { cn } from '../utils/cn';

export default function ExitDialog() {
  const showExitDialog = useAppStore((s) => s.showExitDialog);
  const hideExitConfirm = useAppStore((s) => s.hideExitConfirm);
  const [focusedButton, setFocusedButton] = useState<'yes' | 'no'>('no');
  const yesRef = useRef<HTMLButtonElement>(null);
  const noRef = useRef<HTMLButtonElement>(null);

  const handleExit = useCallback(() => {
    try {
      tizen.application.getCurrentApplication().exit();
    } catch {
      window.close();
    }
  }, []);

  // Pull focus to the dialog when it opens — Tizen ignores autoFocus on
  // dynamically rendered content, so without this the underlying view keeps
  // focus and remote keys never reach this dialog. The button's onFocus then
  // syncs focusedButton state, no setState-in-effect required.
  useEffect(() => {
    if (!showExitDialog) return;
    requestAnimationFrame(() => noRef.current?.focus());
  }, [showExitDialog]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      switch (e.keyCode) {
        case KEY_CODES.LEFT:
        case KEY_CODES.RIGHT:
          e.preventDefault();
          e.stopPropagation();
          // Move DOM focus; onFocus on the target button updates focusedButton.
          (focusedButton === 'yes' ? noRef : yesRef).current?.focus();
          break;
        case KEY_CODES.ENTER:
          e.preventDefault();
          e.stopPropagation();
          if (focusedButton === 'yes') {
            handleExit();
          } else {
            hideExitConfirm();
          }
          break;
        case KEY_CODES.BACK:
          e.preventDefault();
          e.stopPropagation();
          hideExitConfirm();
          break;
      }
    },
    [focusedButton, handleExit, hideExitConfirm]
  );

  if (!showExitDialog) return null;

  return (
    <div className="fixed inset-0 bg-black/75 flex items-center justify-center z-[10000] animate-fade-in p-4 lg:p-0" onKeyDown={handleKeyDown}>
      <div className="bg-surface-dialog border border-white/[0.08] rounded-2xl py-6 px-5 lg:py-9 lg:px-11 text-center w-full max-w-[340px] lg:max-w-none lg:w-auto lg:min-w-[380px] animate-scale-in">
        <h2 className="text-18 lg:text-24 font-bold mb-2">Exit StreamVault?</h2>
        <p className="text-sm lg:text-18 text-[#666] mb-5 lg:mb-7">Are you sure you want to exit?</p>
        <div className="flex gap-2.5 lg:gap-4 justify-center">
          <button
            ref={yesRef}
            className={cn(
              'py-2.5 px-5 lg:py-3 lg:px-9 border-2 border-[#222] rounded-[10px] text-sm lg:text-18 font-semibold bg-surface-border text-[#ccc] transition-all duration-150 focus:border-accent focus:text-white focus:scale-[1.04]',
              focusedButton === 'yes' && 'border-accent bg-accent text-black'
            )}
            data-focusable
            tabIndex={0}
            onClick={handleExit}
            onFocus={() => setFocusedButton('yes')}
          >
            Yes
          </button>
          <button
            ref={noRef}
            className={cn(
              'py-2.5 px-5 lg:py-3 lg:px-9 border-2 border-[#222] rounded-[10px] text-sm lg:text-18 font-semibold bg-surface-border text-[#ccc] transition-all duration-150 focus:border-accent focus:text-white focus:scale-[1.04]',
              focusedButton === 'no' && 'border-accent bg-accent text-black'
            )}
            data-focusable
            tabIndex={0}
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
