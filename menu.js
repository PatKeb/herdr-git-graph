// The right-click menu on a commit row. The panel opens this same mod as a popup at the pointer with
// props { menu: { root, on, hash, short, subject, refs, locals, stash } }; main.js renders it through these helpers.
// ↑/↓ move, Enter runs, Esc closes. An item is { label, steps, hint? }.

import { div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, notify, closeOverlay, props, theme } from "herdr";

// What can be checked out at this commit: its local branches; its remote branches, as the local branch
// of that name (fast-forwarded to the remote when it already exists elsewhere, else created to track
// it); then the commit itself, detached. An item's `steps` run in order as `git <args>`.
export function menuItems(m) {
  // A stash's menu. "{stash}" becomes its stash@{n} when run: the numbers shift as stashes come and go.
  if (m.stash) return [
    { label: "Apply stash", steps: [["stash", "apply", "{stash}"]], fail: "Couldn't apply the stash" },
    { label: "Pop stash", hint: "apply and delete", steps: [["stash", "pop", "{stash}"]], fail: "Couldn't pop the stash" },
    { label: "Delete stash", danger: true, steps: [["stash", "drop", "{stash}"]], fail: "Couldn't delete the stash", done: true },
  ];
  const items = [], here = new Set(m.refs.filter((r) => r.kind === "local" || (r.kind === "head" && r.name !== "HEAD")).map((r) => r.name));
  const locals = new Set([...(m.locals ?? []), ...here]);
  for (const name of here) items.push({ label: `Checkout ${name}`, steps: [["checkout", name]] });
  for (const r of m.refs) {
    if (r.kind !== "remote" || r.name.endsWith("/HEAD")) continue;
    const name = r.name.slice(r.name.indexOf("/") + 1);
    if (here.has(name)) continue;
    if (locals.has(name)) items.push({ label: `Checkout ${name}`, hint: `fast-forward to ${r.name}`, steps: [["checkout", name], ["merge", "--ff-only", r.name]] });
    else items.push({ label: `Checkout ${name}`, hint: `tracks ${r.name}`, steps: [["checkout", "-b", name, "--track", r.name]] });
  }
  items.push({ label: `Checkout ${m.short.slice(0, 7)}`, hint: "detached", steps: [["checkout", "--detach", m.hash]] });
  return items;
}

// Height of the popup for `n` items (it shrinks to its content; this is only the most).
export const menuHeight = (n) => 10 + 31 * n;

export function choose(view, item, cx) {
  if (!item || view.busy) return;
  view.busy = true; cx.notify();
  const m = props().menu, overlay = props().overlay;
  // Run first, then close: closing the popup cancels its unfinished tasks.
  cx.spawn(async () => {
    try {
      let ref = null;
      if (m.stash) {
        const list = await exec("git", ["stash", "list", "--format=%H"], { cwd: m.root, on: m.on });
        const n = list.stdout.split("\n").indexOf(m.hash);
        if (n < 0) throw new Error("The stash is gone (dropped or applied elsewhere).");
        ref = `stash@{${n}}`;
      }
      let ok = true;
      for (const [i, step] of item.steps.entries()) {
        const args = step.map((a) => a === "{stash}" ? ref : a);
        const r = await exec("git", args, { cwd: m.root, on: m.on });
        if (r.code === 0) continue;
        ok = false;
        const why = (r.stderr || r.stdout).trim();
        // The checkout went through; only the fast-forward didn't (the branch has its own commits).
        if (i > 0) notify({ title: `Checked out ${item.steps[0][1]}, but couldn't fast-forward it`, body: why, level: "warning" });
        else notify({ title: item.fail ?? "Checkout failed", body: why, level: "error" });
        break;
      }
      // A dropped stash's commit stays until git collects it: say how to get it back.
      if (ok && item.done) notify({ title: `Deleted ${ref}`, body: `To get it back: git stash apply ${m.hash.slice(0, 10)}`, level: "info" });
    } catch (e) { notify({ title: item.fail ?? "Checkout failed", body: String(e.message ?? e), level: "error" }); }
    closeOverlay(overlay);
  });
}

export function renderMenu(view, cx) {
  const t = theme(), list = menuItems(props().menu);
  view.at = Math.min(view.at ?? 0, list.length - 1);
  return v_flex().id("git-graph-menu").track_focus(view.handle).w_full().min_h(0).p(5).bg(t.popover).text_size(12.8)
    .on_key_down((e, cx) => {
      if (e.key === "down") view.at = (view.at + 1) % list.length;
      else if (e.key === "up") view.at = (view.at + list.length - 1) % list.length;
      else if (e.key === "enter") choose(view, list[view.at], cx);
      else if (e.key === "escape") closeOverlay(props().overlay);
      else return;
      cx.notify();
    })
    .children(list.map((it, i) => h_flex().id(`gm-${i}`).h(31).px(8).gap(9).rounded(7).items_center().cursor_pointer()
      .text_color(view.busy ? t.muted : it.danger ? t.ansi1 : t.foreground)
      .when(i === view.at, (e) => e.bg(t.selected))
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => choose(view, it, cx))
      .child(svg(props().menu.stash ? "mods/git-graph/stash.svg" : "mods/git-graph/branch.svg").size(14).flex_none().text_color(it.danger ? t.ansi1 : t.muted))
      .child(div().flex_1().min_w(0).truncate().child(it.label))
      .when(Boolean(it.hint), (e) => e.child(div().flex_none().max_w(110).truncate().text_size(11).text_color(t.dim).child(it.hint)))));
}
