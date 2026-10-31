// An in-memory folder for the music-folder tests: handles shaped like the File System Access API's,
// with files that can be added, changed and removed between scans. Nothing here is real music.
import type { DirectoryHandleLike, FileHandleLike } from "../local-files.ts";

export interface FakeFolder extends DirectoryHandleLike {
  /** Adds or replaces the file at `path` ("sub/a.mp3"), creating folders on the way. */
  write(path: string, text?: string, lastModified?: number): void;
  remove(path: string): void;
  /** Makes reading `path` fail as a moved or locked file does. */
  breakFile(path: string): void;
  permission: PermissionState;
  permissionRequests: number;
  /** How many files were opened (getFile) across every scan. */
  readonly opened: number;
}

interface Node {
  readonly folders: Map<string, Node>;
  readonly files: Map<string, { text: string; lastModified: number; broken: boolean }>;
}

const emptyNode = (): Node => ({ folders: new Map(), files: new Map() });

export function fakeFolder(name: string, files: Readonly<Record<string, string>> = {}): FakeFolder {
  const root = emptyNode();
  let opened = 0;
  const handleFor = (folderName: string, node: Node): DirectoryHandleLike => ({
    kind: "directory",
    name: folderName,
    async *values(): AsyncIterable<FileHandleLike | DirectoryHandleLike> {
      for (const [childName, child] of node.folders) yield await Promise.resolve(handleFor(childName, child));
      for (const [fileName, entry] of node.files) {
        const handle: FileHandleLike = {
          kind: "file",
          name: fileName,
          getFile: () => {
            opened += 1;
            return entry.broken
              ? Promise.reject(new DOMException("A requested file could not be found.", "NotFoundError"))
              : Promise.resolve(new File([entry.text], fileName, { lastModified: entry.lastModified }));
          },
        };
        yield await Promise.resolve(handle);
      }
    },
  });
  const at = (path: string, create: boolean): { node: Node; leaf: string } | null => {
    const parts = path.split("/");
    const leaf = parts.pop() ?? "";
    let node = root;
    for (const part of parts) {
      let next = node.folders.get(part);
      if (next === undefined) {
        if (!create) return null;
        next = emptyNode();
        node.folders.set(part, next);
      }
      node = next;
    }
    return { node, leaf };
  };
  const base = handleFor(name, root);
  const folder: FakeFolder = {
    kind: "directory",
    name,
    values: () => base.values(),
    permission: "granted",
    permissionRequests: 0,
    get opened() {
      return opened;
    },
    queryPermission: () => Promise.resolve(folder.permission),
    requestPermission: () => {
      folder.permissionRequests += 1;
      return Promise.resolve(folder.permission);
    },
    write(path, text = "ID3fake", lastModified = 1_700_000_000_000) {
      const place = at(path, true);
      place?.node.files.set(place.leaf, { text, lastModified, broken: false });
    },
    remove(path) {
      const place = at(path, false);
      place?.node.files.delete(place.leaf);
    },
    breakFile(path) {
      const place = at(path, false);
      const entry = place?.node.files.get(place.leaf);
      if (entry !== undefined) entry.broken = true;
    },
  };
  for (const [path, text] of Object.entries(files)) folder.write(path, text);
  return folder;
}
