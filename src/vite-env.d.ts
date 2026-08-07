/// <reference types="vite/client" />

// Injected by vite.config.ts at build time (see scripts/build-identity.mjs). Declared here so
// every consumer is typechecked against the same shape rather than reaching for a global.
declare const __SARD_BUILD_ID__: string;
