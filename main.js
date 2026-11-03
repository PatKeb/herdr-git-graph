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
const FORMAT = `%H${SEP}%h${SEP}%P${SEP}%D${SEP}%s${SEP}%an${SEP}%cr${SEP}%ct`;
const STASHES = `%H${SEP}%gd${SEP}%P${SEP}%gs${SEP}%cr${SEP}%ct`;
const DASH = [2, 4.5];  // dotted lanes (working directory, stashes); 26px rows hold whole periods
// Paths whose changes don't change what the graph shows (build output, dependencies, git's objects).
const NOISE = /\/(node_modules|\.nuxt|\.output|\.next|dist|\.cache|\.turbo)\/|\/\.git\/objects\//;
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

// `git status --porcelain` as counts: modified, added (new or untracked), deleted.
function statusCounts(text) {
  const n = { modified: 0, added: 0, deleted: 0 };
  for (const line of text.split("\n")) {
    if (!line) continue;
    const xy = line.slice(0, 2);
    if (xy === "??" || xy.includes("A")) n.added++;
    else if (xy.includes("D")) n.deleted++;
    else n.modified++;
  }
  return n.modified + n.added + n.deleted ? n : null;
}

// The working directory's files for its detail: { path, kind: "added" | "deleted" | "modified", add, del,
// binary }, with lines added and deleted against HEAD (a new file: all its lines, for the first UNCOUNTED).
const UNCOUNTED = 60;
const DIFF_LINES = 1500;  // a diff shows this many lines; the rest in a terminal
async function workingFiles(git) {
  const status = await git(["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"]);
  if (status.code !== 0) throw new Error(status.stderr.trim());
  const head = await git(["rev-parse", "--verify", "--quiet", "HEAD"]);
  const diffs = head.code === 0 ? [await git(["diff", "HEAD", "--numstat", "-z", "--no-renames"])]
    : [await git(["diff", "--cached", "--numstat", "-z", "--no-renames"]), await git(["diff", "--numstat", "-z", "--no-renames"])];
  const stats = {};
  for (const r of diffs) for (const entry of r.stdout.split("\0")) {
    const [a, d, ...rest] = entry.split("\t");
    if (!rest.length) continue;
    const path = rest.join("\t"), old = stats[path] ?? { add: 0, del: 0 };
    stats[path] = { add: old.add + (Number(a) || 0), del: old.del + (Number(d) || 0), binary: a === "-" };
  }
  const files = status.stdout.split("\0").filter(Boolean).slice(0, 1000).map((entry) => {
    const xy = entry.slice(0, 2), path = entry.slice(3);
    const kind = xy === "??" || xy.includes("A") ? "added" : xy.includes("D") ? "deleted" : "modified";
    return { path, kind, untracked: xy === "??", ...(stats[path] ?? { add: 0, del: 0, binary: false }) };
  });
  // Git doesn't diff untracked files; ask it to, against nothing, for the first few.
  await Promise.all(files.filter((f) => f.untracked).slice(0, UNCOUNTED).map(async (f) => {
    const r = await git(["diff", "--no-index", "--numstat", "--", "/dev/null", f.path]);
    const [a] = r.stdout.split("\t");
    if (a === "-") f.binary = true; else f.add = Number(a) || 0;
  }));
  return files;
}

// A commit's files, as workingFiles gives them: against its first parent (a merge: what it brought in).
const SHOW = ["--format=", "--no-renames", "--diff-merges=first-parent", "-z"];
async function commitFiles(git, hash) {
  const [num, names] = await Promise.all([git(["show", ...SHOW, "--numstat", hash, "--"]), git(["show", ...SHOW, "--name-status", hash, "--"])]);
  if (names.code !== 0) throw new Error(names.stderr.trim());
  const stats = {};
  for (const entry of num.stdout.split("\0")) {
    const [a, d, ...rest] = entry.replace(/^\n+/, "").split("\t");
    if (rest.length) stats[rest.join("\t")] = { add: Number(a) || 0, del: Number(d) || 0, binary: a === "-" };
  }
  const parts = names.stdout.replace(/^\n+/, "").split("\0"), files = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const status = parts[i].trim(), path = parts[i + 1];
    if (!status) continue;
    const kind = status.startsWith("A") ? "added" : status.startsWith("D") ? "deleted" : "modified";
    files.push({ path, kind, ...(stats[path] ?? { add: 0, del: 0, binary: false }) });
  }
  return files;
}

// Adds the rows that aren't commits: the working directory's changes on top, waiting for HEAD, and each
// stash by its date, above the commit it was made on (stashes whose commit isn't shown are left out).
function withPending(commits, wip, stashes) {
  const out = commits.slice();
  for (const st of stashes) {
    const base = out.findIndex((c) => c.hash === st.parents[0]);
    if (base < 0) continue;
    let i = out.findIndex((c) => c.kind !== "stash" && c.time < st.time);
    if (i < 0 || i > base) i = base;
    out.splice(i, 0, st);
  }
  if (wip) {
    const head = commits.find((c) => c.refs.some((r) => r.kind === "head"));
    out.unshift({ key: "wip", hash: "wip", kind: "wip", short: "", parents: head ? [head.hash] : [], refs: [], subject: "// WIP", author: "", when: "", counts: wip });
  }
  return out;
}

// Lays the commits out on lanes, GitKraken style: each lane (column) waits for one commit and runs
// straight down. A commit takes the leftmost lane waiting for it (a solid one before a dotted one); other lanes waiting for it end in an
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
  // `dashes[k]`: lane k comes from the working directory or a stash and is drawn dotted.
  let lanes = [], colors = [], dashes = [], paint = 0, width = 1;
  const nextColor = () => PALETTE[paint++ % PALETTE.length];
  const rows = commits.map((c) => {
    const top = lanes, topColors = colors, topDashes = dashes, pending = Boolean(c.kind);
    const next = top.slice(), nextColors = topColors.slice(), nextDashes = topDashes.slice();
    // A new lane takes the first free column, also one a lane ending on this row frees: its elbow in
    // and the new elbow out meet at the dot in a "}".
    const open = (hash) => {
      let k = next.indexOf(null);
      if (k < 0) k = next.length;
      next[k] = hash; nextColors[k] = pending ? "muted" : nextColor(); nextDashes[k] = pending;
      return k;
    };
    const waiting = [];
    top.forEach((h, k) => { if (h === c.hash) waiting.push(k); });
    const fresh = !waiting.length;
    // Its own lane rather than a dotted one, so a stash or the working directory bends into it.
    const idx = fresh ? open(c.hash) : (waiting.find((k) => !topDashes[k]) ?? waiting[0]);
    const lines = [];
    // A commit reached by a dotted lane carries on in a colour of its own.
    if (!fresh && topDashes[idx]) { nextColors[idx] = nextColor(); nextDashes[idx] = false; }
    const color = nextColors[idx];
    for (const k of waiting.filter((k) => k !== idx)) { next[k] = null; nextColors[k] = null; nextDashes[k] = false; lines.push({ from: k, to: idx, color: topColors[k], dashed: topDashes[k], kind: "in" }); }
    for (let k = 0; k < top.length; k++) {
      if (top[k] !== null && top[k] !== c.hash) lines.push({ from: k, to: k, color: topColors[k], dashed: topDashes[k], kind: "through" });
    }
    if (!fresh) lines.push({ from: idx, to: idx, color: topColors[idx], dashed: topDashes[idx], kind: "in" });
    const [first, ...rest] = c.parents;
    next[idx] = first ?? null;
    if (first) lines.push({ from: idx, to: idx, color, dashed: pending, kind: "out" });
    else nextColors[idx] = null;
    for (const p of rest) {
      let k = next.findIndex((h, i) => h === p && i !== idx);
      // A merge from a branch that is still on its way down: join that lane instead of opening one.
      if (k < 0) k = next.findIndex((h, i) => h && i !== idx && at.has(p) && reaches(h, p));
      if (k < 0) k = open(p);
      lines.push({ from: idx, to: k, color: nextColors[k], kind: "out" });
    }
    while (next.length && next[next.length - 1] === null) { next.pop(); nextColors.pop(); nextDashes.pop(); }
    width = Math.max(width, top.length, next.length);
    lanes = next; colors = nextColors; dashes = nextDashes;
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
          const paths = await watchFolder(dir);
          if (this.watched === dir && (paths.includes(dir) || paths.some((p) => !NOISE.test(p)))) this.refresh(cx);
        }
      } catch { this.watched = null; }
    });
  }

  refresh(cx) {
    if (this.loading) { this.again = true; return; }
    const { cwd, on } = location(), context = key();
    if (context !== this.context) {
      this.context = context; this.root = null; this.base = null; this.branch = null; this.rows = []; this.error = null;
      this.watched = null; this.picked = null; this.detail = null; this.files = null; this.diff = null;
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
          const [root] = top.stdout.trim().split("\n");
          this.root = root; this.on = on;
          // The branch the current one is compared against: origin's default, else main/master.
          const head = await git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], root);
          let base = head.code === 0 ? head.stdout.trim() : null;
          for (const name of ["main", "master"]) {
            if (base) break;
            if ((await git(["rev-parse", "--verify", "--quiet", name], root)).code === 0) base = name;
          }
          this.base = base;
          // The whole checkout, so edits show up in the working directory row at once.
          this.watch(root, cx);
        }
        const root = this.root;
        const branch = await git(["branch", "--show-current"], root);
        const heads = await git(["for-each-ref", "--format=%(refname:short)", "refs/heads"], root);
        // Stashes are drawn as their own rows, not as the commits git keeps them in.
        const refs = this.all ? ["--exclude=refs/stash", "--all"] : ["HEAD", ...(this.base ? [this.base] : [])];
        const [log, status, stash] = await Promise.all([
          git(["log", "--date-order", `--format=${FORMAT}`, "-n", String(LIMIT), ...refs, "--"], root),
          git(["status", "--porcelain"], root),
          git(["stash", "list", `--format=${STASHES}`], root),
        ]);
        if (key() !== context) return;
        if (log.code !== 0) throw new Error(log.stderr.trim());
        const commits = log.stdout.replace(/\n$/, "").split("\n").filter(Boolean).map((line) => {
          const [hash, short, parents, refs, subject, author, when, time] = line.split(SEP);
          return { key: hash, hash, short, parents: parents.split(" ").filter(Boolean), refs: parseRefs(refs), subject, author, when, time: +time };
        });
        const stashes = stash.code !== 0 ? [] : stash.stdout.split("\n").filter(Boolean).map((line) => {
          const [hash, ref, parents, subject, when, time] = line.split(SEP);
          // "WIP on main: 340d4d7 fix(...)" says no more than "WIP on main"; a named stash keeps its name.
          const label = subject.replace(/^(WIP on [^:]+): [0-9a-f]+ .*$/, "$1");
          return { key: `stash-${hash}`, hash, kind: "stash", ref, short: hash.slice(0, 7), parents: parents.split(" ").slice(0, 1), refs: [], subject: label, author: ref, when, time: +time };
        });
        const laid = layout(withPending(commits, status.code === 0 ? statusCounts(status.stdout) : null, stashes));
        this.branch = branch.stdout.trim() || "HEAD detached";
        this.locals = heads.code === 0 ? heads.stdout.split("\n").filter(Boolean) : [];
        this.rows = laid.rows; this.lanes = laid.width;
        this.error = null;
        if (this.picked && !this.rows.some((r) => r.hash === this.picked)) { this.picked = null; this.detail = null; this.files = null; this.diff = null; }
        else if (this.picked === "wip") this.loadFiles(cx);
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

  pick(key, cx) {
    const row = this.rows.find((r) => r.key === key);
    if (!row) return;
    const hash = row.hash;
    if (this.picked === hash) { this.picked = null; this.detail = null; this.files = null; this.diff = null; cx.notify(); return; }
    this.picked = hash; this.detail = null; this.files = null; this.diff = null;
    if (row.kind === "wip") { this.loadFiles(cx); cx.notify(); return; }
    const root = this.root, on = this.on, git = (args) => exec("git", [...READ, ...args], { cwd: root, on });
    cx.spawn(async (cx) => {
      try {
        if (row.kind === "stash") {
          const r = await git(["stash", "show", "--stat=70", "--include-untracked", hash]);
          if (this.picked !== hash) return;
          this.detail = (r.code === 0 ? r.stdout : r.stderr).replace(/\n+$/, "").split("\n");
        } else {
          // Who and when, the message, then its files as the working directory shows them.
          const [meta, files] = await Promise.all([
            git(["show", "-s", "--format=%an <%ae>%n%ad%n%n%B", "--date=format:%Y-%m-%d %H:%M", hash, "--"]),
            commitFiles(git, hash),
          ]);
          if (this.picked !== hash) return;
          this.detail = (meta.code === 0 ? meta.stdout : meta.stderr).replace(/\n+$/, "").split("\n");
          this.files = files;
        }
      } catch (e) { if (this.picked === hash) this.detail = [String(e.message ?? e)]; }
      cx.notify();
    });
    cx.notify();
  }

  // The working directory's files, for its detail (again on every refresh while it's open).
  loadFiles(cx) {
    const root = this.root, on = this.on;
    cx.spawn(async (cx) => {
      try {
        const files = await workingFiles((args) => exec("git", [...READ, ...args], { cwd: root, on }));
        if (this.picked === "wip" && this.root === root) {
          this.files = files; this.detail = null;
          // An open diff follows the file: again with its new changes, or closed once it has none.
          const f = this.diff && files.find((x) => x.path === this.diff.path);
          if (f) this.loadDiff(f, cx); else this.diff = null;
        }
      } catch (e) { if (this.picked === "wip") this.detail = [String(e.message ?? e)]; }
      cx.notify();
    });
  }

  // A changed file's diff against HEAD (a new file: against nothing).
  // A commit's file: what the commit changed in it.
  diffArgs(f) {
    if (this.picked !== "wip") return ["show", "--format=", "--diff-merges=first-parent", this.picked, "--", f.path];
    return f.untracked ? ["diff", "--no-index", "--", "/dev/null", f.path] : ["diff", "HEAD", "--", f.path];
  }

  openDiff(path, cx) {
    const f = this.files?.find((x) => x.path === path);
    if (!f) return;
    this.diff = { path, lines: null };
    this.loadDiff(f, cx); cx.notify();
  }

  loadDiff(f, cx) {
    const root = this.root, on = this.on;
    cx.spawn(async (cx) => {
      try {
        const r = await exec("git", [...READ, "--no-pager", "-c", "color.ui=never", ...this.diffArgs(f)], { cwd: root, on });
        if (this.diff?.path !== f.path) return;
        const all = r.stdout.replace(/\n$/, "").split("\n");
        // From the first hunk: the "diff --git", "index" and "---/+++" lines say nothing the header doesn't.
        const start = all.findIndex((l) => l.startsWith("@@") || l.startsWith("Binary files"));
        const lines = start < 0 ? [r.stderr.trim() || "No changes"] : all.slice(start);
        this.diff.lines = lines.length > DIFF_LINES ? [...lines.slice(0, DIFF_LINES), `… ${lines.length - DIFF_LINES} more lines (Open in terminal)`] : lines;
      } catch (e) { if (this.diff?.path === f.path) this.diff.lines = [String(e.message ?? e)]; }
      cx.notify();
    });
  }

  diffLine(line, i, t) {
    const color = line.startsWith("@@") ? t.ansi6 : line.startsWith("+") ? t.ansi2 : line.startsWith("-") ? t.ansi1 : t.foreground;
    return div().id(`diff-${i}`).h(16).flex_none().whitespace_nowrap().text_color(color)
      .when(line.startsWith("@@"), (e) => e.mt(i ? 6 : 0))
      .child(line.replace(/\t/g, "    ").replace(/ /g, " ") || " ");
  }

  // One changed file: what happened to it, its folder dim and its name bright, the lines it changes.
  fileRow(f, t) {
    const icon = { added: ["+", t.ansi2], deleted: ["−", t.ansi1], modified: ["✎", t.ansi3] }[f.kind];
    const cut = f.path.lastIndexOf("/") + 1;
    return h_flex().id(`file-${f.path}`).h(22).flex_none().gap(8).items_center().px(4).mx(-4).rounded(5).cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => this.openDiff(f.path, cx))
      .child(div().w(12).flex_none().text_center().text_size(13).font_semibold().text_color(icon[1]).child(icon[0]))
      .child(h_flex().flex_1().min_w(0).items_center().text_size(12.5)
        .when(cut > 0, (e) => e.child(div().min_w(0).flex_shrink(1).truncate().text_color(t.dim).child(f.path.slice(0, cut))))
        .child(div().flex_none().text_color(t.foreground).child(f.path.slice(cut))))
      .child(h_flex().flex_none().gap(6).text_size(11)
        .when(f.binary, (e) => e.child(div().text_color(t.dim).child("binary")))
        .when(!f.binary && f.add > 0, (e) => e.child(div().text_color(t.ansi2).child(`+${f.add}`)))
        .when(!f.binary && f.del > 0, (e) => e.child(div().text_color(t.ansi1).child(`−${f.del}`))));
  }

  // The right-click menu for a row, as a popup at the pointer.
  contextMenu(key) {
    const row = this.rows.find((r) => r.key === key);
    if (!row || !this.root || row.kind === "wip") return;
    const menu = { root: this.root, on: this.on ?? null, hash: row.hash, short: row.short, subject: row.subject, refs: row.refs, locals: this.locals ?? [], stash: row.kind === "stash" ? row.ref : null };
    openOverlay({ mod: "git-graph", kind: "popup", width: 280, height: menuHeight(menuItems(menu).length), props: { menu } });
  }

  open() {
    if (!this.picked) return;
    const row = this.rows.find((r) => r.hash === this.picked);
    const f = this.diff && this.files?.find((x) => x.path === this.diff.path);
    if (f) { run("pane.split", { direction: "down", argv: ["git", ...this.diffArgs(f)] }); return; }
    const argv = row?.kind === "wip" ? ["git", "status"] : row?.kind === "stash" ? ["git", "stash", "show", "-p", "--include-untracked", this.picked] : ["git", "show", this.picked];
    run("pane.split", { direction: "down", argv });
  }

  wipTitle() { return this.files ? this.filesTitle("Working directory") : "Working directory"; }

  filesTitle(what) {
    const n = this.files.length, add = this.files.reduce((s, f) => s + f.add, 0), del = this.files.reduce((s, f) => s + f.del, 0);
    return `${what} · ${n} ${n === 1 ? "file" : "files"} · +${add} −${del}`;
  }

  rowWidth() { return Math.max(200, (this.size?.width ?? 640) - 2); }
  graphWidth() { return PAD * 2 + (Math.min(this.lanes, 14) - 1) * LANE; }

  // One row of the graph: the lanes' lines as native paths, the commit as a dot. Lines are straight
  // down their lane; a line to or from another lane bends with a rounded elbow at the dot's height.
  graph(row, t) {
    const x = (lane) => PAD + lane * LANE, mid = ROW / 2;
    const line = ({ from, to, color, dashed, kind }) => {
      const x1 = x(from), x2 = x(to);
      let p = PathBuilder.stroke(STROKE);
      if (dashed) p = p.dash_array(DASH);
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
    // The working directory: a dotted ring. A stash: a dotted box with a tray. A commit: a dot.
    const S = row.kind === "stash" ? 16 : DOT;
    const dot = div().absolute().left(x(row.lane) - S / 2).top(mid - S / 2).w(S).h(S);
    const mark = row.kind === "wip" ? dot.rounded_full().bg(t.background).border_2().border_dashed().border_color(t.muted)
      : row.kind === "stash" ? dot.rounded(4).bg(t.background).border_1().border_dashed().border_color(t.muted).flex().items_center().justify_center()
        .child(svg("mods/git-graph/stash.svg").w(10).h(10).text_color(t.muted))
      : dot.rounded_full().bg(t[row.color]).border_2().border_color(head ? t.foreground : t.background);
    return div().relative().flex_none().w(this.graphWidth()).h(ROW).children(lines.map(line)).child(mark);
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

  // The working directory's counts, GitKraken style: ✎ modified, + added, − deleted.
  counts(n, t) {
    const one = (sign, count, color) => count ? div().flex_none().text_size(11).text_color(color).child(`${sign} ${count}`) : null;
    return h_flex().flex_none().gap(8).items_center()
      .children([one("✎", n.modified, t.ansi3), one("+", n.added, t.ansi2), one("−", n.deleted, t.ansi1)].filter(Boolean));
  }

  row(row, t, font) {
    const picked = row.hash === this.picked, head = row.refs.some((r) => r.kind === "head"), pending = Boolean(row.kind);
    return h_flex().w(this.rowWidth()).h(ROW).flex_none().pr(12).gap(8).items_center().cursor_pointer()
      .when(picked, (e) => e.bg(t.selected))
      .child(this.graph(row, t))
      .children(row.refs.slice(0, 4).map((ref) => this.chip(ref, row, t)))
      .when(row.kind === "wip", (e) => e.child(div().flex_none().text_size(12).text_color(t.muted).italic().child(row.subject)).child(this.counts(row.counts, t)).child(div().flex_1()))
      .when(row.kind !== "wip", (e) => e.child(div().flex_1().min_w(0).truncate().text_size(12).when(head, (e) => e.font_semibold()).when(pending, (e) => e.text_color(t.muted).italic()).child(row.subject)))
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
      .when(Boolean(this.picked), (e) => e.child(v_flex().flex_none().h(this.diff ? 340 : 210).border_t(1).border_color(t.border)
        .child(h_flex().h(30).flex_none().px(12).gap(8).items_center()
          .when(Boolean(this.diff), (e) => e.child(button("diff-back", "← Files", false).on_click((_e, cx) => { this.diff = null; cx.notify(); })))
          .child(div().flex_1().min_w(0).truncate().font_family(font).text_size(11).text_color(t.muted)
            .child(this.diff ? this.diff.path : this.picked === "wip" ? this.wipTitle() : this.files ? this.filesTitle(this.picked.slice(0, 10)) : this.rows.find((r) => r.hash === this.picked)?.kind === "stash" ? `${this.rows.find((r) => r.hash === this.picked).ref} · ${this.picked}` : this.picked))
          .child(button("detail-open", "Open in terminal", false).on_click(() => this.open()))
          .child(button("detail-close", "×", false).on_click((_e, cx) => { this.picked = null; this.detail = null; this.files = null; this.diff = null; cx.notify(); })))
        .when(Boolean(this.diff), (e) => e.child(v_flex().id("git-graph-diff").flex_1().min_h(0).overflow_scroll().px(12).pb(8).font_family(font).text_size(11)
          .children((this.diff?.lines ?? ["Loading…"]).map((line, i) => this.diffLine(line, i, t)))))
        .when(!this.diff, (e) => e.child(v_flex().id("git-graph-detail").flex_1().min_h(0).overflow_y_scrollbar().px(12).pb(8)
          .when(!this.files || Boolean(this.detail), (e) => e.children((this.detail ?? ["Loading…"]).map((line, i) => div().h(16).flex_none().truncate().font_family(font).text_size(11)
            .text_color(i < 2 ? t.muted : t.foreground).child(line.replace(/ /g, " ") || " "))))
          .when(Boolean(this.files) && Boolean(this.detail), (e) => e.child(div().h(8).flex_none()))
          .children((this.files ?? []).map((f) => this.fileRow(f, t)))))));
  }
}
