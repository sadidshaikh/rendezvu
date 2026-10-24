/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SERVER_DOMAIN?: string
  readonly VITE_SERVER_SECURE?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
