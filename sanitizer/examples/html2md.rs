// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

// One-off host tool for the source-retention backfill (Category C fallback):
// emit `html_to_markdown(H)` for a sanitized HTML file so a legacy Markdown
// doc with no repo source can be stamped with S := htmlToMarkdown(H).
// Same crate function the Worker calls at read time, so the bytes match prod.
//   cargo run --example html2md -- <sanitized.html>   # M -> stdout
use std::io::Write;

fn main() {
    let path = std::env::args().nth(1).expect("usage: html2md <html-file>");
    let html = std::fs::read_to_string(&path).expect("read input html");
    let md = sanitizer::html_to_markdown(&html);
    std::io::stdout()
        .write_all(md.as_bytes())
        .expect("write markdown to stdout");
}
