import { ApiError } from '@squirmy/client-core';
import type { TvPairing } from '@squirmy/contracts';
import { useEffect, useEffectEvent, useState } from 'react';
import { useAccount } from '../account/AccountProvider';
import { clientDevice } from '../account/storage';

type Pairing = { code?: TvPairing; error?: string; finishing?: boolean };

export function usePairing(attempt: number) {
  const { api, acceptTvSession } = useAccount();
  const accept = useEffectEvent(acceptTvSession);
  const [pairing, setPairing] = useState<Pairing>({});
  useEffect(() => {
    if (!api) return;
    const controller = new AbortController();
    const { signal } = controller;
    let timer: ReturnType<typeof setTimeout>;
    let code: TvPairing;
    let interval: number;
    let deadline: number;

    function failed(error: unknown) {
      if (signal.aborted) return;
      setPairing({ error: error instanceof ApiError && error.status > 0
        ? error.message : 'Couldn’t reach the server. Try again.' });
    }

    function schedule() {
      const remaining = deadline - Date.now();
      timer = setTimeout(() => {
        if (Date.now() >= deadline) {
          setPairing({ error: 'This code has expired. Request a new one to try again.' });
        } else {
          void poll();
        }
      }, Math.min(interval * 1000, remaining));
    }

    async function poll() {
      try {
        const response = await api!.auth.pollTvPairing({ deviceCode: code.deviceCode }, { signal });
        if (signal.aborted) return;
        if (response.status === 'approved') {
          setPairing({ finishing: true });
          await accept(response.session);
          return;
        }
        interval = response.intervalSeconds;
      } catch (error) {
        if (signal.aborted) return;
        if (error instanceof ApiError && (error.status === 0 || error.status === 429 || error.status >= 500)) {
          interval = error.status === 429 ? 60 : Math.min(60, interval * 2);
        } else {
          failed(error);
          return;
        }
      }
      schedule();
    }

    setPairing({});
    void (async () => {
      const device = await clientDevice(true);
      if (signal.aborted) return;
      code = await api.auth.startTvPairing({ device: { ...device, kind: 'tv' } }, { signal });
      if (signal.aborted) return;
      interval = code.intervalSeconds;
      deadline = Date.now() + code.expiresInSeconds * 1000;
      setPairing({ code });
      schedule();
    })().catch(failed);

    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [api, attempt]);
  return pairing;
}
