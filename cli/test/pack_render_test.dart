// SPDX-FileCopyrightText: 2026 Skylled / Kyle Bradshaw
// SPDX-License-Identifier: Apache-2.0

import 'package:slopcafe_cli/api/api.dart';
import 'package:slopcafe_cli/src/commands/doc_render.dart';
import 'package:test/test.dart';

PackDocument _member(String id, {String? slug, String content = 'body\n'}) =>
    PackDocument(
      publicId: id,
      createdAt: DateTime.utc(2026),
      createdByKind: 'agent',
      tags: const [],
      status: 'active',
      visibility: 'private',
      content: content,
      format: 'markdown',
      converterV: 'awh-md-v1',
      version: 1,
      slug: slug,
    );

PackResponse _pack({
  PackRoot? root,
  String source = 'manifest',
  String? query,
  List<PackDocument> documents = const [],
  List<PackOmitted> omitted = const [],
}) =>
    PackResponse(
      pack: PackInfo(
        source: source,
        budgetBytes: 65536,
        maxDocuments: 8,
        usedBytes: 100,
        query: query,
        root: root,
      ),
      documents: documents,
      omitted: omitted,
    );

void main() {
  group('packContent', () {
    test('emits the root prose first, then each member under a separator', () {
      final out = packContent(_pack(
        root: const PackRoot(
          publicId: 'ROOTAAAAAAAAAAAAAAAAAA',
          slug: 'pack-boot',
          content: '# Boot\n',
          format: 'markdown',
        ),
        documents: [_member('MEMBERAAAAAAAAAAAAAAAA', slug: 'one')],
      ));
      expect(out, startsWith('<!-- pack root: pack-boot -->\n# Boot\n'));
      expect(out, contains('---\n'));
      expect(out, contains('<!-- pack member: one (MEMBERAAAAAAAAAAAAAAAA) v1 -->'));
    });

    test('a query-rooted pack has no root and starts at the first member', () {
      // `search --include-bodies` produces this shape — the same renderer must
      // handle it, so both pack roots print identically.
      final out = packContent(_pack(
        source: 'query',
        query: 'onboarding',
        documents: [_member('MEMBERAAAAAAAAAAAAAAAA')],
      ));
      expect(out, startsWith('---\n'));
      expect(out, isNot(contains('pack root')));
    });
  });

  group('packNotes', () {
    PackOmitted omitted(int i) =>
        PackOmitted(ref: 'ref$i', reason: 'max_documents', title: 'Doc $i');

    test('names the root for a document pack and the query for a query pack', () {
      expect(
        packNotes(_pack(
          root: const PackRoot(
            publicId: 'ROOTAAAAAAAAAAAAAAAAAA',
            slug: 'pack-boot',
            content: '',
            format: 'markdown',
          ),
        )).first,
        contains('of pack-boot'),
      );
      expect(
        packNotes(_pack(source: 'query', query: 'onboarding')).first,
        contains('for "onboarding"'),
      );
    });

    test('caps the omitted menu and says how many it held back', () {
      // A query pack can omit every hit past the knobs (up to --limit, default
      // 50); listing them all buries the accounting line. --json keeps the lot.
      final notes = packNotes(_pack(
        source: 'query',
        query: 'x',
        omitted: [for (var i = 0; i < 25; i++) omitted(i)],
      ));
      final listed = notes.where((n) => n.startsWith('omitted (')).length;
      expect(listed, 10);
      expect(notes, contains('…and 15 more omitted — run with --json for the full list'));
      expect(notes.last, contains('raise --budget/--max-docs'));
    });

    test('an unabridged menu gets no "and N more" line', () {
      final notes = packNotes(_pack(omitted: [omitted(0), omitted(1)]));
      expect(notes.where((n) => n.contains('more omitted')), isEmpty);
    });

    test('nothing omitted → just the accounting line', () {
      expect(packNotes(_pack()).length, 1);
    });
  });
}
