import React, { useEffect, useRef, useState } from 'react';
import { Download, RefreshCw, Share, WifiOff, X } from 'lucide-react';
import { registerSW } from 'virtual:pwa-register';
import { useOnlineStatus } from '../hooks/useOnlineStatus';
import { usePWAInstall } from '../hooks/usePWAInstall';

export const PWAInstallButton: React.FC = () => {
  const { isInstallable, isInstalled, isIOS, install } = usePWAInstall();
  const [showIOSGuide, setShowIOSGuide] = useState(false);

  // Suppress button when already running as installed standalone PWA
  if (isInstalled) {
    return null;
  }

  // Android / Desktop Chromium install prompt
  if (isInstallable) {
    return (
      <button
        type="button"
        onClick={() => void install()}
        title="Installa TestMark come app sul dispositivo"
        aria-label="Installa TestMark"
        className="inline-flex h-8 items-center gap-1 rounded-md border border-blue-200 bg-blue-50 px-2 text-xs font-semibold text-blue-800 transition-colors hover:bg-blue-100 whitespace-nowrap shrink-0 sm:px-2.5"
      >
        <Download className="h-3.5 w-3.5" />
        <span className="hidden md:inline">Installa</span>
      </button>
    );
  }

  // iPadOS / iOS Safari guided installation
  if (isIOS) {
    return (
      <>
        <button
          type="button"
          onClick={() => setShowIOSGuide(true)}
          title="Installa TestMark su iPad o iPhone"
          aria-label="Installa TestMark su iPad o iPhone"
          className="inline-flex h-8 items-center gap-1 rounded-md border border-blue-200 bg-blue-50 px-2 text-xs font-semibold text-blue-800 transition-colors hover:bg-blue-100 whitespace-nowrap shrink-0 sm:px-2.5"
        >
          <Download className="h-3.5 w-3.5" />
          <span className="hidden md:inline">Installa</span>
        </button>

        {showIOSGuide && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/45 p-4 backdrop-blur-[1px]"
            role="dialog"
            aria-modal="true"
            aria-labelledby="ios-install-title"
          >
            <div className="w-full max-w-sm rounded-xl border border-slate-200 bg-white shadow-xl">
              <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3.5">
                <h2
                  id="ios-install-title"
                  className="text-sm font-semibold text-slate-900"
                >
                  Installa TestMark su iPad / iPhone
                </h2>
                <button
                  type="button"
                  onClick={() => setShowIOSGuide(false)}
                  aria-label="Chiudi"
                  className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="space-y-3 px-5 py-4 text-xs leading-relaxed text-slate-700">
                <p>
                  Per utilizzare <strong>TestMark</strong> a schermo intero come app sul dispositivo:
                </p>
                <ol className="space-y-2 pl-4 list-decimal">
                  <li>
                    Tocca il pulsante{' '}
                    <span className="inline-flex items-center gap-1 font-semibold text-slate-900">
                      <Share className="inline h-3.5 w-3.5 text-blue-700" />
                      Condividi
                    </span>{' '}
                    nella barra di Safari.
                  </li>
                  <li>
                    Scorri il menu e seleziona{' '}
                    <strong>Aggiungi alla schermata Home</strong>.
                  </li>
                  <li>
                    Conferma toccando <strong>Aggiungi</strong> in alto a destra.
                  </li>
                </ol>
                <p className="text-[11px] text-slate-500">
                  I dati salvati restano archiviati localmente sul dispositivo.
                </p>
              </div>
              <div className="flex justify-end border-t border-slate-100 bg-slate-50/70 px-5 py-3 rounded-b-xl">
                <button
                  type="button"
                  onClick={() => setShowIOSGuide(false)}
                  className="rounded-lg bg-slate-900 px-4 py-1.5 text-xs font-semibold text-white hover:bg-slate-800"
                >
                  Ho capito
                </button>
              </div>
            </div>
          </div>
        )}
      </>
    );
  }

  return null;
};

export const PWAStatusOverlay: React.FC = () => {
  const isOnline = useOnlineStatus();
  const [needRefresh, setNeedRefresh] = useState(false);
  const updateSWRef = useRef<((reloadPage?: boolean) => Promise<void>) | null>(
    null
  );

  useEffect(() => {
    let cleanupListeners: (() => void) | undefined;

    const updateSW = registerSW({
      immediate: true,
      onNeedRefresh() {
        setNeedRefresh(true);
      },
      onRegisteredSW(_swUrl, registration) {
        if (!registration) return;
        const checkUpdate = () => {
          if (navigator.onLine) {
            void registration.update();
          }
        };
        window.addEventListener('focus', checkUpdate);
        const interval = window.setInterval(checkUpdate, 60 * 60 * 1000);
        cleanupListeners = () => {
          window.removeEventListener('focus', checkUpdate);
          window.clearInterval(interval);
        };
      },
    });
    updateSWRef.current = updateSW;

    return () => {
      cleanupListeners?.();
    };
  }, []);

  if (isOnline && !needRefresh) return null;

  return (
    <div className="no-print fixed bottom-4 left-4 z-50 flex flex-col gap-2">
      {needRefresh && (
        <div
          role="status"
          className="flex items-center gap-2.5 rounded-lg border border-blue-200 bg-white px-3.5 py-2 text-xs text-slate-800 shadow-lg"
        >
          <RefreshCw className="h-3.5 w-3.5 shrink-0 text-blue-700" />
          <span className="font-medium">
            Nuova versione disponibile (i dati restano invariati)
          </span>
          <button
            type="button"
            onClick={() => {
              void updateSWRef.current?.(true);
            }}
            className="rounded-md bg-blue-700 px-2.5 py-1 text-xs font-semibold text-white hover:bg-blue-800 whitespace-nowrap"
          >
            Aggiorna
          </button>
          <button
            type="button"
            onClick={() => setNeedRefresh(false)}
            aria-label="Chiudi avviso aggiornamento"
            className="rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {!isOnline && (
        <div
          role="status"
          className="flex items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs font-medium text-amber-900 shadow-md"
        >
          <WifiOff className="h-3.5 w-3.5 shrink-0 text-amber-700" />
          <span>Modalità offline — Dati locali attivi</span>
        </div>
      )}
    </div>
  );
};
