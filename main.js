import { View, div, svg, PathBuilder } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, v_virtual_list } from "gpui-base";
import { spaces, panes, focused, exec, watchFolder, theme, settings, run, props, openOverlay } from "herdr";
import { menuItems, menuHeight, renderMenu } from "./menu.js";

const LIMIT = 300;
const ROW = 26;
const LANE = 16;      // px between lanes
const PAD = 12;       // px before the first lane
const DOT = 12;
const STROKE = 2;
const BEND = 7;       // elbow radius
const K = 0.5523;     // cubic bezier handle for a quarter circle
// Reads write nothing under .git, so the folder watch never triggers itself.
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false"];
const SEP = "\u0001";
const FORMAT = `%H${SEP}%h${SEP}%P${SEP}%D${SEP}%s${SEP}%an${SEP}%cr`;
const PALETTE = ["ansi4", "ansi2", "ansi3", "ansi5", "ansi6", "ansi1", "ansi11", "ansi13", "ansi14", "ansi9", "ansi10", "ansi12"];

// The repo the panel shows: the focused terminal's folder, else the space's.
function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on };
}
const key = () => JSON.stringify(location());

function parseRefs(text) {
  return text.split(", ").filter(Boolean).map((ref) => {
    if (ref.startsWith("HEAD -> ")) return { name: ref.slice(8), kind: "head" };
    if (ref === "HEAD") return { name: ref, kind: "head" };
    if (ref.startsWith("tag: ")) return { name: ref.slice(5), kind: "tag" };
    return { name: ref, kind: ref.includes("/") ? "remote" : "local" };
  });
}

// Lays the commits out on lanes, GitKraken style: each lane (column) waits for one commit and runs
// straight down. A commit takes the leftmost lane waiting for it; other lanes waiting for it end in an
// elbow into its dot ("in"). It hands its lane to its first parent and opens or joins lanes for the
// other parents with an elbow out of its dot ("out"). Lanes never shift sideways between rows, so the
// only bends are those elbows, on the commit's own row. Several lanes may wait for the same commit
// (a branch and the line it forked from): they run side by side and meet at that commit.
function layout(commits) {
  const at = new Map(commits.map((c, i) => [c.hash, i])), byHash = new Map(commits.map((c) => [c.hash, c]));
  // Whether the lane waiting for `from` reaches `target` by first parents before passing its row.
  const reaches = (from, target) => {
    let cur = from;
    while (cur && cur !== target && at.has(cur) && at.get(cur) < at.get(target)) cur = byHash.get(cur)?.parents[0];
    return cur === target;
  };
  let lanes = [], colors = [], paint = 0, width = 1;
  const nextColor = () => PALETTE[paint++ % PALETTE.length];
  const rows = commits.map((c) => {
    const top = lanes, topColors = colors;
    const next = top.slice(), nextColors = topColors.slice();
    // A new lane takes the first free column, also one a lane ending on this row frees: its elbow in
    // and the new elbow out meet at the dot in a "}".
    const open = (hash) => {
      let k = next.indexOf(null);
      if (k < 0) k = next.length;
      next[k] = hash; nextColors[k] = nextColor();
      return k;
    };
    const waiting = [];
    top.forEach((h, k) => { if (h === c.hash) waiting.push(k); });
    const fresh = !waiting.length;
    const idx = fresh ? open(c.hash) : waiting[0];
    const color = nextColors[idx];
    const lines = [];
    for (const k of waiting.slice(1)) { next[k] = null; nextColors[k] = null; lines.push({ from: k, to: idx, color: topColors[k], kind: "in" }); }
    for (let k = 0; k < top.length; k++) {
      if (top[k] !== null && top[k] !== c.hash) lines.push({ from: k, to: k, color: topColors[k], kind: "through" });
    }
    if (!fresh) lines.push({ from: idx, to: idx, color, kind: "in" });
    const [first, ...rest] = c.parents;
    next[idx] = first ?? null;
    if (first) lines.push({ from: idx, to: idx, color, kind: "out" });
    else nextColors[idx] = null;
    for (const p of rest) {
      let k = next.findIndex((h, i) => h === p && i !== idx);
      // A merge from a branch that is still on its way down: join that lane instead of opening one.
      if (k < 0) k = next.findIndex((h, i) => h && i !== idx && at.has(p) && reaches(h, p));
      if (k < 0) k = open(p);
      lines.push({ from: idx, to: k, color: nextColors[k], kind: "out" });
    }
    while (next.length && next[next.length - 1] === null) { next.pop(); nextColors.pop(); }
    width = Math.max(width, top.length, next.length);
    lanes = next; colors = nextColors;
    return { ...c, lane: idx, color, lines };
  });
  return { rows, width };
}

export default class GitGraph extends View {
  init(_props, cx) {
    // Opened as the right-click menu of a commit (see menu.js) rather than as the panel.
    if (props()?.menu) { this.menu = true; this.at = 0; this.handle = cx.focus_handle(); this.handle.focus(); return; }
    this.rows = []; this.lanes = 1; this.all = localStorage.getItem("all") === "1";
    this.refresh(cx);
    cx.timer.every(15000, (cx) => this.refresh(cx));
  }

  watch(dir, cx) {
    if (this.on || this.watched === dir) return;
    this.watched = dir;
    cx.spawn(async (cx) => {
      try {
        while (this.watched === dir) {
          await watchFolder(dir);
          if (this.watched === dir) this.refresh(cx);
        }
      } catch { this.watched = null; }
    });
  }

  refresh(cx) {
    if (this.loading) { this.again = true; return; }
    const { cwd, on } = location(), context = key();
    if (context !== this.context) {
      this.context = context; this.root = null; this.base = null; this.branch = null; this.rows = []; this.error = null;
      this.watched = null; this.picked = null; this.detail = null;
    }
    if (!cwd) return;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const git = (args, dir = cwd) => exec("git", [...READ, ...args], { cwd: dir, on });
        if (!this.root) {
          const top = await git(["rev-parse", "--show-toplevel", "--absolute-git-dir"]);
          if (key() !== context) return;
          if (top.code !== 0) { this.error = "Not a git repository"; return; }
          const [root, gitDir] = top.stdout.trim().split("\n");
          this.root = root; this.on = on;
          // The branch the current one is compared against: origin's default, else main/master.
          const head = await git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], root);
          let base = head.code === 0 ? head.stdout.trim() : null;
          for (const name of ["main", "master"]) {
            if (base) break;
            if ((await git(["rev-parse", "--verify", "--quiet", name], root)).code === 0) base = name;
          }
          this.base = base;
          this.watch(gitDir, cx);
        }
        const root = this.root;
        const branch = await git(["branch", "--show-current"], root);
        const heads = await git(["for-each-ref", "--format=%(refname:short)", "refs/heads"], root);
        const refs = this.all ? ["--all"] : ["HEAD", ...(this.base ? [this.base] : [])];
        const log = await git(["log", "--date-order", `--format=${FORMAT}`, "-n", String(LIMIT), ...refs, "--"], root);
        if (key() !== context) return;
        if (log.code !== 0) throw new Error(log.stderr.trim());
        const commits = log.stdout.replace(/\n$/, "").split("\n").filter(Boolean).map((line) => {
          const [hash, short, parents, refs, subject, author, when] = line.split(SEP);
          return { key: hash, hash, short, parents: parents.split(" ").filter(Boolean), refs: parseRefs(refs), subject, author, when };
        });
        const laid = layout(commits);
        this.branch = branch.stdout.trim() || "HEAD detached";
        this.locals = heads.code === 0 ? heads.stdout.split("\n").filter(Boolean) : [];
        this.rows = laid.rows; this.lanes = laid.width;
        this.error = null;
      } catch (e) { if (key() === context) this.error = String(e.message ?? e); }
      finally {
        this.loading = false; cx.notify();
        if (this.again) { this.again = false; this.refresh(cx); }
      }
    });
  }

  toggle(cx) {
    this.all = !this.all; localStorage.setItem("all", this.all ? "1" : "0");
    this.refresh(cx); cx.notify();
  }

  pick(hash, cx) {
    if (!this.rows.some((row) => row.hash === hash)) return;
    if (this.picked === hash) { this.picked = null; this.detail = null; cx.notify(); return; }
    this.picked = hash; this.detail = null;
    const root = this.root, on = this.on;
    cx.spawn(async (cx) => {
      try {
        const r = await exec("git", [...READ, "show", "--stat=70", "--format=%an <%ae>%n%ad%n%n%B", "--date=format:%Y-%m-%d %H:%M", hash, "--"], { cwd: root, on });
        if (this.picked !== hash) return;
        this.detail = (r.code === 0 ? r.stdout : r.stderr).replace(/\n+$/, "").split("\n");
      } catch (e) { if (this.picked === hash) this.detail = [String(e)]; }
      cx.notify();
    });
    cx.notify();
  }

  // The right-click menu for a row, as a popup at the pointer.
  contextMenu(hash) {
    const row = this.rows.find((r) => r.hash === hash);
    if (!row || !this.root) return;
    const menu = { root: this.root, on: this.on ?? null, hash: row.hash, short: row.short, subject: row.subject, refs: row.refs, locals: this.locals ?? [] };
    openOverlay({ mod: "git-graph", kind: "popup", width: 280, height: menuHeight(menuItems(menu).length), props: { menu } });
  }

  open() {
    if (!this.picked) return;
    run("pane.split", { direction: "down", argv: ["git", "show", this.picked] });
  }

  rowWidth() { return Math.max(200, (this.size?.width ?? 640) - 2); }
  graphWidth() { return PAD * 2 + (Math.min(this.lanes, 14) - 1) * LANE; }

  // One row of the graph: the lanes' lines as native paths, the commit as a dot. Lines are straight
  // down their lane; a line to or from another lane bends with a rounded elbow at the dot's height.
  graph(row, t) {
    const x = (lane) => PAD + lane * LANE, mid = ROW / 2;
    const line = ({ from, to, color, kind }) => {
      const x1 = x(from), x2 = x(to);
      let p = PathBuilder.stroke(STROKE);
      if (kind === "through") p = p.move_to(x1, 0).line_to(x1, ROW);
      else if (x1 === x2) p = kind === "in" ? p.move_to(x1, 0).line_to(x1, mid) : p.move_to(x1, mid).line_to(x1, ROW);
      else if (kind === "out") {
        // Out of the dot sideways, then down the lane it opens or joins.
        const d = Math.sign(x2 - x1);
        p = p.move_to(x1, mid).line_to(x2 - d * BEND, mid)
          .cubic_bezier_to(x2, mid + BEND, x2 - d * BEND * (1 - K), mid, x2, mid + BEND * (1 - K)).line_to(x2, ROW);
      } else {
        // Down its lane, then sideways into the dot.
        const d = Math.sign(x2 - x1);
        p = p.move_to(x1, 0).line_to(x1, mid - BEND)
          .cubic_bezier_to(x1 + d * BEND, mid, x1, mid - BEND * (1 - K), x1 + d * BEND * (1 - K), mid).line_to(x2, mid);
      }
      return window.paint_path(p.build(), t[color]).absolute().top(0).left(0).size_full();
    };
    // Lanes passing straight through first, so the elbows and the dot sit on top.
    const lines = [...row.lines].sort((a, b) => (a.kind === "through") === (b.kind === "through") ? 0 : a.kind === "through" ? -1 : 1);
    const head = row.refs.some((r) => r.kind === "head");
    const dot = div().absolute().left(x(row.lane) - DOT / 2).top(mid - DOT / 2).w(DOT).h(DOT).rounded_full().bg(t[row.color])
      .border_2().border_color(head ? t.foreground : t.background);
    return div().relative().flex_none().w(this.graphWidth()).h(ROW).children(lines.map(line)).child(dot);
  }

  chip(ref, row, t) {
    const lane = t[row.color];
    const color = ref.kind === "tag" ? t.ansi3 : ref.kind === "remote" ? t.muted : lane;
    return h_flex().flex_none().h(18).px(6).gap(4).items_center().rounded(9).border_1().border_color(color)
      .when(ref.kind === "head", (e) => e.bg(lane).text_color(t.background).font_semibold())
      .when(ref.kind !== "head", (e) => e.text_color(color))
      .child(svg(ref.kind === "tag" ? "mods/git-graph/tag.svg" : "mods/git-graph/branch.svg").w(10).h(10).flex_none())
      .child(div().text_size(10).child(ref.name));
  }

  row(row, t, font) {
    const picked = row.hash === this.picked, head = row.refs.some((r) => r.kind === "head");
    return h_flex().w(this.rowWidth()).h(ROW).flex_none().pr(12).gap(8).items_center().cursor_pointer()
      .when(picked, (e) => e.bg(t.selected))
      .child(this.graph(row, t))
      .children(row.refs.slice(0, 4).map((ref) => this.chip(ref, row, t)))
      .child(div().flex_1().min_w(0).truncate().text_size(12).when(head, (e) => e.font_semibold()).child(row.subject))
      .when(this.rowWidth() >= 560, (e) => e.child(div().flex_none().max_w(120).truncate().text_size(11).text_color(t.muted).child(row.author)))
      .when(this.rowWidth() >= 440, (e) => e.child(div().flex_none().w(96).text_right().text_size(11).text_color(t.dim).child(row.when)))
      .child(div().flex_none().font_family(font).text_size(11).text_color(t.dim).child(row.short.slice(0, 7)));
  }

  render(cx) {
    if (this.menu) return renderMenu(this, cx);
    if (key() !== this.context) this.refresh(cx);
    const t = theme(), font = settings().font_family ?? "JetBrains Mono";
    const rows = this.rows;
    const empty = this.error || (this.loading ? "Loading history…" : this.root ? "No commits" : "No folder");
    const button = (id, label, on) => div().id(id).px(7).py(2).rounded(5).text_size(11).cursor_pointer()
      .when(on, (e) => e.bg(t.selected)).text_color(on ? t.foreground : t.muted).hover((s) => s.bg(t.hover)).child(label);
    return v_flex().id("git-graph").on_size_change((size, cx) => { this.size = size; cx.notify(); }).size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(svg("mods/git-graph/graph.svg").w(14).h(14).text_color(t.muted))
        .child(div().font_semibold().child("Git graph"))
        .when(Boolean(this.branch), (e) => e.child(div().min_w(0).truncate().px(5).py(1).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.muted).child(this.branch)))
        .child(div().flex_1())
        .when(this.loading, (e) => e.child(div().text_size(11).text_color(t.dim).frames(["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"], 90)))
        .child(h_flex().flex_none().gap(2).p(2).rounded(6).border_1().border_color(t.border)
          .child(button("mode-branch", this.base ? `vs ${this.base}` : "Branch", !this.all).on_click((_e, cx) => { if (this.all) this.toggle(cx); }))
          .child(button("mode-all", "All", this.all).on_click((_e, cx) => { if (!this.all) this.toggle(cx); }))))
      .child(div().flex_1().min_h(0).relative()
        .child(v_virtual_list("git-graph-rows", rows.length, ROW, (i) => rows[i].key,
          (range) => rows.slice(range.start, range.end).map((row) => this.row(row, t, font))).size_full().on_item_click((key, cx) => this.pick(key, cx))
          .on_item_secondary_click((key, _e, cx) => { cx.stop_propagation(); this.contextMenu(key); }))
        .child(Scrollbar.vertical("git-graph-rows").absolute().inset_0())
        .when(!rows.length, (e) => e.child(div().absolute().top(8).px(14).text_color(t.dim).child(empty))))
      .when(Boolean(this.picked), (e) => e.child(v_flex().flex_none().h(210).border_t(1).border_color(t.border)
        .child(h_flex().h(30).flex_none().px(12).gap(8).items_center()
          .child(div().flex_1().min_w(0).truncate().font_family(font).text_size(11).text_color(t.muted).child(this.picked))
          .child(button("detail-open", "Open in terminal", false).on_click(() => this.open()))
          .child(button("detail-close", "×", false).on_click((_e, cx) => { this.picked = null; this.detail = null; cx.notify(); })))
        .child(v_flex().id("git-graph-detail").flex_1().min_h(0).overflow_y_scrollbar().px(12).pb(8).font_family(font).text_size(11)
          .children((this.detail ?? ["Loading…"]).map((line, i) => div().h(16).flex_none().truncate().text_color(i < 2 ? t.muted : t.foreground).child(line.replace(/ /g, " ") || " "))))));
  }
}
