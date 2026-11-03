#!/bin/zsh
# Makes a scratch copy of a built Portals.app that cannot touch the installed app:
# its own bundle id, no extension, no URL scheme, signed ad hoc.
#   prepare-app.sh <built .app> <copy .app> <bundle id>
# Nothing outside the copy is changed: a built .app given by a symbolic link is copied
# from where it really is, and a copy with a link that leads out of it or nowhere (which
# the changes and the signing below would follow) is refused.
set -euo pipefail
[[ ! -L $2 ]] || { echo "prepare-app.sh: $2 is a link; nothing changed" >&2; exit 1; }
# Physical paths preserve symlink/.. order and the filesystem's actual case.
# Use the same destination for the check and for every operation below.
src=${1:P} dst=${2:P} id=$3
[[ -d $src/Contents ]] || { echo "prepare-app.sh: $1 is not a Mac app" >&2; exit 1; }
root=$dst
[[ $root != $src && $root != $src/* && $src != $root/* ]] || {
  echo "prepare-app.sh: $dst overlaps source $src; nothing changed" >&2; exit 1
}
# Check before removing an old copy too. Relative internal framework links survive
# relocation; an absolute link would still name the original, even if internal there.
for link in ${(f)"$(find "$src" -type l)"}; do
  [[ -e $link ]] || { echo "prepare-app.sh: $link leads nowhere; nothing changed" >&2; exit 1; }
  target=${link:P}
  [[ $target == $src/* && $(readlink "$link") != /* ]] || {
    echo "prepare-app.sh: $link would lead out of the copy; nothing changed" >&2; exit 1
  }
done
rm -rf "$dst"
cp -R "$src" "$dst"
[[ ! -L $dst ]] || { echo "prepare-app.sh: $dst is a link; nothing changed in it" >&2; exit 1; }
root=${dst:P}
for link in ${(f)"$(find "$root" -type l)"}; do
  # A link to nothing (or a loop) cannot be checked: what it names could be made anew.
  [[ -e $link ]] || { echo "prepare-app.sh: $link leads nowhere; nothing changed" >&2; rm -rf "$dst"; exit 1; }
  target=${link:P}
  [[ $target == $root/* ]] || { echo "prepare-app.sh: $link leads out of the copy ($target); nothing changed" >&2; rm -rf "$dst"; exit 1; }
done
rm -rf "$dst/Contents/PlugIns" "$dst/Contents/_CodeSignature"
/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier $id" "$dst/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Delete :CFBundleURLTypes" "$dst/Contents/Info.plist" 2>/dev/null || true
# The extension is gone: a scratch build must not write or prune the installed
# app's shared notification pictures, or ask macOS for access to that container.
/usr/libexec/PlistBuddy -c "Delete :PortalsAppGroup" "$dst/Contents/Info.plist" 2>/dev/null || true
codesign --force --deep -s - "$dst" 2>/dev/null
