// A unified diff drawn GitKraken style: old and new line numbers, added lines on green and removed ones
// on red, and in a removed line followed by its replacement the part that changed a shade stronger.
// The same file lives in mods/changes-multi (mods can't import from each other): change both.

import { div } from "gpui-kit";
import { h_flex } from "gpui-base";

const WORD = /[\p{L}\p{N}_$]/u;
const ROW = 18;
// Saturated green and red of their own: the theme's ansi ones are pastel and turn grey under a tint.
const ADD = "#2ea043", DEL = "#f85149";
// The changed part of a line: red reads louder than green, so it gets less.

// What differs between a removed line and the one that replaced it: [start, end) in each, by whole words.
// Null when the lines share too little for a highlight to mean anything (then the line colour says it).
function changed(a, b) {
  const max = Math.min(a.length, b.length);
  let p = 0, s = 0;
  while (p < max && a[p] === b[p]) p++;
  while (s < max - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  while (p > 0 && WORD.test(a[p - 1]) && (WORD.test(a[p] ?? "") || WORD.test(b[p] ?? ""))) p--;
  while (s > 0 && WORD.test(a[a.length - s]) && (WORD.test(a[a.length - s - 1] ?? "") || WORD.test(b[b.length - s - 1] ?? ""))) s--;
  const indent = Math.min(p, /^\s*/.exec(a)[0].length);
  if (p + s - indent < 0.3 * (Math.max(a.length, b.length) - indent)) return null;
  return [[p, a.length - s], [p, b.length - s]];
}

// Diff lines (from the first "@@") as rows: { kind: "@" | "+" | "-" | " " | "", text, old?, new?, span? }.
export function diffRows(lines) {
  let old = 0, next = 0;
  const rows = lines.map((line) => {
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (m) { old = +m[1]; next = +m[2]; return { kind: "@", text: line }; }
    const kind = line[0], text = line.slice(1);
    if (kind === "-") return { kind, old: old++, text };
    if (kind === "+") return { kind, new: next++, text };
    if (kind === " ") return { kind, old: old++, new: next++, text };
    return { kind: "", text: line };   // "\ No newline at end of file", "Binary files … differ"
  });
  // A run of removed lines straight before a run of added ones: pair them up, line by line.
  for (let i = 0; i < rows.length;) {
    if (rows[i].kind !== "-") { i++; continue; }
    let j = i; while (j < rows.length && rows[j].kind === "-") j++;
    let k = j; while (k < rows.length && rows[k].kind === "+") k++;
    for (let x = 0; x < Math.min(j - i, k - j); x++) {
      const span = changed(rows[i + x].text, rows[j + x].text);
      if (span) { rows[i + x].span = span[0]; rows[j + x].span = span[1]; }
    }
    i = Math.max(k, i + 1);
  }
  return rows;
}

const shown = (text) => text.replace(/\t/g, "    ").replace(/ /g, " ");

// One row. `t`: the theme (its colours are #rrggbb, so an alpha can follow). `fixed`: every row this many
// px high, for a virtual list (a hunk header then gets no gap above it).
export function diffRow(r, i, t, fixed) {
  if (r.kind === "@") {
    return h_flex().id(`diff-${i}`).h(fixed ?? 22).w_full().flex_none().items_center().px(10).when(!fixed && i > 0, (e) => e.mt(6))
      .bg(t.ansi4 + "1a").border_y(1).border_color(t.ansi4 + "33").text_color(t.ansi4)
      .child(div().flex_1().min_w(0).truncate().child(r.text));
  }
  const tint = r.kind === "+" ? ADD : r.kind === "-" ? DEL : null;
  const number = (n) => div().w(34).flex_none().pr(6).text_right().text_color(tint ? tint + "cc" : t.dim).child(n === undefined ? "" : String(n));
  let body;
  if (r.span && tint) {
    const [a, b] = r.span, parts = [[r.text.slice(0, a), false], [r.text.slice(a, b), true], [r.text.slice(b), false]].filter(([s]) => s);
    body = h_flex().flex_1().min_w(0).overflow_hidden().children(parts.map(([s, strong], n) =>
      div().flex_none().whitespace_nowrap().when(strong, (e) => e.bg(tint + (tint === DEL ? "4c" : "70")).rounded(2))
        .when(n === parts.length - 1 && !strong, (e) => e.flex_1().min_w(0).truncate()).child(shown(s))));
  } else body = div().flex_1().min_w(0).truncate().when(!r.kind, (e) => e.text_color(t.dim)).child(shown(r.text) || " ");
  return h_flex().id(`diff-${i}`).h(fixed ?? ROW).w_full().flex_none().items_center().pr(10)
    .when(Boolean(tint), (e) => e.bg(tint + "2e"))
    .child(div().w(3).h_full().flex_none().when(Boolean(tint), (e) => e.bg(tint)))
    .child(number(r.old)).child(number(r.new))
    .child(div().w(14).flex_none().text_center().text_color(tint ?? t.dim).child(r.kind === "+" ? "+" : r.kind === "-" ? "−" : ""))
    .child(body);
}
