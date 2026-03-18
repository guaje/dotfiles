# shellcheck shell=bash
# Prints the current window name.
run_segment() {
	echo "󱂬 #W#{?window_zoomed_flag,(󰊓),}"
	return 0
}
