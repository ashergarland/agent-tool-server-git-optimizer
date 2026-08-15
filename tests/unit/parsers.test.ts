import { describe, expect, it } from 'vitest';
import { parseNameStatus, parseNumstat, symbolsByFile } from '../../src/services/git.js';

const nul = '\0';

describe('NUL-delimited Git parsers', () => {
  it('reads statuses whose paths contain tabs, newlines, and unicode', () => {
    const output = ['M', 'src/a\tb.ts', 'A', 'docs/line\nbreak.md', 'D', 'src/ünïcode.ts', ''].join(
      nul,
    );
    expect(parseNameStatus(output)).toEqual([
      { path: 'src/a\tb.ts', change: 'Modified' },
      { path: 'docs/line\nbreak.md', change: 'Added' },
      { path: 'src/ünïcode.ts', change: 'Deleted' },
    ]);
  });

  it('consumes both paths of a rename or copy record', () => {
    const output = [
      'R100',
      'old.ts',
      'new.ts',
      'C75',
      'src.ts',
      'copy.ts',
      'M',
      'after.ts',
      '',
    ].join(nul);
    expect(parseNameStatus(output)).toEqual([
      { path: 'new.ts', change: 'Modified' },
      { path: 'copy.ts', change: 'Modified' },
      { path: 'after.ts', change: 'Modified' },
    ]);
  });

  it('ignores truncated records rather than mis-associating paths', () => {
    expect(parseNameStatus(`M${nul}`)).toEqual([]);
    expect(parseNameStatus(`R100${nul}only-source${nul}`)).toEqual([]);
    expect(parseNameStatus('')).toEqual([]);
  });

  it('reads numstat counts, tabs in paths, binaries, and renames', () => {
    const output = [
      '4\t2\tsrc/a\tb.ts',
      '10\t0\tdocs/readme.md',
      '-\t-\tassets/logo.png',
      '3\t1\t',
      'old.ts',
      'new.ts',
      '',
    ].join(nul);
    const stats = parseNumstat(output);
    expect(stats.get('src/a\tb.ts')).toEqual({ additions: 4, deletions: 2, binary: false });
    expect(stats.get('docs/readme.md')).toEqual({ additions: 10, deletions: 0, binary: false });
    expect(stats.get('assets/logo.png')).toEqual({ additions: 0, deletions: 0, binary: true });
    expect(stats.get('new.ts')).toEqual({ additions: 3, deletions: 1, binary: false });
  });

  it('extracts best-effort symbols only from well-formed hunk headers', () => {
    const patch = [
      '+++ b/src/app.ts',
      '@@ -1,0 +1,2 @@ export function activeState() {',
      '@@ -5,0 +6,1 @@ class Widget {',
      '+++ /dev/null',
      '@@ -1,0 +1,1 @@ function ignored() {',
      '+++ b/docs/readme.md',
      '@@ -1 +1 @@',
    ].join('\n');
    const symbols = symbolsByFile(patch);
    expect(symbols.get('src/app.ts')).toEqual(['activeState', 'Widget']);
    expect(symbols.get('docs/readme.md')).toBeUndefined();
    expect([...symbols.keys()]).toEqual(['src/app.ts']);
  });
});
