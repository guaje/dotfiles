# shellcheck shell=bash
# Prints the current time in UTC with difference with local time.

run_segment() {
	utc_date=$(date -u +"%m-%d")
	utc_time=$(date -u +"%I:%M %p")
	diff=$(date +"%z")
	# Format +HHMM to +HH:MM
	formatted_diff="${diff:0:3}:${diff:3:2}"
	echo "#[fg=$thm_lavender,bg=$thm_bg,nobold]${TMUX_POWERLINE_SEPARATOR_LEFT_BOLD}#[fg=$thm_bg,bg=$thm_lavender,bold]󰥔 #[fg=$thm_fg,bg=$thm_surface_0,nobold] ${utc_date} ${utc_time} UTC (${formatted_diff})#[fg=$thm_surface_0,bg=$thm_bg,nobold]${TMUX_POWERLINE_SEPARATOR_RIGHT_BOLD}"
	return 0
}
