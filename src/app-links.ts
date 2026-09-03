// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

/**
 * App Links / Universal Links verification files (GitHub issue #50) — so the
 * operator's mobile app can register itself as the in-app handler for
 * `/d/…` and `/s/…` URLs instead of them always opening a browser tab.
 *
 * TRIAGE CORRECTION (issue #50): the issue's stated blocker — "`/.well-known/*`
 * is intercepted by the OAuth provider" — is false. `@cloudflare/workers-
 * oauth-provider` only intercepts `/.well-known/oauth-authorization-server`
 * (exact match) and `/.well-known/oauth-protected-resource` (that path OR a
 * `/`-suffixed variant, per RFC 9728 §3.1) — see
 * `isProtectedResourceMetadataRequest` in the library. Everything else under
 * `/.well-known/`, including the two paths this module serves, reaches
 * `defaultHandler` (`innerHandler` in src/index.ts) exactly like `/healthz` or
 * `/openapi.json`. The REAL blocker named in the issue — the operator's Android
 * release signing certificate not existing yet — is external to this Worker and
 * cannot be resolved here; this module ships the serving half now and stays
 * inert (byte-identical 404) until that certificate exists and its fingerprint
 * is configured.
 *
 * Two routes, both anonymous GET, both off unless configured:
 *
 *   GET /.well-known/assetlinks.json               — Android App Links
 *   GET /.well-known/apple-app-site-association     — iOS Universal Links
 *
 * OFF BY DEFAULT, same shape as `HOMEPAGE_PUBLIC_ID` / `CORS_ALLOWED_ORIGINS`:
 * unset, empty, or malformed config means the route in src/index.ts answers the
 * SAME opaque `not_found` the catch-all serves for any unmatched route — byte-
 * identical to a deployment that predates this module. A fresh fork changes
 * nothing.
 *
 * `appLinksConfig(env)` is the SINGLE reader + validator of the three `[vars]`
 * (`APP_LINKS_ANDROID_PACKAGE`, `APP_LINKS_ANDROID_SHA256`,
 * `APP_LINKS_APPLE_APP_ID`) — same storage-cap discipline as
 * `storageCapBytes`/`corsAllowedOrigins`/`homepagePublicId`: nothing else in
 * the Worker reads these vars directly. Android is all-or-nothing: a package
 * name with no fingerprint (or vice versa) can't produce a correct
 * `assetlinks.json`, so either half missing or malformed degrades the WHOLE
 * platform to unconfigured rather than serving a statement that will fail
 * Google's verification. Malformed input logs (value-free — these are
 * operator-chosen identifiers, not secrets, but nothing is gained by echoing a
 * typo back into the log) and degrades exactly like a bad `HOMEPAGE_PUBLIC_ID`.
 *
 * A leaf module — the only import is the `Env` TYPE (erased at compile time),
 * so test/app-links.test.mjs runs it standalone under the Node strip-types
 * runner, like src/cors.ts.
 */

import type { Env } from "./env.js";

// Android Java package name: reverse-DNS identifier, at least two dot-
// separated segments, each a Java-identifier shape (leading letter, then
// letters/digits/underscore). Reserved-word / single-segment edge cases are
// out of scope — Android itself discourages both.
const ANDROID_PACKAGE_RE = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/;

// One SHA-256 signing-certificate fingerprint in the form Google's own tooling
// prints it (Play Console, `keytool -list -v`, `gradle signingReport`): 32
// colon-separated hex byte-pairs, 64 hex digits total. Accepted case-
// insensitively; normalized to uppercase on output (Google's convention).
const SHA256_FINGERPRINT_RE = /^(?:[0-9A-Fa-f]{2}:){31}[0-9A-Fa-f]{2}$/;

// Apple App ID: a 10-character Team ID (uppercase alphanumeric, per Apple
// Developer → Membership) + "." + a bundle identifier (reverse-DNS, dots/
// hyphens/underscores allowed within).
const APPLE_APP_ID_RE = /^[A-Z0-9]{10}\.[A-Za-z0-9](?:[A-Za-z0-9.\-_]*[A-Za-z0-9])?$/;

export interface AndroidAppLinksConfig {
  packageName: string;
  /** Already validated + uppercased. Always at least one entry. */
  fingerprints: string[];
}

export interface AppleAppLinksConfig {
  /** `TEAMID.bundle.id`, already validated. */
  appId: string;
}

export interface AppLinksConfig {
  android: AndroidAppLinksConfig | null;
  apple: AppleAppLinksConfig | null;
}

/**
 * The SINGLE reader of `APP_LINKS_ANDROID_PACKAGE`, `APP_LINKS_ANDROID_SHA256`
 * and `APP_LINKS_APPLE_APP_ID`. Each platform resolves independently and
 * degrades to `null` (never throws) on anything unset or malformed — the
 * caller turns a `null` into the ordinary opaque 404.
 */
export function appLinksConfig(env: Env): AppLinksConfig {
  return { android: androidAppLinksConfig(env), apple: appleAppLinksConfig(env) };
}

function androidAppLinksConfig(env: Env): AndroidAppLinksConfig | null {
  const packageName = (env.APP_LINKS_ANDROID_PACKAGE ?? "").trim();
  const rawFingerprints = (env.APP_LINKS_ANDROID_SHA256 ?? "").trim();
  // All-or-nothing: one half configured without the other cannot produce a
  // correct statement, so it is unconfigured, not "half configured."
  if (packageName === "" || rawFingerprints === "") return null;

  if (!ANDROID_PACKAGE_RE.test(packageName)) {
    console.warn(
      "app_links.android_package_invalid — APP_LINKS_ANDROID_PACKAGE is set but not a valid " +
        "package name; assetlinks.json stays unconfigured",
    );
    return null;
  }

  const fingerprints: string[] = [];
  for (const piece of rawFingerprints.split(",")) {
    const fp = piece.trim();
    if (fp === "") continue;
    if (!SHA256_FINGERPRINT_RE.test(fp)) {
      // One bad fingerprint invalidates the whole list rather than silently
      // dropping it — a partially-wrong assetlinks.json fails Android's
      // verification just as completely as a missing one, but looks
      // configured, which is worse.
      console.warn(
        "app_links.android_fingerprint_invalid — APP_LINKS_ANDROID_SHA256 contains a malformed " +
          "entry; assetlinks.json stays unconfigured",
      );
      return null;
    }
    fingerprints.push(fp.toUpperCase());
  }
  if (fingerprints.length === 0) return null;

  return { packageName, fingerprints };
}

function appleAppLinksConfig(env: Env): AppleAppLinksConfig | null {
  const appId = (env.APP_LINKS_APPLE_APP_ID ?? "").trim();
  if (appId === "") return null;
  if (!APPLE_APP_ID_RE.test(appId)) {
    console.warn(
      "app_links.apple_app_id_invalid — APP_LINKS_APPLE_APP_ID is set but not TEAMID.bundle.id " +
        "shaped; apple-app-site-association stays unconfigured",
    );
    return null;
  }
  return { appId };
}

// -- JSON builders (pure) -----------------------------------------------------

/**
 * `GET /.well-known/assetlinks.json` body — the standard Android App Links
 * "statement list," naming exactly this deployment's app as the delegate for
 * `handle_all_urls` on this origin.
 * https://developer.android.com/training/app-links/verify-android-applinks
 */
export function buildAndroidAssetLinks(config: AndroidAppLinksConfig): unknown[] {
  return [
    {
      relation: ["delegate_permission/common.handle_all_urls"],
      target: {
        namespace: "android_app",
        package_name: config.packageName,
        sha256_cert_fingerprints: config.fingerprints,
      },
    },
  ];
}

/**
 * `GET /.well-known/apple-app-site-association` body — the modern `components`
 * form (`appID` + `paths`; the deprecated top-level `details`/`paths` form is
 * not emitted). Covers the two document address spaces this Worker serves
 * under an anonymous-reachable path: `/d/*` (public_id) and `/s/*` (slug).
 * https://developer.apple.com/documentation/xcode/supporting-associated-domains
 */
export function buildAppleAppSiteAssociation(config: AppleAppLinksConfig): Record<string, unknown> {
  return {
    applinks: {
      apps: [],
      components: [
        {
          appID: config.appId,
          paths: ["/d/*", "/s/*"],
        },
      ],
    },
  };
}
