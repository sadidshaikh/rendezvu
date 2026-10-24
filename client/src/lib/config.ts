// Where the signaling server lives. In production both values come from the
// build environment. In development they default to the page's own host on
// port 8080, so opening the app at https://<lan-ip>:3000 on a phone reaches
// the server at https://<lan-ip>:8080 without extra config.
const serverDomain = import.meta.env.VITE_SERVER_DOMAIN || `${window.location.hostname}:8080`
const isSecure = import.meta.env.VITE_SERVER_SECURE
  ? import.meta.env.VITE_SERVER_SECURE === 'true'
  : window.location.protocol === 'https:'

export const httpServerUri = `${isSecure ? 'https' : 'http'}://${serverDomain}`
export const wsServerUri = `${isSecure ? 'wss' : 'ws'}://${serverDomain}/ws`
