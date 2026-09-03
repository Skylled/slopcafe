// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

/**
 * The OAuth consent card's callback description — the load-bearing anti-phishing
 * control for open Dynamic Client Registration.
 *
 * `/register` is unauthenticated and accepts public clients, so anyone can mint a
 * client_id with their own redirect_uri and mail the operator an /authorize link.
 * The consent screen is the ONLY human gate, and the callback address is the only
 * unforgeable thing on it — `clientName` is whatever the registrant typed.
 *
 * These tests pin the properties that make the address judgeable at a glance. They
 * are deliberately written as ATTACKS, because the failure mode is not a crash: it
 * is a card that renders perfectly while reading as a name the operator trusts.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { appendIssParam, describeCallback, emphasizeHostTail } from "../src/authorize.ts";

let fails = 0;
function check(name, actual, expected) {
  const ok = actual === expected;
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
  if (!ok) console.log(`       expected: ${JSON.stringify(expected)}\n       actual:   ${JSON.stringify(actual)}`);
}
function checkThat(name, cond, detail = "") {
  if (!cond) fails++;
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${cond ? "" : `\n       ${detail}`}`);
}

// ----- host-tail emphasis: the subdomain-confusion defence ------------------

check(
  "the flagship attack: a familiar prefix is muted, the real destination is not",
  emphasizeHostTail("claude.ai.evil.example"),
  '<span class="sub">claude.ai.</span>evil.example',
);

check(
  "a legitimate vendor host keeps its own name emphasized",
  emphasizeHostTail("claude.ai"),
  "claude.ai",
);

check(
  "a legitimate vendor subdomain mutes only the leading label",
  emphasizeHostTail("console.claude.ai"),
  '<span class="sub">console.</span>claude.ai',
);

check("chatgpt.com is unsplit", emphasizeHostTail("chatgpt.com"), "chatgpt.com");

check(
  "a port stays attached to the emphasized tail",
  emphasizeHostTail("a.b.example.com:8443"),
  '<span class="sub">a.b.</span>example.com:8443',
);

check("an IPv4 literal is never split", emphasizeHostTail("127.0.0.1"), "127.0.0.1");
check("an IPv4 literal with a port is never split", emphasizeHostTail("127.0.0.1:9999"), "127.0.0.1:9999");
check("a bracketed IPv6 literal is never split", emphasizeHostTail("[::1]"), "[::1]");
check("a single label is never split", emphasizeHostTail("localhost"), "localhost");

checkThat(
  "the emphasis markup escapes a host carrying HTML metacharacters",
  !emphasizeHostTail('a.b.<script>"x').includes("<script"),
  emphasizeHostTail('a.b.<script>"x'),
);

// ----- describeCallback: scheme handling ------------------------------------

const https = describeCallback("https://claude.ai.evil.example/cb");
checkThat(
  "an https callback emphasizes the tail in its headline",
  https.headline === '<span class="sub">claude.ai.</span>evil.example',
  https.headline,
);

const loopback = describeCallback("http://127.0.0.1:54321/callback");
checkThat(
  "a loopback callback reads as a local handoff (the native-CLI happy path)",
  loopback.headline.includes("THIS machine") && loopback.cautions.length === 0,
  JSON.stringify(loopback),
);

const v6 = describeCallback("http://[::1]:8080/cb");
checkThat(
  "a bracketed IPv6 loopback parses and reads as local, without cautions",
  v6.headline.includes("THIS machine") && v6.cautions.length === 0,
  JSON.stringify(v6),
);

const ide = describeCallback("vscode://anthropic.claude/auth");
checkThat(
  "a recognized IDE scheme keeps the local-application framing",
  ide.headline.includes("THIS machine"),
  ide.headline,
);

const fakeIde = describeCallback("evilapp://claude.ai/cb");
checkThat(
  "an UNRECOGNIZED scheme does NOT get the reassuring local framing",
  !fakeIde.headline.includes("THIS machine"),
  fakeIde.headline,
);
checkThat(
  "…and is cautioned instead",
  fakeIde.cautions.some((c) => c.includes("unrecognized")),
  JSON.stringify(fakeIde.cautions),
);

const ftp = describeCallback("ftp://evil.example/cb");
checkThat(
  "a network scheme is never described as staying on this machine",
  !ftp.headline.includes("THIS machine"),
  ftp.headline,
);

// ----- describeCallback: the classic spoofing shapes ------------------------

const userinfo = describeCallback("https://claude.ai@evil.example/cb");
checkThat(
  "embedded userinfo does not reach the headline (URL.host excludes it)",
  !userinfo.headline.includes("claude.ai"),
  userinfo.headline,
);
checkThat(
  "…and embedded userinfo is explicitly cautioned",
  userinfo.cautions.some((c) => c.includes('"@"')),
  JSON.stringify(userinfo.cautions),
);

const puny = describeCallback("https://xn--clude-hva.ai/cb");
checkThat(
  "an IDN host is shown in punycode, not re-rendered as lookalike Unicode",
  puny.headline.includes("xn--"),
  puny.headline,
);
checkThat(
  "…and punycode is cautioned",
  puny.cautions.some((c) => c.includes("punycode")),
  JSON.stringify(puny.cautions),
);

const cleartext = describeCallback("http://evil.example/cb");
checkThat(
  "plain http to a REMOTE host warns that the code crosses the network",
  cleartext.cautions.some((c) => c.includes("unencrypted")),
  JSON.stringify(cleartext.cautions),
);

const dotLocalhost = describeCallback("http://claude.ai.localhost:9999/cb");
checkThat(
  "a *.localhost subdomain is NOT treated as loopback (it is attacker-choosable)",
  !dotLocalhost.headline.includes("THIS machine"),
  dotLocalhost.headline,
);

const bad = describeCallback("not a url");
checkThat(
  "an unparseable callback says do not continue",
  bad.where.includes("Do not continue"),
  bad.where,
);

// ----- appendIssParam: RFC 9207 issuer identification ------------------------
//
// Every authorization response we 302 to a client callback (allow AND deny)
// carries `iss=<request origin>` so a client talking to several authorization
// servers can verify WHICH one answered before redeeming the code (the AS
// mix-up attack). These pin the URL-surgery properties the helper promises.

check(
  "https callback gains iss as a url-encoded origin",
  appendIssParam("https://claude.ai/api/mcp/auth_callback?code=abc123&state=xyz", "https://slopcafe.com"),
  "https://claude.ai/api/mcp/auth_callback?code=abc123&state=xyz&iss=https%3A%2F%2Fslopcafe.com",
);

check(
  "custom-scheme callback (IDE deep link) parses and gains iss",
  appendIssParam("vscode://anthropic.claude/auth?code=c1", "https://slopcafe.com"),
  "vscode://anthropic.claude/auth?code=c1&iss=https%3A%2F%2Fslopcafe.com",
);

check(
  "loopback callback with a port keeps its port and gains iss (native CLI path)",
  appendIssParam("http://127.0.0.1:9876/cb?code=c&state=s", "http://localhost:8787"),
  "http://127.0.0.1:9876/cb?code=c&state=s&iss=http%3A%2F%2Flocalhost%3A8787",
);

check(
  "an existing iss is OVERWRITTEN, never duplicated (future library emit / injected param)",
  appendIssParam("https://claude.ai/cb?iss=https%3A%2F%2Fevil.example&code=c", "https://slopcafe.com"),
  "https://claude.ai/cb?iss=https%3A%2F%2Fslopcafe.com&code=c",
);

{
  const out = new URL(appendIssParam("https://claude.ai/cb?code=SECRET&state=st8", "https://slopcafe.com"));
  checkThat(
    "code and state round-trip byte-exact beside iss",
    out.searchParams.get("code") === "SECRET" &&
      out.searchParams.get("state") === "st8" &&
      out.searchParams.get("iss") === "https://slopcafe.com" &&
      [...out.searchParams.keys()].filter((k) => k === "iss").length === 1,
    out.toString(),
  );
}

check(
  "a fragment survives untouched, with iss landing in the query",
  appendIssParam("https://claude.ai/cb?code=c#frag", "https://slopcafe.com"),
  "https://claude.ai/cb?code=c&iss=https%3A%2F%2Fslopcafe.com#frag",
);

check(
  "an unparseable location is returned unchanged rather than thrown on",
  appendIssParam("not a url", "https://slopcafe.com"),
  "not a url",
);

check(
  "the deny shape carries iss too (error responses are authorization responses)",
  appendIssParam(
    "https://claude.ai/cb?error=access_denied&error_description=operator+denied+the+request&state=s",
    "https://slopcafe.com",
  ),
  "https://claude.ai/cb?error=access_denied&error_description=operator+denied+the+request&state=s&iss=https%3A%2F%2Fslopcafe.com",
);

// ----- Door A props: where the recorded client_id comes from ----------------
//
// Migration 0019 / issue #63 stamps `versions.author_client_id` from
// `AwhProps.clientId`, which Door A sets exactly once, at completeAuthorization.
// The whole value of the column is that it cannot be chosen by the requester, so
// the SOURCE of that field is the property worth pinning — and it is a property
// of code that needs a live OAuthProvider, KV and D1 to execute, none of which
// the unit suite has. So this is a source-text pin, the same idiom
// test/mcp-errors.test.mjs uses for the MCP Apps strings: it can't prove the
// runtime behavior, but it fails loudly the moment someone rewrites the props
// literal — in particular the moment someone reaches for `form.get(...)`, which
// is attacker-controlled (anyone who can open the consent link submits that
// form), whereas `authReq` is the request the PROVIDER parsed and validated
// against the registered client.
const authorizeSrc = readFileSync(fileURLToPath(new URL("../src/authorize.ts", import.meta.url)), "utf8");
const propsLiteral = /const props: AwhProps = \{([^}]*)\};/.exec(authorizeSrc)?.[1] ?? "";

checkThat(
  "Door A builds AwhProps with a clientId field at all (issue #63)",
  /\bclientId\s*:/.test(propsLiteral),
  `props literal was: {${propsLiteral}}`,
);
checkThat(
  "Door A takes clientId from the provider-validated authReq, never a form field",
  /clientId:\s*authReq\.clientId\b/.test(propsLiteral),
  `props literal was: {${propsLiteral}}`,
);
checkThat(
  "the consent form never feeds the props literal (no form.get in it)",
  !/form\s*\.\s*get/.test(propsLiteral),
  `props literal was: {${propsLiteral}}`,
);
checkThat(
  "clientId is derived at the same point agentId is — from the binding, not the form",
  /agentId:\s*agent\.id\b/.test(propsLiteral),
  `props literal was: {${propsLiteral}}`,
);
// Door B's counterpart: a static awh_ bearer has no OAuth client, and the null
// must be explicit rather than an omitted field silently typing as undefined.
const oauthSrc = readFileSync(fileURLToPath(new URL("../src/oauth.ts", import.meta.url)), "utf8");
checkThat(
  "Door B stamps clientId: null explicitly (no OAuth client behind an awh_ key)",
  /const props: AwhProps = \{[^}]*clientId:\s*null[^}]*\};/.test(oauthSrc),
  "src/oauth.ts resolveExternalToken must set clientId: null",
);

// ----------------------------------------------------------------------------

if (fails > 0) {
  console.log(`\n${fails} test(s) FAILED`);
  process.exit(1);
} else {
  console.log("\nall authorize-callback tests passed");
}
