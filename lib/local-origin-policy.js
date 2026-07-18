"use strict";

function normalizeOrigin(value) {
  if (!value) return "";
  try {
    const parsed = new URL(String(value));
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
    return parsed.origin;
  } catch {
    return "";
  }
}

function requestServerOrigin(req) {
  const host = String(req?.headers?.host || "").trim();
  if (!host) return "";
  const forwarded = String(req?.headers?.["x-forwarded-proto"] || "").split(",")[0].trim().toLowerCase();
  const protocol = forwarded === "https" || forwarded === "http"
    ? forwarded
    : req?.socket?.encrypted ? "https" : "http";
  return normalizeOrigin(`${protocol}://${host}`);
}

function createLocalOriginPolicy(frontendOrigins = []) {
  const configuredOrigins = new Set(
    (Array.isArray(frontendOrigins) ? frontendOrigins : [])
      .map(normalizeOrigin)
      .filter(Boolean),
  );

  function allowedOrigins(req) {
    const allowed = new Set(configuredOrigins);
    const serverOrigin = requestServerOrigin(req);
    if (serverOrigin) allowed.add(serverOrigin);
    return allowed;
  }

  function isAllowedMutation(req) {
    const origin = normalizeOrigin(req?.headers?.origin);
    if (origin) return allowedOrigins(req).has(origin);

    const fetchSite = String(req?.headers?.["sec-fetch-site"] || "").trim().toLowerCase();
    return !fetchSite || fetchSite === "same-origin" || fetchSite === "none";
  }

  function corsHeaders(req) {
    const headers = {
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "content-type",
    };
    const origin = normalizeOrigin(req?.headers?.origin);
    if (origin && allowedOrigins(req).has(origin)) {
      headers["access-control-allow-origin"] = origin;
      headers.vary = "Origin";
    }
    return headers;
  }

  return { corsHeaders, isAllowedMutation };
}

module.exports = { createLocalOriginPolicy, normalizeOrigin, requestServerOrigin };
