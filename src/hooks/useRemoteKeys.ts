import { useState, useEffect, useCallback, useRef } from 'react';
import { KEY_CODES } from '../utils/keys';
import { useAppStore } from '../stores/appStore';

export function useRemoteKeys(): { showInfo: boolean; channelNumber: string } {
  const [showInfo, setShowInfo] = useState(false);
  const [channelNumber, setChannelNumber] = useState('');
  const channelTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const infoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      const goBack = useAppStore.getState().goBack;

      switch (e.keyCode) {
        case KEY_CODES.BACK:
          e.preventDefault();
          goBack();
          break;

        case KEY_CODES.INFO:
          e.preventDefault();
          setShowInfo(true);
          if (infoTimerRef.current) clearTimeout(infoTimerRef.current);
          infoTimerRef.current = setTimeout(() => setShowInfo(false), 5000);
          break;

        default:
          // Handle number keys for channel direct entry
          if (e.keyCode >= KEY_CODES.NUM_0 && e.keyCode <= KEY_CODES.NUM_9) {
            const digit = String(e.keyCode - KEY_CODES.NUM_0);
            setChannelNumber((prev) => prev + digit);

            if (channelTimerRef.current) clearTimeout(channelTimerRef.current);
            channelTimerRef.current = setTimeout(() => {
              setChannelNumber('');
            }, 2000);
          }
          break;
      }
    },
    []
  );

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      if (channelTimerRef.current) clearTimeout(channelTimerRef.current);
      if (infoTimerRef.current) clearTimeout(infoTimerRef.current);
    };
  }, [handleKeyDown]);

  return { showInfo, channelNumber };
}
