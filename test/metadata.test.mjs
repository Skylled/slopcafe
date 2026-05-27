// Coverage for src/metadata.ts — the validators, derivation, display
// normalization, and tag sanitizer.
//
// Same Node-strip-types harness as test/advisories.test.mjs, same pass/FAIL
// shape so the existing `npm test` stays one log to scan.
//
// Critical cases (where regression would be most user-visible):
//   - bidi-override stripping in normalizeTitleForDisplay (the phishing
//     mitigation the user explicitly asked for)
//   - charset stripping in sanitizeTagsInput (invalid chars silently
//     removed, not rejected; matches the user's "sanitize" framing)
//   - deriveTitleFromHtml's H1 path with nested inline tags + entities
//     (the typical sanitized-doc shape)
//
// Construction note: non-printable / bidi / zero-width chars are built
// via String.fromCharCode (or \u escapes through ch()) so the source file
// stays printable-ASCII. A literal U+202E in a test fixture is silently
// lost on the first refactor.

import {
  deriveTitleFromHtml,
  formatPageTitle,
  normalizeTitleForDisplay,
  parseMetadataHeaders,
  sanitizeTagsInput,
  SITE_BRAND,
  validateDescriptionInput,
  validateSlugInput,
  validateTitleInput,
} from "../src/metadata.ts";

let fails = 0;

function check(label, got, want) {
  const okEq =
    Array.isArray(want) && Array.isArray(got)
      ? want.length === got.length && want.every((v, i) => v === got[i])
      : got === want;
  console.log(`${okEq ? "ok  " : "FAIL"} ${label}`);
  if (!okEq) {
    console.log(`  want: ${JSON.stringify(want)}`);
    console.log(`  got:  ${JSON.stringify(got)}`);
    fails++;
  }
}

/** Shorthand: char from a numeric code point. */
const ch = (cp) => String.fromCharCode(cp);

const RLO = ch(0x202e);   // right-to-left override
const LRO = ch(0x202d);
const LRE = ch(0x202a);
const RLE = ch(0x202b);
const PDF = ch(0x202c);
const LRI = ch(0x2066);
const RLI = ch(0x2067);
const FSI = ch(0x2068);
const PDI = ch(0x2069);
const ZWSP = ch(0x200b);
const ZWNJ = ch(0x200c);
const ZWJ = ch(0x200d);
const WJ = ch(0x2060);
const BOM = ch(0xfeff);
const NUL = ch(0x00);
const TAB = ch(0x09);
const LF = ch(0x0a);

// ----- sanitizeTagsInput ----------------------------------------------------

check("tags: pass through valid", sanitizeTagsInput(["abc", "x_y", "a-b", "Z9"]), [
  "abc",
  "x_y",
  "a-b",
  "Z9",
]);
check(
  "tags: strip invalid chars",
  sanitizeTagsInput(["hello world", "a/b", "x.y", "abc!?"]),
  ["helloworld", "ab", "xy", "abc"],
);
check("tags: drop fully-invalid entries", sanitizeTagsInput(["!!!", "@@@"]), []);
check("tags: drop empty strings", sanitizeTagsInput(["", "  ", "a"]), ["a"]);
check(
  "tags: per-tag length cap (32)",
  sanitizeTagsInput(["a".repeat(40)]),
  ["a".repeat(32)],
);
check(
  "tags: dedupe case-sensitive",
  sanitizeTagsInput(["AI", "ai", "AI", "ML"]),
  ["AI", "ai", "ML"],
);
check(
  "tags: cap array length (10)",
  sanitizeTagsInput(["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l"]),
  ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"],
);
check("tags: non-array → []", sanitizeTagsInput("not-an-array"), []);
check("tags: nulls/non-strings dropped", sanitizeTagsInput([null, 1, "ok"]), ["ok"]);

// ----- validateTitleInput ---------------------------------------------------

check("title: trim + collapse whitespace", validateTitleInput("  hello   world  "), "hello world");
// NUL is stripped (non-whitespace control); TAB is folded to a space by
// WS_RUN_RE (whitespace-class controls survive the strip pass on purpose,
// see DISPLAY_STRIP_RANGES comment in metadata.ts).
check(
  "title: NUL drops + TAB becomes space",
  validateTitleInput("a" + NUL + "b" + TAB + "c"),
  "ab c",
);
check(
  "title: cap at 300 chars",
  validateTitleInput("x".repeat(500)).length,
  300,
);
check("title: NFC normalize", validateTitleInput("é"), "é");
check("title: empty stays empty (re-derive signal)", validateTitleInput(""), "");
check(
  "title: bidi-override PRESERVED at write (display strips later)",
  validateTitleInput("a" + RLO + "b").includes(RLO),
  true,
);

// ----- validateDescriptionInput --------------------------------------------

check(
  "description: strip control chars + trim",
  validateDescriptionInput("  a" + NUL + "b  "),
  "ab",
);
check(
  "description: cap at 500 chars",
  validateDescriptionInput("y".repeat(800)).length,
  500,
);
check(
  "description: bidi preserved (not a phishing surface)",
  validateDescriptionInput("a" + RLO + "b").includes(RLO),
  true,
);

// ----- deriveTitleFromHtml --------------------------------------------------

check(
  "derive: first <h1> text",
  deriveTitleFromHtml("<p>intro</p><h1>The Heading</h1><h1>Second</h1>"),
  "The Heading",
);
check(
  "derive: strips nested inline tags inside H1",
  deriveTitleFromHtml('<h1>Hello <em>cruel</em> <strong>world</strong></h1>'),
  "Hello cruel world",
);
check(
  "derive: decodes named entities",
  deriveTitleFromHtml("<h1>5 &lt; 10 &amp; up</h1>"),
  "5 < 10 & up",
);
check(
  "derive: decodes numeric + hex entities",
  deriveTitleFromHtml("<h1>caf&#233; &#x2014; great</h1>"),
  "café — great",
);
check(
  "derive: fallback to first-N chars of text when no H1",
  deriveTitleFromHtml("<p>This is a paragraph that should become the title.</p>"),
  "This is a paragraph that should become the title.",
);
check(
  "derive: fallback truncates at 80 chars",
  (deriveTitleFromHtml("<p>" + "x".repeat(200) + "</p>") ?? "").length,
  80,
);
check("derive: empty doc → null", deriveTitleFromHtml(""), null);
check("derive: tags-only doc → null", deriveTitleFromHtml("<div></div>"), null);
check(
  "derive: case-insensitive H1 match",
  deriveTitleFromHtml("<H1>Caps</H1>"),
  "Caps",
);

// ----- normalizeTitleForDisplay (anti-phishing) ----------------------------

check(
  "display: strips bidi override (U+202E)",
  normalizeTitleForDisplay("Login" + RLO + ".example.com"),
  "Login.example.com",
);
check(
  "display: strips all bidi-override range (LRE/RLE/PDF/LRO/RLO)",
  normalizeTitleForDisplay("a" + LRE + "b" + RLE + "c" + PDF + "d" + LRO + "e" + RLO + "f"),
  "abcdef",
);
check(
  "display: strips bidi isolates (U+2066-2069)",
  normalizeTitleForDisplay("a" + LRI + "b" + RLI + "c" + FSI + "d" + PDI + "e"),
  "abcde",
);
check(
  "display: strips zero-width chars",
  normalizeTitleForDisplay("a" + ZWSP + "b" + ZWNJ + "c" + ZWJ + "d" + WJ + "e" + BOM + "f"),
  "abcdef",
);
check(
  "display: strips C0/C1 controls",
  normalizeTitleForDisplay("a" + NUL + "bc" + TAB + "de"),
  "abc de",
);
check(
  "display: collapses whitespace runs",
  normalizeTitleForDisplay("hello   " + TAB + LF + "  world"),
  "hello world",
);
check(
  "display: caps at 200 chars",
  normalizeTitleForDisplay("a".repeat(500)).length,
  200,
);
check(
  "display: empty/whitespace → empty",
  normalizeTitleForDisplay("   "),
  "",
);

// ----- formatPageTitle ------------------------------------------------------

check(
  "page-title: appends brand",
  formatPageTitle("Hello"),
  `Hello | ${SITE_BRAND}`,
);
check("page-title: null falls back to brand", formatPageTitle(null), SITE_BRAND);
check(
  "page-title: empty/whitespace falls back to brand",
  formatPageTitle("   "),
  SITE_BRAND,
);
check(
  "page-title: strips bidi before suffix",
  formatPageTitle("Login" + RLO + ".com"),
  `Login.com | ${SITE_BRAND}`,
);

// ----- parseMetadataHeaders -------------------------------------------------
// Build a synthetic Request to exercise the header parser end-to-end.

function makeReq(headers) {
  return new Request("https://example.test/d", { method: "POST", headers });
}

{
  const opts = parseMetadataHeaders(makeReq({}));
  check("headers: all absent → empty input", JSON.stringify(opts), "{}");
}

{
  const opts = parseMetadataHeaders(
    makeReq({
      "x-doc-title": "Hello World",
      "x-doc-description": "A summary",
      "x-doc-tags": "alpha, beta, gam-ma, !bad!",
    }),
  );
  check("headers: title parsed", opts.title, "Hello World");
  check("headers: description parsed", opts.description, "A summary");
  check("headers: tags parsed + sanitized", opts.tags, ["alpha", "beta", "gam-ma", "bad"]);
}

{
  const opts = parseMetadataHeaders(
    makeReq({ "x-doc-title": "", "x-doc-description": "", "x-doc-tags": "" }),
  );
  check("headers: empty title preserved as '' (re-derive)", opts.title, "");
  check("headers: empty description preserved as '' (clear)", opts.description, "");
  check("headers: empty tags → [] (clear)", opts.tags, []);
}

// ----- validateSlugInput ----------------------------------------------------
// Unlike tags, slug validation REJECTS invalid input rather than silently
// sanitizing — uniqueness means a mutated slug could collide with another
// doc's slug. The reason codes ride the error so the caller can surface a
// rule-specific message.

function slug(raw) {
  const r = validateSlugInput(raw);
  return r.ok ? { ok: true, slug: r.slug } : { ok: false, reason: r.reason };
}

check("slug: lowercase alphanumeric passes", slug("hello").ok, true);
check("slug: returns trimmed/lowered value", slug("  HELLO  ").slug, "hello");
check("slug: kebab-case passes", slug("my-doc-2").slug, "my-doc-2");
check("slug: snake_case passes", slug("my_doc_2").slug, "my_doc_2");
check("slug: digits-only passes", slug("12345").slug, "12345");
check("slug: single-char passes", slug("a").slug, "a");

// Rejections — each maps to a specific SlugReject code:
check("slug: empty → empty", slug("").reason, "empty");
check("slug: whitespace-only → empty", slug("   ").reason, "empty");
check("slug: leading hyphen → must_start_alnum", slug("-foo").reason, "must_start_alnum");
check("slug: trailing hyphen → must_end_alnum", slug("foo-").reason, "must_end_alnum");
check("slug: leading underscore → must_start_alnum", slug("_foo").reason, "must_start_alnum");
check("slug: trailing underscore → must_end_alnum", slug("foo_").reason, "must_end_alnum");
check("slug: space inside → bad_charset", slug("foo bar").reason, "bad_charset");
check("slug: dot inside → bad_charset", slug("foo.bar").reason, "bad_charset");
check("slug: too long → too_long", slug("a".repeat(65)).reason, "too_long");
check("slug: exactly 64 chars passes", slug("a".repeat(64)).ok, true);

// Casing — uppercase is lowercased as a courtesy (rather than rejected):
check("slug: uppercase normalized to lowercase", slug("FooBar").slug, "foobar");
check("slug: mixed case + hyphen", slug("Foo-Bar").slug, "foo-bar");

// ----- parseMetadataHeaders + X-Doc-Slug -----------------------------------
// X-Doc-Slug is passed through raw — validation happens in core (so MCP
// and HTTP share one reject path). Empty value is the "release" signal.

{
  const opts = parseMetadataHeaders(makeReq({ "x-doc-slug": "my-doc" }));
  check("headers: slug pass-through", opts.slug, "my-doc");
}
{
  const opts = parseMetadataHeaders(makeReq({ "x-doc-slug": "" }));
  check("headers: empty slug preserved as '' (release)", opts.slug, "");
}
{
  const opts = parseMetadataHeaders(makeReq({}));
  check("headers: slug absent → undefined", opts.slug, undefined);
}

process.exit(fails === 0 ? 0 : 1);
