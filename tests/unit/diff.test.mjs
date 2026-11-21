import assert from 'node:assert/strict'
import test from 'node:test'
import { diffFiles, diffTotals, inlineChange, inlineChanges, languageForPath, looksLikeDiff, parseDiff, splitRows } from '../../web/src/diff.ts'

const GIT = `$ git diff
diff --git a/rest_api/models/order.py b/rest_api/models/order.py
index b8492c0126..8190b6522d 100644
--- a/rest_api/models/order.py
+++ b/rest_api/models/order.py
@@ -49,6 +49,7 @@ from rest_api.models.enums import (
     LabelFormat,
     OrderStatus,
     SignatureType,
+    ThirdPartyPaymentType,
 )
 from rest_api.models.fulfillment_lists import PackList
 from rest_api.models.inventory import Inventory, Warehouse
diff --git a/rest_api/migrations/0493_rate.py b/rest_api/migrations/0493_rate.py
new file mode 100644
index 0000000000..45361c8c1b
--- /dev/null
+++ b/rest_api/migrations/0493_rate.py
@@ -0,0 +1,3 @@
+from django.db import migrations, models
+
+
diff --git a/old.txt b/old.txt
deleted file mode 100644
--- a/old.txt
+++ /dev/null
@@ -1,2 +0,0 @@
-gone
--- an sql comment that was removed
diff --git a/a.py b/b.py
similarity index 90%
rename from a.py
rename to b.py
diff --git a/logo.png b/logo.png
Binary files a/logo.png and b/logo.png differ
done in 0.3s`

test('git diffs: files, statuses, counts, line numbers and surrounding text', () => {
  assert.equal(looksLikeDiff(GIT), true)
  const segments = parseDiff(GIT)
  assert.equal(segments[0].kind, 'text')
  assert.equal(segments[0].text, '$ git diff')
  assert.equal(segments.at(-1).kind, 'text')
  assert.equal(segments.at(-1).text, 'done in 0.3s')
  const files = diffFiles(segments)
  assert.deepEqual(files.map(file => [file.path, file.status, file.additions, file.deletions]), [
    ['rest_api/models/order.py', 'modified', 1, 0],
    ['rest_api/migrations/0493_rate.py', 'added', 3, 0],
    ['old.txt', 'deleted', 0, 2],
    ['b.py', 'renamed', 0, 0],
    ['logo.png', 'binary', 0, 0],
  ])
  const order = files[0].hunks[0]
  assert.equal(order.section, 'from rest_api.models.enums import (')
  assert.deepEqual(order.lines.slice(2, 5).map(line => [line.kind, line.oldNo, line.newNo]), [['context', 51, 51], ['add', undefined, 52], ['context', 52, 53]])
  assert.equal(files[2].hunks[0].lines[1].text, '-- an sql comment that was removed')
  assert.equal(files[3].oldPath, 'a.py')
  assert.deepEqual(diffTotals(files), { additions: 4, deletions: 2 })
  assert.ok(files[0].raw.startsWith('diff --git a/rest_api/models/order.py'))
})

test('loose diffs written by an agent: --- path headers, @@ labels without numbers, (new) files', () => {
  const loose = `--- rest_api/models/label.py
+from rest_api.models.enums import CarrierIntegrations
@@ class Rate
     recommended = models.BooleanField(default=False)
+    is_third_party_billed = models.BooleanField(default=False)
@@
+    def carrier_bills_third_party(self, order):
+        return False

--- rest_api/migrations/0493_rate_is_third_party_billed.py (new)
+class Migration(migrations.Migration):
+    pass`
  const files = diffFiles(parseDiff(loose))
  assert.equal(files.length, 2)
  assert.equal(files[0].path, 'rest_api/models/label.py')
  assert.equal(files[0].hunks.length, 3)
  assert.equal(files[0].hunks[1].section, 'class Rate')
  assert.equal(files[0].additions, 4)
  assert.equal(files[0].hunks[1].lines[0].oldNo, undefined)
  assert.equal(files[1].status, 'added')
  assert.equal(files[1].additions, 2)
})

test('not a diff', () => {
  assert.equal(looksLikeDiff('just some text\n- a bullet\n+ plus'), false)
  assert.equal(diffFiles(parseDiff('hello\nworld')).length, 0)
})

test('split rows pair removals with additions and inline edits find the changed middle', () => {
  const [file] = diffFiles(parseDiff(`--- a/x.ts
+++ b/x.ts
@@ -1,4 +1,4 @@
 keep
-const total = 1
-gone
+const total = 2
 tail`))
  const rows = splitRows(file.hunks[0].lines)
  assert.equal(rows.length, 4)
  assert.equal(rows[1].left.text, 'const total = 1')
  assert.equal(rows[1].right.text, 'const total = 2')
  assert.equal(rows[2].left.text, 'gone')
  assert.equal(rows[2].right, undefined)
  assert.deepEqual(inlineChange('const total = 1', 'const total = 2'), { before: [14, 15], after: [14, 15] })
  assert.equal(inlineChange('abcdefghij', 'zyxwvutsrq'), undefined)
  assert.equal(inlineChanges(file.hunks[0].lines).size, 2)
  assert.equal(languageForPath('web/src/App.tsx'), 'typescript')
  assert.equal(languageForPath('rest_api/models/order.py'), 'python')
})

test('annotated headers and headerless snippets inside a diff block', () => {
  const annotated = diffFiles(parseDiff(`--- rest_api/services/shipping_service.py  (generate_shipping_label_for_order)
             integration = self.integrations.get(carrier.integration)
+            is_third_party_billed = True`))
  assert.equal(annotated.length, 1)
  assert.equal(annotated[0].path, 'rest_api/services/shipping_service.py')
  assert.equal(annotated[0].additions, 1)
  const snippet = parseDiff(`-    carrier = baker.make("Carrier")
+    carrier, _ = Carrier.objects.get_or_create(name=name)`, { assumeDiff: true })
  const files = diffFiles(snippet)
  assert.equal(files.length, 1)
  assert.equal(files[0].path, '')
  assert.deepEqual([files[0].additions, files[0].deletions], [1, 1])
  assert.equal(diffFiles(parseDiff('-    carrier = 1', { assumeDiff: false })).length, 0)
})

test('elided git output (no --- or @@ lines) still shows the changes', () => {
  const [file] = diffFiles(parseDiff(`diff --git a/t.py b/t.py
index 7588cd1740..b09f3a7074 100644
......
+    def test_one(self):
+        pass`))
  assert.equal(file.additions, 2)
  assert.equal(file.hunks[0].lines[0].kind, 'note')
})
