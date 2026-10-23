import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expandTrustedRoots } from '../lib/patterns.mjs'

const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-allowlist-test-')))
try {
  const shared = join(base, 'Shared')
  const sharedA = join(shared, 'a')
  const sharedB = join(shared, 'b')
  const deep = join(sharedB, 'c')
  const data = join(shared, 'data')
  const dataX = join(data, 'x')
  for (const dir of [shared, sharedA, sharedB, deep, dataX]) mkdirSync(dir, { recursive: true })
  writeFileSync(join(sharedA, 'file.txt'), 'x')

  // literal path → itself
  assert.ok(new Set(expandTrustedRoots(shared)).has(shared))

  // trailing `**` → root + every descendant (pruning must not break **)
  const tree = new Set(expandTrustedRoots(join(shared, '**')))
  assert.ok(tree.has(shared), '** includes anchor')
  assert.ok(tree.has(sharedA) && tree.has(sharedB) && tree.has(deep) && tree.has(dataX), '** includes descendants')

  // single `*` → immediate children only
  const children = new Set(expandTrustedRoots(join(shared, '*')))
  assert.ok(children.has(sharedA) && children.has(sharedB) && children.has(data), '* includes immediate children')
  assert.ok(!children.has(deep), '* excludes grandchildren')
  assert.ok(!children.has(shared), '* excludes parent')

  // missing literal → empty
  assert.deepEqual(expandTrustedRoots(join(base, 'Nope')), [])
  assert.deepEqual(expandTrustedRoots(join(base, 'NoSuch', '*')), [])
  assert.deepEqual(expandTrustedRoots(join(base, 'NoSuch', '**')), [])

  // malformed → throw
  assert.throws(() => expandTrustedRoots('relative/path'), /must be absolute/)
  assert.throws(() => expandTrustedRoots('D:\\**\\cache'), /anchored too broadly/)

  // segment pruning: literal-anchored wildcard does not walk whole anchor tree
  {
    let reads = 0
    const readdir = (dir, opts) => {
      reads += 1
      return readdirSync(dir, opts)
    }
    const pruned = new Set(expandTrustedRoots(join(shared, 'a*'), { readdir }))
    assert.ok(pruned.has(join(shared, 'a')), 'segment match still found')
    assert.ok(!pruned.has(join(shared, 'b')) && !pruned.has(join(shared, 'b', 'c')), 'non-matching subtrees excluded')
    assert.ok(reads <= 2, `pruned walk reads at most anchor+match dirs, got ${reads}`)
  }

  // literal tail segment: `data\*` descends only into `data`
  {
    let reads = 0
    const readdir = (dir, opts) => {
      reads += 1
      return readdirSync(dir, opts)
    }
    const children = new Set(expandTrustedRoots(join(shared, 'data', '*'), { readdir }))
    assert.ok(children.has(join(data, 'x')), 'literal-anchored tail still finds nested child')
    assert.ok(reads <= 2, `literal-anchored walk reads at most anchor+nested, got ${reads}`)
  }

  // multi-segment tail: `b\c` nested literal after wildcard-less prefix
  {
    const m = new Set(expandTrustedRoots(join(shared, 'b', 'c')))
    assert.ok(m.has(deep), 'multi-segment tail match found')
  }

  console.log('ALL PATTERNS CHECKS PASSED')
} finally {
  rmSync(base, { recursive: true, force: true })
}
