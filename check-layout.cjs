/* author: csw。使用 Node 执行：node check-layout.cjs，校验布局几何边界。 */
const assert = require("node:assert/strict");
const Module = require("node:module");
const fs = require("node:fs");
const vm = require("node:vm");

// 自测只需纯布局函数，用占位基类加载 Obsidian 插件模块。
const originalLoad = Module._load;
Module._load = function (name, ...args) {
  if (name === "obsidian") return { Plugin: class {}, PluginSettingTab: class {} };
  return originalLoad.call(this, name, ...args);
};
const { computeLayout, normalize, DEFAULTS } = require("./main.js");
Module._load = originalLoad;
const { mermaidBlocks, parseMindmapSource, editMindmap, replaceMindmapBlock } = require("./main.js");
const PluginClass = require("./main.js");

/** 构造大量长标签、不同高度及四层子树，覆盖拥挤和深层情况。 */
function fixture() {
  let id = 0;
  const node = (children = [], wide = false) => ({ id: String(id++), width: wide ? 312 : 108 + id % 3 * 20, height: wide ? 92 : 44, children });
  const branches = Array.from({ length: 8 }, (_, branch) => node(Array.from({ length: 7 }, (_, index) => node(index === 2 ? [node([node([], true), node()]), node()] : [], index % 3 === 0)), branch % 2 === 0));
  return node(branches, true);
}

/** 所有节点必须可定位、互不覆盖，并完整位于导出边界内。 */
function verify(tree, options) {
  const { nodes, bounds } = computeLayout(tree, options);
  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i];
    assert.ok(Number.isFinite(a.x) && Number.isFinite(a.y));
    assert.ok(a.x - a.width / 2 >= bounds.x && a.x + a.width / 2 <= bounds.x + bounds.width);
    assert.ok(a.y - a.height / 2 >= bounds.y && a.y + a.height / 2 <= bounds.y + bounds.height);
    for (const b of nodes.slice(i + 1)) {
      const overlaps = Math.abs(a.x - b.x) < (a.width + b.width) / 2 - 0.01 && Math.abs(a.y - b.y) < (a.height + b.height) / 2 - 0.01;
      assert.equal(overlaps, false, `${options.layout}/${options.density}: ${a.id} overlaps ${b.id}`);
    }
  }
}

for (const layout of ["horizontal", "bilateral", "vertical", "compact"]) {
  for (const density of ["compact", "normal", "spacious"]) {
    verify(fixture(), { ...DEFAULTS, layout, density });
    verify({ id: "root", width: 312, height: 90, children: [] }, { ...DEFAULTS, layout, density });
  }
}
assert.equal(normalize({ layout: "invalid", fontSize: 100, maxWidth: -1 }).layout, DEFAULTS.layout);
assert.equal(normalize({ fontSize: 100 }).fontSize, 24);
assert.equal(normalize({ maxWidth: -1 }).maxWidth, 100);
console.log("Passed: 4 layouts x 3 densities, long labels, deep trees, single-node diagrams, no overlaps and valid bounds.");

// 写回检查覆盖重复名称、节点形状、注释、换行、分支删除和并发冲突。
const source = 'mindmap\r\n  root((中心))\r\n    分支一\r\n      相同名称\r\n      相同名称\r\n    分支二\r\n      子节点\r\n';
const markdown = '正文\r\n```mermaid\r\n' + source + '```\r\n后文\r\n';
const binding = mermaidBlocks(markdown)[0];
assert.equal(parseMindmapSource(source).nodes.length, 6);
const renamed = editMindmap(source, '3', 'rename', '新文字 (A) [B]');
assert.equal(parseMindmapSource(renamed.source).nodes[2].label, '相同名称');
assert.ok(renamed.source.includes('root((中心))'));
assert.ok(editMindmap(source, '0', 'rename', '新中心').source.includes('root(("新中心"))'));
const child = editMindmap(source, '1', 'child', '新增子节点');
assert.equal(parseMindmapSource(child.source).nodes[4].parent, '1');
assert.equal(child.remap['4'], '5');
assert.equal(child.selectedId, '4');
const sibling = editMindmap(source, '2', 'sibling', '新增同级');
assert.equal(parseMindmapSource(sibling.source).nodes[3].parent, '1');
const deleted = editMindmap(source, '1', 'delete');
assert.equal(parseMindmapSource(deleted.source).nodes.length, 3);
assert.equal(deleted.remap['4'], '1');
assert.equal(deleted.selectedId, '0');
assert.ok(!deleted.source.includes('分支一'));
assert.throws(() => editMindmap(source, '0', 'delete'));
assert.throws(() => editMindmap(source, '0', 'sibling', '第二中心'));
assert.throws(() => editMindmap(source, '1', 'rename', '文字\n注入'));
const updated = replaceMindmapBlock(markdown, binding, child.source);
assert.equal(updated, '正文\r\n```mermaid\r\n' + child.source + '```\r\n后文\r\n');
assert.equal(replaceMindmapBlock('新增正文\r\n' + updated, { ...binding, source: child.source }, source), '新增正文\r\n' + markdown);
assert.throws(() => replaceMindmapBlock(markdown.replace('分支一', '外部修改'), binding, renamed.source));
const duplicateDocument = markdown + markdown;
const duplicateBinding = { ...mermaidBlocks(duplicateDocument)[1], duplicateDocument };
assert.ok(replaceMindmapBlock(duplicateDocument, duplicateBinding, child.source).startsWith(markdown));
assert.throws(() => replaceMindmapBlock('插入正文\r\n' + duplicateDocument, duplicateBinding, child.source));
assert.equal(mermaidBlocks('````markdown\n```mermaid\n' + source + '```\n````\n' + markdown).length, 1);
assert.ok(editMindmap('mindmap\n root\n  child\n   ::icon(fa fa-book)\n  %% 保留注释\n  other\n', '1', 'delete').source.includes('%% 保留注释'));
assert.ok(!editMindmap('mindmap\n root\n  child\n   ::icon(fa fa-book)\n  other\n', '1', 'delete').source.includes('::icon'));
console.log("Passed: source sync, shapes, duplicate labels, add child/sibling, subtree deletion, CRLF, comments, conflict rejection and undo patch.");

// 按 Obsidian 的入口求值方式加载，只允许 obsidian 内置依赖。
const loaderModule = { exports: {} };
const loaderCalls = [];
const pluginFactory = vm.runInThisContext("(function(require,module,exports){" + fs.readFileSync(require.resolve("./main.js"), "utf8") + "\n})");
pluginFactory(name => { loaderCalls.push(name); if (name !== "obsidian") throw new Error("Unexpected external dependency: " + name); return { Plugin: class {}, PluginSettingTab: class {} }; }, loaderModule, loaderModule.exports);
assert.deepEqual(loaderCalls, ["obsidian"]);
assert.equal(typeof loaderModule.exports, "function");
assert.equal(typeof loaderModule.exports.editMindmap, "function");
console.log("Passed: Obsidian-style entry evaluation, no relative runtime modules.");

// 真实编辑器的 LF 与磁盘 CRLF 可以等价，但正文差异仍必须拒绝覆盖。
const guardPlugin = new PluginClass();
const editorView = { file: { path: "note.md" }, editor: { getValue: () => "正文\n第二行\n" } };
guardPlugin.app = { workspace: { iterateAllLeaves: callback => callback({ view: editorView }) } };
assert.doesNotThrow(() => guardPlugin.checkEditorContent("note.md", "正文\r\n第二行\r\n"));
assert.throws(() => guardPlugin.checkEditorContent("note.md", "正文\r\n已改变\r\n"));
assert.ok(!fs.readFileSync(require.resolve("./main.js"), "utf8").includes("engine.render("));
console.log("Passed: editor newline equivalence, dirty-buffer rejection, selected-node migration and parsing without Mermaid rendering.");

// 查看模式不拦截编辑键；保存进行中阻止重复修改，Shift+Tab 保留焦点导航。
const editKey = loaderModule.exports.MindmapView.prototype.handleEditKey;
let prevented = 0;
const keyEvent = { key: "Tab", target: { closest: () => null }, preventDefault: () => prevented++, stopPropagation: () => {} };
assert.equal(editKey.call({ editing: false }, keyEvent), false);
assert.equal(prevented, 0);
assert.equal(editKey.call({ editing: true, saving: true }, keyEvent), true);
assert.equal(prevented, 1);
assert.equal(editKey.call({ editing: true, saving: false }, { ...keyEvent, shiftKey: true }), false);
console.log("Passed: read-only keyboard behavior, saving guard and accessible Shift+Tab navigation.");

// 编辑器事务只修改节点差异，并保持围栏外的选区与正文，避免实时预览展开源码。
const { mindmapTransaction } = loaderModule.exports;
const liveMarkdown = markdown.replace(/\r\n/g, '\n'), liveBinding = { ...mermaidBlocks(liveMarkdown)[0], unique: true };
const liveChanged = replaceMindmapBlock(liveMarkdown, liveBinding, editMindmap(liveBinding.source, '1', 'rename', '新分支名称').source);
const tx = mindmapTransaction(liveMarkdown, liveChanged, [
  { anchor: { line: 4, ch: 3 }, head: { line: 4, ch: 5 } },
  { anchor: { line: 10, ch: 2 }, head: { line: 10, ch: 1 } }
], liveBinding);
assert.equal(tx.changes.length, 1);
assert.ok(tx.changes[0].text.length < liveBinding.source.length);
assert.deepEqual(tx.selections[0], { from: { line: 0, ch: 2 }, to: { line: 0, ch: 2 } });
assert.deepEqual(tx.selections[1], { from: { line: 10, ch: 2 }, to: { line: 10, ch: 1 } });
assert.equal(mindmapTransaction(liveMarkdown, liveMarkdown, [], liveBinding), null);
const addedLive = replaceMindmapBlock(liveMarkdown, liveBinding, editMindmap(liveBinding.source, '2', 'child', '新增').source);
const addTx = mindmapTransaction(liveMarkdown, addedLive, [{ anchor: { line: 10, ch: 1 } }], liveBinding);
assert.deepEqual(addTx.selections[0], { from: { line: 11, ch: 1 }, to: { line: 11, ch: 1 } });
const startFence = '```mermaid\n' + liveBinding.source + '```\n后文\n';
const startBinding = { ...mermaidBlocks(startFence)[0], unique: true };
const startTx = mindmapTransaction(startFence, replaceMindmapBlock(startFence, startBinding, editMindmap(startBinding.source, '1', 'rename', '新').source), [{ anchor: { line: 2, ch: 0 } }], startBinding);
assert.equal(startTx.selections[0].from.line, 9);
console.log("Passed: minimal live-editor transactions, fence-safe cursors, backwards selections, line shifts and note-start diagrams.");

// 选择原生 SVG 所属的源码编辑器，阅读模式及其他笔记不得误写。
const liveEditor = { transaction() {}, listSelections() {} };
guardPlugin.views = new Map();
editorView.editor = liveEditor; editorView.containerEl = { contains: svg => svg === 'current-svg' }; editorView.getMode = () => 'source';
assert.equal(guardPlugin.findSourceEditor('current-svg', 'note.md'), liveEditor);
assert.equal(guardPlugin.findSourceEditor('other-svg', 'note.md'), undefined);
assert.equal(guardPlugin.findSourceEditor('current-svg', 'other.md'), undefined);
editorView.getMode = () => 'preview';
assert.equal(guardPlugin.findSourceEditor('current-svg', 'note.md'), undefined);
console.log("Passed: Live Preview editor ownership, wrong-note rejection and reading-mode fallback.");

// 原生 SVG 被重建后，异步保存仍需找到同一编辑会话及所属编辑器。
const oldSvg = {}, newSvg = {}, preservedView = { sourceView: editorView };
guardPlugin.viewOwners = new WeakMap([[oldSvg, preservedView]]); guardPlugin.views.set(newSvg, preservedView);
editorView.getMode = () => 'source';
assert.equal(guardPlugin.getView(oldSvg), preservedView);
assert.equal(guardPlugin.getView(newSvg), preservedView);
assert.equal(guardPlugin.findSourceEditor(oldSvg, 'note.md'), liveEditor);
assert.equal(guardPlugin.findSourceEditor(oldSvg, 'other.md'), undefined);
console.log("Passed: native SVG replacement preserves editor-session ownership for asynchronous saves.");
