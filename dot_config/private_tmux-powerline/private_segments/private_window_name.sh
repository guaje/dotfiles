# shellcheck shell=bash
# Prints the current window name.
run_segment() {
	echo "#[fg=$thm_blue,bg=$thm_bg,nobold]${TMUX_POWERLINE_SEPARATOR_LEFT_BOLD}#[fg=$thm_bg,bg=$thm_blue,bold] 󱂬 #[fg=$thm_fg,bg=$thm_surface_0,nobold] #W#{?window_zoomed_flag,(󰊓),} #[fg=$thm_surface_0,bg=$thm_bg,nobold]${TMUX_POWERLINE_SEPARATOR_RIGHT_BOLD}"
	return 0
}
