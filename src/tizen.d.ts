/**
 * Type declarations for Samsung Tizen TV APIs.
 * Covers AVPlay, AppCommon, ProductInfo, Application, and TVInputDevice.
 */

interface AVPlayPlaybackCallback {
  onbufferingstart?: () => void;
  onbufferingprogress?: (percent: number) => void;
  onbufferingcomplete?: () => void;
  oncurrentplaytime?: (timeMs: number) => void;
  onevent?: (eventType: string, eventData: string) => void;
  onerror?: (eventType: string) => void;
  onsubtitlechange?: (
    duration: number,
    text: string,
    data3: number,
    data4: string
  ) => void;
  onstreamcompleted?: () => void;
  ondrmevent?: (drmEvent: string, drmData: string) => void;
}

type AVPlayState =
  | 'NONE'
  | 'IDLE'
  | 'READY'
  | 'PLAYING'
  | 'PAUSED';

interface AVPlayManager {
  open(url: string): void;
  close(): void;
  play(): void;
  pause(): void;
  stop(): void;
  prepare(): void;
  prepareAsync(
    successCallback?: () => void,
    errorCallback?: (error: Error) => void
  ): void;
  setListener(callback: AVPlayPlaybackCallback): void;
  setDisplayRect(
    x: number,
    y: number,
    width: number,
    height: number
  ): void;
  getState(): AVPlayState;
  seekTo(
    positionMs: number,
    successCallback?: () => void,
    errorCallback?: (error: Error) => void
  ): void;
  getDuration(): number;
  getCurrentTime(): number;
  setSubtitlePosition?(position: number): void;
  getSubtitleLanguage?(): string;
}

interface AppCommonScreenSaverStateEnum {
  SCREEN_SAVER_OFF: number;
  SCREEN_SAVER_ON: number;
}

interface AppCommonManager {
  setScreenSaverState(state: number): void;
  AppCommonScreenSaverState: AppCommonScreenSaverStateEnum;
}

interface ProductInfoManager {
  getModel(): string;
  getFirmware(): string;
}

interface WebApis {
  avplay: AVPlayManager;
  appcommon: AppCommonManager;
  productinfo: ProductInfoManager;
}

interface TizenApplication {
  exit(): void;
}

interface TizenApplicationManager {
  getCurrentApplication(): TizenApplication;
}

interface TVInputDeviceManager {
  registerKey(keyName: string): void;
  unregisterKey(keyName: string): void;
}

interface TizenObject {
  application: TizenApplicationManager;
  tvinputdevice: TVInputDeviceManager;
}

declare const webapis: WebApis;
declare const tizen: TizenObject;
