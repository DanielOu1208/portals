# Portals icon

The icon is two round-arched doorways in shadow, one stepped behind the other, with light
where they overlap. Black, white and greys only.

- `appicon.svg` is the 1024 px app icon: the doorways and their glow on an opaque black
  background, in two layers (`background`, `foreground`) for Icon Composer. iOS supplies the
  icon shape, so there is no inset tile.
- `mark.svg` is the one-colour mark, cropped to the drawing, in `currentColor`: the two
  doorway shapes with the overlap cut away, since the light doesn't survive in one colour.
- `build-icon.sh` renders `appicon.svg` to
  `Portals/Assets.xcassets/AppIcon.appiconset/AppIcon.png`. Run it after editing the SVG.
