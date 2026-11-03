// The right-click menu on a commit row. The panel opens this same mod as a popup at the pointer with
// props { menu: { root, on, hash, short, subject, refs } }; main.js renders it through these helpers.
// ↑/↓ move, Enter runs, Esc closes. An item is { label, steps, hint? }.

import { div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, notify, closeOverlay, props, theme } from "herdr";

// What can be checked out at this commit: its local branches; its remote branches, as the local branch
// of that name (fast-forwarded to the remote when it already exists elsewhere, else created to track
// it); then the commit itself, detached. An item's `steps` run in order as `git <args>`.
export function menuItems(m) {
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
      for (const [i, args] of item.steps.entries()) {
        const r = await exec("git", args, { cwd: m.root, on: m.on });
        if (r.code === 0) continue;
        const why = (r.stderr || r.stdout).trim();
        // The checkout went through; only the fast-forward didn't (the branch has its own commits).
        if (i > 0) notify({ title: `Checked out ${item.steps[0][1]}, but couldn't fast-forward it`, body: why, level: "warning" });
        else notify({ title: "Checkout failed", body: why, level: "error" });
        break;
      }
    } catch (e) { notify({ title: "Checkout failed", body: String(e.message ?? e), level: "error" }); }
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
      .text_color(view.busy ? t.muted : t.foreground)
      .when(i === view.at, (e) => e.bg(t.selected))
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => choose(view, it, cx))
      .child(svg("mods/git-graph/branch.svg").size(14).flex_none().text_color(t.muted))
      .child(div().flex_1().min_w(0).truncate().child(it.label))
      .when(Boolean(it.hint), (e) => e.child(div().flex_none().max_w(110).truncate().text_size(11).text_color(t.dim).child(it.hint)))));
}
