import { launchServer } from "../lib/server-registry";

const cleanUrl = (value: string | undefined): string =>
  (value ?? "").trim().replace(/\/+$/, "");

const hostedBackendUrl = cleanUrl(process.env.EXPO_PUBLIC_STELLA_BACKEND_URL);

const selfHosted = launchServer.kind === "self-hosted" ? launchServer : null;

export const env = {
  backendUrl: selfHosted ? selfHosted.origin : hostedBackendUrl,
  hostedBackendUrl,
  siteUrl: cleanUrl(process.env.EXPO_PUBLIC_STELLA_SITE_URL),
  authUrl: selfHosted
    ? cleanUrl(selfHosted.discovery?.urls.auth ?? selfHosted.origin)
    : cleanUrl(process.env.EXPO_PUBLIC_STELLA_AUTH_URL),
  canvasShareBaseUrl: selfHosted
    ? cleanUrl(selfHosted.discovery?.urls.canvasShare ?? selfHosted.origin)
    : cleanUrl(process.env.EXPO_PUBLIC_CANVAS_SHARE_BASE_URL),
  playIntegrityProjectNumber:
    process.env.EXPO_PUBLIC_PLAY_INTEGRITY_PROJECT_NUMBER?.trim() ?? "",
  mobileScheme:
    process.env.EXPO_PUBLIC_STELLA_MOBILE_SCHEME?.trim() || "stella-mobile",
};

export const hasMobileConfig = Boolean(env.backendUrl);
