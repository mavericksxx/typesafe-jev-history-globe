/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL of the Cloudflare Worker proxying "Try it live" requests to
   * Jev (see worker/src/index.ts). Optional — the panel degrades to an
   * error state without it. */
  readonly VITE_JEV_WORKER_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
