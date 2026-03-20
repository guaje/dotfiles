# shellcheck shell=bash
# Prints the current tmux session info.

run_segment() {
	echo "#[fg=$thm_mauve,bg=$thm_bg,nobold]${TMUX_POWERLINE_SEPARATOR_LEFT_BOLD}#[fg=$thm_bg,bg=$thm_mauve,bold] #[fg=$thm_fg,bg=$thm_surface_0,nobold] #S:#I.#P#[fg=$thm_surface_0,bg=$thm_bg,nobold]${TMUX_POWERLINE_SEPARATOR_RIGHT_BOLD}"
	return 0
}
