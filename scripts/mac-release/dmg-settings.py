# The DMG's window, for dmgbuild: the app beside Applications, with the arrow between them.
import os.path

application = defines["app"]
files = [application]
symlinks = {"Applications": "/Applications"}
icon_locations = {os.path.basename(application): (150, 180), "Applications": (450, 180)}
background = "builtin-arrow"
window_rect = ((200, 200), (600, 400))
icon_size = 96
text_size = 13
show_status_bar = False
show_tab_view = False
show_toolbar = False
show_pathbar = False
show_sidebar = False
format = "UDZO"
