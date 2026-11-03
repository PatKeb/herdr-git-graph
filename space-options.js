// Per-space options, kept in ~/.config/herdr-app/space-options.json (backed up with the config):
//   "nested":      folders holding several repos (project/{be,fe,landing}), read as such by the
//                  agents list (each repo's PR, summed +/−) and the Changes panel (a tab per repo);
//   "hideChanges": space names whose sessions show no +/− change counts in the agents list.
// Toggled from a space's right-click menu (my-menu). The same file is in my-agents,
// changes-multi, my-menu and git-graph: keep the copies identical.
import { appHome, home, readTextFile, writeTextFile, shared, setShared } from "herdr";

const FILE = () => `${appHome()}/space-options.json`;
const strip = (p) => p.replace(/\/+$/, "");
/** A folder as it's stored and shown: ~/Webs/stavcore. */
export const shortFolder = (p) => {
  const h = strip(home()), f = strip(p);
  return f === h ? "~" : f.startsWith(h + "/") ? "~" + f.slice(h.length) : f;
};

let options = null, loadedRev, loadedAt = 0, loading = false, version = 0;

/** The options, read again whenever any mod changes them (or after 15 s, for hand edits);
 *  null until the first read. */
export function spaceOptions(cx) {
  const rev = shared("space-options.rev") ?? 0;
  if ((rev !== loadedRev || Date.now() - loadedAt > 15000) && !loading) {
    loading = true;
    cx.spawn(async (cx) => {
      try {
        const data = JSON.parse((await readTextFile(FILE())) ?? "{}");
        const next = { nested: new Set(data.nested ?? []), hideChanges: new Set(data.hideChanges ?? []) };
        const same = options && [...next.nested].join() === [...options.nested].join() && [...next.hideChanges].join() === [...options.hideChanges].join();
        if (!same) { options = next; version++; }
      } catch { options = options ?? { nested: new Set(), hideChanges: new Set() }; }
      loadedRev = rev; loadedAt = Date.now(); loading = false;
      cx.notify();
    });
  }
  return options;
}

/** Bumps each time the options are (re)read, so a view can redo what depends on them. */
export const optionsVersion = () => version;

/** Whether `folder` is read as a folder of repos. */
export const usesNested = (cx, folder) => Boolean(folder) && Boolean(spaceOptions(cx)?.nested.has(shortFolder(folder)));

/** Whether the space's sessions hide their change counts. */
export const hidesChanges = (cx, spaceName) => Boolean(spaceName) && Boolean(spaceOptions(cx)?.hideChanges.has(spaceName));

/** Adds `value` to the option list `name` ("nested": a folder, "hideChanges": a space name) or removes it. */
export async function setOption(name, value, on) {
  const text = await readTextFile(FILE());
  const data = text ? JSON.parse(text) : {};
  const v = name === "nested" ? shortFolder(value) : value;
  const set = new Set(data[name] ?? []);
  on ? set.add(v) : set.delete(v);
  await writeTextFile(FILE(), JSON.stringify({ ...data, [name]: [...set].sort() }, null, 2) + "\n", text);
  setShared("space-options.rev", Date.now());
}
