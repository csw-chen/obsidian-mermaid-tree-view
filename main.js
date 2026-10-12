const { Plugin, PluginSettingTab, Setting, Notice, loadMermaid } = require("obsidian");
/* author: csw。脑图编辑只更新目标 Mermaid 块，保留笔记其他内容。 */

// 形状分隔符按长度匹配，防止圆形或云形被识别成普通括号。
const SHAPES = [["((", "))"], ["{{", "}}"], [")", "("], ["))", "(("], ["[", "]"], ["(", ")"]].sort((a, b) => b[0].length - a[0].length);
// 使用命名实体，避免 Mermaid 对 #数字; 的预处理干扰 HTML 数字实体。
const LABEL_ENTITIES = { "&": "amp", "<": "lt", ">": "gt", '"': "quot", "'": "apos", "[": "lsqb", "]": "rsqb", "(": "lpar", ")": "rpar", "{": "lcub", "}": "rcub", ":": "colon", "#": "num" };

/** 按 Markdown 围栏读取块，跳过嵌套在其他代码块中的示例。 */
function mermaidBlocks(markdown) {
  const blocks = []; let fence = null;
  for (const match of markdown.matchAll(/[^\r\n]*(?:\r\n|\n|\r|$)/g)) {
    if (!match[0]) continue;
    const line = match[0].replace(/[\r\n]+$/, ""), opening = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)$/.exec(line);
    if (!fence && opening) {
      fence = { marker: opening[1][0], length: opening[1].length, mermaid: opening[2].trim() === "mermaid", start: match.index + match[0].length, line: markdown.slice(0, match.index).split(/\r\n|\n|\r/).length - 1 };
    } else if (fence && new RegExp(`^ {0,3}${fence.marker === "`" ? "`" : "~"}{${fence.length},}\\s*$`).test(line)) {
      if (fence.mermaid) blocks.push({ start: fence.start, end: match.index, line: fence.line, source: markdown.slice(fence.start, match.index) });
      fence = null;
    }
  }
  return blocks;
}

/** 保留每行位置、节点形状与父子关系；复杂多行标签交由源码编辑。 */
function parseMindmapSource(source) {
  const nodes = []; const stack = []; let started = false;
  for (const match of source.matchAll(/[^\r\n]*(?:\r\n|\n|\r|$)/g)) {
    if (!match[0]) continue;
    const line = match[0].replace(/[\r\n]+$/, ""), body = line.trim();
    if (!body || body.startsWith("%%")) continue;
    if (!started) { if (body === "mindmap") { started = true; continue; } return null; }
    if (body.startsWith("::")) { if (!nodes.length) return null; nodes.at(-1).decorators.push({ start: match.index, end: match.index + match[0].length }); continue; }
    const indent = /^ */.exec(line)[0]; if (/\t/.test(line) || body.includes("`")) return null;
    let shape = null, prefix = "", label = body;
    for (const [open, close] of SHAPES) {
      const at = body.indexOf(open);
      if (at >= 0 && body.endsWith(close) && /^[^\s[\](){}]*$/.test(body.slice(0, at))) {
        shape = [open, close]; prefix = body.slice(0, at); label = body.slice(at + open.length, -close.length); break;
      }
    }
    if (!shape && /[\[\](){}]/.test(body)) return null;
    if (label.startsWith('"') && label.endsWith('"')) label = label.slice(1, -1);
    while (stack.length && stack.at(-1).indent.length >= indent.length) stack.pop();
    const parent = stack.at(-1), node = { id: String(nodes.length), label, prefix, shape, indent, parent: parent?.id, start: match.index, end: match.index + match[0].length, eol: match[0].slice(line.length), decorators: [] };
    if (nodes.length && !parent) return null;
    nodes.push(node); stack.push(node);
  }
  return started && nodes.length ? { nodes, eol: source.includes("\r\n") ? "\r\n" : "\n" } : null;
}

/** 用最小文本差异更新编辑器，选区落在图内时移到围栏外，避免展开源码。 */
function mindmapTransaction(before, after, selections, binding) {
  if (before === after) return null;
  let start = 0, end = before.length, nextEnd = after.length;
  while (start < end && start < nextEnd && before[start] === after[start]) start++;
  while (end > start && nextEnd > start && before[end - 1] === after[nextEnd - 1]) { end--; nextEnd--; }
  const position = (text, offset) => { const lines = text.slice(0, offset).split("\n"); return { line: lines.length - 1, ch: lines.at(-1).length }; };
  const offset = pos => { const lines = before.split("\n"); return lines.slice(0, pos.line).reduce((total, line) => total + line.length + 1, 0) + pos.ch; };
  const block = mermaidBlocks(before).find(value => value.source === binding.source && (binding.unique || value.line === binding.line));
  if (!block) throw new Error("脑图源码已改变，请重新选择节点。");
  const opening = before.lastIndexOf("\n", block.start - 2) + 1;
  const closing = before.indexOf("\n", block.end);
  const fenceEnd = closing < 0 ? before.length : closing;
  const safe = opening > 0 ? opening - 1 : Math.min(before.length, fenceEnd + 1);
  const map = value => value <= start ? value : value >= end ? value + nextEnd - end : nextEnd;
  const ranges = selections.map(selection => {
    const anchor = offset(selection.anchor), head = offset(selection.head || selection.anchor);
    const intersects = Math.min(anchor, head) <= fenceEnd && Math.max(anchor, head) >= opening;
    return { from: position(after, map(intersects ? safe : anchor)), to: position(after, map(intersects ? safe : head)) };
  });
  return { changes: [{ from: position(before, start), to: position(before, end), text: after.slice(start, nextEnd) }], selections: ranges };
}

/** 编码 Mermaid 语法字符和 HTML，普通节点可以保留默认形状。 */
function encodeLabel(text) {
  const value = text.trim();
  if (!value || /[\r\n\t`\u0000]/.test(value)) throw new Error("节点文字不能为空，也不能包含换行、制表符或反引号。");
  return value.replace(/[&<>"'\[\](){}:#]/g, character => `&${LABEL_ENTITIES[character]};`);
}

/** 生成单次修改后的源码及旧节点到新节点的映射，供折叠设置迁移。 */
function editMindmap(source, id, action, text) {
  const parsed = parseMindmapSource(source), node = parsed?.nodes.find(value => value.id === String(id));
  if (!node) throw new Error("无法准确定位节点，请刷新脑图后重试。");
  const index = parsed.nodes.indexOf(node); let next = index + 1;
  while (next < parsed.nodes.length && parsed.nodes[next].indent.length > node.indent.length) next++;
  const end = parsed.nodes[next]?.start ?? source.length, removed = new Set(), remap = {};
  let result = source;
  if (action === "rename") {
    const value = encodeLabel(text), label = node.shape ? `${node.prefix}${node.shape[0]}"${value}"${node.shape[1]}` : value;
    result = source.slice(0, node.start) + node.indent + label + node.eol + source.slice(node.end);
  } else if (action === "child" || action === "sibling") {
    if (action === "sibling" && node.parent === undefined) throw new Error("中心节点不能新增同级节点，请新增子节点。");
    const differences = parsed.nodes.filter(value => value.parent !== undefined).map(value => value.indent.length - parsed.nodes[Number(value.parent)].indent.length);
    const step = Math.min(...differences, 2), child = parsed.nodes[index + 1];
    const indent = action === "sibling" ? node.indent : child?.parent === node.id ? child.indent : node.indent + " ".repeat(step);
    const line = indent + encodeLabel(text) + parsed.eol;
    result = source.slice(0, end) + (end && !/[\r\n]$/.test(source.slice(0, end)) ? parsed.eol : "") + line + source.slice(end);
  } else if (action === "delete") {
    if (node.parent === undefined) throw new Error("中心节点不能删除。可以修改它的文字。");
    const ranges = [];
    for (const value of parsed.nodes.slice(index, next)) { removed.add(value.id); ranges.push({ start: value.start, end: value.end }, ...value.decorators); }
    for (const range of ranges.sort((a, b) => b.start - a.start)) result = result.slice(0, range.start) + result.slice(range.end);
  } else throw new Error("不支持的脑图编辑操作。");
  const insertedAt = action === "child" || action === "sibling" ? next : -1;
  let position = 0;
  parsed.nodes.forEach((value, old) => { if (removed.has(value.id)) return; if (old === insertedAt) position++; remap[value.id] = String(position++); });
  return { source: result, remap, selectedId: insertedAt >= 0 ? String(insertedAt) : action === "delete" ? remap[node.parent] : remap[node.id] };
}

/** 定位唯一原块再替换；源块冲突时拒绝覆盖，正文其他修改可以保留。 */
function replaceMindmapBlock(markdown, binding, replacement) {
  const blocks = mermaidBlocks(markdown).filter(block => block.source === binding.source);
  if (blocks.length > 1 && markdown !== binding.duplicateDocument) throw new Error("笔记中的重复脑图或位置已变化，请刷新后重试。");
  const block = blocks.length === 1 ? blocks[0] : blocks.find(value => value.line === binding.line);
  if (!block) throw new Error("该脑图源码已变化或无法唯一定位，请刷新后重试。");
  return markdown.slice(0, block.start) + replacement + markdown.slice(block.end);
}

// 创建 SVG 与可保留原标签链接的 XHTML 元素。
const SVG_NS = "http://www.w3.org/2000/svg";
const HTML_NS = "http://www.w3.org/1999/xhtml";
// 工具栏选项兼作持久化配置的有效值边界。
const LAYOUTS = { auto: "自动适配", horizontal: "横向展开", bilateral: "左右展开", vertical: "纵向树形", compact: "紧凑分列" };
const STYLES = { capsule: "彩色胶囊", cards: "柔彩卡片", outline: "清透描边", branches: "线条脑图" };
const PALETTES = {
  garden: { name: "花园", colors: ["#39a889", "#9270db", "#4c94dc", "#a0b93a", "#de9360", "#dc7296"] },
  ocean: { name: "海岸", colors: ["#168e91", "#3988c9", "#737dc3", "#4caa99", "#d39251", "#b775a5"] },
  autumn: { name: "秋日", colors: ["#b86d43", "#bc9140", "#7f964f", "#ae627a", "#718aaa", "#9978ac"] },
  candy: { name: "糖果", colors: ["#dd7b9c", "#9378d1", "#548fcd", "#52aa99", "#c4a34c", "#de926e"] }
};
// 默认使用彩色胶囊，自动布局选择适合笔记宽度的方向。
const DEFAULTS = { layout: "auto", style: "capsule", palette: "garden", density: "normal", fontSize: 15, maxWidth: 190, levelGap: 70, siblingGap: 18, height: 640, background: "dots", connector: "curve" };
// 密度只调整间距；缩放边界避免画面无限缩小或放大。
const DENSITIES = { compact: 0.7, normal: 1, spacious: 1.4 };
const ZOOM = { min: 0.08, max: 4 };
// 当前插件会话内保留最近 20 次内容修改，撤销仅替换对应 Mermaid 块。
const EDIT_HISTORY_LIMIT = 20;

/** 校验保存配置，并限制可调数值的范围。 */
function normalize(value = {}) {
  const result = { ...DEFAULTS, ...value };
  for (const [key, choices] of Object.entries({ layout: LAYOUTS, style: STYLES, palette: PALETTES, density: DENSITIES, background: { dots: 1, plain: 1 }, connector: { curve: 1, elbow: 1 } })) {
    if (!Object.hasOwn(choices, result[key])) result[key] = DEFAULTS[key];
  }
  for (const [key, min, max] of [["fontSize", 12, 24], ["maxWidth", 100, 320], ["levelGap", 24, 160], ["siblingGap", 8, 64], ["height", 300, 1000]]) result[key] = Math.max(min, Math.min(max, Number(result[key]) || DEFAULTS[key]));
  return result;
}

/** 完整读取原生树关系；无法识别时保留原生 SVG。 */
function readMindmap(svg) {
  const nodes = new Map();
  for (const element of svg.querySelectorAll(".mindmap-node")) {
    const id = /^node_(\d+)$/.exec(element.id)?.[1], label = element.querySelector(":scope > .label");
    if (!id || !label) return null;
    nodes.set(id, { id, text: element.textContent.trim(), html: label.querySelector("foreignObject > div"), children: [] });
  }
  const edges = [...svg.querySelectorAll("path.edge")];
  if (!nodes.size || edges.length !== nodes.size - 1) return null;
  for (const edge of edges) {
    const match = /^edge_(\d+)_(\d+)$/.exec(edge.id), parent = match && nodes.get(match[1]), child = match && nodes.get(match[2]);
    if (!parent || !child || child.parent) return null;
    child.parent = parent; parent.children.push(child);
  }
  const roots = [...nodes.values()].filter(node => !node.parent), visited = new Set();
  if (roots.length !== 1) return null;
  const visit = node => { if (visited.has(node)) return false; visited.add(node); return node.children.every(visit); };
  if (!visit(roots[0]) || visited.size !== nodes.size) return null;
  return { root: roots[0], nodes: [...nodes.values()] };
}

/** 先计算子树尺寸再放置节点，适配深层结构和换行标签。 */
function computeLayout(root, options) {
  const gap = options.siblingGap * DENSITIES[options.density], level = options.levelGap * DENSITIES[options.density], nodes = [];
  const collect = (node, depth = 0, branch = 0) => {
    node.depth = depth; node.branch = branch; nodes.push(node);
    node.children.forEach((child, index) => collect(child, depth + 1, depth === 0 ? index : branch));
  };
  collect(root);
  if (options.layout === "compact") {
    const widthOf = (node, depth = 0) => Math.max(node.width + depth * 24, ...node.children.map(child => widthOf(child, depth + 1)));
    const columns = root.children.map(node => ({ node, width: widthOf(node) }));
    const total = Math.max(root.width, columns.reduce((sum, col) => sum + col.width, 0) + Math.max(0, columns.length - 1) * (gap + 16));
    root.x = total / 2; root.y = root.height / 2;
    let left = 0;
    for (const col of columns) {
      col.node.x = left + col.width / 2; col.node.y = root.height + level + col.node.height / 2;
      let top = col.node.y + col.node.height / 2 + gap + 12;
      const place = (node, depth) => { node.x = left + depth * 24 + node.width / 2; node.y = top + node.height / 2; top += node.height + gap; node.children.forEach(child => place(child, depth + 1)); };
      col.node.children.forEach(child => place(child, 1)); left += col.width + gap + 16;
    }
  } else if (options.layout === "vertical") {
    const heights = [];
    nodes.forEach(node => { heights[node.depth] = Math.max(heights[node.depth] || 0, node.height); });
    const measure = node => { node.span = Math.max(node.width, node.children.reduce((sum, child) => sum + measure(child), 0) + Math.max(0, node.children.length - 1) * gap); return node.span; };
    measure(root);
    const place = (node, left, y) => {
      node.x = left + node.span / 2; node.y = y;
      const sum = node.children.reduce((value, child) => value + child.span, 0) + Math.max(0, node.children.length - 1) * gap;
      let next = node.x - sum / 2;
      node.children.forEach(child => { place(child, next, y + heights[node.depth] / 2 + level + heights[node.depth + 1] / 2); next += child.span + gap; });
    };
    place(root, 0, root.height / 2);
  } else {
    const widths = [];
    nodes.forEach(node => { widths[node.depth] = Math.max(widths[node.depth] || 0, node.width); });
    const measure = node => { node.span = Math.max(node.height, node.children.reduce((sum, child) => sum + measure(child), 0) + Math.max(0, node.children.length - 1) * gap); return node.span; };
    measure(root); root.x = 0; root.y = 0;
    const place = (node, x, top, side) => {
      node.x = x; node.y = top + node.span / 2; node.side = side;
      const sum = node.children.reduce((value, child) => value + child.span, 0) + Math.max(0, node.children.length - 1) * gap;
      let next = node.y - sum / 2;
      node.children.forEach(child => { place(child, x + side * (widths[node.depth] / 2 + level + widths[node.depth + 1] / 2), next, side); next += child.span + gap; });
    };
    const right = [], left = []; let rightSize = 0, leftSize = 0;
    root.children.forEach(child => {
      if (options.layout === "bilateral" && leftSize < rightSize) { left.push(child); leftSize += child.span + gap; }
      else { right.push(child); rightSize += child.span + gap; }
    });
    for (const [children, side] of [[right, 1], [left, -1]]) {
      let top = -(children.reduce((sum, child) => sum + child.span, 0) + Math.max(0, children.length - 1) * gap) / 2;
      children.forEach(child => { place(child, side * (root.width / 2 + level + widths[1] / 2), top, side); top += child.span + gap; });
    }
  }
  const x = Math.min(...nodes.map(node => node.x - node.width / 2)) - 32, y = Math.min(...nodes.map(node => node.y - node.height / 2)) - 32;
  const right = Math.max(...nodes.map(node => node.x + node.width / 2)) + 32, bottom = Math.max(...nodes.map(node => node.y + node.height / 2)) + 32;
  return { nodes, bounds: { x, y, width: right - x, height: bottom - y } };
}

/** 同一笔记内的图恢复各自设置，原文无需写入展示元数据。 */
function diagramKey(model, path) {
  const source = path + JSON.stringify(model.nodes.map(node => [node.id, node.text, node.parent?.id]));
  let hash = 2166136261;
  for (const character of source) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return (hash >>> 0).toString(16);
}

/** 将已验证的缩进源码直接转成查看器模型，复用未改动标签的 HTML。 */
function modelFromSource(source, doc, previous, remap = {}) {
  const parsed = parseMindmapSource(source); if (!parsed) throw new Error("脑图格式无法识别，修改尚未保存。");
  const old = new Map(previous?.nodes.map(node => [node.id, node]) || []), reverse = new Map(Object.entries(remap).map(([before, after]) => [after, before]));
  const nodes = parsed.nodes.map(node => {
    const template = doc.createElement("template"); template.innerHTML = node.label;
    const text = template.content.textContent.trim(), original = old.get(reverse.get(node.id) ?? node.id);
    return { id: node.id, text, html: original?.text === text ? original.html : null, children: [] };
  });
  parsed.nodes.forEach((sourceNode, index) => { if (sourceNode.parent !== undefined) { const parent = nodes[Number(sourceNode.parent)]; nodes[index].parent = parent; parent.children.push(nodes[index]); } });
  return { root: nodes[0], nodes };
}

/** 创建 SVG 元素，属性来源于校验后的几何和配色。 */
function svgElement(doc, tag, attributes = {}) {
  const element = doc.createElementNS(SVG_NS, tag);
  Object.entries(attributes).forEach(([name, value]) => element.setAttribute(name, String(value)));
  return element;
}

/** 仅美化原生流程图和 ER 图，保留节点几何、关系标记及现有查看功能。 */
function styleNativeDiagram(svg) {
  if (!svg.id || svg.classList.contains("mtv-svg")) return null;
  const er = svg.classList.contains("erDiagram") || svg.getAttribute("aria-roledescription") === "er";
  const selector = `#${svg.ownerDocument.defaultView.CSS.escape(svg.id)}.mtv-native`;
  const style = svgElement(svg.ownerDocument, "style", { "data-mtv-native-style": "true" });
  // 使用专用变量与较高选择器优先级，避免 Slick Mermaid 的灰色主题再次覆盖。
  const rules = [
    ["", 'font-family:"Microsoft YaHei UI","Microsoft YaHei",sans-serif!important;'],
    [" text, & tspan, & foreignObject *", 'font-family:"Microsoft YaHei UI","Microsoft YaHei",sans-serif!important;font-size:14px!important;color:var(--mtv-native-text)!important;fill:var(--mtv-native-text)!important;'],
    [" .edgeLabel foreignObject *, & .edgeLabel rect", "background:var(--mtv-native-paper)!important;fill:var(--mtv-native-paper)!important;"],
    [" .flowchart-link, & .relationshipLine", "stroke:var(--mtv-native-line)!important;stroke-width:1.4px!important;"],
    [" marker path, & marker circle, & marker line", "stroke:var(--mtv-native-line)!important;"],
    [" foreignObject p", "margin:0!important;"]
  ];
  if (er) rules.push(
    // ER 的零基数圆圈与乌鸦脚保持空心，通用箭头填色不适用于这些符号。
    [" marker path", "fill:none!important;"],
    [" marker circle", "fill:var(--mtv-native-paper)!important;"],
    [" .node > g:first-child > path:first-child, & .entityBox", "fill:var(--mtv-native-heading)!important;"],
    [" .row-rect-odd > path:first-child, & .attributeBoxOdd", "fill:var(--mtv-native-paper)!important;"],
    [" .row-rect-even > path:first-child, & .attributeBoxEven", "fill:var(--mtv-native-row)!important;"],
    [" .node > g > path[fill=none], & .divider path, & .entityBox, & .attributeBoxOdd, & .attributeBoxEven", "stroke:var(--mtv-native-border)!important;stroke-width:1px!important;"],
    [" .name foreignObject *, & .entityLabel", "color:var(--mtv-native-heading-text)!important;fill:var(--mtv-native-heading-text)!important;font-size:14px!important;font-weight:600!important;"],
    [" .attribute-type foreignObject *, & .attribute-comment foreignObject *", "color:var(--mtv-native-muted)!important;fill:var(--mtv-native-muted)!important;font-size:13px!important;"],
    [" .attribute-name foreignObject *", 'font-family:Consolas,"Microsoft YaHei",monospace!important;font-size:13px!important;'],
    [" .attribute-keys foreignObject *", "color:var(--mtv-native-key)!important;fill:var(--mtv-native-key)!important;font-size:13px!important;font-weight:600!important;"]
  );
  else rules.push(
    [" marker path:not([fill=none])", "fill:var(--mtv-native-line)!important;"],
    [" .node > rect, & .node > polygon, & .node > circle, & .node > ellipse, & .node > path, & .node > g.label-container > path:first-child", "fill:var(--mtv-native-node)!important;stroke:var(--mtv-native-node-border)!important;stroke-width:1.3px!important;"],
    [" .node > rect", "rx:9px;ry:9px;"],
    [" .label foreignObject > div", "display:flex!important;align-items:center!important;justify-content:center!important;width:100%!important;height:100%!important;"],
    [" .node > polygon", "fill:var(--mtv-native-decision)!important;stroke:var(--mtv-native-decision-border)!important;"],
    [" .nodes > .node:first-child > rect", "fill:var(--mtv-native-heading)!important;stroke:var(--mtv-native-heading)!important;"],
    [" .nodes > .node:first-child:has(> rect) .label foreignObject *, & .nodes > .node:first-child:has(> rect) .label text", "color:var(--mtv-native-heading-text)!important;fill:var(--mtv-native-heading-text)!important;font-weight:600!important;"]
  );
  style.textContent = rules.map(([suffix, body]) => `${selector}${suffix.replaceAll("&", selector)}{${body}}`).join("\n");
  svg.classList.add("mtv-native", er ? "mtv-er-style" : "mtv-flow-style");
  svg.append(style);
  return () => {
    style.remove(); svg.classList.remove("mtv-native", "mtv-er-style", "mtv-flow-style");
  };
}

/** 独立查看区域保留原生 SVG，避免美化插件覆盖当前节点。 */
class MindmapView {
  constructor(original, model, options, saved, onChange, editor) {
    this.original = original; this.model = model; this.options = normalize(options); this.onChange = onChange; this.editor = editor;
    this.nodeMap = new Map(model.nodes.map(node => [node.id, node])); this.measureCache = new Map(); this.nodeElements = new Map(); this.editing = false;
    this.folded = new Set(Array.isArray(saved?.folded) ? saved.folded : []); this.doc = original.ownerDocument;
    this.abort = new this.doc.defaultView.AbortController();
    this.root = this.doc.createElement("section"); this.root.className = "mtv-view"; this.root.setAttribute("aria-label", "脑图查看器");
    original.parentElement.insertBefore(this.root, original); this.originalStyle = original.style.display; original.style.display = "none";
    this.host = original.closest(".mermaid, .mermaid-preview"); this.host?.classList.add("mtv-host");
    this.toolbar = this.doc.createElement("div"); this.toolbar.className = "mtv-toolbar"; this.root.append(this.toolbar);
    this.stage = this.doc.createElement("div"); this.stage.className = "mtv-stage"; this.stage.tabIndex = 0; this.stage.setAttribute("aria-label", "脑图画布，拖动平移，Ctrl 加滚轮缩放");
    this.svg = svgElement(this.doc, "svg", { class: "mtv-svg", role: "img", "aria-label": model.root.text }); this.stage.append(this.svg); this.root.append(this.stage);
    this.footer = this.doc.createElement("div"); this.footer.className = "mtv-footer"; this.root.append(this.footer);
    this.createToolbar(); this.bindInteraction(); this.bindNodeInteraction();
    this.resize = new this.doc.defaultView.ResizeObserver(() => {
      const width = this.stage.clientWidth;
      this.stageSize = { width: width || 900, height: this.stage.clientHeight || this.options.height };
      if (this.options.layout === "auto" && this.lastWidth && Math.abs(width - this.lastWidth) > 4) {
        if (this.resizeFrame) this.doc.defaultView.cancelAnimationFrame(this.resizeFrame);
        this.resizeFrame = this.doc.defaultView.requestAnimationFrame(() => { this.resizeFrame = 0; this.render(true); });
      }
      else if (this.autoFit) this.fit(); else this.updateCamera();
      this.lastWidth = width; this.syncInlineLayer();
    }); this.resize.observe(this.stage); this.resize.observe(this.root);
    this.render();
  }

  /** 用终止信号统一移除页面和文档监听器。 */
  listen(element, name, handler, options = {}) { element.addEventListener(name, handler, { ...options, signal: this.abort.signal }); }

  /** 单图控制栏与更多选项均自动保存。 */
  createToolbar() {
    const appearance = this.doc.createElement("div"); appearance.className = "mtv-appearance"; this.toolbar.append(appearance);
    const select = (key, name, choices) => {
      const label = this.doc.createElement("label"); label.className = "mtv-control";
      const caption = this.doc.createElement("span"); caption.textContent = name;
      const input = this.doc.createElement("select"); input.setAttribute("aria-label", name);
      Object.entries(choices).forEach(([value, title]) => { const option = this.doc.createElement("option"); option.value = value; option.textContent = title; input.append(option); });
      input.value = this.options[key]; this.listen(input, "change", () => { this.options[key] = input.value; this.save(); this.render(); });
      label.append(caption, input); appearance.append(label);
    };
    select("layout", "方向", LAYOUTS); select("style", "样式", STYLES);
    select("palette", "配色", Object.fromEntries(Object.entries(PALETTES).map(([key, value]) => [key, value.name])));
    select("density", "间距", { compact: "紧凑", normal: "标准", spacious: "舒展" });
    const tools = this.doc.createElement("div"); tools.className = "mtv-actions"; this.toolbar.append(tools);
    const button = (text, title, action) => {
      const element = this.doc.createElement("button"); element.type = "button"; element.textContent = text; element.title = title; element.setAttribute("aria-label", title);
      this.listen(element, "click", action); tools.append(element); return element;
    };
    button("−", "缩小", () => this.zoom(0.8));
    this.zoomLabel = button("100%", "原始尺寸", () => { this.scale = 1; this.autoFit = false; this.updateCamera(); });
    button("+", "放大", () => this.zoom(1.25)); button("适应", "适应窗口", () => this.fit());
    button("展开", "展开全部分支", () => { this.folded.clear(); this.save(); this.render(); });
    button("收起", "收起到主分支", () => { this.folded = new Set(this.model.root.children.filter(node => node.children.length).map(node => node.id)); this.save(); this.render(); });
    button("更多", "更多显示设置", () => { this.details.hidden = !this.details.hidden; });
    this.fullButton = button("全屏", "全屏查看", () => this.toggleFullscreen()); button("导出", "导出 SVG", () => this.exportSvg());
    if (this.editor) {
      this.editToggle = button("", "编辑脑图", () => this.toggleEditing()); this.editToggle.className = "mtv-edit-toggle"; this.editToggle.setAttribute("aria-pressed", "false");
      const icon = svgElement(this.doc, "svg", { viewBox: "0 0 24 24", width: 16, height: 16, "aria-hidden": "true" });
      icon.append(svgElement(this.doc, "path", { d: "M16 3a2.1 2.1 0 0 1 3 3L8 17l-4 1 1-4L16 3z M14 5l3 3 M4 21h16", fill: "none", stroke: "currentColor", "stroke-width": 1.8, "stroke-linejoin": "round", "stroke-linecap": "round" }));
      this.editToggle.append(icon); this.toolbar.append(this.editToggle); this.createEditBar();
    }
    this.details = this.doc.createElement("div"); this.details.className = "mtv-details"; this.details.hidden = true; this.toolbar.after(this.details);
    const range = (key, name, min, max, step) => {
      const label = this.doc.createElement("label"), caption = this.doc.createElement("span"), input = this.doc.createElement("input");
      input.type = "range"; input.min = min; input.max = max; input.step = step; input.value = this.options[key]; input.setAttribute("aria-label", name);
      const update = () => { caption.textContent = `${name} ${this.options[key]}`; }; update();
      this.listen(input, "change", () => { this.options[key] = Number(input.value); update(); this.save(); this.render(); }); label.append(caption, input); this.details.append(label);
    };
    range("fontSize", "字号", 12, 24, 1); range("maxWidth", "节点宽度", 100, 320, 10); range("levelGap", "层级距离", 24, 160, 4); range("siblingGap", "节点距离", 8, 64, 2); range("height", "画布高度", 300, 1000, 20);
    const checkbox = (name, checked, action) => {
      const label = this.doc.createElement("label"), input = this.doc.createElement("input"); input.type = "checkbox"; input.checked = checked;
      this.listen(input, "change", () => { action(input.checked); this.save(); this.render(); }); label.append(input, this.doc.createTextNode(name)); this.details.append(label);
    };
    checkbox("点阵背景", this.options.background === "dots", value => { this.options.background = value ? "dots" : "plain"; });
    checkbox("直角连线", this.options.connector === "elbow", value => { this.options.connector = value ? "elbow" : "curve"; });
    this.search = this.doc.createElement("input"); this.search.type = "search"; this.search.placeholder = "查找节点…"; this.search.setAttribute("aria-label", "查找节点");
    this.listen(this.search, "input", () => this.highlight()); this.listen(this.search, "keydown", event => { if (event.key === "Enter") this.focusMatch(); }); this.details.append(this.search);
  }

  /** 批量测量未缓存标签；先统一写入再统一读取，避免逐节点强制布局。 */
  measureNodes(sources) {
    const signature = `${this.options.fontSize}/${this.options.maxWidth}`;
    if (this.measureSignature !== signature) { this.measureCache.clear(); this.measureSignature = signature; }
    const measure = this.doc.createElement("div"); measure.className = "mtv-measure";
    const missing = [], keys = new Map();
    for (const source of sources) {
      const main = !source.parent || !source.parent.parent, key = `${main}/${source.text}/${source.html?.innerHTML || ""}`; keys.set(source.id, key);
      if (this.measureCache.has(key)) continue;
      const content = source.html ? source.html.cloneNode(true) : this.doc.createElementNS(HTML_NS, "div");
      if (!source.html) content.textContent = source.text;
      content.className = "mtv-label"; content.removeAttribute("style"); content.querySelectorAll("[style]").forEach(element => element.removeAttribute("style"));
      content.style.fontWeight = main ? "600" : "400";
      const box = this.doc.createElement("div"); box.style.width = "max-content"; box.style.maxWidth = `${this.options.maxWidth}px`; box.append(content); measure.append(box);
      const entry = { content }; this.measureCache.set(key, entry); missing.push(entry);
    }
    if (missing.length) {
      this.root.append(measure);
      const widths = missing.map(entry => Math.ceil(Math.min(this.options.maxWidth, entry.content.getBoundingClientRect().width || this.options.maxWidth)));
      missing.forEach((entry, index) => { entry.labelWidth = widths[index]; entry.content.style.width = `${widths[index]}px`; });
      const heights = missing.map(entry => Math.ceil(entry.content.getBoundingClientRect().height || this.options.fontSize * 1.5));
      missing.forEach((entry, index) => { entry.labelHeight = heights[index]; entry.content.remove(); }); measure.remove();
    }
    return new Map(sources.map(source => { const entry = this.measureCache.get(keys.get(source.id)); return [source.id, { ...source, content: entry.content.cloneNode(true), labelWidth: entry.labelWidth, labelHeight: entry.labelHeight, width: entry.labelWidth + 32, height: entry.labelHeight + 20, children: [] }]; }));
  }

  /** 由原生标签重建独立画面，折叠和改样式不改变笔记。 */
  render(preserveCamera = false) {
    this.stage.style.height = `${this.options.height}px`; this.stage.dataset.background = this.options.background; this.root.style.setProperty("--mtv-font-size", `${this.options.fontSize}px`);
    const visible = []; const collect = source => { visible.push(source); if (!this.folded.has(source.id)) source.children.forEach(collect); }; collect(this.model.root);
    const measured = this.measureNodes(visible);
    const clone = source => { const node = measured.get(source.id); node.children = this.folded.has(source.id) ? [] : source.children.map(clone); return node; };
    const tree = clone(this.model.root);
    const keepDirection = preserveCamera && this.editing && this.options.layout === "auto" && this.effectiveLayout;
    this.effectiveLayout = keepDirection || this.options.layout;
    // 自动选择当前窗口中能以最大字号看全的布局，手动方向始终优先。
    if (this.options.layout === "auto" && !keepDirection) {
      let best = -Infinity;
      for (const direction of ["bilateral", "horizontal", "compact", "vertical"]) {
        const candidate = computeLayout(tree, { ...this.options, layout: direction });
        const score = Math.min((this.stage.clientWidth || 900) / candidate.bounds.width, this.options.height / candidate.bounds.height);
        if (score > best) { best = score; this.effectiveLayout = direction; }
      }
    }
    const layout = computeLayout(tree, { ...this.options, layout: this.effectiveLayout }); this.bounds = layout.bounds; this.positions = new Map(layout.nodes.map(node => [node.id, node])); this.nodeElements.clear();
    const fragment = this.doc.createDocumentFragment();
    const title = svgElement(this.doc, "title"); title.textContent = this.model.root.text; fragment.append(title);
    const colors = PALETTES[this.options.palette].colors;
    for (const parent of layout.nodes) for (const child of parent.children) fragment.append(svgElement(this.doc, "path", { class: "mtv-edge", d: this.edgePath(parent, child), fill: "none", stroke: colors[child.branch % colors.length], "stroke-width": parent.depth === 0 ? 2.2 : 1.6 }));
    for (const node of layout.nodes) {
      const color = node.depth === 0 ? colors[0] : colors[node.branch % colors.length], main = node.depth < 2;
      const solid = main && ["capsule", "cards"].includes(this.options.style), dark = this.doc.body.classList.contains("theme-dark"), surface = dark ? "#202632" : "#ffffff";
      const group = svgElement(this.doc, "g", { class: "mtv-node", "data-node-id": node.id, transform: `translate(${node.x},${node.y})` });
      // 由专用变量控制文字，避免通用 Mermaid 美化插件覆盖主分支的白字。
      group.style.setProperty("--mtv-node-color", solid ? "#ffffff" : dark ? "#e2e8f0" : "#273649");
      group.style.setProperty("--mtv-fold-color", color);
      const card = svgElement(this.doc, "rect", { class: "mtv-card", x: -node.width / 2, y: -node.height / 2, width: node.width, height: node.height, rx: this.options.style === "capsule" ? node.height / 2 : 9, fill: solid ? color : surface, stroke: color, "stroke-width": solid ? 0 : 1.3 });
      if (this.options.style === "cards" && !main) { card.setAttribute("fill", color); card.setAttribute("fill-opacity", dark ? 0.2 : 0.1); }
      if (this.options.style === "branches" && node.depth > 0) { card.setAttribute("fill-opacity", "0"); card.setAttribute("stroke-width", "0"); }
      group.append(card);
      if (this.options.style === "branches" && node.depth > 0) group.append(svgElement(this.doc, "path", { d: `M${-node.width / 2},${node.height / 2 - 3} H${node.width / 2}`, stroke: color, "stroke-width": 2, fill: "none" }));
      const foreign = svgElement(this.doc, "foreignObject", { x: -node.labelWidth / 2, y: -node.labelHeight / 2, width: node.labelWidth, height: node.labelHeight });
      node.content.style.color = solid ? "#ffffff" : dark ? "#e2e8f0" : "#273649"; node.content.style.fontWeight = main ? "600" : "400"; foreign.append(node.content); group.append(foreign);
      const source = this.nodeMap.get(node.id);
      if (this.editing) { group.setAttribute("role", "button"); group.setAttribute("aria-label", node.text); }
      if (source.children.length) {
        const toggle = svgElement(this.doc, "g", { class: "mtv-fold", role: "button", tabindex: 0, "aria-label": `${this.folded.has(node.id) ? "展开" : "折叠"} ${node.text}`, "aria-expanded": !this.folded.has(node.id), transform: `translate(${node.width / 2 + 9},0)` });
        toggle.append(svgElement(this.doc, "circle", { r: 8, fill: surface, stroke: color, "stroke-width": 1 }));
        const mark = svgElement(this.doc, "text", { "text-anchor": "middle", "dominant-baseline": "central", fill: color }); mark.textContent = this.folded.has(node.id) ? "+" : "−"; toggle.append(mark);
        group.append(toggle);
      }
      fragment.append(group); this.nodeElements.set(node.id, group);
    }
    this.svg.replaceChildren(fragment); this.highlight(); this.syncSelection();
    this.stageSize = { width: this.stage.clientWidth || 900, height: this.stage.clientHeight || this.options.height };
    if (preserveCamera && this.center) this.updateCamera(true); else this.fit(true);
  }

  /** 编辑工具只在进入编辑模式后显示，操作入口与快捷键放在同一位置。 */
  createEditBar() {
    this.editBar = this.doc.createElement("div"); this.editBar.className = "mtv-editbar"; this.editBar.hidden = true;
    this.selectedLabel = this.doc.createElement("span"); this.selectedLabel.className = "mtv-selected-label";
    this.editBar.append(this.selectedLabel); this.editButtons = new Map();
    for (const [action, label, shortcut] of [["child", "＋ 子节点", "Tab"], ["sibling", "＋ 同级节点", "Enter"], ["rename", "改名", "F2"], ["delete", "删除", "Del"], ["undo", "撤销", "Ctrl/⌘ Z"]]) {
      const button = this.doc.createElement("button"); button.type = "button"; button.dataset.editAction = action; button.setAttribute("aria-label", label.replace("＋ ", "新增"));
      const text = this.doc.createElement("span"), key = this.doc.createElement("kbd"); text.textContent = label; key.textContent = shortcut; button.append(text, key);
      this.listen(button, "click", () => this.performAction(action)); this.editBar.append(button); this.editButtons.set(action, button);
    }
    this.editStatus = this.doc.createElement("span"); this.editStatus.className = "mtv-edit-status"; this.editStatus.setAttribute("role", "status"); this.editBar.append(this.editStatus);
    this.toolbar.after(this.editBar);
  }

  /** 查看模式不处理编辑动作，也不读取笔记；切换模式无需重新排版。 */
  toggleEditing(value = !this.editing) {
    if (!this.editor || this.saving) return;
    if (!value && this.inlineForm) { this.submitInline().then(saved => { if (saved) this.toggleEditing(false); }); return; }
    this.cancelInline(); this.clearDeletePrompt(); this.editing = value;
    this.root.classList.toggle("is-editing", value); this.editBar.hidden = !value;
    this.editToggle.setAttribute("aria-label", value ? "完成编辑" : "编辑脑图"); this.editToggle.title = value ? "完成编辑，返回查看模式" : "编辑脑图"; this.editToggle.setAttribute("aria-pressed", String(value));
    if (value && !this.nodeMap.has(this.selectedId)) this.selectedId = this.model.root.id;
    for (const [id, element] of this.nodeElements) { if (value) { element.setAttribute("role", "button"); element.setAttribute("aria-label", this.nodeMap.get(id).text); } else { element.removeAttribute("role"); element.removeAttribute("aria-label"); } }
    this.syncSelection(); this.updateCamera(true);
    if (value) this.mountInlineLayer(); else this.restoreInlineLayer();
    if (value) this.stage.focus({ preventScroll: true });
    this.editor.session?.(this);
  }

  /** 编辑画布移出 CodeMirror，原位置用等高占位保留笔记布局。 */
  mountInlineLayer() {
    if (this.inlineAnchor) return;
    const rect = this.root.getBoundingClientRect();
    this.inlineAnchor = this.doc.createElement("div"); this.inlineAnchor.className = "mtv-inline-anchor";
    this.inlineAnchor.setAttribute("aria-hidden", "true");
    this.inlineAnchor.style.height = `${this.fullscreen ? this.homeHeight : rect.height}px`;
    this.scrollOwner = this.original.closest(".cm-scroller,.markdown-preview-view") || this.sourceView?.containerEl || this.original.parentElement;
    if (this.fullscreen && this.placeholder?.isConnected) { this.placeholder.replaceWith(this.inlineAnchor); this.placeholder = null; }
    else this.root.before(this.inlineAnchor);
    this.doc.body.append(this.root); this.syncInlineLayer(true);
  }

  /** 与笔记一起滚动和裁剪；原生区块重建期间沿用上一次锚点，画布保持可见。 */
  syncInlineLayer(immediate = false) {
    if (!this.inlineAnchor || this.fullscreen) return;
    if (!immediate) {
      if (!this.inlineFrame) this.inlineFrame = this.doc.defaultView.requestAnimationFrame(() => { this.inlineFrame = 0; this.syncInlineLayer(true); });
      return;
    }
    this.root.classList.add("mtv-inline-layer");
    const owner = this.scrollOwner, ownerRect = owner?.getBoundingClientRect();
    if (this.inlineAnchor.isConnected) {
      const rect = this.inlineAnchor.getBoundingClientRect();
      this.inlinePosition = { left: rect.left, top: rect.top, width: rect.width, scrollTop: owner?.scrollTop || 0, scrollLeft: owner?.scrollLeft || 0, ownerTop: ownerRect?.top || 0, ownerLeft: ownerRect?.left || 0 };
    }
    const saved = this.inlinePosition; if (!saved) return;
    const top = saved.top + (ownerRect?.top || 0) - saved.ownerTop - (owner?.scrollTop || 0) + saved.scrollTop;
    const left = saved.left + (ownerRect?.left || 0) - saved.ownerLeft - (owner?.scrollLeft || 0) + saved.scrollLeft;
    this.root.style.top = `${top}px`; this.root.style.left = `${left}px`; this.root.style.width = `${saved.width}px`;
    const height = this.root.offsetHeight;
    if (this.inlineAnchor.isConnected && this.inlineAnchor.offsetHeight !== height) this.inlineAnchor.style.height = `${height}px`;
    if (ownerRect && ownerRect.height > 0) this.root.style.clipPath = `inset(${Math.max(0, ownerRect.top - top)}px ${Math.max(0, left + saved.width - ownerRect.right)}px ${Math.max(0, top + height - ownerRect.bottom)}px ${Math.max(0, ownerRect.left - left)}px)`;
  }

  /** 返回查看时重新嵌入已完成渲染的原生区块；等待期间保留独立画布。 */
  restoreInlineLayer() {
    if (!this.inlineAnchor || this.fullscreen || !this.original.isConnected) return;
    this.original.before(this.root); this.inlineAnchor.remove(); this.inlineAnchor = null;
    this.root.classList.remove("mtv-inline-layer"); this.clearLayerPosition();
  }

  /** 重绑定原生 SVG，而不替换正在编辑的画布和输入框。 */
  adoptOriginal(svg) {
    this.original.style.display = this.originalStyle; this.inlineAnchor?.remove();
    this.host?.classList.remove("mtv-host"); this.original = svg; this.originalStyle = svg.style.display; svg.style.display = "none";
    this.host = svg.closest(".mermaid,.mermaid-preview"); this.host?.classList.add("mtv-host");
    if (this.inlineAnchor) { this.inlineAnchor.style.height = `${this.fullscreen ? this.homeHeight : this.root.offsetHeight}px`; svg.before(this.inlineAnchor); }
    if (!this.editing) this.restoreInlineLayer(); else this.syncInlineLayer();
  }

  /** 全屏和嵌入模式各自使用 CSS 定位，不残留独立编辑层的内联位置。 */
  clearLayerPosition() { for (const key of ["top", "left", "width", "clip-path"]) this.root.style.removeProperty(key); }

  /** 点击选择节点，选择状态只更新相关元素，不触发整图渲染。 */
  selectNode(id, focus = true) {
    if (!this.editing || this.saving || !this.nodeMap.has(id)) return;
    if (this.inlineForm && id !== this.selectedId) { this.submitInline().then(saved => { if (saved) this.selectNode(id, focus); }); return; }
    this.nodeElements.get(this.selectedId)?.classList.remove("is-selected"); this.selectedId = id;
    this.clearDeletePrompt(); this.syncSelection();
    if (focus) { this.stage.focus({ preventScroll: true }); this.ensureSelectedVisible(); }
    this.editor.session?.(this);
  }

  /** 同步按钮可用状态，中心节点不提供同级新增或删除操作。 */
  syncSelection() {
    const node = this.nodeMap.get(this.selectedId);
    this.nodeElements.get(this.selectedId)?.classList.toggle("is-selected", this.editing);
    if (!this.editBar) return;
    this.selectedLabel.textContent = node ? node.text : "点击选择节点"; this.selectedLabel.title = node?.text || "";
    this.editButtons.forEach((button, action) => { button.disabled = !!this.saving || (action !== "undo" && (!node || (["sibling", "delete"].includes(action) && !node.parent))); });
    this.editToggle.disabled = !!this.saving;
  }

  /** 选中新节点时轻量平移到可见区域，保持用户当前缩放。 */
  ensureSelectedVisible() {
    const position = this.positions.get(this.selectedId); if (!position || !this.center) return;
    const halfWidth = this.stageSize.width / this.scale / 2, halfHeight = this.stageSize.height / this.scale / 2, padding = 32 / this.scale;
    const x = Math.max(0, Math.min(halfWidth - padding, position.width / 2)), y = Math.max(0, Math.min(halfHeight - padding, position.height / 2));
    if (position.x - x < this.center.x - halfWidth + padding) this.center.x = position.x - x + halfWidth - padding;
    if (position.x + x > this.center.x + halfWidth - padding) this.center.x = position.x + x - halfWidth + padding;
    if (position.y - y < this.center.y - halfHeight + padding) this.center.y = position.y - y + halfHeight - padding;
    if (position.y + y > this.center.y + halfHeight - padding) this.center.y = position.y + y - halfHeight + padding;
    this.updateCamera();
  }

  /** 节点事件统一委托到 SVG，避免每次重绘为每个节点创建监听器。 */
  bindNodeInteraction() {
    const toggle = id => { if (this.folded.has(id)) this.folded.delete(id); else this.folded.add(id); this.save(); this.render(true); };
    this.listen(this.svg, "click", event => {
      const element = event.target.closest(".mtv-node"); if (!element || event.target.closest("a")) return;
      if (event.target.closest(".mtv-fold")) { event.stopPropagation(); toggle(element.dataset.nodeId); }
      else if (this.editing) this.selectNode(element.dataset.nodeId);
    });
    this.listen(this.svg, "dblclick", event => { const element = event.target.closest(".mtv-node"); if (this.editing && element && !event.target.closest(".mtv-fold,a")) { event.stopPropagation(); this.selectNode(element.dataset.nodeId); this.startInline(); } });
    this.listen(this.svg, "contextmenu", event => { const element = event.target.closest(".mtv-node"); if (this.editing && element) { event.preventDefault(); this.selectNode(element.dataset.nodeId); this.editButtons.get("child").focus(); } });
    this.listen(this.svg, "keydown", event => { if (event.target.closest(".mtv-fold") && ["Enter", " "].includes(event.key)) { event.preventDefault(); event.stopPropagation(); toggle(event.target.closest(".mtv-node").dataset.nodeId); } });
  }

  /** Tab 和 Enter 创建节点后直接输入名称，编辑结果实时写回源码。 */
  async performAction(action) {
    if (!this.editing || this.saving) return;
    if (this.inlineForm) { if (await this.submitInline()) return this.performAction(action); return; }
    const node = this.nodeMap.get(this.selectedId); if (!node && action !== "undo") return;
    if (action === "rename") return this.startInline();
    if (["sibling", "delete"].includes(action) && !node.parent) return;
    if (action === "delete" && node.children.length) return this.showDeletePrompt(node);
    this.saving = true; this.editStatus.textContent = "正在保存…"; this.syncSelection();
    try {
      if (action === "undo") await this.editor.undo();
      else { const binding = await this.editor.prepare(); await this.editor.commit(binding, this.selectedId, action, "新节点"); }
      this.editStatus.textContent = "已同步";
    } catch (error) { this.editStatus.textContent = error.message; }
    finally { this.saving = false; this.syncSelection(); }
    if (["child", "sibling"].includes(action) && this.editStatus.textContent === "已同步") this.startInline(true);
  }

  /** 分支删除在工具栏内确认，叶节点直接删除并可撤销。 */
  showDeletePrompt(node) {
    this.clearDeletePrompt(); const prompt = this.doc.createElement("div"); prompt.className = "mtv-delete-prompt";
    let count = 0; const visit = value => { count++; value.children.forEach(visit); }; visit(node);
    const text = this.doc.createElement("span"); text.textContent = `删除这条分支的 ${count} 个节点？`;
    const yes = this.doc.createElement("button"), no = this.doc.createElement("button"); yes.type = no.type = "button"; yes.textContent = "删除分支"; no.textContent = "取消";
    yes.addEventListener("click", async () => { this.clearDeletePrompt(); this.saving = true; this.syncSelection(); try { const binding = await this.editor.prepare(); await this.editor.commit(binding, node.id, "delete", ""); this.editStatus.textContent = "已同步"; } catch (error) { this.editStatus.textContent = error.message; } finally { this.saving = false; this.syncSelection(); this.stage.focus({ preventScroll: true }); } });
    no.addEventListener("click", () => { this.clearDeletePrompt(); this.stage.focus({ preventScroll: true }); }); prompt.append(text, yes, no); this.editBar.append(prompt); this.deletePrompt = prompt;
  }

  /** 清除临时分支删除提示。 */
  clearDeletePrompt() { this.deletePrompt?.remove(); this.deletePrompt = null; }

  /** 在选中节点附近输入文字，Enter 保存，Esc 取消，不打开模态窗口。 */
  async startInline(selectAll = false) {
    if (!this.editing || this.saving || this.inlineForm || this.inlineOpening) return;
    const id = this.selectedId, node = this.nodeMap.get(id); if (!node) return;
    this.inlineOpening = true; let binding;
    try { binding = await this.editor.prepare(); } catch (error) { this.editStatus.textContent = error.message; this.inlineOpening = false; return; }
    this.inlineOpening = false; if (!this.editing || !this.root.isConnected || id !== this.selectedId) return;
    this.ensureSelectedVisible(); this.updateCamera(true);
    const form = this.doc.createElement("form"); form.className = "mtv-inline-editor"; this.inlineForm = form;
    const input = this.doc.createElement("input"); input.type = "text"; input.value = node.text; input.setAttribute("aria-label", "节点文字");
    const save = this.doc.createElement("button"), cancel = this.doc.createElement("button"); save.type = "submit"; save.textContent = "保存"; cancel.type = "button"; cancel.textContent = "取消";
    const position = this.positions.get(id), width = Math.min(360, Math.max(240, this.stageSize.width - 16)), left = this.stageSize.width / 2 + (position.x - this.center.x) * this.scale - width / 2;
    form.style.width = `${width}px`; form.style.left = `${Math.max(8, Math.min(this.stageSize.width - width - 8, left))}px`; form.style.top = `${Math.max(8, Math.min(this.stageSize.height - 52, this.stageSize.height / 2 + (position.y - this.center.y) * this.scale - 22))}px`;
    cancel.addEventListener("click", () => this.cancelInline()); input.addEventListener("keydown", event => { event.stopPropagation(); if (event.key === "Escape") { event.preventDefault(); this.cancelInline(); } });
    const submitInline = async () => {
      if (this.saving) return false;
      if (input.value.trim() === node.text) { this.cancelInline(); return true; }
      this.saving = true; input.disabled = save.disabled = true; this.syncSelection(); this.editStatus.textContent = "正在保存…";
      try { await this.editor.commit(binding, id, "rename", input.value); this.cancelInline(); this.editStatus.textContent = "已同步"; return true; }
      catch (error) { this.editStatus.textContent = error.message; input.disabled = save.disabled = false; input.focus(); return false; }
      finally { this.saving = false; this.syncSelection(); }
    };
    this.submitInline = submitInline; form.addEventListener("submit", event => { event.preventDefault(); submitInline(); });
    form.append(input, save, cancel); this.stage.append(form); input.focus(); if (selectAll) input.select(); else input.setSelectionRange(input.value.length, input.value.length);
  }

  /** 取消当前文字输入，恢复画布快捷键焦点。 */
  cancelInline() { this.inlineForm?.remove(); this.inlineForm = null; this.submitInline = null; if (this.editing && this.root.isConnected) this.stage.focus({ preventScroll: true }); }

  /** 编辑模式的键盘行为接近常用脑图工具，查看模式不拦截这些快捷键。 */
  handleEditKey(event) {
    if (!this.editing || event.target.closest("input,select,textarea,button,.mtv-fold")) return false;
    const key = event.key;
    if (this.saving && (["Tab", "Insert", "Enter", "F2", "Delete", "Backspace", " "].includes(key) || ((event.ctrlKey || event.metaKey) && key.toLowerCase() === "z"))) { event.preventDefault(); event.stopPropagation(); return true; }
    if (this.saving) return false;
    if (key === "Tab" && event.shiftKey) return false;
    if ((event.ctrlKey || event.metaKey) && key.toLowerCase() === "z") this.performAction("undo");
    else if (key === "Tab" || key === "Insert") this.performAction("child");
    else if (key === "Enter") this.performAction("sibling");
    else if (key === "F2" || key === " ") this.startInline(true);
    else if (key === "Delete" || key === "Backspace") this.performAction("delete");
    else if (key === "Escape") this.clearDeletePrompt();
    else if (key === "Home") this.selectNode(this.model.root.id);
    else if (key.startsWith("Arrow")) {
      const current = this.positions.get(this.selectedId); if (!current) return false;
      const horizontal = ["ArrowLeft", "ArrowRight"].includes(key), sign = ["ArrowLeft", "ArrowUp"].includes(key) ? -1 : 1;
      let best, score = Infinity;
      this.positions.forEach(position => { const dx = position.x - current.x, dy = position.y - current.y, primary = (horizontal ? dx : dy) * sign, secondary = Math.abs(horizontal ? dy : dx); const candidate = primary + secondary * 2; if (primary > 1 && candidate < score) { best = position.id; score = candidate; } });
      if (best) this.selectNode(best);
    } else return false;
    event.preventDefault(); event.stopPropagation(); return true;
  }

  /** 源码修改后复用当前画布，保留模式、全屏、相机与标签尺寸缓存。 */
  updateModel(model, state) {
    this.cancelInline(); this.clearDeletePrompt(); this.model = model; this.nodeMap = new Map(model.nodes.map(node => [node.id, node])); this.options = normalize(state.options); this.folded = new Set(state.folded || []); this.selectedId = state.selectedId ?? this.selectedId;
    // 标签改名产生的旧尺寸缓存达到一定数量后统一清理。
    if (this.measureCache.size > model.nodes.length * 2 + 100) this.measureCache.clear();
    this.render(true); this.ensureSelectedVisible(); this.syncSelection();
  }

  /** 连线从卡片边缘出发，按方向支持曲线或直角。 */
  edgePath(parent, child) {
    if (["horizontal", "bilateral"].includes(this.effectiveLayout)) {
      const side = child.side || 1, x1 = parent.x + side * parent.width / 2, x2 = child.x - side * child.width / 2, middle = (x1 + x2) / 2;
      return this.options.connector === "elbow" ? `M${x1},${parent.y} H${middle} V${child.y} H${x2}` : `M${x1},${parent.y} C${middle},${parent.y} ${middle},${child.y} ${x2},${child.y}`;
    }
    const y1 = parent.y + parent.height / 2, y2 = child.y - child.height / 2, middle = (y1 + y2) / 2;
    if (this.effectiveLayout === "compact" && parent.depth > 0) { const x = child.x - child.width / 2; return `M${parent.x},${y1} V${y1 + 6} H${x - 12} V${child.y} H${x}`; }
    return this.options.connector === "elbow" ? `M${parent.x},${y1} V${middle} H${child.x} V${y2}` : `M${parent.x},${y1} C${parent.x},${middle} ${child.x},${middle} ${child.x},${y2}`;
  }

  /** 初始视图限制过度缩小，用户可主动选择整图适应。 */
  fit(readable = false) {
    const fitted = Math.min(this.stageSize.width / this.bounds.width, this.stageSize.height / this.bounds.height, 1);
    this.scale = Math.max(readable ? 0.7 : ZOOM.min, fitted); this.autoFit = !readable;
    this.center = { x: this.bounds.x + this.bounds.width / 2, y: this.bounds.y + this.bounds.height / 2 }; this.updateCamera(true);
  }

  /** 用 SVG viewBox 平移缩放，不把矢量文字转换成位图。 */
  updateCamera(immediate = false) {
    if (!this.center || !this.scale) return;
    if (!immediate) { if (!this.cameraFrame) this.cameraFrame = this.doc.defaultView.requestAnimationFrame(() => { this.cameraFrame = 0; this.updateCamera(true); }); return; }
    if (this.cameraFrame) { this.doc.defaultView.cancelAnimationFrame(this.cameraFrame); this.cameraFrame = 0; }
    const width = this.stageSize.width / this.scale, height = this.stageSize.height / this.scale;
    this.svg.setAttribute("viewBox", `${this.center.x - width / 2} ${this.center.y - height / 2} ${width} ${height}`);
    const zoom = `${Math.round(this.scale * 100)}%`; if (this.zoomLabel.textContent !== zoom) this.zoomLabel.textContent = zoom;
    const footer = `${this.positions.size} / ${this.model.nodes.length} 个节点 · ${LAYOUTS[this.effectiveLayout]} · ${this.editing ? "编辑模式 · Tab 子节点 · Enter 同级 · F2 改名 · Delete 删除" : "查看模式 · 拖动平移 · Ctrl / ⌘ + 滚轮缩放"}${this.editor && !this.editing ? " · 右上角 ✎ 编辑" : ""}`;
    if (this.footer.textContent !== footer) this.footer.textContent = footer;
  }

  /** 鼠标位置居中缩放，放大后仍定位到原目标。 */
  zoom(factor, point) {
    const previous = this.scale; this.scale = Math.max(ZOOM.min, Math.min(ZOOM.max, previous * factor));
    if (point) { const rect = this.stage.getBoundingClientRect(); this.center.x += (point.x - rect.left - rect.width / 2) * (1 / previous - 1 / this.scale); this.center.y += (point.y - rect.top - rect.height / 2) * (1 / previous - 1 / this.scale); }
    this.autoFit = false; this.updateCamera();
  }

  /** 鼠标和触屏拖动、双指缩放、键盘平移均作用于当前画布。 */
  bindInteraction() {
    this.listen(this.root, "click", event => event.stopPropagation()); this.listen(this.root, "dblclick", event => event.stopPropagation());
    // Live Preview 的鼠标处理会把光标放入围栏；画布手势和输入必须留在插件内。
    this.listen(this.root, "pointerdown", event => event.stopPropagation());
    this.listen(this.root, "mousedown", event => { event.stopPropagation(); if (!event.target.closest("input,select,button,a,textarea")) event.preventDefault(); });
    this.listen(this.root, "keydown", event => { event.stopPropagation(); if (event.key === "Escape" && this.fullscreen && !this.inlineForm && !event.defaultPrevented) this.toggleFullscreen(); });
    this.listen(this.doc, "scroll", () => this.syncInlineLayer(), { capture: true, passive: true });
    this.listen(this.doc.defaultView, "resize", () => this.syncInlineLayer(), { passive: true });
    // 独立层位于 body，普通滚轮仍交给所属笔记，Ctrl/⌘ 滚轮继续缩放脑图。
    this.listen(this.root, "wheel", event => { if (this.inlineAnchor && !this.fullscreen && !event.ctrlKey && !event.metaKey && !event.target.closest(".mtv-toolbar")) { event.preventDefault(); this.scrollOwner?.scrollBy({ top: event.deltaY, left: event.deltaX, behavior: "instant" }); } }, { passive: false });
    this.listen(this.stage, "wheel", event => { if (event.ctrlKey || event.metaKey) { event.preventDefault(); this.zoom(Math.exp(-event.deltaY * 0.002), { x: event.clientX, y: event.clientY }); } }, { passive: false });
    const pointers = new Map();
    this.listen(this.stage, "pointerdown", event => { if (event.target.closest(".mtv-fold,a,input,button,.mtv-inline-editor") || (this.editing && event.target.closest(".mtv-node")) || event.button !== 0) return; this.stage.focus({ preventScroll: true }); pointers.set(event.pointerId, { x: event.clientX, y: event.clientY }); this.stage.setPointerCapture(event.pointerId); this.stage.classList.add("is-dragging"); });
    this.listen(this.stage, "pointermove", event => {
      const previous = pointers.get(event.pointerId); if (!previous) return;
      if (pointers.size === 2) { const other = [...pointers.entries()].find(([id]) => id !== event.pointerId)[1]; const before = Math.hypot(previous.x - other.x, previous.y - other.y), after = Math.hypot(event.clientX - other.x, event.clientY - other.y); if (before > 0) this.zoom(after / before, { x: (event.clientX + other.x) / 2, y: (event.clientY + other.y) / 2 }); }
      else { this.center.x -= (event.clientX - previous.x) / this.scale; this.center.y -= (event.clientY - previous.y) / this.scale; this.autoFit = false; this.updateCamera(); }
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    });
    const end = event => { pointers.delete(event.pointerId); if (!pointers.size) this.stage.classList.remove("is-dragging"); };
    this.listen(this.stage, "pointerup", end); this.listen(this.stage, "pointercancel", end);
    this.listen(this.stage, "keydown", event => {
      if (this.handleEditKey(event)) return;
      if (event.target.closest(".mtv-fold,a") || event.defaultPrevented) return;
      if (["+", "="].includes(event.key)) this.zoom(1.25); else if (event.key === "-") this.zoom(0.8); else if (event.key === "0") this.fit();
      else if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) { this.center.x += (event.key === "ArrowLeft" ? -50 : event.key === "ArrowRight" ? 50 : 0) / this.scale; this.center.y += (event.key === "ArrowUp" ? -50 : event.key === "ArrowDown" ? 50 : 0) / this.scale; this.autoFit = false; this.updateCamera(); }
      else return; event.preventDefault();
    });
    this.listen(this.doc, "keydown", event => { if (event.key === "Escape" && this.fullscreen && !this.inlineForm) this.toggleFullscreen(); });
  }

  /** 搜索高亮当前节点，回车可定位折叠结构里的匹配节点。 */
  highlight() {
    const query = this.search.value.trim().toLocaleLowerCase();
    this.nodeElements.forEach((element, id) => { const text = this.nodeMap.get(id)?.text || ""; element.classList.toggle("is-match", !!query && text.toLocaleLowerCase().includes(query)); });
  }

  /** 展开匹配节点祖先，移动相机到首个匹配节点。 */
  focusMatch() {
    const query = this.search.value.trim().toLocaleLowerCase(); if (!query) return;
    const match = this.model.nodes.find(node => node.text.toLocaleLowerCase().includes(query)); if (!match) return;
    let parent = match.parent; while (parent) { this.folded.delete(parent.id); parent = parent.parent; }
    this.save(); this.render();
    const element = this.svg.querySelector(`[data-node-id="${match.id}"]`), position = /translate\(([-\d.]+),([-\d.]+)\)/.exec(element?.getAttribute("transform") || "");
    if (position) { this.center = { x: Number(position[1]), y: Number(position[2]) }; this.scale = 1; this.autoFit = false; this.updateCamera(); }
  }

  /** 使用覆盖层全屏，无需浏览器全屏权限；Esc 可退出。 */
  toggleFullscreen() {
    if (!this.fullscreen) this.homeHeight = this.root.offsetHeight;
    this.fullscreen = !this.fullscreen;
    if (this.inlineAnchor) { this.root.classList.remove("mtv-inline-layer"); this.clearLayerPosition(); }
    else if (this.fullscreen) { this.placeholder = this.doc.createComment("mindmap-view"); this.root.before(this.placeholder); this.doc.body.append(this.root); }
    else if (this.placeholder?.isConnected) this.placeholder.replaceWith(this.root);
    this.root.classList.toggle("is-fullscreen", this.fullscreen); this.fullButton.textContent = this.fullscreen ? "退出" : "全屏"; this.fit();
    if (!this.fullscreen) { if (this.editing) this.syncInlineLayer(true); else this.restoreInlineLayer(); }
  }

  /** 导出当前展开状态为独立 SVG，内嵌标签样式。 */
  exportSvg() {
    const clone = this.svg.cloneNode(true); clone.setAttribute("xmlns", SVG_NS); clone.setAttribute("viewBox", `${this.bounds.x} ${this.bounds.y} ${this.bounds.width} ${this.bounds.height}`); clone.setAttribute("width", this.bounds.width); clone.setAttribute("height", this.bounds.height); clone.querySelectorAll(".mtv-fold").forEach(element => element.remove());
    const style = svgElement(this.doc, "style"); style.textContent = `.mtv-label{font-family:"Microsoft YaHei UI","Microsoft YaHei",sans-serif;font-size:${this.options.fontSize}px;line-height:1.5;white-space:normal;overflow-wrap:anywhere;text-align:center}.mtv-label,.mtv-label *{color:var(--mtv-node-color)!important}.mtv-label p{margin:0}.mtv-edge{stroke-linecap:round}`; clone.prepend(style);
    const url = this.doc.defaultView.URL.createObjectURL(new Blob([new this.doc.defaultView.XMLSerializer().serializeToString(clone)], { type: "image/svg+xml;charset=utf-8" }));
    const link = this.doc.createElement("a"); link.href = url; link.download = `${this.model.root.text.replace(/[<>:"/\\|?*]/g, "-") || "mindmap"}.svg`; link.click(); setTimeout(() => this.doc.defaultView.URL.revokeObjectURL(url), 1000);
  }

  /** 保存单图设置到插件数据，不写入原始 Markdown。 */
  save() { this.onChange({ options: { ...this.options }, folded: [...this.folded] }); }

  /** 禁用或卸载时恢复原生展示并移除所有监听器。 */
  destroy() {
    this.cancelInline(); this.clearDeletePrompt();
    if (this.cameraFrame) this.doc.defaultView.cancelAnimationFrame(this.cameraFrame);
    if (this.resizeFrame) this.doc.defaultView.cancelAnimationFrame(this.resizeFrame);
    if (this.inlineFrame) this.doc.defaultView.cancelAnimationFrame(this.inlineFrame);
    this.inlineAnchor?.remove(); this.placeholder?.remove();
    this.abort.abort(); this.resize.disconnect(); this.root.remove(); this.original.style.display = this.originalStyle;
    if (!this.host?.querySelector(".mtv-view")) this.host?.classList.remove("mtv-host");
  }
}

/** 全局默认选项供新图使用，每张图可用控制栏单独覆盖。 */
class MindmapSettingTab extends PluginSettingTab {
  display() {
    this.containerEl.empty(); this.containerEl.createEl("h2", { text: "脑图样式与布局" });
    this.containerEl.createEl("p", { text: "这里设置新脑图的默认值。每张脑图的工具栏可以单独调整，并自动保存。" });
    const dropdown = (key, name, choices) => new Setting(this.containerEl).setName(name).addDropdown(input => { input.addOptions(choices).setValue(this.plugin.settings.defaults[key]).onChange(async value => { this.plugin.settings.defaults[key] = value; await this.plugin.persist(); }); });
    dropdown("layout", "默认方向", LAYOUTS); dropdown("style", "默认样式", STYLES); dropdown("palette", "默认配色", Object.fromEntries(Object.entries(PALETTES).map(([key, value]) => [key, value.name]))); dropdown("density", "默认间距", { compact: "紧凑", normal: "标准", spacious: "舒展" });
    for (const [key, name, min, max, step] of [["fontSize", "默认字号", 12, 24, 1], ["maxWidth", "节点文字最大宽度", 100, 320, 10], ["height", "默认画布高度", 300, 1000, 20]]) new Setting(this.containerEl).setName(name).addSlider(input => input.setLimits(min, max, step).setValue(this.plugin.settings.defaults[key]).setDynamicTooltip().onChange(async value => { this.plugin.settings.defaults[key] = value; await this.plugin.persist(); }));
    new Setting(this.containerEl).setName("应用默认样式到打开的脑图").setDesc("保留折叠状态，覆盖打开图的显示选项。").addButton(button => button.setButtonText("应用到当前脑图").onClick(async () => { for (const view of [...this.plugin.views.values()]) { view.options = normalize(this.plugin.settings.defaults); view.save(); this.plugin.remount(view); } await this.plugin.persist(); }));
  }
}

/** 在阅读与实时预览中接管脑图，其他 Mermaid 类型保持原生。 */
class MermaidTreeView extends Plugin {
  async onload() {
    const saved = await this.loadData(); this.settings = { defaults: normalize(saved?.defaults), diagrams: saved?.diagrams && typeof saved.diagrams === "object" && !Array.isArray(saved.diagrams) ? saved.diagrams : {} };
    this.views = new Map(); this.viewOwners = new WeakMap(); this.nativeStyles = new Map(); this.documents = new Map(); this.paths = new WeakMap(); this.sourceInfo = new WeakMap(); this.editHistory = []; this.sessions = new Map(); this.writeQueue = Promise.resolve(); this.addSettingTab(new MindmapSettingTab(this.app, this));
    this.registerMarkdownPostProcessor((element, context) => { const diagrams = element.querySelectorAll("svg.mindmapDiagram"); diagrams.forEach(svg => { this.paths.set(svg, context.sourcePath); const section = context.getSectionInfo(svg); if (section) this.sourceInfo.set(svg, { line: section.lineStart }); }); if (diagrams.length || element.querySelector("svg.flowchart,svg.erDiagram")) this.schedule(); });
    this.registerEvent(this.app.workspace.on("layout-change", () => this.schedule()));
    this.registerEvent(this.app.workspace.on("css-change", () => { this.views.forEach(view => view.render(true)); this.schedule(); }));
    this.addCommand({ id: "refresh-mindmaps", name: "刷新脑图查看器", callback: () => { [...this.views.values()].forEach(view => this.remount(view)); this.schedule(); } }); this.app.workspace.onLayoutReady(() => this.schedule());
  }

  /** 合并 DOM 变化，等待 Mermaid 完成节点挂载。 */
  schedule() { if (this.timer !== undefined) return; this.timer = setTimeout(() => { this.timer = undefined; this.scan(); }, 150); }

  /** 观察各窗口的原生图，并清理已关闭的图。 */
  scan() {
    const docs = new Set([document]); this.app.workspace.iterateAllLeaves(leaf => docs.add(leaf.view.containerEl.ownerDocument));
    for (const [original, view] of this.views) if (!original.isConnected) {
      // CodeMirror 可以重建原生区块；独立编辑层只在所属笔记关闭或切换时销毁。
      if (view.inlineAnchor && view.root.isConnected && view.sourceView?.containerEl.isConnected && view.sourceView.file?.path === view.sourcePath) continue;
      view.destroy(); this.views.delete(original);
    }
    for (const [svg, cleanup] of this.nativeStyles) if (!svg.isConnected) { cleanup(); this.nativeStyles.delete(svg); }
    for (const doc of docs) {
      if (!this.documents.has(doc)) {
        const diagramSelector = "svg.mindmapDiagram,svg.flowchart,svg.erDiagram,.mermaid,.mermaid-preview";
        const observer = new doc.defaultView.MutationObserver(records => { if (records.some(record => !record.target.closest?.(".mtv-view") && [...record.addedNodes, ...record.removedNodes].some(node => node.nodeType === 1 && !node.matches?.(".mtv-view") && (node.matches?.(diagramSelector) || node.querySelector?.(diagramSelector))))) this.schedule(); });
        observer.observe(doc.body, { childList: true, subtree: true }); this.documents.set(doc, observer);
      }
      doc.querySelectorAll('svg.flowchart, svg.erDiagram, svg[aria-roledescription="er"]').forEach(svg => {
        if (this.nativeStyles.has(svg)) return;
        const cleanup = styleNativeDiagram(svg); if (cleanup) this.nativeStyles.set(svg, cleanup);
      });
      doc.querySelectorAll("svg.mindmapDiagram").forEach(svg => {
        if (this.views.has(svg)) return;
        const model = readMindmap(svg); if (!model) return;
        let path = this.paths.get(svg), sourceView;
        this.app.workspace.iterateAllLeaves(leaf => { if (leaf.view.containerEl.contains(svg)) { sourceView = leaf.view; path ||= leaf.view.file?.path; } });
        const key = diagramKey(model, path || ""), saved = this.settings.diagrams[key];
        const editingView = [...this.views.values()].find(view => view.inlineAnchor && !view.original.isConnected && view.sourceView === sourceView && diagramKey(view.model, path || "") === key && (view.sourceLine === undefined || this.sourceInfo.get(svg)?.line === undefined || view.sourceLine === this.sourceInfo.get(svg).line));
        if (editingView) {
          this.views.delete(editingView.original); editingView.adoptOriginal(svg); this.views.set(svg, editingView); this.viewOwners.set(svg, editingView); return;
        }
        let view;
        const editor = path ? { prepare: () => this.prepareEdit(view.original, path), commit: (binding, id, action, text) => this.commitEdit(view.original, binding, id, action, text), undo: () => this.undoEdit(view.original, path), session: value => this.rememberSession(value, path) } : null;
        try {
          view = new MindmapView(svg, model, saved?.options || this.settings.defaults, saved, state => { this.settings.diagrams[diagramKey(view?.model || model, path || "")] = state; this.persist(); }, editor); view.sourceView = sourceView; view.sourcePath = path; this.views.set(svg, view); this.viewOwners.set(svg, view);
          const session = this.sessions.get(key);
          if (session?.editing) { view.selectedId = session.selectedId; view.toggleEditing(true); if (session.center) { view.center = { ...session.center }; view.scale = session.scale; view.updateCamera(true); } if (session.fullscreen) view.toggleFullscreen(); }
        }
        catch (error) { console.error("[mermaid-tree-view] Viewer failed", error); svg.style.display = ""; svg.previousElementSibling?.matches(".mtv-view") && svg.previousElementSibling.remove(); }
      });
    }
  }

  /** 使用标签和树关系匹配源块，重复图仅在有准确区块行号时允许编辑。 */
  async prepareEdit(svg, path) {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file?.extension !== "md") throw new Error("找不到原始 Markdown 笔记，无法保存脑图。");
    const editor = this.findSourceEditor(svg, path);
    const markdown = editor ? editor.getValue() : await this.app.vault.read(file), view = this.getView(svg), model = view?.model || readMindmap(svg);
    this.checkEditorContent(path, markdown);
    if (!model) throw new Error("脑图已刷新，请重新打开编辑。");
    const plain = text => { const element = svg.ownerDocument.createElement("template"); element.innerHTML = text; return element.content.textContent.trim().replace(/\s+/g, " "); };
    const nodeMap = new Map(model.nodes.map(node => [node.id, node]));
    const candidates = mermaidBlocks(markdown).filter(block => {
      const parsed = parseMindmapSource(block.source);
      return parsed?.nodes.length === model.nodes.length && parsed.nodes.every(node => {
        const shown = nodeMap.get(node.id);
        return shown && plain(node.label) === shown.text.replace(/\s+/g, " ") && node.parent === shown.parent?.id;
      });
    });
    const line = this.sourceInfo.get(svg)?.line;
    const block = candidates.length === 1 ? candidates[0] : candidates.find(value => value.line === line);
    if (!block) throw new Error("无法准确对应原始脑图。多行 Markdown 标签或重复图请在源码中编辑。");
    if (view) view.sourceLine = block.line;
    return { path, source: block.source, line: block.line, unique: candidates.length === 1, liveEditor: !!editor, duplicateDocument: candidates.length > 1 ? markdown : undefined };
  }

  /** 异步保存期间原生 SVG 可能已被替换，仍找到同一个编辑会话。 */
  getView(svg) { return this.views.get(svg) || this.viewOwners?.get(svg); }

  /** 只使用承载当前图的源码编辑器，全屏时原生 SVG 仍留在所属笔记内。 */
  findSourceEditor(svg, path) {
    let editor; const owner = this.getView(svg)?.sourceView;
    this.app.workspace.iterateAllLeaves(leaf => {
      const view = leaf.view;
      if (view.file?.path === path && (view === owner || view.containerEl?.contains(svg)) && (!view.getMode || view.getMode() === "source") && view.editor?.transaction && view.editor.listSelections) editor = view.editor;
    });
    return editor;
  }

  /** 拒绝同一笔记中互不一致的源码缓冲区；阅读视图里的旧缓存不参与比较。 */
  checkEditorContent(path, markdown) {
    const normalized = markdown.replace(/\r\n?/g, "\n");
    this.app.workspace.iterateAllLeaves(leaf => {
      const view = leaf.view;
      if (view.getMode?.() === "preview") return;
      // CodeMirror 内部使用 LF；换行符差异不代表用户有未保存的正文修改。
      if (view.file?.path === path && view.editor?.getValue && view.editor.getValue().replace(/\r\n?/g, "\n") !== normalized) throw new Error("这篇笔记还有未保存的编辑，请保存后再修改脑图。");
    });
  }

  /** 校验新源码，局部写回后迁移样式和折叠状态。 */
  async commitEdit(svg, binding, id, action, text) {
    if (this.editBusy) throw new Error("正在保存另一处脑图修改，请稍后重试。");
    this.editBusy = true;
    try {
      const edited = editMindmap(binding.source, id, action, text), view = this.getView(svg);
      if (!view?.root.isConnected) throw new Error("脑图已刷新，请重新打开编辑。");
      const previousState = { options: { ...view.options }, folded: [...view.folded], selectedId: view.selectedId ?? id }, previousModel = view.model;
      const nextState = { options: { ...view.options }, folded: [...view.folded].map(value => edited.remap[value]).filter(value => value !== undefined), selectedId: edited.selectedId };
      await this.writeEdit(svg, binding, edited.source, nextState, edited.remap);
      this.editHistory.push({ binding: { ...binding }, nextSource: edited.source, previousState, previousModel });
      if (this.editHistory.length > EDIT_HISTORY_LIMIT) this.editHistory.shift();
    } finally { this.editBusy = false; }
  }

  /** 只撤销当前脑图的最近一次修改，保留笔记其他位置的后续编辑。 */
  async undoEdit(svg, path) {
    if (this.editBusy) throw new Error("正在保存脑图，请稍后重试。");
    this.editBusy = true;
    try {
      const binding = await this.prepareEdit(svg, path);
      const index = this.editHistory.findLastIndex(item => item.binding.path === path && item.nextSource === binding.source && (binding.unique || item.binding.line === binding.line));
      if (index < 0) throw new Error("当前脑图没有可撤销的内容修改。");
      const edit = this.editHistory[index];
      await this.writeEdit(svg, binding, edit.binding.source, edit.previousState, {}, edit.previousModel);
      this.editHistory.splice(index, 1);
    } finally { this.editBusy = false; }
  }

  /** 只调用 Mermaid 语法解析，不运行其力导向排版，再原子写回源块。 */
  async writeEdit(svg, binding, source, state, remap, restoredModel) {
    const file = this.app.vault.getAbstractFileByPath(binding.path), view = this.getView(svg), engine = await loadMermaid();
    if (file?.extension !== "md") throw new Error("笔记已移动或删除，请重新打开脑图。");
    if (!view?.root.isConnected) throw new Error("脑图已刷新，请重新选择节点。");
    const parsedDiagram = await engine.mermaidAPI.getDiagramFromText(source), tree = parsedDiagram.db.getMindmap?.();
    const nextModel = restoredModel || modelFromSource(source, svg.ownerDocument, view.model, remap);
    const nativeParents = new Map(); const collect = (node, parent) => { if (!node) return; nativeParents.set(String(node.id), parent); node.children.forEach(child => collect(child, String(node.id))); }; collect(tree);
    if (nativeParents.size !== nextModel.nodes.length || !nextModel.nodes.every(node => nativeParents.has(node.id) && nativeParents.get(node.id) === node.parent?.id)) throw new Error("节点层级校验失败，修改尚未保存。");
    // 实时预览由编辑器完成局部事务和正常自动保存，避免外部文件更新重载整篇笔记。
    const editor = this.findSourceEditor(svg, binding.path);
    if (binding.liveEditor && !editor) throw new Error("笔记编辑器已关闭，请重新打开脑图。");
    if (editor) {
      const current = editor.getValue(); this.checkEditorContent(binding.path, current);
      const updated = replaceMindmapBlock(current, binding, source), scroll = editor.getScrollInfo();
      const transaction = mindmapTransaction(current, updated, editor.listSelections(), binding);
      this.rememberSession(view, binding.path);
      if (transaction) editor.transaction(transaction, "input.mindmap");
      editor.scrollTo(scroll.left, scroll.top);
      // CodeMirror 在下一帧才执行事务的 scrollIntoView；完成测量后恢复原阅读位置。
      svg.ownerDocument.defaultView.requestAnimationFrame(() => { if (editor.getValue() === updated) editor.scrollTo(scroll.left, scroll.top); });
    } else {
      const current = await this.app.vault.read(file); this.checkEditorContent(binding.path, current);
      await this.app.vault.process(file, markdown => { this.checkEditorContent(binding.path, markdown); return replaceMindmapBlock(markdown, binding, source); });
    }
    const selected = nextModel.nodes.find(node => node.id === state.selectedId); let parent = selected?.parent;
    const folded = new Set(state.folded); while (parent) { folded.delete(parent.id); parent = parent.parent; } state.folded = [...folded];
    this.settings.diagrams[diagramKey(nextModel, binding.path)] = state; this.persist();
    view.updateModel(nextModel, state); this.rememberSession(view, binding.path);
  }

  /** 会话中保存编辑模式，笔记自动刷新后继续编辑；重新启动仍默认查看。 */
  rememberSession(view, path) {
    const key = diagramKey(view.model, path); this.sessions.set(key, { editing: view.editing, selectedId: view.selectedId, center: view.center && { ...view.center }, scale: view.scale, fullscreen: view.fullscreen });
    // 限制打开过的图的临时状态，避免长时间使用造成无界增长。
    if (this.sessions.size > 80) this.sessions.delete(this.sessions.keys().next().value);
  }

  /** 重建控制栏，保持设置值与画面一致。 */
  remount(view) { const svg = view.original; view.destroy(); this.views.delete(svg); this.schedule(); }

  /** 串行保存快照，防止快速切换时旧配置覆盖新配置。 */
  persist() {
    const snapshot = JSON.parse(JSON.stringify(this.settings)); this.writeQueue = this.writeQueue.then(() => this.saveData(snapshot)).catch(error => { console.error("[mermaid-tree-view] Save failed", error); new Notice("脑图设置保存失败，请检查笔记库权限。"); }); return this.writeQueue;
  }

  /** 卸载时恢复原生图，清理全屏面板和观察器。 */
  onunload() { clearTimeout(this.timer); this.documents?.forEach(observer => observer.disconnect()); this.views?.forEach(view => view.destroy()); this.nativeStyles?.forEach(cleanup => cleanup()); }
}

module.exports = MermaidTreeView;
module.exports.MindmapView = MindmapView;
module.exports.readMindmap = readMindmap;
module.exports.computeLayout = computeLayout;
module.exports.normalize = normalize;
module.exports.DEFAULTS = DEFAULTS;
module.exports.styleNativeDiagram = styleNativeDiagram;

module.exports.mermaidBlocks = mermaidBlocks;
module.exports.parseMindmapSource = parseMindmapSource;
module.exports.editMindmap = editMindmap;
module.exports.replaceMindmapBlock = replaceMindmapBlock;
module.exports.modelFromSource = modelFromSource;
module.exports.mindmapTransaction = mindmapTransaction;
